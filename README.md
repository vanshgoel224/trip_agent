# Biruni: Round 3 prototype

> Get the traveller home safe, with the trip they paid for and money they had already promised elsewhere untouched.

This is a working prototype of the Biruni agent for the KEN Case Competition, Round 3. It follows `Biruni_Round3_Implementation_Spec.md`. One orchestrator and six specialists handle disruptions on their own, inside a deterministic authority contract. They reach the outside world only through Biruni's own MCP server.

On top of the spec's recovery engine there is a conversational layer:
- a Grok-style chat UI with **separate chats per function** (general, recovery, translator, split expenses, discover, maps, calendar, budget)
- a tool-calling LLM (Gemini stand-in now, Nemotron when its key is set, Qwen offline)
- **long-term memory** stored as a knowledge graph in graphify's format
- voice translation across 23 Indian languages
- phone GPS and crash detection
- OpenStreetMap maps and directions
- Google Calendar, Reddit, YouTube and Splitwise connectors
- connecting **external MCP servers**

**Status, bluntly:** the recovery engine, guardrails, chats, memory, expense splitting, maps, translation (text) and the MCP client are tested and work. Live adapters for Gnani, Pine Labs, Setu AA, Zerodha, Google Calendar, Reddit, YouTube and Splitwise are written from each provider's official docs or SDK but **have not been run against real accounts**: no keys were available. Without keys, those rails run on the simulator. See [What is not built](#what-is-not-built).

## Quickstart

Requires Node ≥ 22.5. Persistence uses the built-in `node:sqlite`, which is still experimental in Node 22.

```bash
npm install
cp .env.example .env   # put GEMINI_API_KEY (or ONLINE_MODEL_API_KEY) in it; .env is git-ignored
npm test          # 31 tests: authority, payments, idempotency, recovery, restart, chats, memory, expenses, sensors
npm run demo      # CLI walkthrough of every scenario (short undo window)
npm start         # API + demo UI on http://localhost:8787 (30s undo window)
npm run models:check   # ping Nemotron (needs ONLINE_MODEL_API_KEY) and local Qwen/Ollama
```

In the UI:
- **＋ New chat** picks a function.
- **Trip ＋** creates your own trip (any cities).
- **Connections** shows what's live and runs the competition demo scenarios.
- **Memory graph** shows everything Biruni remembers.
- **Trip ▸** opens the status, map, undo button and agent activity panel.

Phone sensors (GPS, accelerometer, microphone) only work on `https://` or `localhost`. To use them from a phone, put the server behind an HTTPS tunnel.

## Architecture

```
Traveller (voice/text) → apps/web → apps/api ─┐
                                              ▼
                              services/orchestrator   (only conversational authority, holds L4 flag)
                                              │ routes to (AgentRun rows, restart up to 3×)
     ┌──────────┬──────────┬────────────┬─────┴────┬──────────┬──────────┐
  finance    recovery   compliance     voice     travel     booking      services/agents/*
     └──────────┴──────────┴────────────┴────┬─────┴──────────┴──────────┘
                                              ▼
                     services/mcp  auth → schema → finance → compliance → authority
                                   → idempotency → rail (safe retries) → normalize → audit
                                              ▼
              services/integrations  gnani · pine-labs · delhivery · setu-aa · zerodha
                                     (interface + Mock* + live stub each)
```

