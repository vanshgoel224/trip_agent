import { BiruniError } from "../../packages/shared";

// Live adapters are deliberately NOT implemented: the vendor API endpoints,
// auth flows and payload shapes have not been verified against current docs.
// Implement each against the provider's official documentation (Phase 5),
// keeping the same interface so MCP tool contracts do not change.
export function notImplemented(provider: string, method: string): never {
  throw new BiruniError(
    "EXTERNAL_FAILURE",
    `${provider}.${method}: live adapter not implemented — set PROVIDER_MODE=mock or implement against verified vendor docs`,
    false,
  );
}

export function requireEnv(...names: string[]) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new BiruniError("AUTH_FAILURE", `missing server-side env: ${missing.join(", ")}`);
}
