"""
Discovery agent: finds lesser-known places from Reddit + YouTube for a given
trip location, extracts candidate places using the LOCAL Ollama model, and
stores them as 'pending' — the main agent surfaces these and asks you yes/no
before anything touches the itinerary.

Network calls happen here only (fetch step). Extraction uses local Ollama
(no cloud LLM call). Run whenever you have signal.

NOTE on Reddit: uses public read-only .json endpoints, no login required.
Fine for personal/low-volume prototype use. For anything beyond that, register
a proper Reddit API app (https://www.reddit.com/prefs/apps) and use OAuth —
the public JSON endpoints are rate-limited and not meant for sustained/commercial use.

NOTE on YouTube: uses the official YouTube Data API v3. Needs a free API key
from Google Cloud Console. Has a daily free quota (~100 search units/day on
default quota — each search costs 100 units, so budget ~1 search per key per day
unless you request a quota increase).
"""
import json
import time
import hashlib
import requests
from db import get_conn, now

YOUTUBE_API_KEY = __import__("os").environ.get("YOUTUBE_API_KEY", "")
REDDIT_HEADERS = {"User-Agent": "trip-agent-prototype/0.1 (personal use)"}
OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "qwen2.5:3b-instruct"


def _cache_raw(endpoint, params, response_obj):
    conn = get_conn()
    params_hash = hashlib.md5(json.dumps(params, sort_keys=True).encode()).hexdigest()
    conn.execute(
        "INSERT INTO raw_responses (endpoint, params_hash, response_json, fetched_at) VALUES (?,?,?,?)",
        (endpoint, params_hash, json.dumps(response_obj), now())
    )
    conn.commit()
    conn.close()


def fetch_reddit(query: str, subreddits=("IndiaTravel", "india", "backpacking")) -> list:
    """Public read-only search, no auth. Returns list of {title, text, url}."""
    results = []
    for sub in subreddits:
        url = f"https://www.reddit.com/r/{sub}/search.json"
        params = {"q": query, "restrict_sr": 1, "sort": "relevance", "limit": 10}
        try:
            r = requests.get(url, params=params, headers=REDDIT_HEADERS, timeout=20)
            r.raise_for_status()
            data = r.json()
            _cache_raw(url, params, data)
            for child in data.get("data", {}).get("children", []):
                d = child.get("data", {})
                results.append({
                    "title": d.get("title", ""),
                    "text": d.get("selftext", "")[:2000],
                    "url": f"https://reddit.com{d.get('permalink', '')}",
                })
        except Exception as e:
            print(f"  reddit fetch failed for r/{sub}: {e}")
        time.sleep(2)  # rate-limit courtesy — public endpoint, don't hammer it
    return results


def fetch_youtube(query: str, max_results: int = 5) -> list:
    """Official API, needs key. Costs quota — call sparingly."""
    if not YOUTUBE_API_KEY:
        print("  no YOUTUBE_API_KEY set, skipping youtube")
        return []
    url = "https://www.googleapis.com/youtube/v3/search"
    params = {
        "part": "snippet", "q": query, "type": "video",
        "maxResults": max_results, "key": YOUTUBE_API_KEY,
    }
    try:
        r = requests.get(url, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        _cache_raw(url, params, data)
        return [{
            "title": item["snippet"]["title"],
            "text": item["snippet"]["description"][:1000],
            "url": f"https://youtube.com/watch?v={item['id']['videoId']}",
        } for item in data.get("items", [])]
    except Exception as e:
        print(f"  youtube fetch failed: {e}")
        return []


def extract_places_via_local_model(raw_texts: list, near_location: str) -> list:
    """Uses the LOCAL Ollama model (no cloud call) to pull candidate place names
    out of scraped text. Returns list of {name, description}."""
    combined = "\n---\n".join(f"{t['title']}\n{t['text']}" for t in raw_texts)[:6000]
    prompt = f"""From the text below (Reddit/YouTube content about travel near {near_location}, India), \
extract SPECIFIC lesser-known places (not famous landmarks already on every tourist list) — \
viewpoints, local eateries, offbeat spots, hidden trails, etc.

Return ONLY a JSON array like:
[{{"name": "...", "description": "one line why it's worth visiting"}}]
If nothing genuinely lesser-known is mentioned, return [].

TEXT:
{combined}
"""
    resp = requests.post(OLLAMA_URL, json={
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }, timeout=120)
    resp.raise_for_status()
    content = resp.json()["message"]["content"]
    try:
        start = content.index("[")
        end = content.rindex("]") + 1
        return json.loads(content[start:end])
    except (ValueError, json.JSONDecodeError):
        print("  extraction: model did not return clean JSON, skipping this batch")
        return []


def discover(near_location: str, query: str = None):
    """Full pipeline: fetch (online) -> extract (local model) -> store as pending."""
    query = query or f"hidden gems offbeat places near {near_location}"
    print(f"Fetching social content for: {query}")
    raw = fetch_reddit(query) + fetch_youtube(query)
    if not raw:
        print("Nothing fetched — check connectivity / API keys.")
        return
    print(f"Fetched {len(raw)} items. Extracting candidate places via local model...")
    places = extract_places_via_local_model(raw, near_location)

    conn = get_conn()
    added = 0
    for p in places:
        existing = conn.execute(
            "SELECT id FROM discovered_places WHERE name=? AND near_location=?",
            (p["name"], near_location)).fetchone()
        if existing:
            continue
        conn.execute(
            "INSERT INTO discovered_places (name, near_location, description, source, source_url, status, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (p["name"], near_location, p.get("description", ""), "reddit/youtube", "", "pending", now())
        )
        added += 1
    conn.commit()
    conn.close()
    print(f"Added {added} new pending discoveries near {near_location}. "
          f"Ask the agent 'any hidden spots near {near_location}?' to review them.")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python discover.py <location_name> [search query]")
        sys.exit(1)
    loc = sys.argv[1]
    q = sys.argv[2] if len(sys.argv) > 2 else None
    discover(loc, q)
