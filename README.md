# Biruni

> Get the traveller home safe, with the trip they paid for and money they had already promised elsewhere untouched.

Biruni is a travel-recovery agent for India, built as the working prototype for the KEN Case Competition, Round 3 (spec: `Biruni_Round3_Implementation_Spec.md`). When a train is cancelled, a bus breaks down or a flight slips, Biruni re-plans and can rebook **on its own within ₹2,000 per incident**, with a 30-second undo. Anything above that, or anything that would touch rent, EMIs or other committed money, needs your yes. Around that core there is a chat app with a function-specific chat for each job, maps, translation in 23 Indian languages, expense splitting, booking, negotiation, SOS, drop detection and encrypted multi-user accounts. It ships as a web app, a PWA, an Android APK, a Docker image and an MCP server.

**Status (commit on `claude/festive-cori-29p0o8`):**

| Area | State |
|---|---|
| Recovery engine, guardrails, authority, undo, idempotency | built and tested (102 unit/integration tests + 4 e2e suites) |
| Chats, memory, expenses, maps, text translation, MCP client/server | built and tested |
| AI agent with a real Gemini key | live check passes 31/31 and the adversarial check passes 11/11 (median reply 2.4 s) |
| Load | 40 concurrent users, 0 errors, p95 < 140 ms |
| Live partner rails: Gnani, Pine Labs, Setu AA, Zerodha, Delhivery, Exotel, Calendar, Reddit, YouTube, Splitwise, WhatsApp | written from official docs/SDKs, **never run against real accounts** (no keys). They run on the simulator until keys are added |
| TBO / Agoda / EaseMyTrip | **slots only.** Their APIs need partner onboarding; the simulator serves bookings |

