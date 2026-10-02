# Biruni: Round 3 prototype

> Get the traveller home safe, with the trip they paid for and money they had already promised elsewhere untouched.

This is a working prototype of the Biruni agent for the KEN Case Competition, Round 3. It follows `Biruni_Round3_Implementation_Spec.md`. One orchestrator and six specialists handle disruptions on their own, inside a deterministic authority contract. They reach the outside world only through Biruni's own MCP server.

On top of the spec's recovery engine there is a conversational layer:
- a Grok-style chat UI with **separate chats per function** (general, recovery, translator, split expenses, discover, maps, calendar, budget)
- a tool-calling LLM (Gemini stand-in now, Nemotron when its key is set, Qwen offline)
- **long-term memory** stored as a knowledge graph in graphify's format
- voice translation across 23 Indian languages
- phone GPS and crash detection
- OpenStreetMap data on a MapLibre map, with directions
- Google Calendar, Reddit, YouTube and Splitwise connectors
- connecting **external MCP servers**
- an **L4 autopilot** that acts on its own, inside the ₹2,000 authority
- a **self-check** pass before replies go out
- feedback collection
- typo-tolerant matching everywhere
- Delhivery parcel/luggage **booking** (simulated until a key is added)
- light and dark themes, with an emoji and name for every chat

