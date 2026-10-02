// Search-engine-style tolerant matching: case-insensitive, accent-insensitive,
// typo-tolerant (Damerau-Levenshtein), prefix-aware, word-order-insensitive.
// Used for commands, memory recall, people's names, languages, chat names and
// keyword fallbacks, so "/recal raul", "Tamill", "cancled" all work.

export const normalize = (s: string) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents (Latin); Indic scripts untouched
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Optimal-string-alignment Damerau-Levenshtein distance (transpositions count as 1). */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2 = new Array(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** Typos allowed for a word of this length (like search engines: none for very short words). */
export const allowedTypos = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

/** Does query word q match candidate word w, allowing typos and prefix typing? */
export function wordMatch(q: string, w: string): boolean {
  if (!q || !w) return false;
  if (q === w) return true;
  if (q.length >= 3 && w.startsWith(q)) return true; // typing in progress
  const k = allowedTypos(Math.min(q.length, w.length));
  if (k === 0) return false;
  if (editDistance(q, w, k) <= k) return true;
  // prefix with a typo: compare against the same-length head of the candidate
  return q.length >= 4 && w.length > q.length && editDistance(q, w.slice(0, q.length), 1) <= 1;
}

/** 0..1 similarity between a query and a candidate phrase (word-order-insensitive). */
export function score(query: string, candidate: string): number {
  const q = normalize(query), c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q)) return 0.95 - Math.min(0.2, (c.length - q.length) / 200);
  const qw = q.split(" "), cw = c.split(" ");
  let hit = 0;
  for (const w of qw) if (cw.some((x) => wordMatch(w, x))) hit++;
  const wordScore = hit / qw.length;
  // whole-string typo similarity for single-token names ("tamill" ~ "tamil")
  const d = editDistance(q, c, 3);
  const whole = d <= 3 ? 1 - d / Math.max(q.length, c.length) : 0;
  return Math.max(wordScore * 0.9, whole * 0.92);
}

/** Best candidate above a threshold, or undefined. */
export function bestMatch<T>(query: string, items: T[], key: (t: T) => string | string[], threshold = 0.6): { item: T; score: number } | undefined {
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const keys = ([] as string[]).concat(key(item));
    const s = Math.max(...keys.map((k) => score(query, k)));
    if (s >= threshold && (!best || s > best.score)) best = { item, score: s };
  }
  return best;
}

/** All candidates above a threshold, best first. */
export function rank<T>(query: string, items: T[], key: (t: T) => string | string[], threshold = 0.55): { item: T; score: number }[] {
  return items
    .map((item) => ({ item, score: Math.max(...([] as string[]).concat(key(item)).map((k) => score(query, k))) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

/** Does the text contain any of these keywords, allowing typos (for keyword fallbacks)? */
export function containsFuzzy(text: string, keywords: string[]): boolean {
  const words = normalize(text).split(" ");
  const joined = ` ${words.join(" ")} `;
  return keywords.some((k) => {
    const nk = normalize(k);
    if (nk.includes(" ")) return joined.includes(` ${nk} `) || score(text, nk) >= 0.9;
    return words.some((w) => w === nk || (nk.length >= 5 && w.length >= 4 && editDistance(w, nk, 1) <= 1) || (nk.length >= 4 && w.startsWith(nk)));
  });
}
