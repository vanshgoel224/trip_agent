"""
Local trip state store. Zero network dependency.
Single file SQLite DB at ~/trip_agent/trip.db (phone-local, survives no-signal zones).
"""
import sqlite3
import json
import os
import time

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trip.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS itinerary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day INTEGER NOT NULL,
    time_slot TEXT,               -- e.g. "09:00" or "morning"
    activity TEXT NOT NULL,
    location TEXT,
    cost_est REAL DEFAULT 0,
    status TEXT DEFAULT 'planned',   -- planned/done/cancelled/skipped
    notes TEXT,
    created_at REAL,
    updated_at REAL
);

CREATE TABLE IF NOT EXISTS budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,       -- transport/stay/food/misc
    label TEXT,
    amount REAL NOT NULL,
    kind TEXT NOT NULL,           -- 'budgeted' or 'spent'
    created_at REAL
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    role TEXT,          -- local contact, driver, hotel, emergency
    phone TEXT,
    location TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS contingencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_event TEXT,     -- e.g. "bus cancelled", "rain", "place closed"
    original_plan TEXT,
    alternate_plan TEXT,
    created_at REAL
);

CREATE TABLE IF NOT EXISTS discovered_places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    near_location TEXT,        -- which trip city/area this was found near
    description TEXT,
    source TEXT,                -- 'reddit' or 'youtube'
    source_url TEXT,
    status TEXT DEFAULT 'pending',  -- pending/approved/rejected
    created_at REAL
);

CREATE TABLE IF NOT EXISTS raw_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT,
    params_hash TEXT,
    response_json TEXT,
    fetched_at REAL
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at REAL,
    source TEXT,
    summary TEXT
);
"""

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()

def now():
    return time.time()

def rows_to_list(rows):
    return [dict(r) for r in rows]

init_db()
