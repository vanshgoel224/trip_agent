// RAM layer (spec §20): current conversation + temporary execution state.
// Cleared at the end of every session. Cloud (Store) is the source of truth;
// ROM is the offline_cache table pre-fetched before departure.
export type Turn = { role: "traveller" | "biruni"; text: string; at: string };

export class SessionMemory {
  private sessions = new Map<string, { turns: Turn[]; scratch: Record<string, unknown> }>();

  get(tripId: string) {
    let s = this.sessions.get(tripId);
    if (!s) this.sessions.set(tripId, (s = { turns: [], scratch: {} }));
    return s;
  }
  push(tripId: string, t: Turn) {
    const s = this.get(tripId);
    s.turns.push(t);
    if (s.turns.length > 50) s.turns.shift();
  }
  end(tripId: string) {
    this.sessions.delete(tripId);
  }
  size() {
    return this.sessions.size;
  }
}
