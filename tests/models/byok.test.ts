import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { setup } from "../helpers";
import { endpointChain, chatWithTools, withModels, type ChatMessage } from "../../services/models";
import { ModelSettings } from "../../services/models/settings";
import { Store } from "../../packages/db";
import { makeCipher } from "../../packages/db/vault";
import { randomBytes } from "node:crypto";

// One fake server playing three roles: OpenAI-compatible (/v1), Anthropic Messages (/anthropic/v1/messages), Hermes (/hermes/v1).
const seen: { path: string; body: any; auth?: string }[] = [];
let anthropicReplies: any[] = [];
const fake: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    const path = req.url ?? "";
    const json = (code: number, j: unknown) => (res.writeHead(code, { "content-type": "application/json" }), res.end(JSON.stringify(j)));
    if (req.method === "GET") return json(200, { data: [{ id: "m1" }, { id: "m2" }] });
    const j = body ? JSON.parse(body) : {};
    seen.push({ path, body: j, auth: String(req.headers.authorization ?? req.headers["x-api-key"] ?? "") });
    if (path.includes("/down/")) return json(500, { error: "down" });
    if (path.includes("/anthropic/")) {
      const r = anthropicReplies.shift() ?? { stop_reason: "end_turn", content: [{ type: "text", text: "Claude says hi" }] };
      return json(200, { id: "msg_1", type: "message", role: "assistant", model: j.model, usage: { input_tokens: 1, output_tokens: 1 }, stop_sequence: null, ...r });
    }
    json(200, { choices: [{ message: { role: "assistant", content: path.includes("/hermes/") ? "Hermes text" : "OpenAI text" } }] });
  });
});
const ready = new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
after(() => fake.close());
const base = async () => (await ready, `http://127.0.0.1:${(fake.address() as any).port}`);

test("BYOK chain follows the user's priority order, skips keyless/disabled rows and unreachable local models", async () => {
  const u = await base();
  const chain = await withModels(
    [
      { id: "a", provider: "deepseek", apiKey: "", model: "deepseek-chat" }, // no key → skipped
      { id: "b", provider: "anthropic", apiKey: "sk-ant-x", baseUrl: `${u}/anthropic`, model: "claude-opus-5-5" },
      { id: "c", provider: "nvidia", apiKey: "nv", baseUrl: `${u}/v1`, enabled: false }, // disabled
      { id: "d", provider: "ollama", baseUrl: "http://127.0.0.1:1/v1", model: "qwen3:4b" }, // unreachable
      { id: "e", provider: "hermes", apiKey: "hk", baseUrl: `${u}/hermes/v1`, model: "hermes-agent" },
    ],
    () => endpointChain(true),
  );
  assert.deepEqual(chain.map((e) => [e.provider, e.tier, e.tools]), [["anthropic", "online", true], ["hermes", "local", false]]);
  const offline = await withModels([{ id: "b", provider: "anthropic", apiKey: "k" }, { id: "e", provider: "hermes", baseUrl: `${u}/hermes/v1` }], () => endpointChain(false));
  assert.deepEqual(offline.map((e) => e.provider), ["hermes"], "offline: only local models");
});

test("Anthropic adapter: tools converted, tool results batched into one user turn, raw blocks echoed back", async () => {
  const u = await base();
  const ep = { provider: "anthropic" as const, apiKey: "sk-ant-x", baseUrl: `${u}/anthropic`, model: "claude-opus-5-5", tools: true };
  anthropicReplies = [{ stop_reason: "tool_use", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "tool_use", id: "tu_1", name: "trip_status", input: { a: 1 } }, { type: "tool_use", id: "tu_2", name: "recall", input: {} }] }];
  const tools = [{ type: "function" as const, function: { name: "trip_status", description: "d", parameters: { type: "object", properties: {} } } }];
  const msgs: ChatMessage[] = [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }];
  const m1 = await chatWithTools(ep, msgs, tools, 5000);
  assert.deepEqual(m1.tool_calls?.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)]), [["tu_1", "trip_status", { a: 1 }], ["tu_2", "recall", {}]]);
  let req = seen.at(-1)!;
  assert.equal(req.body.system, "SYS");
  assert.equal(req.body.tools[0].name, "trip_status");
  assert.equal(req.body.output_config.effort, "medium");
  assert.ok(!("tool_choice" in req.body));
  msgs.push(m1, { role: "tool", tool_call_id: "tu_1", content: "ok1" }, { role: "tool", tool_call_id: "tu_2", content: "ok2" });
  const m2 = await chatWithTools(ep, msgs, tools, 5000);
  assert.equal(m2.content, "Claude says hi");
  req = seen.at(-1)!;
  assert.equal(req.body.messages.length, 3, "user, assistant, ONE user with both tool_results");
  assert.equal(req.body.messages[1].content[0].type, "thinking", "thinking block echoed unchanged");
  assert.deepEqual(req.body.messages[2].content.map((b: any) => b.tool_use_id), ["tu_1", "tu_2"]);
});

