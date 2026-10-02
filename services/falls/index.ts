// Drop watch: the phone reports a detected drop; the countdown runs HERE, on the
// server, so if the phone breaks, dies or loses signal right after the fall, the SOS
// still goes out. Any device signed into the same account (or the phone itself, by
// tap, shake or voice) can cancel within the window.
import { randomUUID } from "node:crypto";
import { BiruniError } from "../../packages/shared";

export type FallReport = {
  at?: string; freefallMs: number; heightM: number; impactG: number; tumbleDeg?: number;
  orientationBefore?: { beta: number; gamma: number; alpha?: number } | null;
  orientationAfter?: { beta: number; gamma: number; alpha?: number } | null;
  severity?: "low" | "medium" | "high";
  location?: { lat: number; lng: number; accuracy?: number; at?: string };
  battery?: number; tripId?: string; device?: string;
};
export type Fall = FallReport & { fallId: string; userId: string; detectedAt: string; deadline: string; status: "PENDING" | "CANCELLED" | "SOS_SENT"; cancelledBy?: string; sos?: unknown };

const num = (v: unknown, lo: number, hi: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BiruniError("INVALID_REQUEST", "fall readings must be numbers");
  return Math.min(hi, Math.max(lo, n));
};
const angle = (o: any) => (o && Number.isFinite(Number(o.beta)) && Number.isFinite(Number(o.gamma)) ? { beta: Math.round(Number(o.beta)), gamma: Math.round(Number(o.gamma)), alpha: Number.isFinite(Number(o.alpha)) ? Math.round(Number(o.alpha)) : undefined } : null);

export const cancelWindowMs = () => Number(process.env.FALL_CANCEL_MS ?? 60_000);

/** Worded for the people receiving the SOS. */
export function describeFall(f: Fall) {
  const parts = [
    `Biruni detected a ${f.severity ?? ""} drop of the phone`.replace("  ", " "),
    `(about ${f.heightM.toFixed(1)} m, ${f.impactG.toFixed(1)} g impact${f.tumbleDeg ? `, tumbled ${f.tumbleDeg}°` : ""})`,
    `at ${new Date(f.detectedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`,
    `and nobody cancelled it within ${Math.round(cancelWindowMs() / 1000)} seconds. They may be hurt or unable to reach the phone.`,
  ];
  return parts.join(" ");
}

export class FallWatch {
  private pending = new Map<string, { fall: Fall; timer: NodeJS.Timeout }>();
  constructor(private onExpire: (fall: Fall) => Promise<unknown>, private record?: (fall: Fall) => void) {}

  report(userId: string, r: FallReport): Fall {
    const existing = this.pending.get(userId);
    if (existing) return existing.fall; // one countdown at a time; a second report doesn't reset it
    const now = Date.now();
    const loc = r.location && Number.isFinite(Number(r.location.lat)) && Number.isFinite(Number(r.location.lng))
      ? { lat: num(r.location.lat, -90, 90), lng: num(r.location.lng, -180, 180), accuracy: r.location.accuracy == null ? undefined : num(r.location.accuracy, 0, 100_000), at: r.location.at ? String(r.location.at).slice(0, 40) : undefined }
      : undefined;
    const fall: Fall = {
      fallId: `FALL-${randomUUID().slice(0, 8).toUpperCase()}`, userId,
      freefallMs: num(r.freefallMs, 0, 10_000), heightM: num(r.heightM, 0, 500), impactG: num(r.impactG, 0, 100), tumbleDeg: r.tumbleDeg == null ? undefined : num(r.tumbleDeg, 0, 100_000),
      orientationBefore: angle(r.orientationBefore), orientationAfter: angle(r.orientationAfter),
      severity: ["low", "medium", "high"].includes(String(r.severity)) ? r.severity : undefined,
      location: loc, battery: r.battery == null ? undefined : num(r.battery, 0, 1), tripId: r.tripId ? String(r.tripId).slice(0, 40) : undefined,
      device: r.device ? String(r.device).slice(0, 60) : undefined,
      at: r.at ? String(r.at).slice(0, 40) : undefined, detectedAt: new Date(now).toISOString(), deadline: new Date(now + cancelWindowMs()).toISOString(), status: "PENDING",
    };
    const timer = setTimeout(async () => {
      this.pending.delete(userId);
      fall.status = "SOS_SENT";
      try {
        fall.sos = await this.onExpire(fall);
      } catch (e) {
        fall.sos = { error: (e as Error).message };
      }
      this.record?.(fall);
    }, cancelWindowMs());
    this.pending.set(userId, { fall, timer });
    this.record?.(fall);
    return fall;
  }

  active(userId: string) {
    return this.pending.get(userId)?.fall;
  }

  cancel(userId: string, fallId: string, by: string) {
    const p = this.pending.get(userId);
    if (!p || p.fall.fallId !== fallId) throw new BiruniError("INVALID_REQUEST", "No countdown running for that drop (it may have already sent the SOS)");
    clearTimeout(p.timer);
    this.pending.delete(userId);
    p.fall.status = "CANCELLED";
    p.fall.cancelledBy = String(by).slice(0, 40);
    this.record?.(p.fall);
    return p.fall;
  }

  stopAll() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
