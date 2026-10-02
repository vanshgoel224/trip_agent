// Long-term memory as a knowledge graph, stored and exported in graphify's
// format (networkx node-link JSON: nodes / links / hyperedges, with
// community, relation, confidence and source fields), so graphify's report and
// graph.html tooling can read it. Shared by every chat.
import { createHash } from "node:crypto";
import type { Store } from "../../packages/db";
import { nowIso } from "../../packages/shared";
import { normalize, score, wordMatch } from "../../packages/shared/fuzzy";
import { bus } from "../../packages/events";

export type NodeType = "traveller" | "person" | "place" | "trip" | "preference" | "expense" | "activity" | "fact" | "chat" | "language" | "thing";

export type MemNode = {
  id: string;
  label: string;
  norm_label: string;
  type: NodeType;
  community: number;
  community_name: string;
  source_file: string; // chat id the memory came from (graphify: source file)
  file_type: "memory";
  mentions: number;
  attrs?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type MemLink = {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: "EXTRACTED" | "INFERRED";
  confidence_score: number;
  source_file: string;
  weight: number;
  created_at: string;
};

const COMMUNITIES: Record<NodeType, [number, string]> = {
  traveller: [0, "Traveller"],
  person: [1, "People"],
  place: [2, "Places"],
  trip: [3, "Trips"],
  activity: [3, "Trips"],
  preference: [4, "Preferences"],
  language: [4, "Preferences"],
  expense: [5, "Money & Expenses"],
  fact: [6, "Facts"],
  thing: [6, "Facts"],
  chat: [7, "Conversations"],
};

export const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9ऀ-ॿ]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "x";
// Opaque ids: row ids/index columns are not encrypted, so they must not contain the fact itself.
export const nodeId = (type: NodeType, label: string) => `${type}_${createHash("sha256").update(slug(label)).digest("hex").slice(0, 16)}`;

export class MemoryGraph {
  private cache?: { nodes: MemNode[]; links: MemLink[] };
  constructor(private store: Store) {}

  upsertNode(type: NodeType, label: string, source: string, attrs?: Record<string, unknown>): MemNode {
    label = label.trim();
    // Same type + near-identical label (case, spacing, one typo) → same node.
    const twin = type !== "chat" ? this.nodes().find((n) => n.type === type && score(label, n.label) >= 0.93) : undefined;
    const id = twin?.id ?? nodeId(type, label);
    const prev = this.store.get<MemNode>("memory_nodes", id);
    const [community, community_name] = COMMUNITIES[type] ?? COMMUNITIES.thing;
    const node: MemNode = prev
      ? { ...prev, mentions: prev.mentions + 1, attrs: { ...prev.attrs, ...attrs }, updated_at: nowIso() }
      : { id, label: label.slice(0, 120), norm_label: label.toLowerCase().slice(0, 120), type, community, community_name, source_file: source, file_type: "memory", mentions: 1, attrs, created_at: nowIso(), updated_at: nowIso() };
    this.store.put("memory_nodes", id, node, { key: type });
    this.cache = undefined;
    return node;
  }

  link(source: string, target: string, relation: string, from: string, confidence: MemLink["confidence"] = "EXTRACTED", score = 1): MemLink {
    const rel = slug(relation) || "related_to";
    const id = `L_${createHash("sha256").update(`${source}|${rel}|${target}`).digest("hex").slice(0, 24)}`;
    const prev = this.store.get<MemLink>("memory_links", id);
    const link: MemLink = prev
      ? { ...prev, weight: prev.weight + 1, confidence_score: Math.max(prev.confidence_score, score) }
      : { id, source, target, relation: rel, confidence, confidence_score: score, source_file: from, weight: 1, created_at: nowIso() };
    this.store.put("memory_links", id, link, { key: source });
    this.cache = undefined;
    return link;
  }

  /** Rejects junk before it enters long-term memory. Returns a reason, or undefined if acceptable. */
  static junk(f: { subject: string; relation: string; object: string }): string | undefined {
    const sub = String(f.subject ?? "").trim(), obj = String(f.object ?? "").trim(), rel = String(f.relation ?? "").trim();
    if (sub.length < 2 || obj.length < 2 || rel.length < 2) return "too short";
    if (sub.length > 80 || obj.length > 80 || rel.length > 40) return "too long to be a durable fact";
    const vague = /^(it|this|that|they|something|anything|stuff|thing|unknown|n\/a|none|null|undefined|ok|yes|no)$/i;
    if (vague.test(sub) || vague.test(obj)) return "too vague";
    if (sub.toLowerCase() === obj.toLowerCase()) return "subject equals object";
    return undefined;
  }

  /** Store a subject–relation–object fact. */
  remember(f: { subject: string; subject_type?: NodeType; relation: string; object: string; object_type?: NodeType }, chatId: string, confidence: MemLink["confidence"] = "INFERRED") {
    const bad = MemoryGraph.junk(f);
    if (bad) return { skipped: `${f.subject} ${f.relation} ${f.object}`.slice(0, 120), reason: bad };
    const a = this.upsertNode(f.subject_type ?? "thing", f.subject, chatId);
    const b = this.upsertNode(f.object_type ?? "thing", f.object, chatId);
    const l = this.link(a.id, b.id, f.relation, chatId, confidence, confidence === "EXTRACTED" ? 1 : 0.8);
    bus.emitEvent({ tripId: "*", agent: "memory", type: "MEMORY", detail: `${a.label} —${l.relation}→ ${b.label}` });
    return { subject: a.id, object: b.id, relation: l.relation };
  }

