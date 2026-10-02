// Negotiator: talks to a hotel owner / taxi / auto driver on the traveller's
// behalf, in the counterparty's language, haggles, confirms, and records the deal.
//
// Who decides what:
//   - Numbers are deterministic: the traveller sets target and max; Biruni opens
//     below target, concedes on a fixed schedule, accepts automatically only at or
//     under max, and walks away above it. The model never picks the price.
//   - The model only (a) reads the counterparty's message (price? agreeing?) and
//     (b) phrases Biruni's next line naturally in their language. Both have
//     deterministic fallbacks (digit parsing in Indic scripts, template lines).
//   - Biruni never pays here and never shares more than name, dates and pickup/drop.
//
// Channels:
//   relay    — works now: the traveller's phone shows/speaks the line to the person
//              face-to-face or on speaker; their reply is typed or captured by mic.
//   whatsapp — WhatsApp Business Cloud API (WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID).
//              Free-form text only within 24 h of the other person messaging you;
//              cold outreach needs an approved template (WHATSAPP_TEMPLATE).
//   sms/call — Exotel (services/telephony): SMS, and live calls with Gnani speech; simulated without keys.
import type { Telephony } from "../telephony";
import type { Store } from "../../packages/db";
import { id, inr, nowIso } from "../../packages/shared";
import { bus } from "../../packages/events";
import { chat as modelChat, endpointChain, extractJson, GENERIC_SYSTEM } from "../models";
import { containsFuzzy } from "../../packages/shared/fuzzy";

export type DealKind = "hotel" | "taxi" | "auto" | "other";
export type Channel = "relay" | "whatsapp" | "sms" | "call";
export type DealStatus = "NEGOTIATING" | "AGREED" | "CONFIRMED" | "WALKED_AWAY" | "CANCELLED";
export type Turn = { from: "biruni" | "counterparty"; text: string; translation?: string; roman?: string; price?: number; at: string; sent?: string };
export type Deal = {
  dealId: string;
  tripId?: string;
  kind: DealKind;
  counterparty: { name: string; phone?: string; language: string };
  goal: string;
  details: Record<string, string>;
  travellerName: string;
  target: number;
  max: number;
  ourLast: number;
  theirLast?: number;
  rounds: number;
  maxRounds: number;
  channel: Channel;
  status: DealStatus;
  agreedPrice?: number;
  transcript: Turn[];
  recorded?: string[];
  createdAt: string;
  updatedAt: string;
};

type Action = "OPEN" | "COUNTER" | "ACCEPT" | "ASK_PRICE" | "WALK_AWAY" | "CONFIRM_DETAILS" | "THANKS";

// ---------- deterministic helpers ----------

const DIGIT_BLOCKS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66]; // Devanagari…Malayalam digit zeros
export function toAsciiDigits(s: string) {
  return s.replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (ch) => {
    const c = ch.charCodeAt(0);
    const z = DIGIT_BLOCKS.find((b) => c >= b && c <= b + 9)!;
    return String(c - z);
  });
}

/** Fallback price reader: "₹1,200", "1200 rs", "1.5k", "१२००", "800/-". Picks the most plausible amount. */
export function parsePrice(text: string): number | undefined {
  const t = toAsciiDigits(text).toLowerCase().replace(/(\d),(\d)/g, "$1$2");
  const nums: number[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(k|hazar|hazaar|thousand)?/g)) {
    let v = Number(m[1]);
    if (m[2]) v *= 1000;
    if (v >= 20 && v <= 500000) nums.push(Math.round(v));
  }
  return nums.length ? Math.max(...nums) : undefined;
}

const YES = ["ok", "okay", "done", "theek", "thik", "haan", "ha", "chalo", "deal", "agreed", "fine", "confirmed", "pakka", "sari", "seri", "aagatum", "hoon", "houdu", "avunu", "ho", "ठीक", "हाँ", "पक्का", "சரி", "ஓகே", "ಸರಿ", "సరే"];
const NO = ["no", "nahi", "nahin", "illa", "illai", "mudiyadhu", "venam", "kudiradu", "not possible", "nako", "na", "नहीं", "இல்லை", "முடியாது", "வேண்டாம்", "ಇಲ್ಲ", "లేదు"];
const FIRM = ["final", "last price", "fixed", "aakhri", "akhri", "fix rate", "kadaisi", "கடைசி", "फाइनल", "आखिरी", "koneya", "chivari"];
export function readReplyFallback(text: string, ourLast: number): { price?: number; accepts: boolean; rejects: boolean; firm: boolean } {
  const price = parsePrice(text);
  const t = text.toLowerCase();
  const accepts = (price === undefined || price <= ourLast) && containsFuzzy(t, YES) && !containsFuzzy(t, NO);
  return { price, accepts, rejects: containsFuzzy(t, NO) && !accepts, firm: containsFuzzy(t, FIRM) };
}

