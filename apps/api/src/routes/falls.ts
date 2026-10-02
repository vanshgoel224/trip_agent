// Routes: phone-drop watch. Report a drop → 60 s countdown on the server → wide SOS
// unless cancelled from the phone (tap / shake / voice) or any other signed-in device.
import { bus } from "../../../../packages/events";
import { withActor } from "../../../../packages/shared/context";
import { describeFall, FallWatch, cancelWindowMs, type Fall } from "../../../../services/falls";
import type { RouteFn } from "../http";
import { me, rt, spaces } from "../spaces";
import { sendSos } from "./social";

const emit = (f: Fall, type: string, detail: string) => {
  const a = spaces.accounts.byId(f.userId);
  if (a) withActor({ userId: a.userId, username: a.username }, () => bus.emitEvent({ tripId: "*", agent: "device", type, detail, data: { fallId: f.fallId, deadline: f.deadline, status: f.status } }));
};

export const falls = new FallWatch(
  async (f) => {
    const space = spaces.loadedSpace(f.userId);
    if (!space) return { error: "account not loaded" };
    // Wide range: trip members, trusted contacts AND everyone on the server who offered to help.
    const r = await spaces.run(space, () => sendSos(space, { message: describeFall(f), location: f.location, everyone: true, tripId: f.tripId }));
    emit(f, "FALL_SOS", `No response after the drop: SOS sent to ${r.sentTo.length} people`);
    return r;
  },
  (f) => {
    const space = spaces.loadedSpace(f.userId);
    // Keep the moment on record in the user's own encrypted space.
    if (space) spaces.run(space, () => space.b.store.put("device_readings", f.fallId, f, { tripId: f.tripId, key: "FALL" }));
  },
);

export default function register(route: RouteFn) {
  route("POST", "/api/falls", (_r, body) => {
    const f = falls.report(me().userId, { ...body, tripId: body.tripId || undefined });
    emit(f, "FALL", `Phone drop detected (~${f.heightM.toFixed(1)} m, ${f.impactG.toFixed(1)} g). SOS in ${Math.round(cancelWindowMs() / 1000)} s unless someone taps I'm OK`);
    return f;
  });
  route("GET", "/api/falls/active", () => falls.active(me().userId) ?? null);
  route("POST", "/api/falls/:id/cancel", (_r, body, p) => {
    const by = ["screen", "shake", "voice", "other-device", "keyboard"].includes(String(body.by)) ? String(body.by) : "screen";
    const f = falls.cancel(me().userId, p.id, by);
    emit(f, "FALL_CANCELLED", `Drop alert cancelled (${by}) — no SOS sent`);
    return f;
  });
  route("GET", "/api/falls", () => rt().store.list<Fall>("device_readings", { key: "FALL" }).slice(-20).reverse());
}
