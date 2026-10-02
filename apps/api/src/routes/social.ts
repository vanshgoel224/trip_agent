// Routes: your profile, trusted contacts, shared trips, SOS help channel.
import { safetyNumber } from "../../../../packages/crypto";
import type { Traveller, TripState } from "../../../../packages/domain";
import { bus } from "../../../../packages/events";
import { BiruniError } from "../../../../packages/shared";
import { withActor } from "../../../../packages/shared/context";
import { parsePhoto } from "../../../../services/social";
import type { RouteFn } from "../http";
import { me, rt, spaces, type Space } from "../spaces";

const contacts = () => rt().store.get<{ list: string[] }>("settings", "contacts")?.list ?? [];

/** India's emergency numbers. 112 is the single number for police, fire and ambulance. */
export const EMERGENCY = [
  { number: "112", label: "Emergency (police, fire, ambulance)" },
  { number: "108", label: "Ambulance (most states)" },
  { number: "1363", label: "Tourist helpline (verify for your state)" },
];

/** Raise an SOS as this space's user: sealed alerts, live pings to recipients, SMS to the trip's emergency contact. */
export async function sendSos(space: Space, input: { message: string; location?: { lat: number; lng: number; accuracy?: number; at?: string }; everyone?: boolean; tripId?: string; photo?: unknown }) {
  const b = space.b;
  const tripId = input.tripId;
  const trip = tripId ? b.store.get<TripState>("trips", tripId) : undefined;
  const last = b.devices.latest(tripId) ?? b.devices.latest();
  const location = input.location && Number.isFinite(Number(input.location.lat)) ? input.location : last ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy, at: last.at } : undefined;
  const contactsList = b.store.get<{ list: string[] }>("settings", "contacts")?.list ?? [];
  const r = spaces.social.raiseSos(space.me, { message: input.message, location, tripTitle: trip ? `${trip.itinerary.origin} → ${trip.itinerary.destination}` : undefined }, { contacts: contactsList, everyone: !!input.everyone, photo: parsePhoto(input.photo) });
  // Wake each recipient's live stream (they see who, not what, until they open it).
  for (const name of r.sentTo) {
    const a = spaces.accounts.byUsername(name);
    if (a) withActor({ userId: a.userId, username: a.username }, () => bus.emitEvent({ tripId: "*", agent: "help", type: "SOS", detail: `🚨 ${space.me.username} needs help — open SOS` }));
  }
  // Emergency contact on the trip gets an SMS (simulated until Exotel keys are set).
  let sms: string | undefined;
  const traveller = trip ? b.store.get<Traveller>("users", trip.travellerId) : undefined;
  if (traveller?.emergencyContact?.phone) {
    const where = location ? ` Location: https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=16/${location.lat}/${location.lng}` : "";
    sms = await b.telephony.sendSms(traveller.emergencyContact.phone, `SOS from ${space.me.username} via Biruni: ${input.message.slice(0, 300) || "I need help"}.${where} If you can't reach them, call 112.`).catch((e) => `not sent: ${(e as Error).message}`);
  }
  return { ...r, emergencyContactSms: sms, location: location ? { lat: location.lat, lng: location.lng } : undefined, emergency: EMERGENCY, note: "Biruni alerts people you trust. It does not replace 112 — call 112 if you can." };
}

