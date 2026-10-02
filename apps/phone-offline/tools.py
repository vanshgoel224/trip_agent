"""
Tools exposed to the local model via Ollama tool-calling.
All functions are pure offline — no network calls anywhere in this file.
Cached data (POIs, transit options, last-known prices) lives in cached_data/*.json
and is refreshed only by sync_online.py when internet is present.
"""
import json
import os
from db import get_conn, now, rows_to_list

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cached_data")


def _load_cache(name):
    path = os.path.join(CACHE_DIR, f"{name}.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


# ---------- Itinerary ----------

def add_itinerary_item(day: int, activity: str, time_slot: str = "", location: str = "",
                        cost_est: float = 0, notes: str = "") -> dict:
    """Add a planned activity to the itinerary for a given trip day."""
    conn = get_conn()
    cur = conn.execute(
        "INSERT INTO itinerary (day, time_slot, activity, location, cost_est, notes, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (day, time_slot, activity, location, cost_est, notes, now(), now())
    )
    conn.commit()
    item_id = cur.lastrowid
    conn.close()
    return {"status": "added", "id": item_id}


def update_itinerary_item(item_id: int, status: str = None, activity: str = None,
                           time_slot: str = None, notes: str = None) -> dict:
    """Update an existing itinerary item — used to cancel, reroute, reschedule, or mark done."""
    conn = get_conn()
    fields, vals = [], []
    for col, val in [("status", status), ("activity", activity), ("time_slot", time_slot), ("notes", notes)]:
        if val is not None:
            fields.append(f"{col}=?")
            vals.append(val)
    if not fields:
        conn.close()
        return {"status": "no_change"}
    fields.append("updated_at=?")
    vals.append(now())
    vals.append(item_id)
    conn.execute(f"UPDATE itinerary SET {', '.join(fields)} WHERE id=?", vals)
    conn.commit()
    conn.close()
    return {"status": "updated", "id": item_id}


def get_itinerary(day: int = None) -> dict:
    """Fetch the current itinerary, optionally filtered to one day."""
    conn = get_conn()
    if day is not None:
        rows = conn.execute("SELECT * FROM itinerary WHERE day=? ORDER BY time_slot", (day,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM itinerary ORDER BY day, time_slot").fetchall()
    conn.close()
    return {"itinerary": rows_to_list(rows)}


def remove_itinerary_item(item_id: int) -> dict:
    """Delete an itinerary item entirely."""
    conn = get_conn()
    conn.execute("DELETE FROM itinerary WHERE id=?", (item_id,))
    conn.commit()
    conn.close()
    return {"status": "deleted", "id": item_id}


# ---------- Budget ----------

def set_budget(category: str, amount: float, label: str = "") -> dict:
    """Set/add a budgeted amount for a category (transport, stay, food, misc)."""
    conn = get_conn()
    conn.execute("INSERT INTO budget (category, label, amount, kind, created_at) VALUES (?,?,?,?,?)",
                 (category, label, amount, "budgeted", now()))
    conn.commit()
    conn.close()
    return {"status": "set"}


def log_expense(category: str, amount: float, label: str = "") -> dict:
    """Log an actual expense against a category."""
    conn = get_conn()
    conn.execute("INSERT INTO budget (category, label, amount, kind, created_at) VALUES (?,?,?,?,?)",
                 (category, label, amount, "spent", now()))
    conn.commit()
    conn.close()
    return {"status": "logged"}


def get_budget_summary() -> dict:
    """Get budgeted vs spent per category, and overall remaining budget."""
    conn = get_conn()
    rows = rows_to_list(conn.execute("SELECT * FROM budget").fetchall())
    conn.close()
    summary = {}
    for r in rows:
        cat = r["category"]
        summary.setdefault(cat, {"budgeted": 0, "spent": 0})
        summary[cat][r["kind"]] += r["amount"]
    total_budgeted = sum(v["budgeted"] for v in summary.values())
    total_spent = sum(v["spent"] for v in summary.values())
    return {"by_category": summary, "total_budgeted": total_budgeted,
            "total_spent": total_spent, "remaining": total_budgeted - total_spent}


# ---------- Contacts ----------

def add_contact(name: str, role: str, phone: str = "", location: str = "", notes: str = "") -> dict:
    """Add a local contact (driver, host, emergency contact, on-ground person)."""
    conn = get_conn()
    conn.execute("INSERT INTO contacts (name, role, phone, location, notes) VALUES (?,?,?,?,?)",
                 (name, role, phone, location, notes))
    conn.commit()
    conn.close()
    return {"status": "added"}


def get_contacts(location: str = None) -> dict:
    """Fetch saved contacts, optionally filtered by location."""
    conn = get_conn()
    if location:
        rows = conn.execute("SELECT * FROM contacts WHERE location LIKE ?", (f"%{location}%",)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM contacts").fetchall()
    conn.close()
    return {"contacts": rows_to_list(rows)}


# ---------- Offline lookups (cached, last synced when net was available) ----------

def lookup_cached_pois(location: str, category: str = "") -> dict:
    """Look up points of interest near a location from last-synced offline cache
    (restaurants, sights, ATMs etc). Data freshness = last sync_online.py run."""
    pois = _load_cache("pois")
    results = [p for p in pois.get(location, []) if not category or p.get("category") == category]
    return {"results": results, "note": "from offline cache, may be stale"}


def lookup_cached_transit(origin: str, destination: str) -> dict:
    """Look up cached transit/transport options between two places
    (last-known fares/timings, NOT live)."""
    transit = _load_cache("transit")
    key = f"{origin}->{destination}"
    return {"options": transit.get(key, []), "note": "last-known offline data, verify when online"}


def get_cache_freshness() -> dict:
    """Report how old the cached data is — critical before trusting it for a decision."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1").fetchone()
    conn.close()
    if not row:
        return {"synced": False, "message": "Never synced. Cached data may not exist or be from setup only."}
    import time as t
    age_hrs = (t.time() - row["synced_at"]) / 3600
    return {"synced": True, "last_sync_hours_ago": round(age_hrs, 1), "source": row["source"]}


# ---------- Discovered places (from social media agent, pending user approval) ----------

def get_pending_discoveries(near_location: str = None) -> dict:
    """Get lesser-known places found by the discovery agent that are awaiting your yes/no."""
    conn = get_conn()
    if near_location:
        rows = conn.execute(
            "SELECT * FROM discovered_places WHERE status='pending' AND near_location LIKE ?",
            (f"%{near_location}%",)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM discovered_places WHERE status='pending'").fetchall()
    conn.close()
    return {"pending": rows_to_list(rows)}


def approve_discovery(discovery_id: int, day: int, time_slot: str = "") -> dict:
    """User approved a discovered place — mark approved AND add it to the itinerary."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM discovered_places WHERE id=?", (discovery_id,)).fetchone()
    if not row:
        conn.close()
        return {"error": "not found"}
    conn.execute("UPDATE discovered_places SET status='approved' WHERE id=?", (discovery_id,))
    conn.commit()
    conn.close()
    add_itinerary_item(day=day, activity=row["name"], time_slot=time_slot,
                        location=row["near_location"],
                        notes=f"discovered via {row['source']}: {row['description']}")
    return {"status": "approved_and_added"}


def reject_discovery(discovery_id: int) -> dict:
    """User said no to a discovered place."""
    conn = get_conn()
    conn.execute("UPDATE discovered_places SET status='rejected' WHERE id=?", (discovery_id,))
    conn.commit()
    conn.close()
    return {"status": "rejected"}


# ---------- Contingency planning ----------

def generate_contingency(trigger_event: str, original_plan: str, alternate_plan: str) -> dict:
    """Record a contingency decision — e.g. original plan disrupted, what was substituted instead.
    This is a LOG action; the model must decide the alternate_plan itself using itinerary +
    cached data + contacts already available, since no live data exists offline."""
    conn = get_conn()
    conn.execute(
        "INSERT INTO contingencies (trigger_event, original_plan, alternate_plan, created_at) VALUES (?,?,?,?)",
        (trigger_event, original_plan, alternate_plan, now())
    )
    conn.commit()
    conn.close()
    return {"status": "logged"}


# ---------- Tool schema (OpenAI/Ollama function-calling format) ----------

TOOL_FUNCTIONS = {
    "add_itinerary_item": add_itinerary_item,
    "update_itinerary_item": update_itinerary_item,
    "get_itinerary": get_itinerary,
    "remove_itinerary_item": remove_itinerary_item,
    "set_budget": set_budget,
    "log_expense": log_expense,
    "get_budget_summary": get_budget_summary,
    "add_contact": add_contact,
    "get_contacts": get_contacts,
    "lookup_cached_pois": lookup_cached_pois,
    "lookup_cached_transit": lookup_cached_transit,
    "get_cache_freshness": get_cache_freshness,
    "generate_contingency": generate_contingency,
    "get_pending_discoveries": get_pending_discoveries,
    "approve_discovery": approve_discovery,
    "reject_discovery": reject_discovery,
}

TOOL_SCHEMA = [
    {"type": "function", "function": {"name": "add_itinerary_item", "description": add_itinerary_item.__doc__,
     "parameters": {"type": "object", "properties": {
         "day": {"type": "integer"}, "activity": {"type": "string"}, "time_slot": {"type": "string"},
         "location": {"type": "string"}, "cost_est": {"type": "number"}, "notes": {"type": "string"}
     }, "required": ["day", "activity"]}}},
    {"type": "function", "function": {"name": "update_itinerary_item", "description": update_itinerary_item.__doc__,
     "parameters": {"type": "object", "properties": {
         "item_id": {"type": "integer"}, "status": {"type": "string"}, "activity": {"type": "string"},
         "time_slot": {"type": "string"}, "notes": {"type": "string"}
     }, "required": ["item_id"]}}},
    {"type": "function", "function": {"name": "get_itinerary", "description": get_itinerary.__doc__,
     "parameters": {"type": "object", "properties": {"day": {"type": "integer"}}}}},
    {"type": "function", "function": {"name": "remove_itinerary_item", "description": remove_itinerary_item.__doc__,
     "parameters": {"type": "object", "properties": {"item_id": {"type": "integer"}}, "required": ["item_id"]}}},
    {"type": "function", "function": {"name": "set_budget", "description": set_budget.__doc__,
     "parameters": {"type": "object", "properties": {
         "category": {"type": "string"}, "amount": {"type": "number"}, "label": {"type": "string"}
     }, "required": ["category", "amount"]}}},
    {"type": "function", "function": {"name": "log_expense", "description": log_expense.__doc__,
     "parameters": {"type": "object", "properties": {
         "category": {"type": "string"}, "amount": {"type": "number"}, "label": {"type": "string"}
     }, "required": ["category", "amount"]}}},
    {"type": "function", "function": {"name": "get_budget_summary", "description": get_budget_summary.__doc__,
     "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "add_contact", "description": add_contact.__doc__,
     "parameters": {"type": "object", "properties": {
         "name": {"type": "string"}, "role": {"type": "string"}, "phone": {"type": "string"},
         "location": {"type": "string"}, "notes": {"type": "string"}
     }, "required": ["name", "role"]}}},
    {"type": "function", "function": {"name": "get_contacts", "description": get_contacts.__doc__,
     "parameters": {"type": "object", "properties": {"location": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "lookup_cached_pois", "description": lookup_cached_pois.__doc__,
     "parameters": {"type": "object", "properties": {
         "location": {"type": "string"}, "category": {"type": "string"}
     }, "required": ["location"]}}},
    {"type": "function", "function": {"name": "lookup_cached_transit", "description": lookup_cached_transit.__doc__,
     "parameters": {"type": "object", "properties": {
         "origin": {"type": "string"}, "destination": {"type": "string"}
     }, "required": ["origin", "destination"]}}},
    {"type": "function", "function": {"name": "get_cache_freshness", "description": get_cache_freshness.__doc__,
     "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "generate_contingency", "description": generate_contingency.__doc__,
     "parameters": {"type": "object", "properties": {
         "trigger_event": {"type": "string"}, "original_plan": {"type": "string"}, "alternate_plan": {"type": "string"}
     }, "required": ["trigger_event", "original_plan", "alternate_plan"]}}},
    {"type": "function", "function": {"name": "get_pending_discoveries", "description": get_pending_discoveries.__doc__,
     "parameters": {"type": "object", "properties": {"near_location": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "approve_discovery", "description": approve_discovery.__doc__,
     "parameters": {"type": "object", "properties": {
         "discovery_id": {"type": "integer"}, "day": {"type": "integer"}, "time_slot": {"type": "string"}
     }, "required": ["discovery_id", "day"]}}},
    {"type": "function", "function": {"name": "reject_discovery", "description": reject_discovery.__doc__,
     "parameters": {"type": "object", "properties": {"discovery_id": {"type": "integer"}},
     "required": ["discovery_id"]}}},
]
