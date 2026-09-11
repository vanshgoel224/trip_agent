"""
Run this WHENEVER you have signal (before the trip, at a hotel wifi, etc) to refresh
the offline cache the agent uses when there's no signal. This is the ONLY file in the
project that makes network calls.

Plug in your own API keys below. Left as stubs since keys are user-specific.
Suggested free/cheap APIs for India trip data:
  - POIs: OpenStreetMap Overpass API (free, no key) or Google Places API (key needed)
  - Transit: your transport API of choice (e.g. IRCTC unofficial APIs, redBus, etc — varies)
  - Weather: OpenWeatherMap (free tier, key needed) — cache next 5 days before losing signal
"""
import json
import os
import time
import requests

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cached_data")
os.makedirs(CACHE_DIR, exist_ok=True)

# ---- FILL THESE IN ----
GOOGLE_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")
OPENWEATHER_API_KEY = os.environ.get("OPENWEATHER_API_KEY", "")
# ------------------------


def save_cache(name, data):
    with open(os.path.join(CACHE_DIR, f"{name}.json"), "w") as f:
        json.dump(data, f, indent=2)


def fetch_pois_osm(location: str, lat: float, lon: float, radius_m: int = 3000) -> list:
    """Free, no API key. Pulls tourist/food/ATM POIs near a point via Overpass API."""
    query = f"""
    [out:json][timeout:25];
    (
      node["tourism"](around:{radius_m},{lat},{lon});
      node["amenity"~"restaurant|atm|hospital|pharmacy"](around:{radius_m},{lat},{lon});
    );
    out body;
    """
    r = requests.post("https://overpass-api.de/api/interpreter", data={"data": query}, timeout=60)
    r.raise_for_status()
    elements = r.json().get("elements", [])
    results = []
    for el in elements:
        tags = el.get("tags", {})
        if "name" not in tags:
            continue
        results.append({
            "name": tags["name"],
            "category": tags.get("tourism") or tags.get("amenity", "poi"),
            "lat": el.get("lat"), "lon": el.get("lon"),
        })
    return results


def fetch_weather(lat: float, lon: float) -> dict:
    if not OPENWEATHER_API_KEY:
        return {"error": "no OPENWEATHER_API_KEY set, skipped"}
    r = requests.get("https://api.openweathermap.org/data/2.5/forecast", params={
        "lat": lat, "lon": lon, "appid": OPENWEATHER_API_KEY, "units": "metric"
    }, timeout=30)
    r.raise_for_status()
    return r.json()


def sync(locations: list):
    """locations: list of dicts like {"name": "Rishikesh", "lat": 30.0869, "lon": 78.2676}"""
    from db import get_conn, now

    pois_cache = {}
    weather_cache = {}
    for loc in locations:
        print(f"Syncing {loc['name']}...")
        try:
            pois_cache[loc["name"]] = fetch_pois_osm(loc["name"], loc["lat"], loc["lon"])
        except Exception as e:
            print(f"  POI fetch failed: {e}")
        try:
            weather_cache[loc["name"]] = fetch_weather(loc["lat"], loc["lon"])
        except Exception as e:
            print(f"  Weather fetch failed: {e}")
        time.sleep(1)  # be polite to free APIs

    save_cache("pois", pois_cache)
    save_cache("weather", weather_cache)

    # transit.json is intentionally left to be filled manually or via a
    # transport-specific API you have keys for — format:
    # {"CityA->CityB": [{"mode": "bus", "operator": "...", "fare_est": 350, "duration_hr": 4}]}
    if not os.path.exists(os.path.join(CACHE_DIR, "transit.json")):
        save_cache("transit", {})

    conn = get_conn()
    conn.execute("INSERT INTO sync_log (synced_at, source, summary) VALUES (?,?,?)",
                 (now(), "sync_online.py", f"synced {len(locations)} locations"))
    conn.commit()
    conn.close()
    print("Sync complete. Safe to go offline now.")


if __name__ == "__main__":
    # EDIT THIS LIST with your actual trip stops before running.
    LOCATIONS = [
        {"name": "Rishikesh", "lat": 30.0869, "lon": 78.2676},
    ]
    sync(LOCATIONS)
