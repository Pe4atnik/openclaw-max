/**
 * Account config resolution for the MAX channel plugin.
 */

import type { MaxConfig, MaxTokenInput, ResolvedMaxAccount } from "./types.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_WEBHOOK_PATH = "/max/webhook";

/**
 * List all configured account IDs for a config object.
 */
export function listAccountIds(cfg: { channels?: { max?: MaxConfig } }): string[] {
  const maxCfg = cfg?.channels?.max;
  if (!maxCfg) return [];
  const extra = Object.keys(maxCfg.accounts ?? {});
  // Always include 'default' if the root-level config has a token
  if (maxCfg.token) return [DEFAULT_ACCOUNT_ID, ...extra];
  return extra.length > 0 ? extra : [];
}

/**
 * Resolve a single account's full config.
 */
export function resolveAccount(
  cfg: { channels?: { max?: MaxConfig } },
  accountId?: string | null,
): ResolvedMaxAccount {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const maxCfg = cfg?.channels?.max ?? {};

  // Per-account overrides (if not default)
  const perAccount = id !== DEFAULT_ACCOUNT_ID ? (maxCfg.accounts?.[id] ?? {}) : {};

  // Merge: per-account overrides root-level
  const merged = { ...maxCfg, ...perAccount };

  const { token, tokenUnresolved } = readToken(merged.token);

  return {
    accountId: id,
    token,
    ...(tokenUnresolved ? { tokenUnresolved } : {}),
    enabled: merged.enabled !== false,
    webhookUrl: merged.webhookUrl,
    webhookSecret: merged.webhookSecret,
    webhookPath: merged.webhookPath ?? DEFAULT_WEBHOOK_PATH,
    dmPolicy: merged.dmPolicy ?? "pairing",
    allowFrom: normalizeAllowFrom(merged.allowFrom),
    httpProxy: merged.httpProxy?.trim() || undefined,
  };
}

/**
 * The host resolves a SecretRef token before the plugin sees the config. When it
 * cannot (provider down, id missing), it leaves the reference object in place and
 * marks the account unavailable; everything here must survive that object instead
 * of calling `.trim()` on it.
 */
function readToken(raw: MaxTokenInput | undefined): { token: string; tokenUnresolved?: string } {
  if (raw === undefined || raw === null) return { token: "" };
  if (typeof raw === "string") return { token: raw.trim() };
  if (typeof raw === "object" && typeof raw.source === "string") {
    return { token: "", tokenUnresolved: `${raw.source}:${raw.provider ?? "?"}:${raw.id ?? "?"}` };
  }
  return { token: "", tokenUnresolved: "value is not a string" };
}

/** Why an account has no usable token, for logs and send errors. */
export function describeMissingToken(account: Pick<ResolvedMaxAccount, "tokenUnresolved">): string {
  return account.tokenUnresolved
    ? `MAX token SecretRef ${account.tokenUnresolved} is not resolved (check the secrets provider: openclaw secrets audit)`
    : "MAX token not configured";
}

function normalizeAllowFrom(raw?: string[]): string[] {
  if (!raw) return [];
  return raw
    .map((s) => String(s).trim())
    .filter(Boolean)
    .map((s) => s.replace(/^max:(?:user:)?/i, ""));
}
