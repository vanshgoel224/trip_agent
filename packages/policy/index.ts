// Deterministic policy. The model never has final authority over anything here (spec §33).
import type {
  AuthorityLedger,
  Debit,
  DisruptionClass,
  Incident,
  Obligation,
  ObligationClassification,
  ObligationMap,
  Route,
  StopReason,
} from "../domain";
import { id, inr, nowIso } from "../shared";
import { containsFuzzy } from "../shared/fuzzy";

// ---------- Disruption classification (spec §4.3) ----------

// English words: substring + typo-tolerant ("acident", "harrased").
const SAFETY_WORDS = [
  "accident", "injur", "hurt", "bleed", "assault", "harass", "attack", "unsafe", "threat",
  "robbed", "stolen phone", "followed", "following me", "stalking", "stalker", "medical", "hospital", "emergency", "police", "sos",
  "scared", "afraid", "in danger", "not safe", "molest", "kidnap", "drunk", "rash driv", "overspeeding", "chest pain", "can't breathe", "unconscious", "fainted",
];
// Hindi / Hinglish: exact words only. Short romanised words collide under typo-matching
// ("hoon" is one letter from "khoon"), so these never go through the fuzzy matcher.
const SAFETY_EXACT = /(^|[^\p{L}])(peecha|pichha|picha kar|darr? lag|bachao|bachaao|madad karo|chot lagi|khoon nikal|khoon beh|chhed|ched raha|chhed raha|maar raha|maar diya|loot liya|loot gaya|pīchhā|पीछा|डर लग|बचाओ|मदद करो|चोट लगी|खून)([^\p{L}]|$)/iu;
const ROUTE_WORDS = [
  "landslide", "flood", "road block", "road closed", "blocked", "bandh", "strike", "protest",
  "curfew", "diversion", "bridge",
];

/**
 * Keyword classifier. SAFETY always wins; a model proposal may upgrade a
 * class to SAFETY but can never downgrade a SAFETY match.
 */
export function classifyDisruption(text: string, modelProposal?: DisruptionClass): DisruptionClass {
  // Case-insensitive, typo-tolerant ("acident", "UNSAFE", "harrased"). Safety errs towards escalating.
  const t = text.toLowerCase();
  if (SAFETY_WORDS.some((w) => t.includes(w)) || SAFETY_EXACT.test(text) || containsFuzzy(text, SAFETY_WORDS.filter((w) => w.length >= 5)) || modelProposal === "SAFETY") return "SAFETY";
  if (ROUTE_WORDS.some((w) => t.includes(w)) || containsFuzzy(text, ROUTE_WORDS.filter((w) => w.length >= 5))) return "ROUTE_BLOCKED";
  return modelProposal ?? "LOGISTICAL";
}

// ---------- Obligation inference from Setu AA debits (spec §4.2) ----------
// Implementation decision (not specified in the design artifact): thresholds
// below are a deterministic baseline; the online model may later refine
// descriptions but cannot lower a classification.

const OBLIGATION_WORDS = ["rent", "emi", "loan", "fee", "fees", "tuition", "insurance", "premium", "sip", "school", "college"];

const normPayee = (n: string) =>
  n.toLowerCase().replace(/[0-9/#*-]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");

export function inferObligations(debits: Debit[], asOf = new Date()): Obligation[] {
  const groups = new Map<string, Debit[]>();
  for (const d of debits) {
    const k = normPayee(d.narration);
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const out: Obligation[] = [];
  for (const [payee, ds] of groups) {
    const months = new Set(ds.map((d) => d.date.slice(0, 7))).size;
    const amounts = ds.map((d) => d.amount);
    const max = Math.max(...amounts);
    const min = Math.min(...amounts);
    const stable = max - min <= 0.1 * max;
    const keyword = OBLIGATION_WORDS.some((w) => payee.split(" ").includes(w) || payee.includes(w));

    let classification: ObligationClassification | null = null;
    if (keyword && months >= 5 && stable) classification = "CONFIRMED";
    else if (months >= 5 && stable) classification = "INFERRED";
    else if (months >= 3 && (stable || keyword)) classification = "PROBABLE";
    else if (keyword || max >= 5000) classification = "UNCERTAIN";
    if (!classification) continue;

    const last = ds.map((d) => d.date).sort().at(-1)!;
    const day = Number(last.slice(8, 10));
    const due = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), day));
    if (due < asOf) due.setUTCMonth(due.getUTCMonth() + 1);

    out.push({
      id: id("OBL"),
      description: ds[ds.length - 1].narration,
      amount: max, // conservative: largest observed debit
      dueDate: due.toISOString().slice(0, 10),
      classification,
      // Uncertain money tightens the guard and is never treated as free (spec §4.2).
      protected: true,
      source: "SETU_AA",
    });
  }
  return out;
}