export default function register(route: RouteFn) {
  // ---------- profile ----------
  route("GET", "/api/me", () => {
    const a = spaces.accounts.byId(me().userId)!;
    return { userId: a.userId, username: a.username, displayName: a.displayName, help: a.help, createdAt: a.createdAt };
  });
  route("POST", "/api/me", (_r, body) => {
    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.displayName = String(body.displayName).trim().slice(0, 40);
    if (body.helpOptIn !== undefined) patch.help = { optIn: !!body.helpOptIn };
    const a = spaces.accounts.update(me().userId, patch);
    return { username: a.username, displayName: a.displayName, help: a.help };
  });
  // Your data, decrypted, as one JSON file (India's DPDP Act: right to access).
  route("GET", "/api/me/export", () => {
    const a = spaces.accounts.byId(me().userId)!;
    const data = {
      exportedAt: new Date().toISOString(), format: "biruni-export-v1",
      account: { username: a.username, displayName: a.displayName, createdAt: a.createdAt, help: a.help },
      space: rt().store.dump(),
      sharedTrips: spaces.social.shares(me().userId).map((s) => ({ ...spaces.social.view(s, me()), items: spaces.social.items(s.shareId, me()) })),
      sos: { sent: spaces.social.mine(me()), received: spaces.social.inbox(me()) },
    };
    // API keys you entered stay out of exports.
    for (const row of (data.space.settings ?? []) as { providers?: { apiKey?: string }[] }[]) for (const p of row.providers ?? []) if (p.apiKey) p.apiKey = "(removed from export)";
    return { __binary: Buffer.from(JSON.stringify(data, null, 2)), mime: "application/json; charset=utf-8", filename: `biruni-${a.username}-${new Date().toISOString().slice(0, 10)}.json` };
  });
  route("GET", "/api/users/lookup", (_r, _b, _p, url) => {
    const a = spaces.accounts.byUsername(url.searchParams.get("u") ?? "");
    if (!a) return { found: false };
    return { found: true, username: a.username, displayName: a.displayName, safetyNumber: a.userId === me().userId ? undefined : safetyNumber({ publicKey: me().identity.publicKey, username: me().username }, { publicKey: a.publicKey, username: a.username }) };
  });

  // ---------- trusted contacts (who gets my SOS even outside shared trips) ----------
  route("GET", "/api/contacts", () => contacts().map((u) => ({ username: u, exists: !!spaces.accounts.byUsername(u) })));
  route("POST", "/api/contacts", (_r, body) => {
    const u = String(body.username ?? "").trim().toLowerCase();
    if (!spaces.accounts.byUsername(u)) throw new BiruniError("INVALID_REQUEST", `No Biruni user called "${u}" on this server`);
    if (u === me().username) throw new BiruniError("INVALID_REQUEST", "That's you");
    const list = body.remove ? contacts().filter((x) => x !== u) : [...new Set([...contacts(), u])].slice(0, 50);
    rt().store.put("settings", "contacts", { list });
    return list;
  });

  // ---------- shared trips ----------
  const view = (shareId: string) => {
    const s = spaces.social.shareFor(shareId, me());
    const items = spaces.social.items(shareId, me());
    // Itinerary: live from the leader's space when it's loaded, else the last shared snapshot.
    const leader = s.leaderTripId ? spaces.loadedSpace(s.leaderId) : undefined;
    let itinerary: unknown = [...items].reverse().find((i) => i.kind === "itinerary")?.content;
    if (leader && s.leaderTripId) {
      try {
        const t = leader.b.store.get<TripState>("trips", s.leaderTripId);
        if (t) itinerary = { origin: t.itinerary.origin, destination: t.itinerary.destination, status: t.status, legs: t.itinerary.legs, bookings: leader.b.partners.list(s.leaderTripId).map((x) => ({ bookingRef: x.bookingRef, pnr: x.pnr, summary: leader.b.partners.summary(x) })), live: true };
      } catch {
        /* keep snapshot */
      }
    }
    return { ...spaces.social.view(s, me()), items, itinerary, pendingCancels: spaces.social.pendingCancels(shareId, me()) };
  };
  route("GET", "/api/shares", () => spaces.social.shares(me().userId).map((s) => spaces.social.view(s, me())));
  route("POST", "/api/shares", (_r, body) => {
    if (body.tripId && !rt().store.get("trips", String(body.tripId))) throw new BiruniError("INVALID_REQUEST", "Unknown trip");
    const s = spaces.social.createShare(me(), String(body.title ?? ""), body.tripId ? String(body.tripId) : undefined);
    return view(s.shareId);
  });
  route("GET", "/api/shares/:id", (_r, _b, p) => view(p.id));
  route("POST", "/api/shares/:id/invite", (_r, body, p) => (spaces.social.invite(p.id, me(), String(body.username ?? "")), view(p.id)));
  route("POST", "/api/shares/:id/remove", (_r, body, p) => (spaces.social.remove(p.id, me(), String(body.userId ?? "")), body.userId === me().userId ? { left: true } : view(p.id)));
  route("POST", "/api/shares/:id/leader", (_r, body, p) => (spaces.social.makeLeader(p.id, me(), String(body.userId ?? "")), view(p.id)));
  route("POST", "/api/shares/:id/link", (_r, body, p) => {
    if (!rt().store.get("trips", String(body.tripId ?? ""))) throw new BiruniError("INVALID_REQUEST", "Unknown trip");
    spaces.social.linkTrip(p.id, me(), String(body.tripId));
    return view(p.id);
  });
  route("POST", "/api/shares/:id/message", (_r, body, p) => spaces.social.post(p.id, me(), "message", { text: body.text }));
  route("POST", "/api/shares/:id/snapshot", (_r, _b, p) => {
    const s = spaces.social.shareFor(p.id, me());
    if (s.leaderId !== me().userId || !s.leaderTripId) throw new BiruniError("POLICY_BLOCKED", "Only the leader can share the itinerary, after linking a trip");
    const t = rt().orchestrator.trip(s.leaderTripId);
    return spaces.social.post(p.id, me(), "itinerary", { origin: t.itinerary.origin, destination: t.itinerary.destination, status: t.status, legs: t.itinerary.legs, at: new Date().toISOString() });
  });
  route("POST", "/api/shares/:id/cancel-request", (_r, body, p) => spaces.social.requestCancel(p.id, me(), { bookingRef: body.bookingRef, reason: body.reason }));
  route("POST", "/api/shares/:id/cancel-decide", (_r, body, p) =>
    spaces.social.decideCancel(p.id, me(), String(body.requestId ?? ""), body.approve !== false, async (ref) => {
      const r = await rt().partners.cancel(ref, "cancelled by trip leader");
      return `${rt().partners.summary(r.booking)} · refund ₹${r.refundInr.toLocaleString("en-IN")}`;
    }),
  );

  // ---------- SOS ----------
  route("GET", "/api/sos", () => ({ inbox: spaces.social.inbox(me()), mine: spaces.social.mine(me()), emergency: EMERGENCY }));
  route("POST", "/api/sos", (_r, body) => sendSos(spaces.current(), { message: String(body.message ?? ""), location: body.location, everyone: !!body.everyone, tripId: body.tripId ? String(body.tripId) : undefined, photo: body.photo }));
  route("POST", "/api/sos/:id/respond", (_r, body, p) => {
    const out = spaces.social.respond(p.id, me(), body.kind, body.note);
    const sender = spaces.social.inbox(me()).find((x) => x.sosId === p.id)?.from;
    const a = sender ? spaces.accounts.byUsername(sender) : undefined;
    const label = { seen: "has seen it", coming: "is coming", called_authorities: "has called the authorities", cant_help: "can't help" }[String(body.kind)] ?? body.kind;
    if (a) withActor({ userId: a.userId, username: a.username }, () => bus.emitEvent({ tripId: "*", agent: "help", type: "SOS_REPLY", detail: `${me().username} ${label}` }));
    return out;
  });
  route("GET", "/api/sos/:id/photo", (_r, _b, p) => {
    const ph = spaces.social.photo(p.id, me());
    return { __binary: ph.data, mime: ph.mime };
  });
  route("POST", "/api/sos/:id/resolve", (_r, _b, p) => spaces.social.resolve(p.id, me()));
}
