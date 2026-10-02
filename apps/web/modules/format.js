// Data formatters, shared by the server and the app (one source of truth).
// Indian conventions: ₹ with lakh/crore grouping, IST times, +91 numbers, km.
const IST = "Asia/Kolkata";

/** ₹1,23,456 · ₹1,234.50 · compact: ₹1.2L / ₹3.4Cr / ₹12k */
export function inr(n, { compact = false, paise = false } = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "₹—";
  const sign = v < 0 ? "−" : "";
  const a = Math.abs(v);
  if (compact) {
    if (a >= 1e7) return `${sign}₹${trim(a / 1e7)}Cr`;
    if (a >= 1e5) return `${sign}₹${trim(a / 1e5)}L`;
    if (a >= 1e3) return `${sign}₹${trim(a / 1e3)}k`;
  }
  return sign + "₹" + a.toLocaleString("en-IN", { minimumFractionDigits: paise ? 2 : 0, maximumFractionDigits: paise ? 2 : 0 });
}
const trim = (x) => (Math.round(x * 10) / 10).toString();

/** "2 Oct, 9:05 pm" in IST (or with year if not this year). */
export function dateTime(d, { seconds = false } = {}) {
  const t = toDate(d);
  if (!t) return "—";
  const sameYear = new Date().getFullYear() === t.getFullYear();
  return t.toLocaleString("en-IN", { timeZone: IST, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: true }).replace(" am", " am").replace(" pm", " pm");
}
export function time(d) {
  const t = toDate(d);
  return t ? t.toLocaleTimeString("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true }) : "—";
}
export function date(d) {
  const t = toDate(d);
  return t ? t.toLocaleDateString("en-IN", { timeZone: IST, weekday: "short", day: "numeric", month: "short" }) : "—";
}
/** "just now", "5 min ago", "in 2 h", "3 days ago" */
export function relative(d, now = Date.now()) {
  const t = toDate(d);
  if (!t) return "—";
  const s = Math.round((t.getTime() - now) / 1000);
  const a = Math.abs(s);
  const f = (n, u) => (s < 0 ? `${n} ${u} ago` : `in ${n} ${u}`);
  if (a < 45) return "just now";
  if (a < 3600) return f(Math.round(a / 60), "min");
  if (a < 86400) return f(Math.round(a / 3600), "h");
  if (a < 86400 * 30) return f(Math.round(a / 86400), Math.round(a / 86400) === 1 ? "day" : "days");
  return date(t);
}
const toDate = (d) => {
  if (d == null || d === "") return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t;
};

/** 850 m · 12.4 km · 240 km */
export function distance(m) {
  const v = Number(m);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1000) return `${Math.round(v / 10) * 10} m`;
  return v < 100_000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v / 1000)} km`;
}
/** 45 s · 12 min · 2 h 5 min */
export function duration(seconds) {
  const v = Math.round(Number(seconds));
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 60) return `${v} s`;
  const h = Math.floor(v / 3600), m = Math.round((v % 3600) / 60);
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
/** +91 98765 43210 (Indian mobile), otherwise the digits as given. */
export function phone(p) {
  const d = String(p ?? "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : String(p ?? "");
}
/** Show the last 4 only: ••••3210 */
export const maskTail = (s, keep = 4) => (s ? `••••${String(s).slice(-keep)}` : "");
/** PNR 4512345678 → 451-2345678 (IRCTC 10-digit), others unchanged, upper-cased. */
export function pnr(s) {
  const v = String(s ?? "").trim().toUpperCase();
  return /^\d{10}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3)}` : v;
}
/** 1.2 MB · 340 KB · 18 B */
export function bytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${Math.round(v / 1024)} KB`;
  return `${(v / 1024 ** 2).toFixed(1)} MB`;
}
/** 30.7352° N, 79.0669° E */
export function coords(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "—";
  return `${Math.abs(a).toFixed(4)}° ${a >= 0 ? "N" : "S"}, ${Math.abs(b).toFixed(4)}° ${b >= 0 ? "E" : "W"}`;
}
/** Trim and cap user text for display (keeps whole words where it can). */
export function clip(s, max = 120) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  if (t[max - 1] === " ") return cut + "…"; // cut lands on a word boundary already
  return (cut.lastIndexOf(" ") > max * 0.6 ? cut.slice(0, cut.lastIndexOf(" ")) : cut) + "…";
}