| Spec rule | Where it is enforced |
|---|---|
| Orchestrator is the only conversational authority and holds L4 | `services/orchestrator/index.ts`, `authority.ts` |
| Finance is the single writer of the obligation map and ledger | `packages/db` rejects writes to `obligations`, `authority_ledgers` and `transactions` without the one-time finance capability |
| ₹2,000 is cumulative per incident, and the daily ceiling is separate | `FinanceAgent.ledger()` derives both from append-only holds |
| Four checks before every action (§9) | `packages/policy` + MCP pipeline + `RecoveryAgent.run` |
| Every MCP call passes finance and compliance checks and is audited | `services/mcp/server.ts`. Blocked calls are audited too |
| Idempotency: `idempotency_key`, `incident_id`, `tool_call_id` | `tool_calls` table, MCP step 6, rail status reconciliation |
| 30s undo with compensation | `services/agents/recovery/undo.ts`, persisted and rehydrated on restart |
| Agents restart without hidden memory | recovery steps are checkpointed on the incident, and `AgentRouter` restarts from that checkpoint |
| Model proposes, policy decides | `services/models`: the model only proposes intent and disruption class. SAFETY can't be downgraded |
| Credentials only on the server | env is read in `services/integrations/*`; the browser only talks to `/api` |

### The 7 rail MCP tools (names are PROVISIONAL)

The design artifact fixes the count at seven but doesn't list canonical names (spec §6, §32). These are working names. **Lock them against the final architecture diagram before implementation freeze.** Each rename is a one-line change in `services/mcp/schemas`.

| Tool | Rail | Caller | Consequential |
|---|---|---|---|
| `voice_speak` | Gnani | voice | no |
| `route_search` | Delhivery (or offline cache) | travel | no |
| `vendor_verify` | vendor directory (simulated) | recovery | no |
| `payment_execute` (charge/refund/status) | Pine Labs | recovery | yes |
| `booking_execute` (book/cancel/verify) | booking inventory (simulated) | booking | yes |
| `financial_context` | Setu AA | finance | no |
| `holdings_context` | Zerodha (read-only, no sell method exists) | finance | no |

The server also has 3 **supporting tools**, which sit outside the spec's seven: `discovery_search` (Reddit and YouTube), `calendar_read` and `calendar_write`. They go through the same auth, compliance and audit pipeline.

Run them over real MCP stdio, for example with an MCP inspector: `BIRUNI_MCP_AGENT=recovery npm run mcp:stdio`.

The six specialist names (finance, recovery, compliance, voice, travel, booking) follow spec §4. The spec itself says the agent-to-rail mapping isn't final.

## Demo scenarios

