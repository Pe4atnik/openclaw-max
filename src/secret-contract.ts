/**
 * SecretRef contract for the MAX channel.
 *
 * The host looks for `secret-contract-api.js` in the plugin root or `dist/` and
 * calls `collectRuntimeConfigAssignments` while it builds the runtime config
 * snapshot: every `token` that is a SecretRef (`{ source, provider, id }`) is
 * resolved there, and the plugin receives a plain string.
 *
 * The collector follows MAX's own account model rather than the host's generic
 * one: the root `token` always backs the `default` account (see
 * `listAccountIds`), and is inherited by every named account without a token of
 * its own. The generic helper would skip the root token once named accounts
 * exist, leaving `default` with an unresolved object.
 */

import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  hasOwnProperty,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

const CHANNEL_KEY = "max";
const DEFAULT_ACCOUNT_ID = "default";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: CHANNEL_KEY,
  account: ["token"],
  channel: ["token"],
});

type Owner = {
  ownerKind: "account";
  ownerId: string;
  requiredForGateway: false;
  disposition: "isolate";
  contract: unknown;
};

function accountOwner(accountId: string, contract: unknown): Owner {
  return {
    ownerKind: "account",
    ownerId: `${CHANNEL_KEY}:${normalizeAccountId(accountId)}`,
    requiredForGateway: false,
    disposition: "isolate",
    contract,
  };
}

/** Mirrors the host's `appendConfigPathSegment`, which the SDK does not export. */
function accountTokenPath(accountId: string): string {
  const base = `channels.${CHANNEL_KEY}.accounts`;
  const segment = /^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(accountId)
    ? `.${accountId}`
    : `[${JSON.stringify(accountId)}]`;
  return `${base}${segment}.token`;
}

/** Same rule as `resolveAccount`: the account's own `enabled` wins over the root. */
function isAccountEnabled(channel: Record<string, unknown>, account: Record<string, unknown>): boolean {
  const flag = hasOwnProperty(account, "enabled") ? account.enabled : channel.enabled;
  return flag !== false;
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, CHANNEL_KEY);
  if (!channel) return;

  const { accounts: rawAccounts, ...channelDefaults } = channel;
  const accounts = Object.entries(isRecord(rawAccounts) ? rawAccounts : {}).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );

  // Root token: the default account plus every enabled named account that inherits it.
  if (hasOwnProperty(channel, "token")) {
    const consumers = [
      ...(channel.enabled !== false ? [{ accountId: DEFAULT_ACCOUNT_ID, account: {} }] : []),
      ...accounts
        .filter(([id, account]) =>
          normalizeAccountId(id) !== DEFAULT_ACCOUNT_ID &&
          !hasOwnProperty(account, "token") &&
          isAccountEnabled(channel, account))
        .map(([accountId, account]) => ({ accountId, account })),
    ];
    const apply = (value: unknown) => {
      channel.token = value;
    };
    if (consumers.length === 0) {
      collectSecretInputAssignment({
        value: channel.token,
        path: `channels.${CHANNEL_KEY}.token`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: false,
        inactiveReason: "MAX channel is disabled and no enabled account inherits this top-level token.",
        apply,
      });
    } else {
      const contract = {
        channel: channelDefaults,
        consumers: consumers
          .map(({ accountId, account }) => ({ accountId: normalizeAccountId(accountId), account }))
          .sort((left, right) => left.accountId.localeCompare(right.accountId)),
      };
      for (const { accountId } of consumers) {
        collectSecretInputAssignment({
          value: channel.token,
          path: `channels.${CHANNEL_KEY}.token`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          owner: accountOwner(accountId, contract),
          apply,
        });
      }
    }
  }

  // Named accounts with a token of their own. `accounts.default` is never read by
  // `resolveAccount` (the default account is the root), so it is not collected.
  for (const [accountId, account] of accounts) {
    if (normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID) continue;
    if (!hasOwnProperty(account, "token")) continue;
    collectSecretInputAssignment({
      value: account.token,
      path: accountTokenPath(accountId),
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: isAccountEnabled(channel, account),
      inactiveReason: "MAX account is disabled.",
      owner: accountOwner(accountId, { channel: channelDefaults, account }),
      apply: (value: unknown) => {
        account.token = value;
      },
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
