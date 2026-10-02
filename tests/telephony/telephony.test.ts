process.env.OFFLINE_MODEL_CONFIG = "off";
delete process.env.GEMINI_API_KEY;
delete process.env.ONLINE_MODEL_API_KEY;
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "../../packages/db";
import { Negotiator } from "../../services/negotiator";
import { Telephony, type SpeechIO } from "../../services/telephony";
import { RATE, Vad, resample, wav, wavToPcm8k } from "../../services/telephony/audio";

const tone = (ms: number, amp = 8000) => {
  const n = Math.round((RATE * ms) / 1000), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 300 * i) / RATE)), i * 2);
  return b;
};
const silence = (ms: number) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);

test("audio: WAV round trip, resampling, VAD finds utterances and ignores clicks", () => {
  const pcm = tone(500);
  assert.deepEqual(wavToPcm8k(wav(pcm)), pcm);
  const at16 = resample(pcm, 8000, 16000);
  assert.equal(at16.length, pcm.length * 2);
  assert.equal(wavToPcm8k(wav(at16, 16000)).length, pcm.length);
  assert.throws(() => wavToPcm8k(Buffer.from("ID3 mp3 data that is not wav at all..................")), /not a WAV/);
  const vad = new Vad();
  const feed = (b: Buffer) => { let out; for (let i = 0; i < b.length; i += 320) out = vad.push(b.subarray(i, i + 320)) ?? out; return out; };
  assert.equal(feed(Buffer.concat([tone(60), silence(1000)])), undefined, "60 ms click is not speech");
  const u = feed(Buffer.concat([tone(600), silence(900)]));
  assert.ok(u && u.length >= tone(600).length);
});

test("phone numbers: Indian mobiles only", () => {
  assert.equal(Telephony.normalizePhone("+91 98765-43210"), "09876543210");
  assert.equal(Telephony.normalizePhone("09876543210"), "09876543210");
  assert.throws(() => Telephony.normalizePhone("12345"), /Indian mobile/);
  assert.throws(() => Telephony.normalizePhone("+1 415 555 0100"), /Indian mobile/);
});

test("SMS deal without Exotel keys: simulated and labelled; inbound SMS continues the deal", async () => {
  for (const k of ["EXOTEL_SID", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_CALLER_ID"]) delete process.env[k];
  const neg = new Negotiator(new Store());
  neg.telephony = new Telephony({ negotiator: neg });
  const { deal, line } = await neg.start({ kind: "taxi", counterpartyName: "Ravi", counterpartyPhone: "9876543210", language: "ta-IN", goal: "airport drop", travellerName: "Vansh", target: 800, max: 1000, channel: "sms" });
  assert.match(line.sent ?? "", /simulated/);
  const r = await neg.inboundSms("+919876543210", "1200 rupees");
  assert.ok(r && r.deal.dealId === deal.dealId);
  assert.ok(r!.line && (r!.line.price ?? 0) <= 1000, "never offers above max");
  assert.equal(await neg.inboundSms("+919999999999", "hello"), undefined, "unknown sender ignored");
});

test("live call loop over WebSocket: hears the driver, negotiator decides, speaks back; stops when agreed", async () => {
  process.env.TELEPHONY_WS_SECRET = "s".repeat(32);
  const heard: string[] = [];
  const speech: SpeechIO = {
    live: true,
    async stt() { return heard.shift() ?? ""; },
    async tts(text) { return tone(Math.min(400, 20 * text.length)); },
  };
  const neg = new Negotiator(new Store());
  const tel = new Telephony({ negotiator: neg, speech });
  neg.telephony = tel;
  const { deal } = await neg.start({ kind: "auto", counterpartyName: "Anna", counterpartyPhone: "9876543210", language: "ta-IN", goal: "station to hotel", travellerName: "V", target: 150, max: 200, channel: "relay" });
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => (Telephony.streamAuthorized(req) ? wss.handleUpgrade(req, sock, head, (ws) => tel.handleStream(ws)) : sock.destroy()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;

  // Wrong secret is refused.
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}/telephony/exotel/stream/wrong`); w.on("open", res); w.on("error", rej); }));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/telephony/exotel/stream/${"s".repeat(32)}`);
  const media: string[] = [];
  const closed = new Promise<void>((r) => ws.on("close", () => r()));
  ws.on("message", (m) => { const j = JSON.parse(String(m)); if (j.event === "media") media.push(j.media.payload); });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({ event: "start", stream_sid: "SS1", start: { call_sid: "C1", custom_parameters: { CustomField: deal.dealId } } }));
  const say = async (text: string) => {
    heard.push(text);
    const audio = Buffer.concat([tone(600), silence(1000)]);
    for (let i = 0; i < audio.length; i += 320) ws.send(JSON.stringify({ event: "media", stream_sid: "SS1", media: { payload: audio.subarray(i, i + 320).toString("base64") } }));
    await new Promise((r) => setTimeout(r, 300));
  };
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(media.length > 0, "opening line spoken on connect");
  await say("இருநூற்று ஐம்பது ரூபாய்"); // 250, above max → counter
  await say("சரி 180 final"); // 180 final within max → accept
  await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
  const d = neg.get(deal.dealId)!;
  assert.ok(["AGREED", "CONFIRMED"].includes(d.status), d.status);
  assert.ok(d.agreedPrice! <= 200);
  assert.equal(d.transcript.filter((t) => t.from === "counterparty").length, 2, JSON.stringify(d.transcript.map((t) => [t.from, t.text, t.price])));
  ws.close();
  server.close();
});