export function buildObligationMap(balance: number, obligations: Obligation[]): ObligationMap {
  const committedTotal = obligations.filter((o) => o.protected).reduce((s, o) => s + o.amount, 0);
  return {
    accountBalance: balance,
    obligations,
    committedTotal,
    freeBalance: Math.max(0, balance - committedTotal),
    refreshedAt: nowIso(),
  };
}

// ---------- Four checks (spec §9) ----------

export type CheckResult = { pass: boolean; code?: string; reason: string };

export function checkNecessary(incident: Incident, route: Route, tripDestination: string): CheckResult {
  if (incident.hasVerifiedWayHome)
    return { pass: false, code: "VERIFIED_WAY_HOME", reason: "Traveller already has a verified way home" };
  const reaches = route.to.toLowerCase() === tripDestination.toLowerCase();
  return reaches
    ? { pass: true, reason: "Option restores the route to the destination" }
    : { pass: false, code: "NOT_NECESSARY", reason: `Option ends at ${route.to}, not ${tripDestination}` };
}

export function checkAuthority(ledger: AuthorityLedger, amount: number): CheckResult {
  if (amount > ledger.remainingIncident)
    return { pass: false, code: "AUTHORITY_EXCEEDED", reason: `${inr(amount)} exceeds remaining incident authority ${inr(ledger.remainingIncident)}` };
  if (amount > ledger.remainingDaily)
    return { pass: false, code: "AUTHORITY_EXCEEDED", reason: `${inr(amount)} exceeds remaining daily ceiling ${inr(ledger.remainingDaily)}` };
  return { pass: true, reason: `Within authority (incident ${inr(ledger.remainingIncident)}, daily ${inr(ledger.remainingDaily)})` };
}

export function checkObligationSafe(map: ObligationMap, amount: number): CheckResult {
  return amount <= map.freeBalance
    ? { pass: true, reason: `${inr(amount)} fits in free balance ${inr(map.freeBalance)}` }
    : {
        pass: false,
        code: "OBLIGATION_BLOCKED",
        reason: `free balance after obligations is only ${inr(map.freeBalance)}; ${inr(map.committedTotal)} is committed`,
      };
}

export function checkSafety(cls: DisruptionClass | undefined): CheckResult {
  return cls === "SAFETY"
    ? { pass: false, code: "SAFETY_INVOLVED", reason: "Safety involved: autonomous execution stops, escalate" }
    : { pass: true, reason: "Not safety-critical" };
}

export function stopReasonFor(code: string | undefined): StopReason | undefined {
  switch (code) {
    case "AUTHORITY_EXCEEDED":
      return "AUTHORITY_EXHAUSTED";
    case "OBLIGATION_BLOCKED":
      return "OBLIGATION_AT_RISK";
    case "SAFETY_INVOLVED":
      return "SAFETY_INVOLVED";
    case "VERIFIED_WAY_HOME":
      return "VERIFIED_WAY_HOME";
    case "USER_REQUIRED":
      return "TRAVELLER_ACTION_REQUIRED";
    default:
      return undefined;
  }
}

// ---------- Vendor ladder (spec §13) ----------

export const VENDOR_LADDER: Route["vendorRung"][] = [
  "PINE_LABS_MERCHANT",
  "UPI_OPERATOR",
  "LOCAL_TRANSPORT",
  "LOGGED_CASH",
];

export type VendorProfile = {
  vendorId: string;
  identityVerified: boolean;
  rating: number;
  reviewCount: number;
  distanceFromQuotedPickupKm: number;
  quotedPrice: number;
  referenceFare: number;
  fraudFlags: string[];
};

// Implementation decision: thresholds are prototype defaults, tune with data.
export const VENDOR_THRESHOLDS = { minRating: 3.5, minReviews: 10, maxDistanceKm: 2, maxPriceMultiple: 1.5 };

export function verifyVendor(v: VendorProfile): CheckResult & { checks: Record<string, boolean> } {
  const checks = {
    identity: v.identityVerified,
    reviews: v.rating >= VENDOR_THRESHOLDS.minRating && v.reviewCount >= VENDOR_THRESHOLDS.minReviews,
    locationConsistency: v.distanceFromQuotedPickupKm <= VENDOR_THRESHOLDS.maxDistanceKm,
    quotedPrice: v.quotedPrice <= v.referenceFare * VENDOR_THRESHOLDS.maxPriceMultiple,
    fraudIndicators: v.fraudFlags.length === 0,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return failed.length
    ? { pass: false, code: "VENDOR_REJECTED", reason: `Vendor failed: ${failed.join(", ")}`, checks }
    : { pass: true, reason: "Vendor passed identity, reviews, location, price and fraud checks", checks };
}
