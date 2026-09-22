/** Разбор настроек учётных записей канала и доступ к рантайму ядра. */
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_ID, DEFAULT_WEBHOOK_PATH, listAccountIds, resolveAccount } from "./accounts.js";
import { getMaxRuntime, setMaxRuntime } from "./runtime.js";

describe("listAccountIds", () => {
  it("без настроек канала список пуст", () => {
    expect(listAccountIds({})).toEqual([]);
    expect(listAccountIds({ channels: {} })).toEqual([]);
  });

  it("корневой токен даёт учётку по умолчанию", () => {
    expect(listAccountIds({ channels: { max: { token: "t" } } })).toEqual(["default"]);
  });

  it("корневой токен и отдельные учётки складываются", () => {
    expect(
      listAccountIds({ channels: { max: { token: "t", accounts: { work: { token: "w" } } } } }),
    ).toEqual(["default", "work"]);
  });

  it("без корневого токена остаются только отдельные учётки", () => {
    expect(listAccountIds({ channels: { max: { accounts: { work: { token: "w" } } } } })).toEqual([
      "work",
    ]);
  });

  it("канал без токена и без учёток не даёт ничего", () => {
    expect(listAccountIds({ channels: { max: {} } })).toEqual([]);
  });
});

describe("resolveAccount", () => {
  const cfg = {
    channels: {
      max: {
        token: "  root-token  ",
        dmPolicy: "allowlist" as const,
        allowFrom: [" max:user:42 ", "max:7", "", "  "],
        httpProxy: "  http://proxy.test  ",
        accounts: {
          work: { token: "work-token", enabled: false, webhookUrl: "https://h.test/hook" },
        },
      },
    },
  };

  it("учётка по умолчанию берёт корневые значения и чистит их", () => {
    expect(resolveAccount(cfg)).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      token: "root-token",
      enabled: true,
      webhookUrl: undefined,
      webhookSecret: undefined,
      webhookPath: DEFAULT_WEBHOOK_PATH,
      dmPolicy: "allowlist",
      // Префиксы `max:` и `max:user:` снимаются, пустые строки выбрасываются.
      allowFrom: ["42", "7"],
      httpProxy: "http://proxy.test",
    });
  });

  it("настройки учётки перекрывают корневые", () => {
    const account = resolveAccount(cfg, "work");
    expect(account).toMatchObject({
      accountId: "work",
      token: "work-token",
      enabled: false,
      webhookUrl: "https://h.test/hook",
    });
  });

  it("неизвестная учётка не падает, а берёт корневые значения", () => {
    expect(resolveAccount(cfg, "ghost")).toMatchObject({ accountId: "ghost", token: "root-token" });
  });

  it("пустой конфиг даёт разумные умолчания", () => {
    expect(resolveAccount({})).toEqual({
      accountId: DEFAULT_ACCOUNT_ID,
      token: "",
      enabled: true,
      webhookUrl: undefined,
      webhookSecret: undefined,
      webhookPath: DEFAULT_WEBHOOK_PATH,
      dmPolicy: "pairing",
      allowFrom: [],
      httpProxy: undefined,
    });
  });

  it("пустой прокси считается отсутствующим", () => {
    expect(resolveAccount({ channels: { max: { httpProxy: "   " } } }).httpProxy).toBeUndefined();
  });
});

describe("рантайм ядра", () => {
  beforeEach(() => {
    setMaxRuntime(null);
  });

  it("без регистрации обращение к рантайму — внятная ошибка", () => {
    expect(() => getMaxRuntime()).toThrow("Runtime not initialized");
  });

  it("после регистрации отдаёт то, что положили", () => {
    const runtime = { channel: {} };
    setMaxRuntime(runtime);
    expect(getMaxRuntime()).toBe(runtime);
  });
});
