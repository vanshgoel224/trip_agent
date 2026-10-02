// Gnani (Vachana) — voice I/O, Indian-language interaction, autonomous-action readback (spec §7).
// Live contract taken from Gnani's official Python SDK `gnani-vachana` 0.7.9:
//   TTS  POST {base}/api/v1/tts/inference  JSON  -> binary audio
//   STT  POST {base}/stt/v3                multipart(audio_file, language_code, format) -> {transcript}
//   auth header: X-API-Key-ID ; optional X-API-Request-ID
// Not yet exercised with a real key; verify against docs.gnani.ai when you get one.
import { randomUUID } from "node:crypto";
import { BiruniError } from "../../../packages/shared";

export type SpeakResult = {
  channel: "GNANI" | "DEVICE_TTS";
  text: string;
  language: string;
  to: string;
  audioBase64?: string; // mp3, when Gnani produced real audio
  mime?: string;
};

export interface VoiceProvider {
  readonly live: boolean;
  speak(text: string, language: string, to: string): Promise<SpeakResult>;
  transcribe(input: { text?: string; audioBase64?: string; mime?: string }, language: string): Promise<string>;
}

export class MockGnaniProvider implements VoiceProvider {
  readonly live = false;
  spoken: SpeakResult[] = [];
  async speak(text: string, language: string, to: string) {
    // The browser plays this via the Web Speech API as a stand-in for Gnani audio.
    const r: SpeakResult = { channel: "GNANI", text, language, to };
    this.spoken.push(r);
    return r;
  }
  async transcribe(input: { text?: string }) {
    return input.text ?? "";
  }
}

// timbre-v2.5 voices per language, from the SDK's voice catalogue.
const VOICES: Record<string, string> = {
  "hi-IN": "Nalini", "en-IN": "Kaveri", "ta-IN": "Asmita", "te-IN": "Suhana", "kn-IN": "Saanvi",
  "ml-IN": "Reshma", "mr-IN": "Zahira", "bn-IN": "Kirra", "gu-IN": "Falak", "pa-IN": "Mehuli",
};
const STT_LANGS = new Set(["en-IN", "hi-IN", "gu-IN", "ta-IN", "kn-IN", "te-IN", "mr-IN", "bn-IN", "ml-IN", "pa-IN"]);
const looksHinglish = (t: string) => /\b(hai|kya|nahi|mera|meri|kar|raha|rahi|gaya|gayi|ho|bhai|yaar|chalo)\b/i.test(t) && !/[ऀ-ॿ]/.test(t);

export class GnaniProvider implements VoiceProvider {
  readonly live = true;
  private base = (process.env.GNANI_API_URL || "https://api.vachana.ai").replace(/\/$/, "");
  constructor(private key = process.env.GNANI_API_KEY) {
    if (!key) throw new BiruniError("AUTH_FAILURE", "missing server-side env: GNANI_API_KEY");
  }
  private headers(extra: Record<string, string> = {}) {
    return { "X-API-Key-ID": this.key!, "X-API-Request-ID": randomUUID(), ...extra };
  }

  async speak(text: string, language: string, to: string): Promise<SpeakResult> {
    const voice = looksHinglish(text) ? "Poorvi" : VOICES[language] ?? "Kaveri";
    const res = await fetch(`${this.base}/api/v1/tts/inference`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        text: text.slice(0, 1000),
        model: "timbre-v2.5",
        voice,
        language: VOICES[language] ? language : undefined,
        speed: 1.0,
        audio_config: { sample_rate: 24000, encoding: "linear_pcm", num_channels: 1, sample_width: 2, container: "mp3", bitrate: "64k" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new BiruniError(res.status === 401 || res.status === 403 ? "AUTH_FAILURE" : "EXTERNAL_FAILURE", `Gnani TTS HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, res.status >= 500);
    const audio = Buffer.from(await res.arrayBuffer());
    return { channel: "GNANI", text, language, to, audioBase64: audio.toString("base64"), mime: "audio/mpeg" };
  }

  async transcribe(input: { text?: string; audioBase64?: string; mime?: string }, language: string): Promise<string> {
    if (!input.audioBase64) return input.text ?? "";
    const form = new FormData();
    const ext = input.mime?.includes("webm") ? "webm" : input.mime?.includes("ogg") ? "ogg" : input.mime?.includes("mp4") ? "m4a" : "wav";
    form.append("audio_file", new Blob([Buffer.from(input.audioBase64, "base64")], { type: input.mime ?? "audio/wav" }), `speech.${ext}`);
    form.append("language_code", STT_LANGS.has(language) ? language : "en-IN");
    form.append("format", "verbatim");
    const res = await fetch(`${this.base}/stt/v3`, { method: "POST", headers: this.headers(), body: form, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Gnani STT HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, res.status >= 500);
    const j = (await res.json()) as { success?: boolean; transcript?: string };
    return j.transcript ?? "";
  }
}
