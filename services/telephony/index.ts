// Telephony through Exotel (Indian numbers, ExoPhones).
//   SMS:   POST https://<key>:<token>@<subdomain>/v1/Accounts/<sid>/Sms/send   (From, To, Body)
//   Call:  POST https://<key>:<token>@<subdomain>/v1/Accounts/<sid>/Calls/connect
//          From=<their number>, CallerId=<your ExoPhone>, Url=<your call flow with a
//          Voicebot/Stream applet pointing at wss://<your host>/telephony/exotel/stream/<secret>>
//   Media: the applet streams 8 kHz 16-bit mono PCM as base64 JSON frames
//          (events connected/start/media/stop); we answer with media frames.
// Endpoint shapes follow Exotel's public v1 API and Voicebot applet docs as I know them.
// Verify against developer.exotel.com with your account before relying on them.
// India: promotional/transactional SMS need DLT registration (TRAI); calls need a
// KYC'd ExoPhone. Without EXOTEL_* keys, SMS and calls run in simulated mode and say so.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { bus } from "../../packages/events";
import { BiruniError } from "../../packages/shared";
import type { Deal, Negotiator } from "../negotiator";
import { RATE, Vad, wav, wavToPcm8k } from "./audio";

export type SpeechIO = {
  live: boolean;
  /** 8 kHz PCM16 mono → text */
  stt(pcm8k: Buffer, language: string): Promise<string>;
  /** text → 8 kHz PCM16 mono */
  tts(text: string, language: string): Promise<Buffer>;
};