| | Scenario | Expected and verified by tests |
|---|---|---|
| A | Successful recovery (₹1,200) | autonomous booking, audit trail, undo window, verification, itinerary v2, readback, ₹800 authority left |
| B | Authority exceeded (₹2,450) | blocked, traveller asked; on approval runs as a traveller-approved spend |
| C | Obligation protected (₹1,400 with ₹901 free after rent + EMI) | blocked even though it's within authority; traveller asked |
| D | Pine Labs times out after charging | rail status reconciled, exactly 1 charge, ledger matches |
| LADDER | Pine Labs and UPI decline | unverified local vendor skipped, verified local vendor booked |
| SAFETY | "accident… unsafe" | autonomy stops, 112 prompt, emergency contact alerted only after a "yes" (traveller hasn't opted in) |
| OFFLINE | no network | options come from the pre-fetched cache, only logged cash can execute, device TTS relay |
| RESTART | recovery agent crashes after paying | restarts from checkpoint, payment returns `ALREADY_COMPLETED`, no second charge |

All fares, balances and vendors are **simulated and fictional**. They aren't real market prices.

## Models

```bash
export ONLINE_MODEL_API_KEY=nvapi-...      # NVIDIA key; never commit it
# or, as a temporary stand-in for Nemotron (not in the Biruni design):
export GEMINI_API_KEY=...                  # optional GEMINI_MODEL=<id> to pin a model
```

Tested with a real Gemini key: auto-pick chose `gemini-3.5-flash-lite` (~0.6s per call). It
correctly read Hinglish messages that the keyword rules miss, e.g. "gaadi beech raste mein kharab ho
gayi" → disruption, and "koi mera peecha kar raha hai" → SAFETY. Full `gemini-3.8-flash` took 3–28s
and returned 503 "high demand" during testing, so it is not the default.

```bash
ollama pull qwen3:4b && ollama serve       # on the phone/laptop, for the offline model
npm run models:check
```

## Conversational layer

| Chat | What it does | Notable tools |
|---|---|---|
| General | anything; also gets tools from external MCP servers | all below |
| Recovery | disruptions, approvals, undo | `report_disruption`, `approve_pending`, `undo_last_action` |
| Translator | translates only the latest message into the chosen language, with pronunciation; **Speak & translate** button for voice → voice | `speak` |
| Split expenses | Splitwise-style group expenses, balances, fewest transfers to settle | `add_expense`, `get_balances`, `settle_up`, `splitwise_push` |
| Discover | lesser-known places from Reddit and YouTube | `discover_places` |
| Maps | live location, nearby ATMs, hospitals and police, turn-by-turn directions drawn on the map | `where_am_i`, `nearby_places`, `directions` |
| Calendar | read and add Google Calendar events | `calendar_list_events`, `calendar_add_event` |
| Budget | authority left, free balance after protected obligations | `get_budget` |

Guardrails that stay deterministic even with an LLM in the loop:
- Safety words escalate **before** any model is asked, in every chat.
- `approve_pending` only works if the traveller's own latest message is an explicit yes.
- Money only moves through the recovery agent and the MCP guards.
- Expense recording refuses an identical expense within 10 minutes unless the traveller confirms it.
- Each chat only sees its own tools.
- External MCP tools never get money or approval powers, and their output is treated as untrusted data.

**Memory** lives in `memory_nodes` and `memory_links` and is exported (`/api/memory/graph`, or "Export" writes `memory-out/graph.json` and `GRAPH_REPORT.md`) in graphify's networkx node-link format: `nodes`, `links` with `relation`, `confidence` and `source_file`, `hyperedges` and communities. Repeating a fact strengthens its edge. Relevant facts are recalled into every chat.

**Voice translation:** speech-to-text, then LLM translation, then text-to-speech. With `GNANI_API_KEY`, Gnani handles speech in and out for 10 languages (en, hi, bn, ta, te, kn, ml, mr, gu, pa). The other 13 (Odia, Assamese, Urdu, Konkani and others) get text translation plus whatever speech voices the phone's browser has. Speech quality for those depends on the device, not on Biruni.

**Crash detection** is a heuristic, not a certified safety system. When the phone reports at least 3.5 g followed by stillness, Biruni asks "Are you OK?". With no answer in 30 seconds, it escalates through the normal SAFETY policy. That means 112 guidance, and the emergency contact is alerted only if the traveller opted in; otherwise Biruni asks first.

**External MCP servers:** add any HTTP MCP server in Connections. stdio servers, which run a local command, are only allowed through the server-side `BIRUNI_MCP_SERVERS` env. Letting a web page start commands would be a remote-code-execution hole. Delhivery Maps' own MCP server auto-connects when `DELHIVERY_MAPS_TOKEN` is set.

## Live rails: what each adapter does

| Rail | Source of the contract | Live behaviour | Verified with a real key? |
|---|---|---|---|
| Gnani | official `gnani-vachana` SDK 0.7.9 (`/api/v1/tts/inference`, `/stt/v3`, `X-API-Key-ID`) | real TTS audio and STT | **No** |
| Pine Labs | pinelabs.com Plural API docs | a charge becomes a **payment link the traveller must complete**; status by merchant reference; refunds | **No** |
| Setu AA | docs.setu.co FIU APIs | consent, then data session, then 6 months of debits | **No**; token acquisition isn't covered in the docs I read, so set `SETU_ACCESS_TOKEN` |
| Zerodha | kite.trade Kite Connect v3 docs | daily login flow, read-only holdings | **No** |
| Delhivery | delhivery.com/maps/developer | Maps MCP server (geocode, route). There's no transport inventory API, so bus and train alternatives stay simulated | **No**; Bearer auth assumed |
| Google Calendar | Google OAuth and Calendar v3 | OAuth read and write, or ICS read-only | **No** |
| Reddit / YouTube / Splitwise | public API docs | search, search, sync | **No** (Reddit anonymous is blocked from cloud IPs) |
| Gemini (stand-in LLM) | Google OpenAI-compatible endpoint | tool calling | **Yes** |
| OpenStreetMap | Nominatim, OSRM | geocoding, reverse geocoding, nearby, directions | **Yes** (Overpass timed out from the sandbox; falls back to Nominatim) |

Pine Labs note: a payment gateway can't silently debit a traveller. Autonomous recovery spending, which is the ₹2,000 L4 contract, needs a pre-authorised mandate arrangement with Pine Labs (the "Grantex authority" the design mentions). That isn't built. Live charges currently stop and hand the traveller a payment link.

## Implementation decisions the spec leaves open

These are my calls. Review them before freeze.

- **Obligation inference thresholds:** keyword plus ≥5 stable months gives CONFIRMED; ≥5 stable months gives INFERRED; ≥3 months gives PROBABLE; a keyword or ≥₹5,000 gives UNCERTAIN. **All four classes are protected.** The spec says uncertain money is never free. Holdings are never counted.
- **Undo restores authority:** a refunded spend gives the ₹ back to both the incident and daily authority.
- **Traveller-approved spends** (after B or C) bypass the autonomous ₹2,000 and daily checks and don't consume them. An obligation override happens only when the traveller approved that specific obligation warning. Both are audited with the approval id.
- **Readbacks:** one voice notice when the action executes (with the undo prompt), then the final readback after verification. This reconciles spec §14 with §21.
- **Vendor checks:** minimum rating 3.5, at least 10 reviews, pickup within 2 km, quote no more than 1.5× the reference fare, and no fraud flags. Required for the `LOCAL_TRANSPORT` rung.
- **Offline:** only `LOGGED_CASH` can execute, and voice falls back to device TTS.

## What is not built

- **No live rail has been exercised with a real account.** See the table above. Expect field-name fixes the first time each one runs.
- **No autonomous Pine Labs debit.** Live charges become payment links (see above).
- **No transport booking API.** Alternatives and PNRs are simulated for every city pair.
- **The Qwen offline model isn't on a phone.** It's reached through a local Ollama server, which can't be reached from the cloud container. `apps/phone-offline/` is the older Python offline agent, not integrated.
- **Not in the UI:** Setu consent creation exists only as an API endpoint (`POST /api/aa/consent`).
- **Free Gemini quota is small.** Bursts hit HTTP 429; Biruni retries once, then answers from the tool results.
- **No user authentication on `/api`.** It's single-user; add auth before exposing it anywhere.
- **Group-leader policy, Redis, Postgres runtime.** The Prisma schema is valid, but the app runs on SQLite.
- `graphify-out/` describes the old Python layout and is stale.

## Layout

```
apps/web               Grok-style chat UI (vanilla JS, Leaflet map, SSE activity, sensors, mic/WAV recorder)
apps/api               HTTP API, spec §23 endpoints + /api/scenarios, /api/events
apps/phone-offline     previous offline Python agent (see its README)
services/orchestrator  planner, router (restartable AgentRuns), state-machine, authority (L4)
services/agents/*      finance, recovery (+ undo), compliance, voice, travel, booking
services/mcp           server pipeline, tools, middleware, zod schemas, stdio entry
services/integrations  five rails (mock + live stub), simulator, scenarios
services/models        model router (online/offline/rules) + tool-calling chat
services/conversation.ts  chat entry point + voice translation pipeline
services/orchestrator/chat-agent.ts, chats.ts   LLM agent and per-function chats
services/memory        graph memory (graphify format)
services/devices       GPS + crash-detection check-ins
services/mcp-client    connect external MCP servers
services/integrations/{openstreetmap,google-calendar,reddit,youtube}   connectors
services/agents/expenses  Splitwise-style splitting
packages/*             domain types, db, policy, events, shared
prisma/schema.prisma   production schema
tests/*                node:test suites + scenarios/run-demo.ts
```
