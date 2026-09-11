# Graph Report - trip_agent  (2026-09-11)

## Corpus Check
- Corpus is ~4,165 words - fits in a single context window. You may not need a graph.

## Summary
- 94 nodes · 198 edges · 12 communities (7 shown, 5 thin omitted)
- Extraction: 84% EXTRACTED · 16% INFERRED · 1% AMBIGUOUS · INFERRED: 31 edges (avg confidence: 0.84)
- Token cost: 85,050 input · 0 output

## Community Hubs (Navigation)
- Agent Loop & Phone Runtime
- Offline Cache & Online Sync
- Discovery Agent (Reddit/YouTube)
- SQLite Store & Delete Ops
- Read-Only Query Tools
- Cached POI/Transit Lookups
- Discovery Approval Flow
- Trip DB Domain Concepts
- Contingency Logging
- Expense Logging
- Itinerary Updates
- Budget Setting

## God Nodes (most connected - your core abstractions)
1. `get_conn()` - 22 edges
2. `now()` - 12 edges
3. `Offline Trip Agent` - 11 edges
4. `Ollama (local LLM runtime)` - 9 edges
5. `discover()` - 8 edges
6. `sync()` - 8 edges
7. `Discovery Agent (hidden gems)` - 8 edges
8. `get_pending_discoveries()` - 7 edges
9. `approve_discovery()` - 7 edges
10. `Offline Execution Model` - 7 edges

## Surprising Connections (you probably didn't know these)
- `lookup_cached_pois()` --shares_data_with--> `cached_data/ (POI/transit/weather cache)`  [INFERRED]
  tools.py → README.md
- `lookup_cached_pois()` --shares_data_with--> `Overpass API (OSM POI data)`  [INFERRED]
  tools.py → README.md
- `lookup_cached_transit()` --shares_data_with--> `transit.json cache`  [INFERRED]
  tools.py → README.md
- `main()` --references--> `Ollama (local LLM runtime)`  [INFERRED]
  agent.py → README.md
- `main()` --implements--> `Tool Calling`  [INFERRED]
  agent.py → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Offline/online boundary via cached data** — readme_offline_execution, readme_replanning_on_disruption, readme_cached_data, sync_online, tools_get_cache_freshness, readme_cache_staleness [EXTRACTED 1.00]
- **Discovery-to-approval flow (fetch, extract, stage, human approve)** — discover, readme_reddit_json_endpoints, readme_youtube_data_api_v3, readme_ollama, readme_discovered_places, tools_get_pending_discoveries, tools_approve_discovery, readme_human_in_the_loop_approval [EXTRACTED 1.00]
- **Android on-device LLM stack (Termux, proot Ubuntu, Ollama, qwen2.5, agent.py)** — setup_termux, readme_termux_setup, readme_ubuntu_proot, readme_ollama, readme_qwen2_5_3b_instruct, agent [EXTRACTED 1.00]

## Communities (12 total, 5 thin omitted)

### Community 0 - "Agent Loop & Phone Runtime"
Cohesion: 0.19
Nodes (17): call_ollama(), is_online(), main(), Offline trip-planning agent. Talks ONLY to localhost Ollama — zero external…, Best-effort connectivity check. Used only to warn the user, never blocks…, Runs one user turn to completion, including any tool-call loops., run_turn(), 8GB Phone Optimization Notes (+9 more)

### Community 1 - "Offline Cache & Online Sync"
Cohesion: 0.19
Nodes (17): Cache Freshness / Staleness Reporting, cached_data/ (POI/transit/weather cache), CLI via Termux (no native Android app), No Live Booking/Payment (by design), Offline Execution Model, Offline Trip Agent, Replanning on Disruption, transit.json cache (+9 more)

### Community 2 - "Discovery Agent (Reddit/YouTube)"
Cohesion: 0.22
Nodes (15): now(), _cache_raw(), discover(), extract_places_via_local_model(), fetch_reddit(), fetch_youtube(), Discovery agent: finds lesser-known places from Reddit + YouTube for a given…, Full pipeline: fetch (online) -> extract (local model) -> store as pending. (+7 more)

### Community 3 - "SQLite Store & Delete Ops"
Cohesion: 0.22
Nodes (9): get_conn(), init_db(), Local trip state store. Zero network dependency. Single file SQLite DB at…, add_contact(), Add a local contact (driver, host, emergency contact, on-ground person)., User said no to a discovered place., Delete an itinerary item entirely., reject_discovery() (+1 more)

### Community 4 - "Read-Only Query Tools"
Cohesion: 0.22
Nodes (9): rows_to_list(), get_budget_summary(), get_contacts(), get_itinerary(), get_pending_discoveries(), Get budgeted vs spent per category, and overall remaining budget., Fetch saved contacts, optionally filtered by location., Get lesser-known places found by the discovery agent that are awaiting your… (+1 more)

### Community 5 - "Cached POI/Transit Lookups"
Cohesion: 0.38
Nodes (6): _load_cache(), lookup_cached_pois(), lookup_cached_transit(), Tools exposed to the local model via Ollama tool-calling. All functions are…, Look up points of interest near a location from last-synced offline cache…, Look up cached transit/transport options between two places (last-known…

### Community 6 - "Discovery Approval Flow"
Cohesion: 0.40
Nodes (5): Human-in-the-loop Discovery Approval, add_itinerary_item(), approve_discovery(), User approved a discovered place — mark approved AND add it to the itinerary., Add a planned activity to the itinerary for a given trip day.

## Ambiguous Edges - Review These
- `sync_online.py` → `transit.json cache`  [AMBIGUOUS]
  README.md · relation: shares_data_with

## Knowledge Gaps
- **1 isolated node(s):** `setup_termux.sh script`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 30 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `sync_online.py` and `transit.json cache`?**
  _Edge tagged AMBIGUOUS (relation: shares_data_with) - confidence is low._
- **Why does `get_conn()` connect `SQLite Store & Delete Ops` to `Offline Cache & Online Sync`, `Discovery Agent (Reddit/YouTube)`, `Read-Only Query Tools`, `Cached POI/Transit Lookups`, `Discovery Approval Flow`, `Contingency Logging`, `Expense Logging`, `Itinerary Updates`, `Budget Setting`?**
  _High betweenness centrality (0.225) - this node is a cross-community bridge._
- **Why does `Offline Trip Agent` connect `Offline Cache & Online Sync` to `Agent Loop & Phone Runtime`, `Discovery Agent (Reddit/YouTube)`, `SQLite Store & Delete Ops`, `Cached POI/Transit Lookups`?**
  _High betweenness centrality (0.125) - this node is a cross-community bridge._
- **Why does `Ollama (local LLM runtime)` connect `Agent Loop & Phone Runtime` to `Discovery Agent (Reddit/YouTube)`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **What connects `setup_termux.sh script` to the rest of the system?**
  _1 weakly-connected nodes found - possible documentation gaps or missing edges._