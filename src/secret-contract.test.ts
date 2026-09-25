/**
 * Контракт секретов: какие пути с токеном отдаются ядру на разрешение, чьи они
 * и активны ли. Сборщик ядра здесь подменён записью вызовов — сквозная проверка
 * на настоящих функциях ядра лежит в `secret-contract.core.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Collected = {
  value: unknown;
  path: string;
  active?: boolean;
  inactiveReason?: string;
  owner?: { ownerId: string; contract: unknown };
  apply: (value: unknown) => void;
};
const collected: Collected[] = [];

vi.mock("openclaw/plugin-sdk/channel-secret-basic-runtime", () => {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  return {
    isRecord,
    hasOwnProperty: (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key),
    getChannelRecord: (config: { channels?: Record<string, unknown> }, key: string) => {
      const channel = config.channels?.[key];
      return isRecord(channel) ? channel : undefined;
    },
    createChannelSecretTargetRegistryEntries: (params: unknown) => [params],
    collectSecretInputAssignment: (params: Collected) => {
      collected.push(params);
    },
  };
});
vi.mock("openclaw/plugin-sdk/account-id", () => ({
  normalizeAccountId: (id: string) => id.trim().toLowerCase() || "default",
}));

const contract = await import("./secret-contract.js");
const api = await import("../secret-contract-api.js");

const ref = { source: "exec", provider: "openclaw-keychain", id: "max-bot-token" };
const context = {} as never;
const collect = (max: unknown) =>
  contract.collectRuntimeConfigAssignments({ config: { channels: { max } }, context });

beforeEach(() => {
  collected.length = 0;
});

describe("реестр путей", () => {
  it("токен на уровне канала и в каждой учётке", () => {
    expect(contract.secretTargetRegistryEntries).toEqual([
      { channelKey: "max", account: ["token"], channel: ["token"] },
    ]);
  });

  it("точка входа для ядра отдаёт то же самое", () => {
    expect(api.secretTargetRegistryEntries).toBe(contract.secretTargetRegistryEntries);
    expect(api.collectRuntimeConfigAssignments).toBe(contract.collectRuntimeConfigAssignments);
    expect(api.channelSecrets).toEqual({
      secretTargetRegistryEntries: contract.secretTargetRegistryEntries,
      collectRuntimeConfigAssignments: contract.collectRuntimeConfigAssignments,
    });
  });
});

describe("сборщик назначений", () => {
  it("без канала MAX ничего не собирает", () => {
    contract.collectRuntimeConfigAssignments({ config: {}, context });
    collect(undefined);
    expect(collected).toEqual([]);
  });

  it("корневой токен принадлежит учётке по умолчанию, разрешённое значение ложится на место", () => {
    const max: Record<string, unknown> = { token: ref };
    collect(max);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ value: ref, path: "channels.max.token", owner: { ownerId: "max:default" } });
    collected[0].apply("resolved");
    expect(max.token).toBe("resolved");
  });

  it("корень без токена не собирается", () => {
    collect({ dmPolicy: "open" });
    expect(collected).toEqual([]);
  });

  it("корневой токен наследуют учётки без своего, свои токены собираются отдельно", () => {
    const work = { token: ref };
    const channel: Record<string, unknown> = {
      token: { source: "env", provider: "default", id: "MAX_ROOT" },
      accounts: { work, spare: {}, off: { enabled: false }, junk: "not-an-object" },
    };
    collect(channel);

    const root = collected.filter((c) => c.path === "channels.max.token");
    expect(root.map((c) => c.owner?.ownerId)).toEqual(["max:default", "max:spare"]);
    expect(root[0].owner?.contract).toBe(root[1].owner?.contract);

    const own = collected.filter((c) => c.path !== "channels.max.token");
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ path: "channels.max.accounts.work.token", active: true, owner: { ownerId: "max:work" } });
    own[0].apply("w");
    expect(work.token).toBe("w");
  });

  it("выключенный канал: корень неактивен, если его никто не наследует", () => {
    const channel: Record<string, unknown> = { enabled: false, token: ref };
    collect(channel);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ path: "channels.max.token", active: false });
    expect(collected[0].inactiveReason).toContain("disabled");
    collected[0].apply("x");
    expect(channel.token).toBe("x");
  });

  it("учётка, включённая явно при выключенном корне, наследует корневой токен — как в resolveAccount", () => {
    collect({ enabled: false, token: ref, accounts: { work: { enabled: true } } });
    expect(collected.map((c) => c.owner?.ownerId)).toEqual(["max:work"]);
  });

  it("выключенная учётка со своим токеном собирается неактивной", () => {
    collect({ accounts: { off: { enabled: false, token: ref } } });
    expect(collected[0]).toMatchObject({ path: "channels.max.accounts.off.token", active: false });
    expect(collected[0].inactiveReason).toContain("disabled");
  });

  it("accounts.default не читается resolveAccount и не собирается", () => {
    collect({ token: "root", accounts: { default: { token: ref } } });
    expect(collected.map((c) => c.path)).toEqual(["channels.max.token"]);
    expect(collected[0].owner?.ownerId).toBe("max:default");
  });

  it("необычный id учётки пишется в путь так же, как у ядра", () => {
    collect({ accounts: { "1bot": { token: ref }, "a.b": { token: ref } } });
    expect(collected.map((c) => c.path)).toEqual([
      'channels.max.accounts["1bot"].token',
      'channels.max.accounts["a.b"].token',
    ]);
  });
});
