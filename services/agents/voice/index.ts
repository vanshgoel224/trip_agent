// Voice agent — Gnani speech I/O, readback of autonomous actions,
// disruption notifications, confirmation prompts (spec §4.5).
import type { Traveller, TripState } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { id, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { AgentMcp } from "../../mcp/client";
import { getRuntime } from "../../orchestrator/authority";

export type Utterance = { utteranceId: string; tripId: string; incidentId?: string; to: "TRAVELLER" | "EMERGENCY_CONTACT"; text: string; channel: "GNANI" | "DEVICE_TTS" | "BLOCKED"; kind: string; at: string };

export class VoiceAgent {
  constructor(private store: Store, private mcp: AgentMcp) {}

  private language(tripId: string) {
    const t = this.store.get<TripState>("trips", tripId)!;
    return this.store.get<Traveller>("users", t.travellerId)?.preferredLanguage ?? "en-IN";
  }

  async say(tripId: string, text: string, opts: { incidentId?: string; kind?: string; to?: Utterance["to"]; approvalId?: string } = {}): Promise<Utterance> {
    const to = opts.to ?? "TRAVELLER";
    let channel: Utterance["channel"];
    if (!getRuntime(this.store, tripId).online) {
      // Offline: Gnani is unreachable; the on-device model relays via local TTS.
      channel = "DEVICE_TTS";
    } else {
      const r = await this.mcp.call(
        "voice_speak",
        { tripId, incidentId: opts.incidentId, text, language: this.language(tripId), to },
        opts.approvalId ? { approval: { approvalId: opts.approvalId } } : undefined,
      );
      channel = r.success ? "GNANI" : "BLOCKED";
    }
    const u: Utterance = { utteranceId: id("UTT"), tripId, incidentId: opts.incidentId, to, text, channel, kind: opts.kind ?? "INFO", at: nowIso() };
    // Stored as offline_cache "notes" so the phone can replay them without signal.
    this.store.put("offline_cache", u.utteranceId, { type: "VOICE_NOTE", ...u }, { tripId, incidentId: opts.incidentId, key: "VOICE" });
    bus.emitEvent({ tripId, incidentId: opts.incidentId, agent: "voice", type: "VOICE", detail: text, data: u });
    return u;
  }

  transcript(tripId: string): Utterance[] {
    return this.store.list<Utterance & { type: string }>("offline_cache", { tripId, key: "VOICE" });
  }
}