test("tool-less endpoint (Hermes): no tools sent, earlier tool turns flattened, Anthropic blocks stripped", async () => {
  const u = await base();
  const ep = { provider: "hermes" as const, apiKey: "hk", baseUrl: `${u}/hermes/v1`, model: "hermes-agent", tools: false };
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "trip_status", arguments: "{}" } }], _anthropic: [{ type: "text" }] },
    { role: "tool", tool_call_id: "x", content: "BOOKED" },
  ];
  const r = await chatWithTools(ep, msgs, [{ type: "function", function: { name: "t", description: "", parameters: {} } }], 5000);
  assert.equal(r.content, "Hermes text");
  const req = seen.at(-1)!;
  assert.ok(!("tools" in req.body));
  assert.equal(req.auth, "Bearer hk");
  assert.ok(req.body.messages.every((m: any) => m.role !== "tool" && !m.tool_calls && !m._anthropic));
});

test("Hermes-only: chat answers in text, but trip actions go to deterministic rules (never to a tool-less model)", async () => {
  const u = await base();
  const { b, tripId } = await setup("A");
  b.modelSettings.save([{ provider: "hermes", apiKey: "hk", baseUrl: `${u}/hermes/v1`, model: "hermes-agent" }]);
  const chat = b.conversation.newChat("general", tripId);
  const r1 = await b.modelSettings.run(() => b.conversation.send(chat.chatId, "what is a good snack in Goa?"));
  assert.equal(r1.message.text, "Hermes text");
  assert.match(r1.source, /OFFLINE_MODEL:hermes-agent/);
  assert.match(seen.at(-1)!.body.messages[0].content, /no tools/);
  const r2 = await b.modelSettings.run(() => b.conversation.send(chat.chatId, "my bus got cancelled"));
  assert.equal(r2.source, "RULES");
  b.shutdown();
});

test("model settings: keys encrypted at rest, masked in the view, kept when the UI sends the mask back", () => {
  const s = new Store(":memory:", makeCipher(randomBytes(32)));
  const ms = new ModelSettings(s);
  const [row] = ms.save([{ provider: "gemini", apiKey: "AQ.secret-key-1234" }]);
  assert.equal(ms.view()[0].apiKey, "••••1234");
  ms.save([{ id: row.id, provider: "gemini", apiKey: "••••1234", model: "gemini-x" }]);
  assert.equal(ms.list()[0].apiKey, "AQ.secret-key-1234");
  assert.equal(ms.list()[0].model, "gemini-x");
  const raw = JSON.stringify((s as any).db.prepare("SELECT * FROM settings").all());
  assert.ok(!raw.includes("secret-key"), "no plaintext key in the database");
  assert.throws(() => ms.save([{ provider: "evil" as any }]), /unknown provider/);
  assert.throws(() => ms.save([{ provider: "custom", baseUrl: "file:///etc/passwd" }]), /http/);
});

test("fallback: first BYOK provider down → next one answers the same turn", async () => {
  const u = await base();
  const { b, tripId } = await setup("A");
  b.modelSettings.save([
    { provider: "custom", apiKey: "x", baseUrl: `${u}/down/v1`, model: "m" },
    { provider: "anthropic", apiKey: "sk-ant", baseUrl: `${u}/anthropic`, model: "claude-sonnet-5-5" },
  ]);
  anthropicReplies = [];
  const chat = b.conversation.newChat("general", tripId);
  const r = await b.modelSettings.run(() => b.conversation.send(chat.chatId, "hello"));
  assert.equal(r.message.text, "Claude says hi");
  assert.match(r.source, /claude-sonnet-5-5 \(fallback\)/);
  b.shutdown();
});