const round10 = (n: number) => Math.round(n / 10) * 10;

/** The haggling policy. Pure function: same inputs, same move. */
export function nextMove(d: Pick<Deal, "target" | "max" | "ourLast" | "rounds" | "maxRounds">, their: { price?: number; accepts: boolean; rejects: boolean; firm?: boolean }): { action: Action; price?: number } {
  if (their.accepts) return { action: "ACCEPT", price: d.ourLast };
  const p = their.price;
  // "Final price" within the traveller's max: take it rather than risk losing the deal.
  if (their.firm && p !== undefined && p <= d.max) return { action: "ACCEPT", price: p };
  if (p === undefined) return their.rejects && d.rounds >= d.maxRounds ? { action: "WALK_AWAY" } : { action: "ASK_PRICE" };
  if (p <= d.target) return { action: "ACCEPT", price: p };
  if (p <= d.max) {
    const gap = p - d.ourLast;
    if (d.rounds >= d.maxRounds || gap <= Math.max(20, p * 0.05)) return { action: "ACCEPT", price: p };
    return { action: "COUNTER", price: Math.min(p, round10(d.ourLast + Math.max(10, gap * 0.4))) };
  }
  if (d.rounds >= d.maxRounds) return { action: "WALK_AWAY" };
  return { action: "COUNTER", price: Math.min(d.max, round10(d.ourLast + Math.max(10, (Math.min(p, d.max) - d.ourLast) * 0.5))) };
}

// ---------- language ----------

const LANG_NAMES: Record<string, string> = {
  "hi-IN": "Hindi", "en-IN": "English", "kn-IN": "Kannada", "ta-IN": "Tamil", "te-IN": "Telugu", "ml-IN": "Malayalam", "mr-IN": "Marathi",
  "bn-IN": "Bengali", "gu-IN": "Gujarati", "pa-IN": "Punjabi", "or-IN": "Odia", "kok-IN": "Konkani", "ur-IN": "Urdu", "as-IN": "Assamese",
};

// Every template is built up front, so a missing price must not throw (ASK_PRICE/WALK_AWAY have none).
const money = (n?: number) => (typeof n === "number" && Number.isFinite(n) ? inr(n) : "");

/** Template lines (Hindi / English) when no model is reachable. */
function templateLine(action: Action, d: Deal, price?: number): { text: string; translation: string } {
  const what = d.kind === "hotel" ? `room (${d.goal})` : `ride (${d.goal})`;
  const en: Record<Action, string> = {
    OPEN: `Hello ${d.counterparty.name}, I'm calling for ${d.travellerName}. We need a ${what}. Can you do it for ${money(price)}?`,
    COUNTER: `That's a bit high. Can you do ${money(price)}?`,
    ACCEPT: `Okay, ${money(price)} is fine. Done.`,
    ASK_PRICE: `How much will it be for the ${what}?`,
    WALK_AWAY: `Sorry, that's above our budget. Thank you for your time.`,
    CONFIRM_DETAILS: `To confirm: ${what}, ${Object.entries(d.details).map(([k, v]) => `${k}: ${v}`).join(", ")}, for ${money(price)}, name ${d.travellerName}. Please confirm.`,
    THANKS: `Thank you, it's confirmed.`,
  };
  const hi: Record<Action, string> = {
    OPEN: `नमस्ते ${d.counterparty.name} जी, मैं ${d.travellerName} की तरफ़ से बात कर रहा हूँ। हमें ${d.kind === "hotel" ? "कमरा" : "गाड़ी"} चाहिए (${d.goal})। ${price} रुपये में हो जाएगा?`,
    COUNTER: `थोड़ा ज़्यादा है। ${price} रुपये में कर दीजिए?`,
    ACCEPT: `ठीक है, ${price} रुपये पक्का।`,
    ASK_PRICE: `कितने पैसे लगेंगे?`,
    WALK_AWAY: `माफ़ कीजिए, यह हमारे बजट से ज़्यादा है। धन्यवाद।`,
    CONFIRM_DETAILS: `पक्का कर लेते हैं: ${d.goal}, ${price} रुपये, नाम ${d.travellerName}। कृपया कन्फ़र्म कीजिए।`,
    THANKS: `धन्यवाद, पक्का हो गया।`,
  };
  // Tamil fallback lines (have a native speaker review the wording).
  const ta: Record<Action, string> = {
    OPEN: `வணக்கம் ${d.counterparty.name}, நான் ${d.travellerName} சார்பாக பேசுகிறேன். எங்களுக்கு ${d.kind === "hotel" ? "ஒரு அறை" : "ஒரு வண்டி"} வேண்டும் (${d.goal}). ${price} ரூபாய்க்கு முடியுமா?`,
    COUNTER: `கொஞ்சம் அதிகமா இருக்கு. ${price} ரூபாய்க்கு பண்ணுங்களேன்?`,
    ACCEPT: `சரி, ${price} ரூபாய் ஓகே.`,
    ASK_PRICE: `எவ்வளவு ஆகும்?`,
    WALK_AWAY: `மன்னிக்கவும், இது எங்க பட்ஜெட்டுக்கு மேல. நன்றி.`,
    CONFIRM_DETAILS: `உறுதி பண்ணிக்கலாம்: ${d.goal}, ${price} ரூபாய், பெயர் ${d.travellerName}. தயவுசெய்து உறுதி பண்ணுங்க.`,
    THANKS: `நன்றி, உறுதியாயிடுச்சு.`,
  };
  if (d.counterparty.language === "hi-IN") return { text: hi[action], translation: en[action] };
  if (d.counterparty.language === "ta-IN") return { text: ta[action], translation: en[action] };
  return { text: en[action], translation: en[action] };
}

