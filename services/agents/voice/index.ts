// Voice agent — Gnani speech I/O, readback of autonomous actions,
// disruption notifications, confirmation prompts, voice translation (spec §4.5).
import type { Traveller, TripState } from "../../../packages/domain";
import type { Store } from "../../../packages/db";
import { id, nowIso } from "../../../packages/shared";
import { bus } from "../../../packages/events";
import type { AgentMcp } from "../../mcp/client";
import type { VoiceProvider } from "../../integrations/gnani";
import { getRuntime } from "../../orchestrator/authority";

export type Utterance = {
  utteranceId: string;
  tripId: string;
  incidentId?: string;
  to: "TRAVELLER" | "EMERGENCY_CONTACT";
  text: string;
  language: string;
  channel: "GNANI" | "DEVICE_TTS" | "BLOCKED";
  kind: string;
  audioUrl?: string; // set when Gnani returned real audio
  at: string;
};

/** Recent synthesized audio, served at /api/voice/audio/:id. RAM only (spec §20). */
export const audioCache = new Map<string, { mime: string; data: Buffer; at: number }>();
function cacheAudio(b64: string, mime: string) {
  const key = id("AUD");
  audioCache.set(key, { mime, data: Buffer.from(b64, "base64"), at: Date.now() });
  for (const [k, v] of audioCache) if (Date.now() - v.at > 30 * 60_000) audioCache.delete(k);
  return `/api/voice/audio/${key}`;
}

export class VoiceAgent {
  constructor(private store: Store, private mcp: AgentMcp, private provider: VoiceProvider) {}

  get live() {
    return this.provider.live;
  }

  private language(tripId: string) {
    const t = this.store.get<TripState>("trips", tripId);
    return (t && this.store.get<Traveller>("users", t.travellerId)?.preferredLanguage) ?? "en-IN";
  }

  async say(tripId: string, text: string, opts: { incidentId?: string; kind?: string; to?: Utterance["to"]; approvalId?: string; language?: string } = {}): Promise<Utterance> {
    const to = opts.to ?? "TRAVELLER";
    const language = opts.language ?? this.language(tripId);
    let channel: Utterance["channel"];
    let audioUrl: string | undefined;
    if (!getRuntime(this.store, tripId).online) {
      channel = "DEVICE_TTS"; // offline: Gnani unreachable; the phone speaks locally
    } else {
      const r = await this.mcp.call("voice_speak", { tripId, incidentId: opts.incidentId, text, language, to }, opts.approvalId ? { approval: { approvalId: opts.approvalId } } : undefined);
      channel = r.success ? "GNANI" : "BLOCKED";
      const d = r.data as { audioBase64?: string; mime?: string } | undefined;
      if (d?.audioBase64) audioUrl = cacheAudio(d.audioBase64, d.mime ?? "audio/mpeg");
    }
    const u: Utterance = { utteranceId: id("UTT"), tripId, incidentId: opts.incidentId, to, text, language, channel, kind: opts.kind ?? "INFO", audioUrl, at: nowIso() };
    // Stored as offline_cache "notes" so the phone can replay text without signal (audio stays in RAM).
    this.store.put("offline_cache", u.utteranceId, { type: "VOICE_NOTE", ...u, audioUrl: undefined }, { tripId, incidentId: opts.incidentId, key: "VOICE" });
    bus.emitEvent({ tripId, incidentId: opts.incidentId, agent: "voice", type: "VOICE", detail: text, data: u });
    return u;
  }

  /** Direct TTS without a trip (translator). Returns audio URL when Gnani is live. */
  async synthesize(text: string, language: string): Promise<{ audioUrl?: string; channel: string }> {
    if (!this.provider.live) return { channel: "BROWSER_TTS" };
    const r = await this.provider.speak(text, language, "TRAVELLER");
    return r.audioBase64 ? { audioUrl: cacheAudio(r.audioBase64, r.mime ?? "audio/mpeg"), channel: "GNANI" } : { channel: "GNANI" };
  }

  /** Gnani STT when live; otherwise the browser already sent text. */
  async transcribe(input: { text?: string; audioBase64?: string; mime?: string }, language: string) {
    if (input.text && !input.audioBase64) return { text: input.text, channel: "BROWSER_STT" };
    if (!this.provider.live) throw new Error("Server speech-to-text needs GNANI_API_KEY; the browser's own recognition is used instead");
    return { text: await this.provider.transcribe(input, language), channel: "GNANI" };
  }

  transcript(tripId: string): Utterance[] {
    return this.store.list<Utterance & { type: string }>("offline_cache", { tripId, key: "VOICE" });
  }
}
