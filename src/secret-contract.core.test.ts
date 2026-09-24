/**
 * Сквозная проверка на настоящих функциях ядра: SecretRef в настройках канала
 * собирается контрактом, разрешается сборщиком секретов ядра и доходит до
 * `resolveAccount` строкой; схемы (zod и JSON из манифеста) принимают и строку,
 * и ссылку.
 *
 * Без установленного ядра (так гоняет CI и `check:test-isolation`) набор
 * пропускается: мокать здесь нечего, смысл именно в настоящем ядре.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const core = await import("openclaw/plugin-sdk/secret-ref-runtime").catch(() => null);
// Контракт импортирует подпути SDK статически, поэтому грузится только при ядре.
const { collectRuntimeConfigAssignments } = core
  ? await import("./secret-contract.js")
  : { collectRuntimeConfigAssignments: () => {} };
const { resolveAccount } = await import("./accounts.js");

describe.skipIf(!core)("SecretRef на настоящем ядре", () => {
  async function resolveThroughCore(config: { channels: { max: Record<string, unknown> } }, env: NodeJS.ProcessEnv) {
    const context = core!.createResolverContext({ sourceConfig: structuredClone(config) as never, env });
    collectRuntimeConfigAssignments({ config, context });
    const resolved = await core!.resolveSecretRefValues(
      context.assignments.map((a) => a.ref),
      { config: config as never, env },
    );
    core!.applyResolvedAssignments({ assignments: context.assignments, resolved });
    return context;
  }

  it("ссылки на уровне канала и в учётке разрешаются в строки", async () => {
    const config = {
      channels: {
        max: {
          token: { source: "env", provider: "default", id: "MAX_ROOT_TOKEN" },
          accounts: { work: { token: { source: "env", provider: "default", id: "MAX_WORK_TOKEN" } } },
        },
      },
    };
    const context = await resolveThroughCore(config, { MAX_ROOT_TOKEN: " root-secret ", MAX_WORK_TOKEN: "work-secret" });

    expect(context.assignments.map((a) => [a.path, a.ownerId])).toEqual([
      ["channels.max.token", "max:default"],
      ["channels.max.accounts.work.token", "max:work"],
    ]);
    expect(resolveAccount(config, "default").token).toBe("root-secret");
    expect(resolveAccount(config, "work").token).toBe("work-secret");
  });

  it("строковый токен ядру не отдаётся — разрешать нечего", async () => {
    const config = { channels: { max: { token: "plain" } } };
    const context = await resolveThroughCore(config, {});
    expect(context.assignments).toEqual([]);
    expect(resolveAccount(config).token).toBe("plain");
  });

  it("неразрешимая ссылка: ядро сообщает ошибку, плагин не падает на объекте", async () => {
    const ref = { source: "env", provider: "default", id: "MAX_MISSING_TOKEN" };
    const config = { channels: { max: { token: ref } } };
    await expect(resolveThroughCore(config, {})).rejects.toThrow(/MAX_MISSING_TOKEN/);
    // Так ядро оставляет владельца в «холодной» деградации: кладёт ссылку как есть.
    const account = resolveAccount(config);
    expect(account.token).toBe("");
    expect(account.tokenUnresolved).toBe("env:default:MAX_MISSING_TOKEN");
  });

  it("zod-схема канала принимает строку и ссылку, отвергает кривую ссылку", async () => {
    const { createMaxPlugin } = await import("./channel.js");
    const schema = createMaxPlugin().configSchema;
    const ok = (token: unknown) => schema.runtime.safeParse({ token }).success;
    expect(ok("plain")).toBe(true);
    expect(ok({ source: "exec", provider: "openclaw-keychain", id: "max-bot-token" })).toBe(true);
    expect(ok({ source: "env", provider: "default", id: "MAX_TOKEN" })).toBe(true);
    expect(ok({ source: "exec" })).toBe(false);
    expect(ok({ source: "env", provider: "default", id: "lowercase" })).toBe(false);
    expect(ok(42)).toBe(false);
    // JSON-схема, которую ядро строит из zod, тоже знает про ссылку.
    expect(JSON.stringify(schema.schema.properties.token)).toContain('"exec"');
  });

  it("JSON-схемы манифеста принимают строку и ссылку", async () => {
    const { default: Ajv } = await import("ajv");
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const ajv = new Ajv({ strict: false });
    const channelSchema = ajv.compile(manifest.channelConfigs.max.schema);
    const pluginSchema = ajv.compile(manifest.configSchema);
    const ref = { source: "exec", provider: "openclaw-keychain", id: "max-bot-token" };

    for (const token of ["plain", ref, { source: "env", provider: "default", id: "MAX_TOKEN" }]) {
      expect(channelSchema({ token })).toBe(true);
      expect(pluginSchema({ max: { token } })).toBe(true);
    }
    for (const token of [{ source: "exec" }, { ...ref, extra: 1 }, 42]) {
      expect(channelSchema({ token })).toBe(false);
    }
    expect(manifest.channelConfigs.max.uiHints.token.sensitive).toBe(true);
  });
});