// ---------- service ----------

type Recorder = (deal: Deal) => Promise<string[]>;

export class Negotiator {
  private recorder?: Recorder;
  constructor(private store: Store) {}

  onConfirmed(r: Recorder) {
    this.recorder = r;
  }

  get(dealId: string) {
    return this.store.get<Deal>("deals", dealId);
  }
  list(tripId?: string) {
    return this.store.list<Deal>("deals", tripId ? { tripId } : {}).reverse();
  }
  private save(d: Deal) {
    d.updatedAt = nowIso();
    this.store.put("deals", d.dealId, d, { tripId: d.tripId }); // phone stays inside the encrypted record
    bus.emitEvent({ tripId: d.tripId ?? "*", agent: "negotiator", type: "DEAL", detail: `${d.kind} with ${d.counterparty.name}: ${d.status}${d.agreedPrice ? ` at ${inr(d.agreedPrice)}` : ""}`, data: { dealId: d.dealId } });
    return d;
  }

  async start(input: {
    tripId?: string; kind: DealKind; counterpartyName: string; counterpartyPhone?: string; language: string; goal: string;
    details?: Record<string, string>; travellerName: string; target: number; max: number; channel?: Channel; maxRounds?: number;
  }): Promise<{ deal: Deal; line: Turn }> {
    if (!(input.target > 0) || !(input.max >= input.target)) throw new Error("Need a target price and a maximum ≥ target (both in ₹), set by the traveller");
    const channel = input.channel ?? "relay";
    const d: Deal = {
      dealId: id("DEAL"), tripId: input.tripId, kind: input.kind,
      counterparty: { name: input.counterpartyName.trim() || (input.kind === "hotel" ? "Owner" : "Bhaiya"), phone: input.counterpartyPhone, language: LANG_NAMES[input.language] ? input.language : "hi-IN" },
      goal: input.goal.trim().slice(0, 200), details: input.details ?? {}, travellerName: input.travellerName || "the traveller",
      target: Math.round(input.target), max: Math.round(input.max), ourLast: round10(input.target * 0.85), rounds: 0, maxRounds: input.maxRounds ?? 4,
      channel, status: "NEGOTIATING", transcript: [], createdAt: nowIso(), updatedAt: nowIso(),
    };
    const line = await this.say(d, "OPEN", d.ourLast);
    this.save(d);
    return { deal: d, line };
  }

