# Biruni: Round 3 prototype

> Get the traveller home safe, with the trip they paid for and money they had already promised elsewhere untouched.

This is a working vertical slice of the Biruni agent for the KEN Case Competition, Round 3. It follows `Biruni_Round3_Implementation_Spec.md`. One orchestrator and six specialists handle disruptions on their own, inside a deterministic authority contract. They reach the outside world only through Biruni's own MCP server, which exposes 7 tools.

**Status:** the prototype runs end to end against a realistic simulator. None of the external rails (Gnani, Pine Labs, Delhivery, Setu AA, Zerodha) are wired to real APIs yet. See [What is not built](#what-is-not-built).

## Quickstart

Requires Node ≥ 22.5. Persistence uses the built-in `node:sqlite`, which is still experimental in Node 22.

```bash
npm install
npm test          # 22 tests: authority, payments/obligations, idempotency, recovery, restart
npm run demo      # CLI walkthrough of every scenario (short undo window)
npm start         # API + demo UI on http://localhost:8787 (30s undo window)
```

In the UI, pick a scenario, press **Send** to report the disruption, then watch the agent activity panel. **UNDO** is live for 30 seconds.

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

### The 7 MCP tools (names are PROVISIONAL)

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

## Implementation decisions the spec leaves open

These are my calls. Review them before freeze.

- **Obligation inference thresholds:** keyword plus ≥5 stable months gives CONFIRMED; ≥5 stable months gives INFERRED; ≥3 months gives PROBABLE; a keyword or ≥₹5,000 gives UNCERTAIN. **All four classes are protected.** The spec says uncertain money is never free. Holdings are never counted.
- **Undo restores authority:** a refunded spend gives the ₹ back to both the incident and daily authority.
- **Traveller-approved spends** (after B or C) bypass the autonomous ₹2,000 and daily checks and don't consume them. An obligation override happens only when the traveller approved that specific obligation warning. Both are audited with the approval id.
- **Readbacks:** one voice notice when the action executes (with the undo prompt), then the final readback after verification. This reconciles spec §14 with §21.
- **Vendor checks:** minimum rating 3.5, at least 10 reviews, pickup within 2 km, quote no more than 1.5× the reference fare, and no fraud flags. Required for the `LOCAL_TRANSPORT` rung.
- **Offline:** only `LOGGED_CASH` can execute, and voice falls back to device TTS.

## What is not built

- **Live rail adapters.** `PROVIDER_MODE=live` deliberately throws `not implemented`. I haven't verified the vendor endpoints and auth flows against current docs, and I won't guess them. Implement each one behind the existing interface in Phase 5. The tool contracts don't change.
- **Model calls:** the code is there (an OpenAI-compatible client with a timeout and a rules fallback) but hasn't been tested against a real Nemotron or Qwen endpoint. Check the base URL and model id in your provider's docs.
- **Qwen 4B on the phone:** not integrated. `apps/phone-offline/` is the earlier offline Python agent (Ollama, `qwen2.5:3b-instruct`). It's kept as the starting point for that layer. It is not the Qwen 4B the spec names.
- **No user authentication on `/api`.** It's a demo; add JWT before exposing it anywhere.
- **Group leader policy, Redis, Postgres runtime.** `prisma/schema.prisma` is valid, but the prototype runs on SQLite.
- `graphify-out/` describes the old Python layout and is stale.

## Layout

```
apps/web               demo UI (vanilla JS, SSE activity panel, Web Speech stand-in for Gnani)
apps/api               HTTP API, spec §23 endpoints + /api/scenarios, /api/events
apps/phone-offline     previous offline Python agent (see its README)
services/orchestrator  planner, router (restartable AgentRuns), state-machine, authority (L4)
services/agents/*      finance, recovery (+ undo), compliance, voice, travel, booking
services/mcp           server pipeline, tools, middleware, zod schemas, stdio entry
services/integrations  five rails (mock + live stub), simulator, scenarios
services/models        model router (online/offline/rules)
packages/*             domain types, db, policy, events, shared
prisma/schema.prisma   production schema
tests/*                node:test suites + scenarios/run-demo.ts
```