  // In-RAM cache for quick recall; invalidated on every write.
  private load() {
    return (this.cache ??= { nodes: this.store.list<MemNode>("memory_nodes"), links: this.store.list<MemLink>("memory_links") });
  }
  nodes() {
    return this.load().nodes;
  }

  /** /forget: delete nodes matching the query and every link touching them. */
  forget(q: string): string[] {
    // Deleting is destructive: require a strong match (typos OK, loose matches not).
    const hits = this.search(q, 10).filter((h) => h.match >= 0.8 && h.type !== "traveller" && h.type !== "chat");
    for (const h of hits) {
      for (const l of this.links().filter((l) => l.source === h.id || l.target === h.id)) this.store.delete("memory_links", l.id);
      this.store.delete("memory_nodes", h.id);
    }
    this.cache = undefined;
    if (hits.length) bus.emitEvent({ tripId: "*", agent: "memory", type: "MEMORY", detail: `Forgot ${hits.map((h) => h.label).join(", ")}` });
    return hits.map((h) => h.label);
  }
  links() {
    return this.load().links;
  }

  /** Quick recall: typo- and case-tolerant match on node labels, with their direct facts. No model call. */
  search(q: string, limit = 20) {
    if (normalize(q).length < 2) return [];
    const { nodes, links } = this.load();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return nodes
      .filter((n) => n.type !== "chat")
      .map((n) => ({ n, s: score(q, n.label) }))
      .filter((x) => x.s >= 0.55)
      .sort((a, b) => b.s - a.s || b.n.mentions - a.n.mentions)
      .slice(0, limit)
      .map(({ n, s }) => ({
        id: n.id,
        label: n.label,
        type: n.type,
        community: n.community_name,
        mentions: n.mentions,
        match: Math.round(s * 100) / 100,
        facts: links
          .filter((l) => l.source === n.id || l.target === n.id)
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 12)
          .map((l) => `${byId.get(l.source)?.label ?? l.source} ${l.relation.replace(/_/g, " ")} ${byId.get(l.target)?.label ?? l.target}`),
      }));
  }


  /** Facts relevant to a message: nodes whose label appears in it, their neighbours, plus the traveller's preferences. */
  recall(text: string, limit = 25): string[] {
    const words = normalize(text).split(" ").filter((w) => w.length >= 3);
    const nodes = this.nodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const mentioned = (n: MemNode) => {
      const lw = normalize(n.label).split(" ").filter((w) => w.length >= 3);
      return lw.length > 0 && lw.every((l) => words.some((w) => wordMatch(w, l)));
    };
    const hit = new Set(nodes.filter((n) => n.type !== "chat" && mentioned(n)).map((n) => n.id));
    for (const n of nodes) if (n.type === "traveller" || n.type === "preference" || n.type === "language") hit.add(n.id);
    const facts = this.links()
      .filter((l) => hit.has(l.source) || hit.has(l.target))
      .sort((a, b) => b.weight - a.weight || b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((l) => `${byId.get(l.source)?.label ?? l.source} ${l.relation.replace(/_/g, " ")} ${byId.get(l.target)?.label ?? l.target}`);
    return [...new Set(facts)];
  }

  /** graphify-compatible export (networkx node-link). */
  exportGraphify() {
    const nodes = this.nodes().map(({ created_at, updated_at, ...n }) => ({ ...n, _origin: "memory" }));
    const links = this.links().map(({ id, created_at, ...l }) => ({ ...l, _origin: "memory", context: "conversation" }));
    const communities = new Map<string, string[]>();
    for (const n of nodes) communities.set(n.community_name, [...(communities.get(n.community_name) ?? []), n.id]);
    const hyperedges = [...communities].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({
      id: `community_${slug(name)}`, label: name, nodes: ids, relation: "belong_to", confidence: "EXTRACTED", confidence_score: 1.0, source_file: "memory",
    }));
    return { directed: false, multigraph: false, graph: { hyperedges }, nodes, links, hyperedges, built_at: nowIso() };
  }

  /** graphify-style GRAPH_REPORT.md. */
  report() {
    const nodes = this.nodes();
    const links = this.links();
    const degree = new Map<string, number>();
    for (const l of links) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const god = [...degree].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const label = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
    const comms = [...new Set(nodes.map((n) => n.community_name))];
    const inferred = links.filter((l) => l.confidence === "INFERRED").length;
    return [
      `# Graph Report - Biruni memory  (${nowIso().slice(0, 10)})`,
      "",
      "## Summary",
      `- ${nodes.length} nodes · ${links.length} edges · ${comms.length} communities`,
      `- Extraction: ${links.length ? Math.round((100 * (links.length - inferred)) / links.length) : 0}% EXTRACTED · ${links.length ? Math.round((100 * inferred) / links.length) : 0}% INFERRED`,
      "",
      "## Community Hubs (Navigation)",
      ...comms.map((c) => `- ${c}`),
      "",
      "## God Nodes (most connected - your core abstractions)",
      ...god.map(([id, d], i) => `${i + 1}. \`${label(id)}\` - ${d} edges`),
      "",
    ].join("\n");
  }
}
