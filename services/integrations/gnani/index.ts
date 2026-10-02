// Gnani — voice I/O, Indian-language interaction, autonomous-action readback (spec §7).
import { notImplemented, requireEnv } from "../live-stub";

export type SpeakResult = { channel: "GNANI" | "DEVICE_TTS"; text: string; language: string; to: string; audioUrl?: string };

export interface VoiceProvider {
  speak(text: string, language: string, to: string): Promise<SpeakResult>;
  transcribe(input: { text?: string; audioBase64?: string }, language: string): Promise<string>;
}

export class MockGnaniProvider implements VoiceProvider {
  spoken: SpeakResult[] = [];
  async speak(text: string, language: string, to: string) {
    // The browser demo plays this via the Web Speech API as a stand-in for Gnani audio.
    const r: SpeakResult = { channel: "GNANI", text, language, to };
    this.spoken.push(r);
    return r;
  }
  async transcribe(input: { text?: string }) {
    return input.text ?? "";
  }
}

export class GnaniProvider implements VoiceProvider {
  constructor() {
    requireEnv("GNANI_API_KEY", "GNANI_API_URL");
  }
  speak(): Promise<SpeakResult> {
    return notImplemented("gnani", "speak");
  }
  transcribe(): Promise<string> {
    return notImplemented("gnani", "transcribe");
  }
}
