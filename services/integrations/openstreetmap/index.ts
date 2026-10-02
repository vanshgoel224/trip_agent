// OpenStreetMap: Nominatim (geocoding), Overpass (nearby POIs, with a Nominatim
// fallback), OSRM (routing + turn-by-turn). All free public services with fair-use
// limits (Nominatim: max 1 request/second, identifying User-Agent). For production
// traffic, self-host or use a paid provider. Data © OpenStreetMap contributors (ODbL).
const UA = process.env.OSM_USER_AGENT || "biruni-prototype/0.1 (KEN Round 3 demo)";
const NOMINATIM = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const OSRM = process.env.OSRM_URL || "https://router.project-osrm.org";

export type LatLng = { lat: number; lng: number };
export type Place = { name: string; lat: number; lng: number; kind?: string; address?: string; distanceM?: number; osm?: string };

let lastNominatim = 0;
async function nominatim(path: string): Promise<any> {
  const wait = lastNominatim + 1100 - Date.now(); // fair-use: ≤ 1 req/s
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const res = await fetch(`${NOMINATIM}${path}`, { headers: { "user-agent": UA, "accept-language": "en-IN,en" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

export function distanceM(a: LatLng, b: LatLng) {
  const R = 6371e3, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export async function reverseGeocode(p: LatLng): Promise<{ name: string; address: Record<string, string> }> {
  const j = await nominatim(`/reverse?lat=${p.lat}&lon=${p.lng}&format=jsonv2&zoom=17&addressdetails=1`);
  return { name: j.display_name ?? `${p.lat},${p.lng}`, address: j.address ?? {} };
}

export async function findPlace(q: string, near?: LatLng): Promise<Place[]> {
  const bias = near ? `&viewbox=${near.lng - 0.5},${near.lat + 0.5},${near.lng + 0.5},${near.lat - 0.5}` : "";
  const j = (await nominatim(`/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=5&countrycodes=in${bias}`)) as any[];
  return j.map((x) => {
    const p = { name: x.name || x.display_name, lat: +x.lat, lng: +x.lon, kind: `${x.category}/${x.type}`, address: x.display_name, osm: `${x.osm_type}/${x.osm_id}` };
    return near ? { ...p, distanceM: distanceM(near, p) } : p;
  });
}

// Common traveller needs → OSM tags.
const KINDS: Record<string, [string, string]> = {
  atm: ["amenity", "atm"], bank: ["amenity", "bank"], hospital: ["amenity", "hospital"], clinic: ["amenity", "clinic"],
  pharmacy: ["amenity", "pharmacy"], police: ["amenity", "police"], restaurant: ["amenity", "restaurant"], cafe: ["amenity", "cafe"],
  fuel: ["amenity", "fuel"], toilets: ["amenity", "toilets"], bus_station: ["amenity", "bus_station"], taxi: ["amenity", "taxi"],
  railway_station: ["railway", "station"], hotel: ["tourism", "hotel"], hostel: ["tourism", "hostel"], attraction: ["tourism", "attraction"],
  viewpoint: ["tourism", "viewpoint"], temple: ["amenity", "place_of_worship"], supermarket: ["shop", "supermarket"],
};
export const NEARBY_KINDS = Object.keys(KINDS);

export async function nearby(kind: string, at: LatLng, radiusM = 1500, limit = 8): Promise<{ source: string; places: Place[] }> {
  const tag = KINDS[kind] ?? ["amenity", kind];
  try {
    const q = `[out:json][timeout:15];nwr["${tag[0]}"="${tag[1]}"](around:${radiusM},${at.lat},${at.lng});out center ${limit * 2};`;
    const res = await fetch(OVERPASS, { method: "POST", headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(q)}`, signal: AbortSignal.timeout(18_000) });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const j = (await res.json()) as { elements: any[] };
    const places = j.elements
      .map((e) => ({ name: e.tags?.name ?? kind, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon, kind, osm: `${e.type}/${e.id}`, address: [e.tags?.["addr:street"], e.tags?.["addr:city"]].filter(Boolean).join(", ") || undefined }))
      .filter((p) => p.lat)
      .map((p) => ({ ...p, distanceM: distanceM(at, p) }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, limit);
    return { source: "overpass", places };
  } catch {
    // Fallback: Nominatim bounded search around the point.
    const d = radiusM / 111_000;
    const j = (await nominatim(`/search?q=${encodeURIComponent(tag[1].replace("_", " "))}&format=jsonv2&limit=${limit}&bounded=1&viewbox=${at.lng - d},${at.lat + d},${at.lng + d},${at.lat - d}`)) as any[];
    const places = j.map((x) => ({ name: x.name || tag[1], lat: +x.lat, lng: +x.lon, kind, address: x.display_name, osm: `${x.osm_type}/${x.osm_id}` }))
      .map((p) => ({ ...p, distanceM: distanceM(at, p) }))
      .sort((a, b) => a.distanceM - b.distanceM);
    return { source: "nominatim", places };
  }
}

export type Directions = { distanceM: number; durationS: number; steps: string[]; geometry: [number, number][]; profile: string };

/** Note: the public OSRM demo server only reliably supports the driving profile. */
export async function directions(from: LatLng, to: LatLng, profile: "driving" | "walking" | "cycling" = "driving"): Promise<Directions> {
  const res = await fetch(`${OSRM}/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const j = (await res.json()) as any;
  if (j.code !== "Ok" || !j.routes?.length) throw new Error(`No route (${j.code})`);
  const r = j.routes[0];
  const steps = r.legs[0].steps.map((s: any) => {
    const m = s.maneuver;
    const verb = m.type === "depart" ? "Head" : m.type === "arrive" ? "Arrive" : m.type === "turn" || m.type === "end of road" || m.type === "fork" ? `Turn ${m.modifier ?? ""}` : m.type === "roundabout" || m.type === "rotary" ? `Take exit ${m.exit ?? ""} at the roundabout` : m.modifier ? `Continue ${m.modifier}` : "Continue";
    return `${verb.trim()}${s.name ? ` onto ${s.name}` : ""}${s.distance > 0 ? ` (${s.distance >= 1000 ? (s.distance / 1000).toFixed(1) + " km" : Math.round(s.distance) + " m"})` : ""}`;
  });
  return { distanceM: Math.round(r.distance), durationS: Math.round(r.duration), steps, geometry: r.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]), profile };
}