  /** Feed the counterparty's reply (typed, from mic, or from WhatsApp); returns Biruni's next line. */
  async counterpartySaid(dealId: string, text: string): Promise<{ deal: Deal; line?: Turn; recorded?: string[] }> {
    const d = this.get(dealId);
    if (!d) throw new Error("Unknown deal");
    if (!["NEGOTIATING", "AGREED"].includes(d.status)) return { deal: d };
    const read = await this.read(d, text);
    d.transcript.push({ from: "counterparty", text, translation: read.translation, price: read.price, at: nowIso() });
    if (read.price) d.theirLast = read.price;

    if (d.status === "AGREED") {
      // Waiting for them to confirm the details.
      if (read.accepts || (read.price !== undefined && read.price <= d.agreedPrice!)) {
        d.status = "CONFIRMED";
        const line = await this.say(d, "THANKS", d.agreedPrice);
        d.recorded = (await this.recorder?.(d)) ?? [];
        this.save(d);
        return { deal: d, line, recorded: d.recorded };
      }
      if (read.price && read.price > d.agreedPrice!) {
        d.status = "NEGOTIATING"; // they changed the price: back to haggling
      } else {
        const line = await this.say(d, "CONFIRM_DETAILS", d.agreedPrice);
        this.save(d);
        return { deal: d, line };
      }
    }

    d.rounds++;
    const move = nextMove(d, read);
    let line: Turn;
    if (move.action === "ACCEPT") {
      d.agreedPrice = move.price!;
      if (d.kind === "hotel") {
        d.status = "AGREED";
        line = await this.say(d, "CONFIRM_DETAILS", d.agreedPrice);
      } else {
        d.status = "CONFIRMED";
        line = await this.say(d, "ACCEPT", d.agreedPrice);
        d.recorded = (await this.recorder?.(d)) ?? [];
      }
    } else if (move.action === "COUNTER") {
      d.ourLast = move.price!;
      line = await this.say(d, "COUNTER", move.price);
    } else if (move.action === "WALK_AWAY") {
      d.status = "WALKED_AWAY";
      line = await this.say(d, "WALK_AWAY");
    } else {
      line = await this.say(d, "ASK_PRICE");
    }
    this.save(d);
    return { deal: d, line, recorded: d.recorded };
  }

  cancel(dealId: string) {
    const d = this.get(dealId);
    if (!d) throw new Error("Unknown deal");
    d.status = "CANCELLED";
    return this.save(d);
  }

  /** Inbound WhatsApp message → matching open deal by phone. */
  /** Set by the runtime: Exotel SMS and calls. */
  telephony?: Telephony;

  async inboundSms(from: string, text: string) {
    const digits = String(from).replace(/\D/g, "").slice(-10);
    const d = this.list().find((x) => x.channel === "sms" && x.counterparty.phone?.replace(/\D/g, "").endsWith(digits) && ["NEGOTIATING", "AGREED"].includes(x.status));
    return d ? this.counterpartySaid(d.dealId, String(text).slice(0, 2000)) : undefined;
  }

  async inboundWhatsApp(from: string, text: string) {
    const digits = from.replace(/\D/g, "").slice(-10);
    const d = this.list().find((x) => x.channel === "whatsapp" && x.counterparty.phone?.replace(/\D/g, "").endsWith(digits) && ["NEGOTIATING", "AGREED"].includes(x.status));
    return d ? this.counterpartySaid(d.dealId, text) : undefined;
  }

  // ---------- model-assisted reading & phrasing (with fallbacks) ----------

  private async read(d: Deal, text: string): Promise<{ price?: number; accepts: boolean; rejects: boolean; firm: boolean; translation?: string }> {
    const fb = readReplyFallback(text, d.ourLast);
    const ep = (await endpointChain(true).catch(() => []))[0];
    if (!ep) return fb;
    try {
      const raw = await modelChat(ep, `A ${d.kind === "hotel" ? "hotel owner" : "driver"} replied during price negotiation. Our last offer was ₹${d.ourLast}.
Their message (may be in ${LANG_NAMES[d.counterparty.language]}, Hinglish or mixed): """${text}"""
Return ONLY JSON: {"price": <rupee amount they are asking now as a number, or null>, "accepts": <true only if they agree to OUR last offer or confirm>, "rejects": <true if they refuse>, "firm": <true if they say it is their final/fixed price>, "translation": "<English translation>"}`, 12_000, GENERIC_SYSTEM);
      const j = extractJson(raw) as any;
      const price = typeof j.price === "number" && j.price >= 20 && j.price <= 500000 ? Math.round(j.price) : fb.price;
      // Guard against a model "hearing" a price that isn't in the text at all.
      const grounded = price === undefined || parsePrice(text) !== undefined || /sau|hazar|hazaar|nooru|aayiram|ayiram|saavira|veyyi|vandu|shambhar|ek|do|teen|char|paanch|நூறு|நூற்று|ாயிர|ஆயிர|सौ|हज़ार|हजार|ಸಾವಿರ|ನೂರು|వెయ్యి|వంద/i.test(text);
      return { price: grounded ? price : fb.price, accepts: !!j.accepts && !(price && price > d.ourLast), rejects: !!j.rejects, firm: !!j.firm || fb.firm, translation: typeof j.translation === "string" ? j.translation : undefined };
    } catch {
      return fb;
    }
  }

