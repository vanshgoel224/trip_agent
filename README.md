# Offline Trip Agent

## What this actually is
A local AI agent (Ollama + tool-calling) that runs fully offline on your phone for
itinerary management, budgeting, contact tracking, and last-minute replanning using
cached data. It does NOT book anything, fetch live prices, or know real-time transit
status — that is physically impossible without a network call at that moment. Anyone
who tells you otherwise is wrong.

## What "offline execution" really means here
- Full itinerary CRUD, budget tracking, contact storage → 100% offline, always works.
- Replanning on disruption (place shut, transport cancelled, weather) → offline, using
  whatever was cached during the last `sync_online.py` run. The agent will tell you
  how stale that cache is (`get_cache_freshness`) — trust it accordingly.
- Live prices/bookings/availability → needs a network call, period. Run `sync_online.py`
  whenever you have signal (hotel wifi, one bar of data) to refresh the cache.

## Setup (Android)
1. Install **Termux from F-Droid** (not Play Store — that build is deprecated/broken).
2. Copy this folder onto the phone (`termux-setup-storage`, then copy into `~/storage/shared`).
3. Run `bash setup_termux.sh`. Installs Ubuntu-in-proot + Ollama (no native Android
   Ollama binary exists, this is the standard workaround) + pulls `qwen2.5:3b-instruct`
   (~2GB, chosen because it supports tool-calling reliably at this size).
4. `proot-distro login ubuntu -- ollama serve` in one Termux tab, `python agent.py` in another.

## iOS
No Termux equivalent exists on iOS (Apple sandboxing blocks it). Two real options:
- **a-Shell / iSH** can run limited Linux userland but Ollama's binary won't run under iSH's
  usermode x86 emulation reliably — not recommended, I'm not confident this works well.
- **Realistic iOS path**: run Ollama on a home server/laptop on your own network, hit it
  from an iOS shortcut/app over local wifi/Tailscale when in range, same code works since
  `agent.py` just calls `localhost:11434` — point it at your server's LAN IP instead.
  This is NOT phone-offline, flagging that clearly.

## Optimization notes (8GB phone)
- `qwen2.5:3b-instruct` Q4 quantization ≈ 2-2.5GB RAM. Leaves ~5GB for Android + Termux.
  If you get OOM kills, drop to `qwen2.5:1.5b-instruct` in `agent.py` — smaller but tool-calling
  accuracy drops noticeably, I have not verified how much.
- CPU-only inference on phone SoCs: expect roughly 3-8 tokens/sec depending on chipset —
  I don't have your exact phone's benchmark, treat this as a rough range, not a spec.
- SQLite DB (`trip.db`) is tiny (KBs), no storage concern.
- Keep `sync_online.py` runs short — Overpass API (free OSM POI data) has fair-use rate
  limits, don't hammer it.

## Discovery agent (hidden gems from Reddit/YouTube)
`python discover.py "Rishikesh"` — run when you have signal. Fetches Reddit
(r/IndiaTravel, r/india, r/backpacking — public read-only, no login) and YouTube
(official Data API v3, needs `YOUTUBE_API_KEY` env var, free quota ~1 search/day
on default quota) content about the location. Raw text is cached, then the
**local Ollama model** (not a cloud call) extracts candidate lesser-known places
into `discovered_places`, status `pending`.

Nothing gets added to your itinerary automatically. Ask the agent (offline,
in `agent.py`) something like "any hidden spots near Rishikesh?" — it checks
`get_pending_discoveries`, shows you the candidates, and only calls
`approve_discovery` after you say yes.

Reddit note: public `.json` endpoints, fine for personal/prototype use. Don't
hammer them — script already sleeps between requests. For real/sustained use,
register a proper Reddit API app instead.

## Files
- `agent.py` — main loop, talks to local Ollama only
- `tools.py` — all agent capabilities (itinerary/budget/contacts/contingency/cached lookups)
- `db.py` — SQLite schema, zero network
- `sync_online.py` — the ONLY file that touches network, run when you have signal
- `setup_termux.sh` — Android setup
- `cached_data/` — POI/transit/weather cache, refreshed by sync_online.py

## Not built (be aware)
- No live booking/payment integration (correctly excluded — you don't want an LLM
  autonomously spending money, and it's out of scope for "offline" anyway).
- No native Android app/UI — this is CLI via Termux. A proper Android app (Kotlin +
  llama.cpp via JNI) is a much bigger build; say so if you want that instead of CLI.
- transit.json cache format is defined but not auto-populated — no single free API
  covers Indian intercity transit broadly; you'll need to plug in whatever transit
  API/data source you have keys for, or populate it manually before a trip.
