// "Test all connections": one parallel pass over every third-party integration.
// Free public services and model lists are pinged live; paid/keyed APIs report
// whether they're configured (a live call would spend quota or need an account).
import type { Biruni } from "../runtime";
import { endpointChain } from "../models";
import { redditConfigured } from "./reddit";
import { youtubeConfigured } from "./youtube";
import { splitwiseConfigured } from "../agents/expenses";

export type Check = { id: string; name: string; group: string; state: "ok" | "down" | "off" | "simulated"; ms?: number; note: string };

const UA = { "user-agent": "Biruni/0.2 (travel assistant; health check)" };
async function ping(url: string, init: RequestInit = {}, okCodes = [200]): Promise<{ ok: boolean; ms: number; note: string }> {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer().catch(() => {});
    return { ok: okCodes.includes(r.status), ms: Date.now() - t, note: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, note: (e as Error).name === "TimeoutError" ? "timed out (5 s)" : String((e as Error).message).slice(0, 80) };
  }
}
const env = (...k: string[]) => k.every((x) => !!process.env[x]);
const keyed = (id: string, name: string, group: string, configured: boolean, live: string, off: string): Check => ({ id, name, group, state: configured ? "ok" : "simulated", note: configured ? `${live} (configured; not called, to save quota)` : off });

export async function healthCheck(b: Biruni): Promise<{ at: string; checks: Check[]; summary: string }> {
  const live = await Promise.all([
    (async (): Promise<Check[]> => {
      const chain = await endpointChain(true).catch(() => []);
      if (!chain.length) return [{ id: "models", name: "AI models", group: "AI", state: "off", note: "No model reachable: add one in Settings → Models, or set GEMINI_API_KEY" }];
      return Promise.all(
        chain.map(async (ep): Promise<Check> => {
          const base = ep.baseUrl.replace(/\/$/, "");
          const r = ep.provider === "anthropic" ? await ping(`${base}/v1/models`, { headers: { "x-api-key": ep.apiKey ?? "", "anthropic-version": "2023-06-01" } }) : await ping(`${base}/models`, { headers: ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {} });
          return { id: `model:${ep.provider ?? "env"}:${ep.model}`, name: `${ep.provider ?? "AI"} · ${ep.model}`, group: "AI", state: r.ok ? "ok" : "down", ms: r.ms, note: `${ep.tier}${ep.tools === false ? ", text only" : ""} · ${r.note}` };
        }),
      );
    })(),
    ping("https://nominatim.openstreetmap.org/status.php?format=json").then((r): Check => ({ id: "nominatim", name: "OpenStreetMap search (Nominatim)", group: "Maps", state: r.ok ? "ok" : "down", ms: r.ms, note: r.note })),
    ping("https://photon.komoot.io/api/?q=Pune&limit=1").then((r): Check => ({ id: "photon", name: "Place search (Photon)", group: "Maps", state: r.ok ? "ok" : "down", ms: r.ms, note: r.note })),
    ping("https://router.project-osrm.org/route/v1/driving/73.8567,18.5204;73.8,18.52?overview=false").then((r): Check => ({ id: "osrm", name: "Directions (OSRM)", group: "Maps", state: r.ok ? "ok" : "down", ms: r.ms, note: r.note })),
    ping("https://tiles.openfreemap.org/styles/liberty").then((r): Check => ({ id: "tiles", name: "Map tiles (OpenFreeMap)", group: "Maps", state: r.ok ? "ok" : "down", ms: r.ms, note: `${r.note}; falls back to OSM raster tiles` })),
  ]);
  const mcp = b.mcpClients.list().map((s): Check => ({ id: `mcp:${s.serverId}`, name: `MCP: ${s.name}`, group: "MCP servers", state: s.connected ? "ok" : "down", note: s.connected ? `${s.tools.length} tools` : s.error ?? "not connected" }));
  const tel = b.telephony.status();
  const checks: Check[] = [
    ...live.flat(),
    keyed("gnani", "Gnani voice (STT/TTS)", "Voice", b.voice.live, "Gnani", "Device voices in use; set GNANI_API_KEY for Gnani"),
    keyed("exotel", "Exotel calls & SMS", "Telephony", tel.mode === "live", "Exotel", "Simulated: set EXOTEL_SID / API_KEY / API_TOKEN / CALLER_ID"),
    keyed("whatsapp", "WhatsApp Business", "Telephony", env("WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"), "WhatsApp Cloud API", "Off: set WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID"),
    ...b.partners.status().partners.map((p) => ({ id: `partner:${p.id}`, name: p.label, group: "Booking", state: "simulated" as const, note: p.note })),
    keyed("delhivery", "Delhivery parcels", "Booking", env("DELHIVERY_API_KEY"), "Delhivery", "Simulated: set DELHIVERY_API_KEY"),
    keyed("aviationstack", "Flight status (AviationStack)", "Operator feed", env("AVIATIONSTACK_KEY"), "AviationStack", "Off: set AVIATIONSTACK_KEY; forwarded SMS still works"),
    keyed("pinelabs", "Pine Labs payments", "Money", !/^Mock/.test(b.providers.payments.constructor.name), "Pine Labs", "Simulated: set PINELABS_CLIENT_ID / API_KEY"),
    keyed("setu", "Setu Account Aggregator", "Money", !/^Mock/.test(b.providers.financial.constructor.name), "Setu AA", "Simulated: set SETU_ACCESS_TOKEN / PRODUCT_INSTANCE_ID"),
    keyed("zerodha", "Zerodha (read-only)", "Money", !/^Mock/.test(b.providers.holdings.constructor.name), "Kite Connect", "Simulated: set ZERODHA_API_KEY / SECRET"),
    keyed("gcal", "Google Calendar", "Plans", env("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET") || env("GOOGLE_CALENDAR_ICS_URL"), "Google Calendar", "Off: set GOOGLE_CLIENT_ID/SECRET or GOOGLE_CALENDAR_ICS_URL"),
    keyed("reddit", "Reddit tips", "Discover", redditConfigured(), "Reddit OAuth", "Anonymous mode (often blocked from cloud servers)"),
    keyed("youtube", "YouTube", "Discover", youtubeConfigured(), "YouTube Data API", "Off: set YOUTUBE_API_KEY"),
    keyed("splitwise", "Splitwise sync", "Money", splitwiseConfigured(), "Splitwise", "Local splitting works; set SPLITWISE_API_KEY to sync"),
    ...mcp,
  ];
  const n = (s: Check["state"]) => checks.filter((c) => c.state === s).length;
  return { at: new Date().toISOString(), checks, summary: `${n("ok")} working · ${n("down")} down · ${n("simulated")} simulated · ${n("off")} off` };
}