All fares, balances and vendors in simulator mode are **fictional**, not market prices. See [Honest gaps](#honest-gaps).

---

## Contents

1. [Quickstart](#quickstart)
2. [Using the app](#using-the-app)
3. [How recovery works](#how-recovery-works)
4. [AI models and speed](#ai-models-and-speed)
5. [Accounts, encryption and shared trips](#accounts-encryption-and-shared-trips)
6. [Safety: SOS, drop and crash watch](#safety-sos-drop-and-crash-watch)
7. [Features by chat](#features-by-chat)
8. [Booking, operator feed, telephony, negotiation](#booking-operator-feed-telephony-negotiation)
9. [Phone app and permissions](#phone-app-and-permissions)
10. [Hosting and remote MCP](#hosting-and-remote-mcp)
11. [Testing and CI/CD](#testing-and-cicd)
12. [Configuration](#configuration)
13. [Live rails](#live-rails)
14. [Design decisions](#design-decisions)
15. [Honest gaps](#honest-gaps)
16. [Layout](#layout)
17. [Legal](#legal)

---

## Quickstart

You need Node 22.5 or newer. Data is stored with the built-in `node:sqlite`, which is still marked experimental in Node 22.

```bash
git clone https://github.com/vanshgoel224/trip_agent.git && cd trip_agent
git checkout claude/festive-cori-29p0o8
npm install
cp .env.example .env     # set GEMINI_API_KEY (or another model key) and BIRUNI_INITIAL_PIN
npm start                # http://localhost:8787
```

- The server starts **locked**. Sign in with a username and PIN. `BIRUNI_INITIAL_PIN` creates the first user, `owner`; anyone else can create an account from the sign-in screen.
- **No key is required to run.** Without a model key, the deterministic rules still handle disruptions, approvals, undo and status. Every partner without a key runs on the simulator and says so.
- `.env` is git-ignored. Never commit keys.

**Docker:**

```bash
docker compose up -d                          # app on :8787, data in the biruni-data volume
docker compose --profile test run --rm test   # full test suite + e2e in a container
```

If Docker Hub rate-limits you, add `--build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-slim`.

**Phone sensors** (GPS, mic, camera, motion) only work over `https://` or on `localhost`. To use a phone, put the server behind an HTTPS tunnel (Cloudflare Tunnel or ngrok) or host it (see [Hosting](#hosting-and-remote-mcp)).

---

## Using the app

| Where | What it does |
|---|---|
| **＋ New chat** (Ctrl/Cmd+Shift+O) | Start a chat for one function (table in [Features by chat](#features-by-chat)), or a **✎ Custom chat** with your own instructions and chosen tool groups |
| **General** chat | Ask anything. If a message turns out to be an expense, a disruption, a map question and so on, it is also filed into that function's chat |
| **Trip ＋ / Trip ▸** | Create a trip for any cities; open its status, map, undo button, autopilot toggle and agent activity |
| **🚨 SOS** (red button) | Send an "I'm stuck here" alert with your location ([Safety](#safety-sos-drop-and-crash-watch)) |
| **Drop & crash watch** | Switch on phone-drop and vehicle-crash detection |
| **👥 People & shared trips** | Trusted contacts, shared trips, safety numbers |
| **🗣️ My style** | Teach Biruni your words and dialect, and record a voice sample |
| **🛡️ Permissions** | See and grant location, mic, camera, motion, notifications and storage |
| **🔋 Power** | Battery-aware mode, plus the smart-power demo |
| **Settings & connections** | AI models (bring your own key), connectors, external MCP servers, 🩺 Test all connections, demo scenarios, data export, delete account |
| **Memory graph** | Everything Biruni remembers, with search |
| **💬 Send feedback** | Product feedback |
| ◐ / ☀ / ☾ and 🔇 | Theme, and sound on/off |

**Commands** (no model call, except `/btw`):
- `/recall <name>`: answer from memory.
- `/forget <thing>`: delete it from memory.
- `/btw <question>`: a side question answered with read-only tools. It is **never saved**: no history, no memory, no filing.

Commands tolerate typos (`/Recal`, `/FORGT`). Double-click a chat title to rename it or change its emoji.

---

## How recovery works

```
Traveller (voice/text) → apps/web → apps/api ─┐
                                              ▼
                              services/orchestrator   (only conversational authority, holds the L4 flag)
                                              │ routes to restartable AgentRuns
     ┌──────────┬──────────┬────────────┬─────┴────┬──────────┬──────────┐
  finance    recovery   compliance     voice     travel     booking      services/agents/*
     └──────────┴──────────┴────────────┴────┬─────┴──────────┴──────────┘
                                              ▼
                     services/mcp  auth → schema → finance → compliance → authority
                                   → idempotency → rail (safe retries) → normalize → audit
                                              ▼
                     services/integrations  rails (simulator + live adapter each)
```

The full system architecture (deployment, request lifecycle, security model, code map, CRUD table, CI/CD and performance) is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Rules the code enforces

| Rule | Where |
|---|---|
| The orchestrator is the only conversational authority and holds L4 | `services/orchestrator/index.ts`, `authority.ts` |
| Finance is the only writer of obligations, ledgers and transactions | `packages/db` rejects writes without the one-time finance capability |
| ₹2,000 is cumulative per incident; there is a separate daily ceiling | `FinanceAgent.ledger()`, from append-only holds |
| Four checks before every action | `packages/policy` + MCP pipeline + `RecoveryAgent.run` |
| Every MCP call passes finance and compliance checks and is audited, including blocked ones | `services/mcp/server.ts` |
| Idempotency by `idempotency_key`, `incident_id`, `tool_call_id` | `tool_calls` table, rail status reconciliation |
| 30 s undo with compensation, survives restart | `services/agents/recovery/undo.ts` |
| Agents restart from checkpoints, not hidden memory | `AgentRouter` |
| The model proposes; policy decides. Safety can't be downgraded | `services/models`, `packages/policy` |
| Safety words escalate **before** any model is called | `packages/policy` (English fuzzy match + exact Hindi/Hinglish match) |
| Booking and approval tools need an explicit, unhedged yes in your latest message | `explicitYes` guard: "book it? not yet", "yes but wait" and "abhi nahi" are refused |
| Undo only on an explicit request | `explicitUndo`: "not yet" never triggers an undo |
| Credentials stay on the server | `services/integrations/*`; the browser only talks to `/api` |

### Demo scenarios (each verified by tests)

Run them from **Settings & connections**, or `npm run demo` for a CLI walkthrough.

| | Scenario | Result |
|---|---|---|
| A | Recovery costs ₹1,200 | Booked on its own, audited, undo window, verified, itinerary v2, ₹800 authority left |
| B | Recovery costs ₹2,450 | Blocked; you are asked; on yes it runs as a traveller-approved spend |
| C | ₹1,400, but only ₹901 is free after rent + EMI | Blocked even though it's within ₹2,000; you are asked |
| D | Pine Labs times out after charging | Status reconciled; exactly 1 charge; ledger matches |
| LADDER | Pine Labs and UPI decline | Unverified local vendor skipped; verified one booked |
| SAFETY | "accident… unsafe" | Autonomy stops; 112 prompt; emergency contact alerted only after a yes (unless opted in) |
| OFFLINE | No network | Options from the pre-fetched cache; only logged cash can execute; device voice |
| RESTART | Recovery agent crashes after paying | Restarts from checkpoint; payment returns `ALREADY_COMPLETED`; no second charge |

### L4 autopilot

Every 60 s (`AUTOPILOT_TICK_MS`) Biruni checks each active trip without being asked. Toggle it per trip in the Trip panel.

| Signal | Decision |
|---|---|
| Trusted operator says CANCELLED | **ACT**: recover and book within ₹2,000 with undo, or stop and ask |
| Cancellation from an unconfirmed source | **WAIT** for a second independent report |
| Delay < 180 min | **NOTIFY** and keep watching |
| Delay ≥ 180 min | **ACT** |
| Signal for a leg that left over 3 h ago | **IGNORE** (stale) |
| GPS + OSRM travel time + 30 min buffer > time left | **NOTIFY**: "Leave now" |
| Departure within 3 h | **NOTIFY**: reminder |
| Recovery finished | **ASK** for a vendor rating |
| Another recovery already running | **WAIT** (logged) |

Every decision is logged with its reasons and shown in the Trip panel. Archived trips are skipped.

### The 7 rail MCP tools (names are provisional)

The spec fixes the count at seven but not the names. Renaming one is a one-line change in `services/mcp/schemas`.

| Tool | Rail | Caller | Moves money or bookings |
|---|---|---|---|
| `voice_speak` | Gnani | voice | no |
| `route_search` | Delhivery / offline cache | travel | no |
| `vendor_verify` | vendor directory (simulated) | recovery | no |
| `payment_execute` | Pine Labs | recovery | yes |
| `booking_execute` | booking inventory (simulated) | booking | yes |
| `financial_context` | Setu AA | finance | no |
| `holdings_context` | Zerodha (read-only; no sell method exists) | finance | no |

Supporting tools outside the seven: `discovery_search` (Reddit/YouTube), `calendar_read` and `calendar_write`. They go through the same pipeline. Run the server over stdio with `BIRUNI_MCP_AGENT=recovery npm run mcp:stdio`.

---

## AI models and speed

**Order of attempts for every reply:**
1. **Your models** (Settings → Models), in your order.
2. **The server's `.env` model** as backup (turn off with `BYOK_SERVER_FALLBACK=off`).
3. **A local model**, if it passes a 0.8 s health check. The default is the **Hermes Agent** gateway (`http://127.0.0.1:8642/v1`, `HERMES_API_KEY`). Ollama works through `OFFLINE_MODEL_CONFIG`.
4. **Deterministic rules**, which still handle disruptions, undo, approvals, status and safety.

If a model fails mid-turn, the next one continues the same turn.

**Bring your own key.** Each user can add Anthropic (Claude, official SDK), Gemini, NVIDIA Nemotron, DeepSeek, OpenAI, OpenRouter, Groq, Mistral, Together, Ollama, Hermes Agent or any OpenAI-compatible URL.
- **Load models** lists what your key can actually use; **Test** measures one round trip.
- Keys are encrypted with your PIN and only shown back masked (`••••1234`).
- Claude uses the Messages API with `effort: medium` (`ANTHROPIC_EFFORT`).
- Preset model names are suggestions; trust **Load models**.

**Hermes runs with its tools off.** Its API runs Hermes' own tools server-side and won't accept Biruni's tools. So Biruni sends it none, and trip actions (cancel, undo, approve) never go to a tool-less model. `config/hermes/config.yaml` disables Hermes' toolsets and binds it to 127.0.0.1. Verify the key names against your Hermes version.

**Speed features:**
- **Racing:** if a model takes over 2.5 s (`MODEL_HEDGE_MS`), the next one starts in parallel and the first good answer wins.
- **Benching:** failing models are skipped for a while: rate-limited (429) 20–120 s, server errors or timeouts 10 s, bad key 5 min, retired model 1 h.
- **Gemini rotation:** with one key, Biruni tries the fast *flash-lite* models (each has its own free-tier limit) before *flash*.
- **No long waits:** a provider asking to retry later than 1.5 s (`MODEL_MAX_RETRY_WAIT_MS`) is skipped instead.
- **Short side calls:** classification 4 s, self-check 5 s; past those, rules or the unchecked reply are used.
- **Measured** (`npm run agent:check`, 13 turns, Gemini free tier): median 2.4 s, slowest 3.4 s.
- **The real limit is the free tier.** A second provider key (Groq or DeepSeek are fast and cheap) removes it.

**Thinking checks in chats:**
- The model is told to ask only when a wrong guess would cost money, time or safety; to check facts with tools; to compare at least two options; and to plan multi-step tasks (`make_plan` / `update_plan`, up to 12 steps).
- **Self-check:** replies involving money, bookings, numbers or directions are checked against the tool results by a second call and marked "self-checked" or "self-corrected". `CRITIC=off` disables it to save quota.
- Without any trip, the agent still helps with general travel questions.

`npm run models:check` pings the configured online model and the local tier.

---

## Accounts, encryption and shared trips

The key handling follows the patterns used by Signal and similar apps.

| Piece | How |
|---|---|
| Your data | Its own database file, AES-256-GCM with a random 256-bit data key (DEK) |
| PIN | Wraps the DEK through **Argon2id** (46 MiB, 1 pass, the OWASP setting), run in worker threads so sign-ins don't freeze the server. Changing the PIN re-wraps the DEK only |
| Records | Bound to `table:id` with AES-GCM AAD, so ciphertext can't be swapped between rows |
| Identity | One X25519 key pair per user; the private key is encrypted with your DEK |
| Shared trips | A trip key encrypts the group chat, itinerary snapshots and cancellation requests. It is sealed to each member (ephemeral X25519 + HKDF-SHA256 + AES-GCM) and **rotated when someone is removed** |
| Safety numbers | 60 digits per pair of users; compare in person to rule out a key swap |
| Sessions | HttpOnly, SameSite=Strict cookies (`Secure` + HSTS on HTTPS), 30 min idle lock; "sign out everywhere" drops the key from memory |
| Live events | Filtered per user |
| Wrong PINs | No lockout (your choice) |

**Shared trips:** only the **trip leader** decides cancellations. Members ask; the leader approves; the cancellation runs in the leader's space. Leadership can be handed over.

**Your data (CRUD):** rename, archive or delete trips; **export everything** as JSON (API keys left out); **delete your account** (PIN + typing DELETE; your shared trips pass to another member).

**Limits:**
- The server sees metadata: who is in which shared trip and who sent an SOS to whom, and when. It can't read messages or locations.
- A 4-digit PIN is weak if the data files are stolen (10,000 guesses, even at Argon2id speed). Use 6+ digits or a password.
- While you are signed in, your key is in server memory so the autopilot can work.
- `.env` is not encrypted.
- Webhooks, remote MCP and telephony act for one **service user** (`BIRUNI_SERVICE_USER`, default: the first account).

---

## Safety: SOS, drop and crash watch

### SOS help channel

Example: "I'm stuck in a cave near Kedarnath; call the authorities or come help before they arrive."

- **Who gets it:** your shared-trip members, your trusted contacts and, if you choose, everyone on the server who opted in to help.
- **What it carries:** your message and location, plus an optional photo. The photo is compressed on the phone (1280 px WebP, EXIF stripped; a 12 MP photo becomes roughly 100–150 KB), validated by its real file type, encrypted once and sealed to each recipient.
- **Replies:** recipients answer "I'm coming", "I've called the authorities" (with a note, e.g. "Called SDRF, ETA 2 h"), "Seen" or "Can't help". Only you can mark yourself safe.
- **Works while locked:** the lock screen shows "🚨 1 SOS alert waiting" (a count only; details need the PIN).
- **Emergency contact SMS:** your trip's emergency contact gets an SMS with a map link through Exotel. It is simulated without Exotel keys.
- **If the server is unreachable:** the app offers a ready SMS with your last known location. That location is stored **encrypted on the phone** (PBKDF2-SHA256 600k + AES-GCM; key in memory only while signed in).
- **112 and 108 are always one tap away. Biruni does not dispatch police or rescue.** 1363 is shown as the tourist helpline; verify it for your state.

### Drop watch

1. **Detection:** free fall followed by an impact.
2. **Recorded:**
   - fall time and estimated height (½·g·t²)
   - impact in g
   - tumble (gyroscope)
   - angle before and after
   - location, battery and severity
3. **Countdown:** 60 s (`FALL_CANCEL_MS`), run **on the server**, so the SOS still goes out if the phone dies.
4. **Cancel**, even with a broken screen:
   - tap **I'm OK**
   - **shake 3 times**
   - **say "I'm OK" / "theek hoon"**
   - press any key
   - tap I'm OK on **another device signed into your account**
5. **No cancel:** a **wide SOS** goes to trip members, trusted contacts and every opted-in helper, plus an SMS to the emergency contact.
6. **Offline:** the countdown runs on the phone, then tries the SOS, then offers the SMS.

**Tested against** synthetic sensor data: 1.3 m, waist-high and 2 m+ drops, walking, a hard tap, a 2 cm slip, a soft catch and bounces.

### Crash watch (vehicle)

A hard jolt (≥ 3.5 g, `IMPACT_G`) with no free fall, followed by stillness, makes Biruni ask "Are you OK?". With no answer in 30 s (`CRASH_CHECKIN_MS`), it escalates through the safety policy: 112 guidance, and the emergency contact is alerted only if you opted in; otherwise Biruni asks first.

**Limits:**
- These are heuristics, not certified safety systems.
- Thresholds were tuned on synthetic data. Expect to adjust `apps/web/modules/falldetect.js` after real drop tests.
- A web app can't read volume or power buttons; that's why shake and voice cancels exist.
- A web app can only read sensors **while it is open**. Screen-off detection needs a native background service.

---

## Features by chat

| Chat | What it does | Main tools |
|---|---|---|
| 💬 General | Anything. Also gets tools from connected external MCP servers | all |
| 🚨 Recovery | Disruptions, approvals, undo, forwarded operator SMS | `report_disruption`, `approve_pending`, `undo_last_action` |
| 🎫 Book travel | Flights, trains, buses, hotels | `travel_search`, `travel_book` |
| 🤝 Negotiate | Haggle with hotels, taxis and autos in their language | negotiator |
| 📦 Send parcel | Delhivery quote, book, track, cancel | `delivery_quote`, `delivery_book`, `delivery_track` |
| 🗣️ Translator | Translates your latest message, with pronunciation; **Speak & translate** for voice to voice | `speak` |
| 💸 Split expenses | Splitwise-style group expenses, balances, fewest transfers | `add_expense`, `get_balances`, `settle_up`, `splitwise_push` |
| 🧭 Discover | Lesser-known places from Reddit and YouTube | `discover_places` |
| 🗺️ Maps | Live location; nearby ATMs, hospitals, police and vegetarian places; turn-by-turn directions | `where_am_i`, `nearby_places`, `directions` |
| 📅 Calendar | Read and add Google Calendar events | `calendar_list_events`, `calendar_add_event` |
| 💰 Budget | Authority left; free balance after protected obligations | `get_budget` |
| ✎ Custom | Your instructions plus the tool groups you choose | chosen |

**Memory.**
- Stored as a knowledge graph (`memory_nodes`, `memory_links`) and recalled into every chat; repeating a fact strengthens its link.
- Vague, too short or too long facts are rejected.
- Exported in graphify's node-link format through `/api/memory/graph`, or with **Export**, which writes `memory-out/graph.json` and `GRAPH_REPORT.md`.

**Translation and voice.**
- Pipeline: speech → text → LLM translation → speech, across **23 Indian languages**.
- Without keys it uses the device's built-in voices; the Voice picker marks the ones your device can speak with 🔈.
- With `GNANI_API_KEY`, Gnani handles speech in and out for 10 languages: en, hi, bn, ta, te, kn, ml, mr, gu, pa.
- The other 13 get text translation plus whatever voices the phone has.
- Wrong-script output is corrected; for example, Konkani is forced into Devanagari, not Malayalam script.

**My style.**
- Teach Biruni your words with meanings (`scene = situation`, `jugaad = quick fix`), phrases, form of address (aap, tum or tu), language mix and region.
- Stored encrypted and given to the model **as data only**. Anything that reads like an instruction ("ignore…", "approve…", "spend…") is refused.
- Style never changes prices, safety advice or what needs your approval.
- **Voice sample:** record 20–60 s and confirm it's your voice; it's stored encrypted and can be deleted. **Voice cloning is not connected:** Gnani's cloning API couldn't be verified, so nothing is sent anywhere.

**Maps.**
- MapLibre (vendored locally) with OpenFreeMap vector tiles; OSM raster tiles as fallback.
- Search uses Photon, which is typo-tolerant ("fort agauda" → Fort Aguada), then Nominatim. Nearby places use Overpass; routing uses OSRM.
- No keys needed, but these are free community services with fair-use limits. Self-host them or pay a provider before real traffic.

**Typo tolerance.**
- Applies everywhere: commands, memory ("Rahul" = "Raahul"), names in expenses, disruption words ("cancled", "delayd") and language names ("tamill").
- Case- and accent-insensitive Damerau-Levenshtein matching, with prefixes and any word order. Very short words must match exactly.

**Feedback.**
- 👍/👎 on every reply.
- 1–5★ vendor ratings after a recovery. A vendor rated below 3.5★ drops off the recovery ladder.
- "the bus was awful, 2/5" in any chat is recorded.
- Export with `/api/feedback.csv`.

**External MCP servers.** Add any HTTP MCP server in Settings. stdio servers, which run local commands, are only allowed through the server-side `BIRUNI_MCP_SERVERS` setting, so a web page can't start commands. External tools never get money or approval powers, and their output is treated as untrusted.

**Formatting and effects.**
- One shared formatter (`apps/web/modules/format.js`): ₹ in lakh/crore, IST times, "5 min ago", km, +91 numbers and PNRs.
- Sounds are generated with Web Audio (no audio files): send, receive, success, error and an SOS alarm. There are haptics and toasts; 🔇 mutes, and your phone's reduce-motion setting is honoured.

**Power.**
- Real behaviour: the app reads the battery where the browser allows. Below 20%, or with Power saver on, GPS polls every 60 s instead of 10 s.
- **Smart power panel: a demo only.** Neither web nor Android apps can take power from other apps, and the panel says so.

---

## Booking, operator feed, telephony, negotiation

**Travel booking.**
- Flights, trains, buses and hotels between Indian cities, priced in ₹.
- Bookings are idempotent and need an explicit yes plus names as on ID. They become itinerary legs that the autopilot watches.
- **TBO, Agoda and EaseMyTrip are slots:** their APIs need partner onboarding with business KYC, so Biruni reports "not wired" rather than guessing endpoints. The simulator serves bookings meanwhile.

**Operator status feed.**
- **Forwarded SMS/email** is parsed without a model, in English and Hindi: cancelled, delays like "2 hrs 15 mins" or "२ घंटे देरी", rescheduled.
- Send it through:
  - the 🚨 chat
  - `POST /api/feed/message`
  - an SMS-forwarder app calling `POST /api/feed/inbound` with `FEED_TOKEN`
- **Flight status** comes from AviationStack (`AVIATIONSTACK_KEY`).
- All signals go through the autopilot's corroboration and ₹2,000 rules.

**Telephony (Exotel).**
- SMS for negotiations and SOS, plus inbound SMS.
- **Live calls:** Biruni rings the driver or hotel. 8 kHz audio streams to `wss://…/telephony/exotel/stream/<secret>`, where speech is detected, transcribed (Gnani), passed to the negotiator and spoken back, with barge-in.
- Simulated without keys. Verify endpoint shapes on developer.exotel.com. India requires DLT registration for SMS (`EXOTEL_DLT_*`).

**Negotiator (🤝).**
- **You set** a target and a maximum. Biruni opens below the target and concedes on a fixed schedule.
- It accepts only within your max, takes a stated "final price" if that's within your max, and walks away politely above it.
- **The model never picks a price;** it only reads the other side's message and phrases the next line.
- It understands Indic digits (१२००, ௧௨௦௦, ೫೦೦), "1.5k" and numbers in words (இரண்டாயிரத்து இருநூறு = 2,200).
- **Hotels:** agree → confirm details → recorded in plans, memory and Calendar. Taxis and autos are recorded on agreement.
- **Channels:**
  - **In person (relay):** the line is shown in their script with pronunciation; 🔊 speaks it; 🎤 hears the reply.
  - **WhatsApp Business** (`WHATSAPP_*` keys, Meta signature verified). First contact needs an approved template.
  - **Exotel** SMS and calls (above).
- **Biruni never pays in a negotiation.** You pay the person directly.

**Delhivery parcels and luggage (📦).**
- Flow: quote (surface or express) → details → booking **only after an explicit yes** → AWB, tracking and cancel before pickup.
- Simulated without `DELHIVERY_API_KEY` and `DELHIVERY_PICKUP_LOCATION`.
- With keys, Biruni also files a real pickup request to `/fm/request/new/` (the auth header format is assumed; verify it in Delhivery One).
- **Not built:** real waybill creation (its request format isn't public) and Delhivery's real tariff; the tariff is simulated.

---

## Phone app and permissions

**PWA (recommended on Android):**
- Open the HTTPS URL in Chrome → menu → *Install app*.
- No extra installs.
- Has full device voice through Chrome's speech, and the app shell works offline.

**APK:**
- Built by GitHub Actions (`.github/workflows/android-apk.yml`) on pushes that touch `apps/mobile`, and on `v*` tags (attached to a release).
- Download it from the run's **Artifacts**. It's a debug build; allow *Install unknown apps* for your browser or file manager.
- On first launch the app asks Android for location, microphone, camera and notifications, then asks for your server address (pre-filled from the repo variable `BIRUNI_SERVER_URL`).
- The manifest also declares vibration, wake lock and high-rate motion sensors.
- Limit (verify on your device): Android WebView generally lacks browser speech APIs, so voice in the APK needs Gnani keys. Use the PWA in Chrome for free device voices.

**🛡️ Permissions panel:**
- Shows the status of location, mic, camera, motion, notifications and storage: what each is for, an **Allow** button, and how to fix a block in browser or Android settings.
- Warns when the page isn't on HTTPS.
- Opens once after first sign-in.

Hermes and Ollama run on a computer, not on the phone.

---

## Hosting and remote MCP

**Works as-is** on any always-on host with a persistent disk:
- Render, Railway or Fly.io with a volume
- a small VPS (most providers have Indian regions)
- your own PC behind Cloudflare Tunnel or ngrok

**Vercel: not as-is.** Biruni is a long-running server with a local SQLite file, in-memory unlock keys, a 60 s autopilot loop and live event streams (SSE). Vercel Functions are stateless with no persistent disk. Making it work there means a hosted database plus cron; check Vercel's current limits first.

**Images:** CI publishes a Docker image to GHCR on `main` and `v*` tags.

**Remote MCP (use Biruni from Claude or any MCP client):**
- Set `BIRUNI_MCP_TOKEN` (24+ random characters). The server then serves Streamable HTTP MCP at **`/mcp`**.
- Auth: `Authorization: Bearer <token>`.
- Tools: `biruni_chat` (the whole agent), `biruni_trips` and `biruni_trip_status`.
- Payment rails are **not** exposed.
- After each restart, sign in once so the encrypted data is unlocked.

---

## Testing and CI/CD

| Command | What it does |
|---|---|
| `npm run check` | Typecheck, browser-module syntax check, secret scan of tracked files |
| `npm test` | 102 unit/integration tests: authority, payments, idempotency, recovery, chat, autopilot, negotiator, security, models, booking, telephony, feed, users, falls, format, policy, style |
| `npm run test:e2e` | Real server: ~1,000 hostile requests (fuzz), remote MCP, drop → SOS, account CRUD, compression |
| `npm run demo` | CLI walkthrough of every demo scenario |
| `npm run agent:check` | Live AI walkthrough of a Pune → Goa trip (needs a model key): memory, recovery, undo, expenses, translation, booking, haggling, operator SMS, maps, safety, `/btw`, SOS, drop. Add `--gap` to pace requests on a free tier |
| `npm run agent:check:hard` | Adversarial: over-limit demands, prompt injection, gibberish, 4,500-character input, message bursts, late undo, broken first model, contradictions, Hindi-only safety |
| `npm run load:test -- --users 40 --rounds 3` | Concurrent users; last run: 0 errors, p50 ~10 ms, p95 < 140 ms, memory flat |
| `docker build --target test .` | The container test CI runs |

**Bugs these found and fixed** include:
- Argon2 freezing the event loop under load (now in worker threads)
- keep-alive connection resets
- a `//` path that hung requests
- a phantom drop alarm
- "not yet" being treated as undo
- a "hoon" → "khoon" safety false positive
- Konkani coming out in the wrong script
- unstable booking offer ids

**CI/CD** (`.github/workflows/`):
- `ci.yml`: checks → Docker test build → e2e → container health check → GHCR publish on `main` or `v*` tags.
- `android-apk.yml`: builds the APK.
- Dependabot keeps dependencies current.

---

## Configuration

Everything is in `.env.example`. The main keys:

| Purpose | Keys |
|---|---|
| Sign-in | `BIRUNI_INITIAL_PIN`, `LOCK_IDLE_MIN`, `BIRUNI_SERVICE_USER` |
| Online model | `GEMINI_API_KEY`, `GEMINI_MODEL`, or `ONLINE_MODEL_API_KEY` / `ONLINE_MODEL_BASE_URL` / `ONLINE_MODEL_NAME` |
| Local model | `HERMES_URL`, `HERMES_API_KEY`, `HERMES_MODEL`, `OFFLINE_MODEL_CONFIG` |
| Model tuning | `MODEL_TIMEOUT_MS`, `MODEL_HEDGE_MS`, `MODEL_MAX_RETRY_WAIT_MS`, `CRITIC`, `ANTHROPIC_EFFORT`, `BYOK_SERVER_FALLBACK` |
| Autopilot and undo | `AUTOPILOT_TICK_MS`, `AUTOPILOT_DELAY_RECOVER_MIN`, `AUTOPILOT_LEAVE_BUFFER_MIN`, `UNDO_WINDOW_MS` |
| Safety | `FALL_CANCEL_MS`, `IMPACT_G`, `CRASH_CHECKIN_MS`, `CRITICAL_BATTERY_PCT` |
| Rails | `GNANI_*`, `PINELABS_*`, `SETU_*`, `ZERODHA_*`, `DELHIVERY_*` |
| Booking partners | `TBO_*`, `AGODA_*`, `EASEMYTRIP_API_KEY` |
| Feed and telephony | `FEED_TOKEN`, `AVIATIONSTACK_KEY`, `EXOTEL_*`, `TELEPHONY_WS_SECRET`, `WHATSAPP_*` |
| Connectors | `GOOGLE_*`, `GOOGLE_CALENDAR_ICS_URL`, `REDDIT_*`, `YOUTUBE_API_KEY`, `SPLITWISE_API_KEY` |
| Maps | `NOMINATIM_URL`, `PHOTON_URL`, `OVERPASS_URL`, `OSRM_URL`, `OSM_USER_AGENT` |
| MCP | `BIRUNI_MCP_TOKEN`, `BIRUNI_MCP_SERVERS` |

---

## Live rails

| Rail | Contract source | Live behaviour | Run with a real key? |
|---|---|---|---|
| Gnani | official `gnani-vachana` SDK 0.7.9 | TTS and STT | No |
| Pine Labs | Plural API docs | A charge becomes a **payment link you complete**; status; refunds | No |
| Setu AA | docs.setu.co FIU APIs | Consent → data session → 6 months of debits (set `SETU_ACCESS_TOKEN`) | No |
| Zerodha | Kite Connect v3 docs | Daily login, read-only holdings | No |
| Delhivery | Delhivery API docs (pickup request) | Simulated; with a key, a real pickup request | No |
| Exotel | developer.exotel.com | SMS, calls, audio stream | No |
| WhatsApp | Meta Cloud API docs | Send + signed inbound webhook | No |
| Google Calendar | OAuth + Calendar v3 | Read/write, or ICS read-only | No |
| Reddit / YouTube / Splitwise | public API docs | Search, search, sync | No (Reddit blocks anonymous cloud IPs) |
| Gemini | OpenAI-compatible endpoint | Tool calling | **Yes** |
| OpenStreetMap | Nominatim, Photon, OSRM | Geocoding, nearby, directions | **Yes** (Overpass timed out from the sandbox; falls back to Nominatim) |

**Pine Labs:** a gateway can't silently debit you. Fully autonomous spending needs a pre-authorised mandate with Pine Labs, which isn't built, so live charges stop and hand you a payment link.

---

## Design decisions

These are calls the spec left open; review them before freeze.

- **Obligation classes:**
  - keyword + ≥ 5 stable months → CONFIRMED
  - ≥ 5 stable months → INFERRED
  - ≥ 3 months → PROBABLE
  - a keyword or ≥ ₹5,000 → UNCERTAIN

  All four are protected, and holdings are never counted as free money.
- **Undo** gives the ₹ back to both the incident and the daily authority.
- **Traveller-approved spends** (after B or C) don't use up the autonomous ₹2,000. An obligation override needs approval of that specific warning. Both are audited.
- **Readbacks:** one voice notice when an action runs (with the undo prompt), then a final readback after verification.
- **Vendor checks:** rating ≥ 3.5 from ≥ 10 reviews, pickup within 2 km, quote ≤ 1.5× the reference fare, no fraud flags.
- **Offline:** only logged cash can execute; voice falls back to the device.

---

## Honest gaps

| Gap | Why | What closes it |
|---|---|---|
| Live rails never run against real accounts | no keys during development | run each with a key; expect field-name fixes |
| TBO / Agoda / EaseMyTrip real booking | partner kits need business KYC | wire endpoints into `services/integrations/partners` |
| Exotel calls on a real phone | no account; stream frame format unverified | test one call, adjust frame fields |
| Gnani voice cloning | cloning API not verified | confirm with Gnani, then wire the slot in `services/style` |
| Drop/crash thresholds | tuned on synthetic data | real-device drop tests |
| Sensors with the app closed | web apps can't run sensors in the background | a native background service |
| SOS push when the app is closed / across servers | alerts reach users of the same server, live or at next sign-in | Web Push / FCM |
| Pine Labs autonomous debit | gateways need a mandate | a mandate product |
| Delhivery waybill creation | request format not public | Delhivery One portal access |
| WhatsApp cold outreach | 24-hour rule | an approved template |
| Train/bus live status | no official public API (forwarded SMS works) | IRCTC/aggregator partner access |
| APK voice without Gnani | WebView lacks Web Speech | Gnani keys or native speech plugins |
| On-phone local model | Hermes/Ollama run on a computer | a native on-device build (llama.cpp or MLC) |
| Vercel hosting | stateless, no disk | hosted DB + cron, or an always-on host |
| Multi-device key sync across servers | one server holds the encrypted spaces | key sync |
| Low-resource language quality | depends on the model | native-speaker review, stronger model |
| Free-tier speed ceiling | provider rate limits | a second provider key |
| No-reply behaviour (e.g. 600 s without a chat response) | not defined yet | your tweak |
| `graphify-out/` | describes old Python code | rerun graphify |

---

## Layout

```
apps/web                 chat UI + PWA (vanilla JS, MapLibre vendored, SSE, sensors, recorder)
apps/web/modules         format, image, effects, permissions, sos, people, style, fall, falldetect,
                         securelocal, battery, legal (each starts independently)
apps/api/src             server.ts (sign-in, isolation, webhooks, static), http.ts, spaces.ts (per-user runtimes)
apps/api/src/routes      trips, chat, device, travel, models, connections, autopilot, deals, feedback,
                         social, falls, style (one file per feature)
apps/mobile              Capacitor Android shell (launcher, permissions); APK built in Actions
apps/phone-offline       earlier offline Python agent
config/hermes            hardened Hermes Agent config (tools off, localhost only)
services/orchestrator    planner, router, state machine, authority, chat agent, chats
services/agents/*        finance, recovery (+ undo), compliance, voice, travel, booking, expenses
services/mcp             MCP server pipeline, tools, schemas, stdio + HTTP entry
services/mcp-client      connect external MCP servers
services/models          model chain, BYOK providers, encrypted settings
services/integrations    rails, partners (+ simulator), maps, calendar, reddit, youtube, health check
services/autopilot       L4 autopilot
services/feed            operator status feed
services/telephony       Exotel SMS/calls, audio (VAD, WAV, resample)
services/negotiator      deterministic haggling
services/social          shared trips + SOS (sealed per recipient)
services/falls           drop watch countdown
services/devices         GPS + crash check-ins
services/style           My style + voice sample
services/memory          graph memory (graphify format)
services/conversation.ts chat entry point + translation pipeline
packages/crypto          Argon2id (workers), envelope keys, X25519 sealed boxes, safety numbers
packages/db              store (AES-GCM + AAD), accounts
packages/policy          safety words, consent and authority checks
packages/{domain,events,shared}
scripts                  check, agent-check(-hard), load-test, check-models
tests/*                  node:test suites, e2e, scenarios/run-demo.ts
docs/ARCHITECTURE.md     full system architecture
```

---

## Legal

- **Biruni™ helps; you decide, and you are responsible** for your travel, bookings, payments and safety decisions. It is not an emergency service and does not replace 112.
- The first-run notice and the full terms are in `apps/web/legal.html`.
- `LICENSE` is proprietary, all rights reserved. It is a template; have a lawyer review it.
- `NOTICE` lists third-party licences (MapLibre BSD-3, OpenStreetMap ODbL and others).
