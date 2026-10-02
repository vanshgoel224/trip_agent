// The user's model choices (providers, keys, models, priority order). Stored as one
// record in the encrypted store, so keys are sealed with the vault key like all data.
// Keys never go back to the browser: the API returns them masked.
import { randomUUID } from "node:crypto";
import type { Store } from "../../packages/db";
import { PRESETS, withModels, type ProviderConfig } from "./providers";

const ID = "models";
export const mask = (k?: string) => (k ? `••••${k.slice(-4)}` : "");
const isMasked = (k?: string) => !!k && k.startsWith("••••");

export class ModelSettings {
  constructor(private store: Store) {}

  list(): ProviderConfig[] {
    return this.store.get<{ providers: ProviderConfig[] }>("settings", ID)?.providers ?? [];
  }

  /** What the UI sees: same list, keys masked. */
  view() {
    return this.list().map((p) => ({ ...p, apiKey: mask(p.apiKey), hasKey: !!p.apiKey }));
  }

  /** Replaces the list (its order is the priority). A blank or masked key keeps the stored one. */
  save(incoming: Partial<ProviderConfig>[]): ProviderConfig[] {
    if (!Array.isArray(incoming)) throw new Error("providers must be a list");
    const old = new Map(this.list().map((p) => [p.id, p]));
    const out: ProviderConfig[] = incoming.slice(0, 20).map((p) => {
      if (!p.provider || !(p.provider in PRESETS)) throw new Error(`unknown provider ${p.provider}`);
      const id = p.id && old.has(p.id) ? p.id : randomUUID();
      const key = String(p.apiKey ?? "").trim();
      const apiKey = !key || isMasked(key) ? old.get(id)?.apiKey : key;
      const baseUrl = String(p.baseUrl ?? "").trim();
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("base URL must start with http:// or https://");
      return { id, provider: p.provider, apiKey, baseUrl: baseUrl || undefined, model: String(p.model ?? "").trim() || undefined, enabled: p.enabled !== false };
    });
    this.store.put("settings", ID, { providers: out });
    return out;
  }

  /** The stored key for a provider row (for "Load models" on an already-saved row). */
  keyFor(id: string) {
    return this.list().find((p) => p.id === id)?.apiKey;
  }

  /** Runs fn with these settings active; with none saved, the server's env defaults apply. */
  run<T>(fn: () => T): T {
    const list = this.list();
    return withModels(list.length ? list : undefined, fn);
  }
}