  private async say(d: Deal, action: Action, price?: number): Promise<Turn> {
    let line = templateLine(action, d, price);
    let roman: string | undefined;
    const ep = (await endpointChain(true).catch(() => []))[0];
    if (ep) {
      try {
        const raw = await modelChat(ep, `You are speaking on behalf of ${d.travellerName} (a traveller) to ${d.counterparty.name}, a ${d.kind === "hotel" ? "hotel/homestay owner" : d.kind === "auto" ? "auto-rickshaw driver" : "taxi driver"} in India.
Language: ${LANG_NAMES[d.counterparty.language]} — natural, polite, local, short (1–2 spoken sentences), like a friendly local would bargain.
Context: ${d.goal}. ${Object.entries(d.details).map(([k, v]) => `${k}: ${v}`).join(", ")}
Say exactly this move, nothing more: ${action}${price ? ` with the price ₹${price}` : ""}.
(OPEN = greet, say what you need, offer the price; COUNTER = politely say it's high and offer the price; ACCEPT = agree at the price; ASK_PRICE = ask their price; WALK_AWAY = politely decline, budget; CONFIRM_DETAILS = repeat the booking details and price and ask them to confirm; THANKS = thank them, confirmed.)
Never mention any amount other than ${price ?? "none"}. Never share phone numbers, payment details or addresses beyond the context.
Return ONLY JSON: {"text": "<in ${LANG_NAMES[d.counterparty.language]} script>", "roman": "<Latin-script reading>", "translation": "<English>"}`, 12_000, GENERIC_SYSTEM);
        const j = extractJson(raw) as any;
        const ok = typeof j.text === "string" && j.text.trim();
        // The price in the generated line must match the policy's price (or be absent).
        const said = parsePrice(String(j.text ?? "")) ?? parsePrice(String(j.roman ?? ""));
        if (ok && (!price || said === undefined || said === price)) {
          line = { text: j.text.trim(), translation: String(j.translation ?? line.translation) };
          roman = typeof j.roman === "string" ? j.roman : undefined;
        }
      } catch {
        /* template line */
      }
    }
    const turn: Turn = { from: "biruni", ...line, roman, price, at: nowIso() };
    turn.sent = await this.deliver(d, turn).catch((e) => `not sent: ${(e as Error).message}`);
    d.transcript.push(turn);
    return turn;
  }

  private async deliver(d: Deal, t: Turn): Promise<string> {
    if (d.channel === "relay") return "relay: show or speak this on the traveller's phone";
    if (d.channel === "whatsapp") {
      if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) throw new Error("WhatsApp not connected (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID)");
      if (!d.counterparty.phone) throw new Error("no phone number");
      const to = d.counterparty.phone.replace(/\D/g, "").replace(/^(\d{10})$/, "91$1");
      const first = d.transcript.filter((x) => x.from === "counterparty").length === 0;
      // Cold outreach outside the 24 h window must use an approved template.
      const body = first && process.env.WHATSAPP_TEMPLATE
        ? { messaging_product: "whatsapp", to, type: "template", template: { name: process.env.WHATSAPP_TEMPLATE, language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en" }, components: [{ type: "body", parameters: [{ type: "text", text: t.text.slice(0, 900) }] }] } }
        : { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: t.text } };
      const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v23.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`WhatsApp HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return "whatsapp: sent";
    }
    if (!this.telephony) throw new Error(`${d.channel} needs telephony (Exotel): not wired`);
    if (d.channel === "sms") {
      if (!d.counterparty.phone) throw new Error("no phone number");
      return this.telephony.sendSms(d.counterparty.phone, t.text);
    }
    // call: the first line rings them; later lines are spoken on the live call by the stream handler.
    if (!d.transcript.some((x) => x.from === "biruni")) return this.telephony.call(d);
    return "call: spoken on the live line";
  }
}
