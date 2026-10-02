// Reddit — traveller-written tips and lesser-known places (ported from the old
// apps/phone-offline/discover.py). Uses an app-only OAuth token when
// REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET are set (create a "script" app at
// https://www.reddit.com/prefs/apps); otherwise tries the public read-only JSON,
// which Reddit often blocks from cloud IPs (403).
import { BiruniError } from "../../../packages/shared";

export type RedditPost = { title: string; subreddit: string; score: number; url: string; excerpt: string };

const SUBS = ["IndiaTravel", "india", "backpacking"];
const UA = "biruni-prototype/0.1 (KEN Round 3 demo)";
let token: { value: string; exp: number } | undefined;

export const redditConfigured = () => !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);

async function appToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new BiruniError("AUTH_FAILURE", `Reddit token HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export async function searchReddit(place: string, limit = 5): Promise<RedditPost[]> {
  const auth: Record<string, string> = redditConfigured() ? { authorization: `Bearer ${await appToken()}` } : {};
  const host = redditConfigured() ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const q = encodeURIComponent(`${place} (hidden OR offbeat OR underrated OR tips)`);
  const out: RedditPost[] = [];
  for (const sub of SUBS) {
    const res = await fetch(`${host}/r/${sub}/search${redditConfigured() ? "" : ".json"}?q=${q}&restrict_sr=1&sort=relevance&t=year&limit=${limit}`, {
      headers: { "user-agent": UA, ...auth },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 403 || res.status === 401)
      throw new BiruniError("AUTH_FAILURE", `Reddit refused anonymous access (HTTP ${res.status}). Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.`);
    if (!res.ok) continue;
    const j = (await res.json()) as { data?: { children?: { data: any }[] } };
    for (const c of j.data?.children ?? []) {
      const d = c.data;
      out.push({ title: d.title, subreddit: d.subreddit, score: d.score, url: `https://www.reddit.com${d.permalink}`, excerpt: String(d.selftext ?? "").slice(0, 400) });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
