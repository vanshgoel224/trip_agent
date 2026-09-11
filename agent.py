"""
Offline trip-planning agent. Talks ONLY to localhost Ollama — zero external calls
in this file. Run: python agent.py
"""
import json
import socket
import requests
from tools import TOOL_FUNCTIONS, TOOL_SCHEMA

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "qwen2.5:3b-instruct"   # swap for phi3.5:3.8b if tool-calling is flaky on qwen build

SYSTEM_PROMPT = """You are an offline trip-planning and execution assistant running entirely \
on the user's phone with no internet connection. You manage itinerary, budget, contacts, and \
contingency replanning using ONLY local tools — you have no live internet data.

Rules:
- You do NOT have live prices, live availability, or live transit status. Any cached data \
(lookup_cached_pois, lookup_cached_transit) may be stale — always check get_cache_freshness \
and tell the user the data's age before relying on it for a decision.
- When something changes last-minute (a plan is cancelled, place is shut, weather turns bad), \
use get_itinerary + lookup_cached_* + get_contacts to construct the best alternative from what's \
already known, update the itinerary with update_itinerary_item, and log the change with \
generate_contingency. Be decisive — the user needs an answer, not a hedge, but be upfront that \
it's based on cached/local info, not live data.
- Keep answers short and actionable. This is a phone screen, not a laptop.
- If the user asks something that needs live internet data you genuinely don't have (e.g. \
"is this flight still available"), say so plainly instead of guessing.
- A separate discovery agent (discover.py, run when online) finds lesser-known places from \
Reddit/YouTube and stores them as pending. When the user asks about a location, or when \
building/reviewing itinerary for a location, check get_pending_discoveries for that area. \
ALWAYS ask the user yes/no before calling approve_discovery — never add a discovered place \
to the itinerary without explicit confirmation. If they say no, call reject_discovery.
"""


def is_online(timeout=1.5) -> bool:
    """Best-effort connectivity check. Used only to warn the user, never blocks anything."""
    try:
        socket.setdefaulttimeout(timeout)
        socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect(("1.1.1.1", 53))
        return True
    except OSError:
        return False


def call_ollama(messages):
    resp = requests.post(OLLAMA_URL, json={
        "model": MODEL,
        "messages": messages,
        "tools": TOOL_SCHEMA,
        "stream": False,
    }, timeout=120)
    resp.raise_for_status()
    return resp.json()


def run_turn(messages):
    """Runs one user turn to completion, including any tool-call loops."""
    while True:
        data = call_ollama(messages)
        msg = data["message"]
        messages.append(msg)

        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return msg.get("content", "")

        for tc in tool_calls:
            fn_name = tc["function"]["name"]
            args = tc["function"].get("arguments", {})
            if isinstance(args, str):
                args = json.loads(args)
            fn = TOOL_FUNCTIONS.get(fn_name)
            if fn is None:
                result = {"error": f"unknown tool {fn_name}"}
            else:
                try:
                    result = fn(**args)
                except Exception as e:
                    result = {"error": str(e)}
            messages.append({"role": "tool", "content": json.dumps(result)})


def main():
    print("Offline Trip Agent — Ctrl+C to quit")
    online = is_online()
    print(f"[connectivity: {'ONLINE' if online else 'OFFLINE'}]")
    if online:
        print("Tip: run `python sync_online.py` first to refresh cached data before going offline.")

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    while True:
        try:
            user_in = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_in:
            continue
        messages.append({"role": "user", "content": user_in})
        reply = run_turn(messages)
        print(f"\nagent> {reply}")


if __name__ == "__main__":
    main()