**Status, bluntly (as of the latest commit):** the recovery engine, guardrails, chats, memory, expense splitting, maps, translation (text) and the MCP client are tested and work. Live adapters for Gnani, Pine Labs, Setu AA, Zerodha, Google Calendar, Reddit, YouTube and Splitwise are written from each provider's official docs or SDK but **have not been run against real accounts**: no keys were available. Without keys, those rails run on the simulator, and voice uses the device's built-in voices. Delhivery bookings are simulated until a key is added. See [What is not built](#what-is-not-built).

## Quickstart

Requires Node ≥ 22.5. Persistence uses the built-in `node:sqlite`, which is still experimental in Node 22.

```bash
npm install
cp .env.example .env   # set GEMINI_API_KEY (or ONLINE_MODEL_API_KEY) and BIRUNI_INITIAL_PIN; .env is git-ignored
npm test          # 60 tests: authority, payments, idempotency, recovery, restart, chats, memory, expenses, sensors
npm run demo      # CLI walkthrough of every scenario (short undo window)
npm start         # API + UI on http://localhost:8787 — starts LOCKED; enter your PIN
npm run models:check   # ping Nemotron (needs ONLINE_MODEL_API_KEY) and local Qwen/Ollama
```

In the UI:
- **＋ New chat** (sidebar or top bar, or Ctrl/Cmd+Shift+O) picks a function, or **✎ Custom chat…** where you write the instructions and pick which tool groups it may use. Double-click a chat title to rename it.
- **General auto-files:** a General message that turns into an expense, disruption, map query, plan, translation and so on is also copied, with its reply, into that function's chat. The chat is created if needed.
- **Commands** (no model call, except `/btw`):
  - `/recall <name>` instantly answers from memory.
  - `/forget <thing>` deletes it from memory.
  - `/btw <question>` asks a side question that's answered with read-only tools and **never saved**: no chat history, no memory, no auto-filing.
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

## Security: PIN lock and encryption at rest

- **Every stored record** (chats, memory, trips, deals, payments, feedback and the rest) is encrypted with AES-256-GCM. The key is derived from your PIN with scrypt (N=2^17, about 0.3 s per attempt) and lives only in RAM. The PIN is never stored.
- **Opaque IDs:** the database's row ids and index columns are opaque. Memory ids are hashes, so they can't leak content.
- **Boots locked:** the server starts locked, and the runtime, autopilot and MCP connections don't load until the PIN is entered.
- **First run:** you set a PIN in the app, or it's taken from `BIRUNI_INITIAL_PIN` in your local `.env`. Any existing plaintext data is encrypted at that point.
- **Sessions:** every API call and the live event stream need an unlock session. That's an HttpOnly, SameSite=Strict cookie that expires after 30 idle minutes (`LOCK_IDLE_MIN`).
- **🔒 Lock** locks the screen. Connections → **Change PIN** re-encrypts everything in a single transaction.
- **No lockout after wrong PINs** (your choice).

Limits, bluntly:
- A 4-digit PIN has 10,000 combinations. With a copy of the database file, an attacker can try them all offline in under an hour despite scrypt. Use 6 or more digits, or a password, if the file could be stolen.
- While unlocked, the key is in the server's memory; locking the screen doesn't remove it, which is what lets the autopilot keep running. Only a server restart does.
- `.env` (API keys) and exported `memory-out/` files are **not** encrypted.

## Negotiator: hotels, taxis, autos

The 🤝 chat negotiates and books for you in the other person's language: Tamil, Kannada, Hindi, Konkani and others.
- **You set** the target price and a **maximum**. Biruni opens below the target and concedes on a fixed, deterministic schedule. It accepts automatically only within your max, takes a stated "final price" if that's within your max, and walks away politely above it. The model only reads the other person's message (price, yes/no, "final") and phrases the next line. It can never choose a price.
- **It understands** prices in Indic digits (१२००, ௧௨௦௦, ೫೦೦), "1.5k", and numbers written as words (e.g. இரண்டாயிரத்து இருநூறு = 2,200; tested live).
- **Hotels** go negotiate → agree → confirm the details → **recorded** in trip plans, memory and Google Calendar if connected. Taxis and autos are recorded on agreement.
- **Channels:**
  - **Relay** works today: the line to say is shown in their script with pronunciation, 🔊 speaks it in their language, and 🎤 captures their reply.
  - **WhatsApp Business Cloud API** works with `WHATSAPP_*` keys. The inbound webhook verifies Meta's signature. WhatsApp's 24-hour rule means first contact needs an approved template.
  - **Phone calls and SMS** need a telephony provider (Exotel, Twilio or a Gnani voice bot). They report "not connected" rather than pretending.
- **Biruni never pays in a negotiation**; you pay the person directly.

## Model fallback chain

Each reply tries these in order:
1. **Online model:** Nemotron, or Gemini as the stand-in.
2. **Local Qwen** through Ollama, if it answers a 0.8 s health check.
3. **Deterministic rules**, which still handle disruptions, undo, approvals and status.

If the online model fails mid-turn (a quota hit, say), local Qwen continues *the same turn*. `MODEL_PRIMARY=local` puts Qwen first. Local Qwen only works when Biruni runs on your own machine with `ollama serve` and `ollama pull qwen3:4b` (check that tag exists in Ollama's library); this cloud container can't reach it.

## L4 autopilot and critical thinking

**Autopilot (on by default per trip; toggle it in the Trip panel).** Every 60 seconds (`AUTOPILOT_TICK_MS`) Biruni reviews each active trip *without being asked*:

| Signal | What it decides | Why |
|---|---|---|
| Operator says CANCELLED (trusted feed) | **ACT**: autonomous recovery, then booking within ₹2,000 with a 30 s undo, or it stops and asks | the L4 contract |
| Same, but from an unconfirmed source | **WAIT** until a second independent report | don't spend money on a rumour |
| Delay under 180 min | **NOTIFY** and keep watching | least-invasive action |
| Delay of 180 min or more | **ACT** (recovery) | likely to miss the trip |
| Signal for a leg that left over 3 h ago | **IGNORE** | stale |
| GPS, OSRM travel time and a 30 min buffer exceed the time left | **NOTIFY**: "Leave now" | |
| Departure within 3 h | **NOTIFY**: reminder | |
| Recovery finished | **ASK** for a vendor rating | ratings feed the vendor ladder |

Every decision is logged with what it considered and why, and shown in the Trip panel. All money still goes through recovery and the MCP guards.

The operator feed is **simulated**: Connections → "Autopilot demo" pushes cancel and delay events. A real operator, IRCTC or bus-aggregator status API would plug into `Autopilot.operatorEvent`.

**Critical thinking in chats:**
- The system prompt makes the model:
  - clarify only when a wrong guess would cost money, time or safety
  - check facts with tools and flag contradictions
  - weigh at least two options on cost, time, safety and obligations
  - plan multi-step tasks (`make_plan` / `update_plan`, up to 12 steps)
  - verify outcomes and report uncertainty
- **Self-check:** before a reply that involves money, bookings, numbers or directions goes out, a second model call compares the draft against the tool results. It fixes invented or contradicted details, marking the reply "self-checked" or "self-corrected". `CRITIC=off` disables it, which saves free-tier quota.
- **Consent guard:** booking and approval tools only work if the traveller's own latest message is an explicit yes with no hedging. "book it? not yet", "yes but wait" and "abhi nahi" are all refused.

## Feedback

- 👍/👎 on every reply; 👎 asks what was wrong.
- After a recovery, rate the vendor 1–5★. **Vendor ratings update that vendor's score**, so a badly rated operator falls below the ladder's 3.5★ bar and stops being used.
- In any chat, saying "the bus was awful, 2/5" is recorded through `record_feedback`.
- "💬 Send feedback" in the sidebar takes product feedback.
- Connections shows a summary; export everything from `/api/feedback.csv`.

## Typo-tolerant matching

Matching works like a search engine:
- case-insensitive and accent-insensitive
- tolerates typos (Damerau-Levenshtein, transpositions count as 1)
- matches as you type (prefixes) and in any word order
- very short words must match exactly, to avoid false hits

It's used for:
- **slash commands:** `/Recal`, `/FORGT`, `/ BTW`
- **memory:** recall, dedup ("Rahul" = "rahul" = "Raahul"), and `/forget`, which needs a strong match
- **people's names in expenses**
- **disruption and safety keywords:** "ACIDENT", "cancled", "delayd"
- **language names:** "tamill" → ta-IN
- **chat search** over titles and messages
- **place search:** Photon, a typo-tolerant OpenStreetMap geocoder ("fort agauda" → Fort Aguada), then Nominatim

## Delhivery parcels and luggage

The 📦 chat walks through: quote (surface or express, price and ETA), then details, then booking **only after an explicit yes**, then an AWB, tracking stages, and cancelling before pickup. Without `DELHIVERY_API_KEY` and `DELHIVERY_PICKUP_LOCATION`, every booking is **simulated** and says so. With them, Biruni also files a real pickup request to Delhivery's documented `/fm/request/new/` endpoint; the auth header format is assumed, so verify it in Delhivery One. Creating a real waybill isn't implemented, because its request format isn't public. The tariff is simulated, not Delhivery's rate card.

## Conversational layer

| Chat | What it does | Notable tools |
|---|---|---|
| General | anything; also gets tools from external MCP servers | all below |
| Recovery | disruptions, approvals, undo | `report_disruption`, `approve_pending`, `undo_last_action` |
| Translator | translates only the latest message into the chosen language, with pronunciation; **Speak & translate** button for voice → voice | `speak` |
| Split expenses | Splitwise-style group expenses, balances, fewest transfers to settle | `add_expense`, `get_balances`, `settle_up`, `splitwise_push` |
| Discover | lesser-known places from Reddit and YouTube | `discover_places` |
| Maps | live location, nearby ATMs, hospitals and police (and **vegetarian** places, using OSM's `diet:vegetarian` tag), turn-by-turn directions drawn on a MapLibre map | `where_am_i`, `nearby_places`, `directions` |
| Custom | your own instructions plus the tool groups you tick | chosen per chat |
| 📦 Send parcel | Delhivery quote, book, track, cancel | `delivery_quote`, `delivery_book`, `delivery_track` |

Every chat has an **emoji and a name**: ✎ in the top bar or a double-click on the title opens the editor. The ◐/☀/☾ button switches between system, light and dark themes.
| Calendar | read and add Google Calendar events | `calendar_list_events`, `calendar_add_event` |
| Budget | authority left, free balance after protected obligations | `get_budget` |

Guardrails that stay deterministic even with an LLM in the loop:
- Safety words escalate **before** any model is asked, in every chat.
- `approve_pending` only works if the traveller's own latest message is an explicit yes.
- Money only moves through the recovery agent and the MCP guards.
- Expense recording refuses an identical expense within 10 minutes unless the traveller confirms it.
- Each chat only sees its own tools.
- External MCP tools never get money or approval powers, and their output is treated as untrusted data.

**Memory hygiene:** facts that are too short, too long or vague ("it is something") are rejected before they're stored. Use `/btw` for throwaway questions, and `/forget` to remove anything wrong. The Memory graph window has a quick-recall search that highlights matching nodes.

**Memory** lives in `memory_nodes` and `memory_links` and is exported (`/api/memory/graph`, or "Export" writes `memory-out/graph.json` and `GRAPH_REPORT.md`) in graphify's networkx node-link format: `nodes`, `links` with `relation`, `confidence` and `source_file`, `hyperedges` and communities. Repeating a fact strengthens its edge. Relevant facts are recalled into every chat.

**Voice translation:** speech-to-text, then LLM translation, then text-to-speech. **Right now it uses the device's built-in voices** (browser speech recognition and synthesis). The sidebar "Voice" picker marks languages your device can speak with 🔈. With `GNANI_API_KEY`, Gnani handles speech in and out for 10 languages (en, hi, bn, ta, te, kn, ml, mr, gu, pa). The other 13 (Odia, Assamese, Urdu, Konkani and others) get text translation plus whatever speech voices the phone's browser has. Speech quality for those depends on the device, not on Biruni.

**Crash detection** is a heuristic, not a certified safety system. When the phone reports at least 3.5 g followed by stillness, Biruni asks "Are you OK?". With no answer in 30 seconds, it escalates through the normal SAFETY policy. That means 112 guidance, and the emergency contact is alerted only if the traveller opted in; otherwise Biruni asks first.

**External MCP servers:** add any HTTP MCP server in Connections. stdio servers, which run a local command, are only allowed through the server-side `BIRUNI_MCP_SERVERS` env. Letting a web page start commands would be a remote-code-execution hole.

**Maps:** MapLibre GL shows OpenStreetMap data through OpenFreeMap's free vector style, falling back to standard OSM raster tiles. Search, nearby places and directions use Nominatim, Overpass and OSRM. No keys are needed. These are free community services with fair-use limits, so self-host them or pay a provider before real traffic.

## Live rails: what each adapter does

| Rail | Source of the contract | Live behaviour | Verified with a real key? |
|---|---|---|---|
| Gnani | official `gnani-vachana` SDK 0.7.9 (`/api/v1/tts/inference`, `/stt/v3`, `X-API-Key-ID`) | real TTS audio and STT | **No** |
| Pine Labs | pinelabs.com Plural API docs | a charge becomes a **payment link the traveller must complete**; status by merchant reference; refunds | **No** |
| Setu AA | docs.setu.co FIU APIs | consent, then data session, then 6 months of debits | **No**; token acquisition isn't covered in the docs I read, so set `SETU_ACCESS_TOKEN` |
| Zerodha | kite.trade Kite Connect v3 docs | daily login flow, read-only holdings | **No** |
| Delhivery | delhivery-express-api-doc (pickup request) | parcel/luggage booking: simulated end to end without a key; with a key it also files a real pickup request (auth format assumed). Maps use OpenStreetMap, not Delhivery | **No** |
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

## What is not built (once you add keys, these remain)

| Gap | Why | What closes it |
|---|---|---|
| Live rails never run against real accounts | no keys during development | run each with its key; expect field-name fixes |
| Pine Labs can't debit you autonomously | gateways need a mandate or pre-auth | a Pine Labs mandate product (the design's "Grantex authority") |
| No real bus/train/flight inventory or booking | no API wired; alternatives and PNRs are simulated | an aggregator API (bus, IRCTC or flight partner) |
| Delhivery waybill/shipment creation | request format isn't public | Delhivery One developer portal access |
| Phone calls and SMS for the negotiator | needs a telephony provider | Exotel, Twilio, or a Gnani voice-bot account |
| WhatsApp cold outreach | WhatsApp's 24-hour rule | an approved message template |
| Operator status feed for the autopilot | simulated | a real operator, IRCTC or bus-aggregator status API |
| On-phone Qwen 4B | runs through Ollama on a computer, not inside the phone app | a native mobile build (llama.cpp or MLC) |
| Native phone app | it's a web app; phone sensors need HTTPS | a PWA served over HTTPS, or Capacitor/React Native |
| Multi-user, accounts, cloud sync | single user, one SQLite file | auth plus Postgres (the Prisma schema exists) |
| Translation quality in low-resource languages | depends on the model | a native-speaker review, and a stronger model for those languages |
| Crash detection | a heuristic | proper validation on real devices |
| `graphify-out/` | describes the old Python code | rerun graphify |

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
