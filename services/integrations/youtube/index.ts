// YouTube Data API v3 search (ported from apps/phone-offline/discover.py).
// Needs YOUTUBE_API_KEY: a Google Cloud API key with "YouTube Data API v3" enabled.
// A Gemini/AI Studio key does NOT work here. Each search costs 100 quota units
// (default quota is 10,000 units/day; verify current limits in Google's docs).
import { BiruniError } from "../../../packages/shared";

export type YouTubeVideo = { title: string; channel: string; url: string; published: string; description: string };

export const youtubeConfigured = () => !!process.env.YOUTUBE_API_KEY;

export async function searchYouTube(place: string, limit = 5): Promise<YouTubeVideo[]> {
  if (!youtubeConfigured()) throw new BiruniError("AUTH_FAILURE", "YouTube not connected: set YOUTUBE_API_KEY");
  const q = encodeURIComponent(`${place} hidden places travel guide`);
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${limit}&regionCode=IN&relevanceLanguage=en&q=${q}&key=${process.env.YOUTUBE_API_KEY}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new BiruniError(res.status === 403 ? "RATE_LIMIT" : "AUTH_FAILURE", `YouTube HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { items?: { id: { videoId: string }; snippet: any }[] };
  return (j.items ?? []).map((i) => ({
    title: i.snippet.title,
    channel: i.snippet.channelTitle,
    url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
    published: String(i.snippet.publishedAt).slice(0, 10),
    description: String(i.snippet.description ?? "").slice(0, 300),
  }));
}