/** Gnani speech for calls. TTS is requested as 8 kHz WAV; verify Gnani supports that container. */
export function gnaniSpeech(): SpeechIO {
  const key = process.env.GNANI_API_KEY;
  const base = (process.env.GNANI_API_URL || "https://api.vachana.ai").replace(/\/$/, "");
  return {
    live: !!key,
    async stt(pcm, language) {
      if (!key) throw new BiruniError("EXTERNAL_FAILURE", "Phone calls need speech-to-text: set GNANI_API_KEY");
      const form = new FormData();
      form.append("audio_file", new Blob([new Uint8Array(wav(pcm))], { type: "audio/wav" }), "speech.wav");
      form.append("language_code", language);
      form.append("format", "verbatim");
      const res = await fetch(`${base}/stt/v3`, { method: "POST", headers: { "X-API-Key-ID": key }, body: form, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Gnani STT HTTP ${res.status}`);
      return ((await res.json()) as { transcript?: string }).transcript ?? "";
    },
    async tts(text, language) {
      if (!key) throw new BiruniError("EXTERNAL_FAILURE", "Phone calls need text-to-speech: set GNANI_API_KEY");
      const res = await fetch(`${base}/api/v1/tts/inference`, {
        method: "POST",
        headers: { "X-API-Key-ID": key, "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 1000), model: "timbre-v2.5", language, speed: 1.0, audio_config: { sample_rate: RATE, encoding: "linear_pcm", num_channels: 1, sample_width: 2, container: "wav" } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Gnani TTS HTTP ${res.status}`);
      return wavToPcm8k(Buffer.from(await res.arrayBuffer()));
    },
  };
}

type CallRecord = { callSid?: string; dealId: string; to: string; status: string; at: string; simulated: boolean };

export class Telephony {
  private calls: CallRecord[] = [];
  constructor(private d: { negotiator: Negotiator; speech?: SpeechIO }) {}

  private get cfg() {
    const e = process.env;
    return { sid: e.EXOTEL_SID, key: e.EXOTEL_API_KEY, token: e.EXOTEL_API_TOKEN, sub: e.EXOTEL_SUBDOMAIN || "api.exotel.com", callerId: e.EXOTEL_CALLER_ID, flowUrl: e.EXOTEL_FLOW_URL, smsFrom: e.EXOTEL_SMS_FROM || e.EXOTEL_CALLER_ID };
  }
  get live() {
    const c = this.cfg;
    return !!(c.sid && c.key && c.token && c.callerId);
  }
  get speech() {
    return this.d.speech ?? gnaniSpeech();
  }

  status() {
    return {
      provider: "Exotel",
      mode: this.live ? "live" : "simulated (set EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_CALLER_ID)",
      calls: this.live && this.cfg.flowUrl ? "ready" : this.live ? "set EXOTEL_FLOW_URL (call flow with a Voicebot/Stream applet)" : "simulated",
      speech: this.speech.live ? "Gnani" : "needs GNANI_API_KEY for live calls",
      streamPath: process.env.TELEPHONY_WS_SECRET ? "/telephony/exotel/stream/<TELEPHONY_WS_SECRET>" : "set TELEPHONY_WS_SECRET (24+ chars)",
      recentCalls: this.calls.slice(-10),
    };
  }

  private base() {
    const c = this.cfg;
    return { url: `https://${c.sub}/v1/Accounts/${c.sid}`, auth: "Basic " + Buffer.from(`${c.key}:${c.token}`).toString("base64") };
  }

  static normalizePhone(p: string) {
    const d = String(p ?? "").replace(/\D/g, "");
    const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
    if (!/^[6-9]\d{9}$/.test(ten)) throw new BiruniError("INVALID_REQUEST", "Need an Indian mobile number");
    return `0${ten}`; // Exotel accepts 0-prefixed Indian numbers
  }

  async sendSms(to: string, body: string): Promise<string> {
    const num = Telephony.normalizePhone(to);
    if (!this.live) {
      bus.emitEvent({ tripId: "*", agent: "voice", type: "SMS", detail: `SMS (simulated) to ${num.slice(0, 4)}…: ${body.slice(0, 80)}` });
      return "sms: simulated (no Exotel keys), not actually sent";
    }
    const { url, auth } = this.base();
    const res = await fetch(`${url}/Sms/send.json`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: this.cfg.smsFrom!, To: num, Body: body.slice(0, 900), ...(process.env.EXOTEL_DLT_TEMPLATE_ID ? { DltTemplateId: process.env.EXOTEL_DLT_TEMPLATE_ID } : {}), ...(process.env.EXOTEL_DLT_ENTITY_ID ? { DltEntityId: process.env.EXOTEL_DLT_ENTITY_ID } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Exotel SMS HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return "sms: sent via Exotel";
  }

  /** Rings the counterparty; once they answer, the flow's stream applet connects to handleStream. */
  async call(deal: Deal): Promise<string> {
    if (!deal.counterparty.phone) throw new BiruniError("INVALID_REQUEST", "No phone number for this deal");
    const num = Telephony.normalizePhone(deal.counterparty.phone);
    const rec: CallRecord = { dealId: deal.dealId, to: num.slice(0, 4) + "…", status: "initiated", at: new Date().toISOString(), simulated: !this.live };
    this.calls.push(rec);
    if (!this.live || !this.cfg.flowUrl) {
      rec.status = "simulated";
      return "call: simulated (no Exotel keys/flow). Use the relay buttons to play each line on speaker.";
    }
    if (!this.speech.live) throw new BiruniError("EXTERNAL_FAILURE", "Live calls need Gnani speech (GNANI_API_KEY)");
    const { url, auth } = this.base();
    const res = await fetch(`${url}/Calls/connect.json`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: num, CallerId: this.cfg.callerId!, Url: this.cfg.flowUrl!, CustomField: deal.dealId, TimeLimit: "600" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new BiruniError("EXTERNAL_FAILURE", `Exotel call HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json().catch(() => ({}))) as { Call?: { Sid?: string } };
    rec.callSid = j.Call?.Sid;
    rec.status = "ringing";
    return `call: ringing via Exotel${rec.callSid ? ` (${rec.callSid.slice(0, 8)}…)` : ""}`;
  }

  /** Is this upgrade request for our media stream (secret in the path)? */
  static streamAuthorized(req: IncomingMessage) {
    const secret = process.env.TELEPHONY_WS_SECRET ?? "";
    const m = String(req.url ?? "").match(/^\/telephony\/exotel\/stream\/([^/?]+)/);
    if (secret.length < 24 || !m) return false;
    const a = createHash("sha256").update(m[1]).digest(), b = createHash("sha256").update(secret).digest();
    return timingSafeEqual(a, b);
  }

  private dealFor(callSid?: string, custom?: string) {
    const byCustom = custom ? this.d.negotiator.get(custom) : undefined;
    if (byCustom) return byCustom;
    const rec = this.calls.find((c) => c.callSid && c.callSid === callSid) ?? [...this.calls].reverse().find((c) => !c.simulated);
    return rec ? this.d.negotiator.get(rec.dealId) : undefined;
  }

  /**
   * One live call: speak Biruni's line, listen, transcribe, let the negotiator decide,
   * speak the answer. The negotiator's deterministic price policy still decides every price.
   */
  handleStream(ws: WebSocket) {
    const vad = new Vad();
    let streamSid = "";
    let deal: Deal | undefined;
    let busy = Promise.resolve();
    let speakingUntil = 0;
    const speech = this.speech;
    const send = (o: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    const play = async (text: string) => {
      const pcm = await speech.tts(text, deal!.counterparty.language);
      for (let i = 0; i < pcm.length; i += 3200) send({ event: "media", stream_sid: streamSid, media: { payload: pcm.subarray(i, i + 3200).toString("base64") } });
      speakingUntil = Date.now() + (pcm.length / 2 / RATE) * 1000;
    };
    const lastBiruni = () => [...(deal?.transcript ?? [])].reverse().find((t) => t.from === "biruni")?.text;
    const finished = () => !deal || !["NEGOTIATING", "AGREED"].includes(this.d.negotiator.get(deal.dealId)?.status ?? "");

    ws.on("message", (raw) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.event === "start") {
        streamSid = m.stream_sid ?? m.streamSid ?? m.start?.stream_sid ?? "";
        deal = this.dealFor(m.start?.call_sid ?? m.start?.callSid, m.start?.custom_parameters?.CustomField ?? m.start?.customParameters?.CustomField);
        if (!deal) {
          ws.close(1011, "no deal for this call");
          return;
        }
        bus.emitEvent({ tripId: deal.tripId ?? "*", agent: "voice", type: "CALL", detail: `Call connected for ${deal.kind} deal with ${deal.counterparty.name}` });
        const opening = lastBiruni();
        if (opening) busy = busy.then(() => play(opening)).catch(() => {});
      } else if (m.event === "media" && deal && m.media?.payload) {
        const chunk = Buffer.from(m.media.payload, "base64");
        const wasSpeaking = vad.speaking;
        const utter = vad.push(chunk);
        if (!wasSpeaking && vad.speaking && Date.now() < speakingUntil) {
          send({ event: "clear", stream_sid: streamSid }); // barge-in: stop our audio
          speakingUntil = 0;
        }
        if (!utter) return;
        const d = deal;
        busy = busy
          .then(async () => {
            const text = (await speech.stt(utter, d.counterparty.language)).trim();
            if (!text) return;
            const r = await this.d.negotiator.counterpartySaid(d.dealId, text);
            if (r.line?.text) await play(r.line.text);
            if (finished()) setTimeout(() => ws.close(1000, "deal finished"), Math.max(0, speakingUntil - Date.now()) + 500);
          })
          .catch((e) => void bus.emitEvent({ tripId: d.tripId ?? "*", agent: "voice", type: "CALL", detail: `Call turn failed: ${String((e as Error).message).slice(0, 120)}` }));
      } else if (m.event === "stop") {
        ws.close(1000, "stream stopped");
      }
    });
    ws.on("error", () => {});
  }
}
