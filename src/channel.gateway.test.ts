/**
 * Внутренности запуска канала: длинный опрос с ошибками и откатом, вебхук с
 * обработчиком и снятием устаревшего маршрута, разбор сетевых вложений.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  sendDm: vi.fn(),
  sendToChat: vi.fn(),
  sendDmWithImage: vi.fn(),
  sendToChatWithImage: vi.fn(),
  editMessage: vi.fn(),
  markSeen: vi.fn(),
  sendTypingAction: vi.fn(),
  getUpdates: vi.fn(),
  subscribeWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getBotInfo: vi.fn(),
  getUploadUrl: vi.fn(),
  uploadFile: vi.fn(),
  configureMaxTransport: vi.fn(),
  createUpload: vi.fn(),
  uploadToUrl: vi.fn(),
  sendWithAttachment: vi.fn(),
};
vi.mock("./client.js", () => client);

const unregisterRoute = vi.fn();
const registerPluginHttpRoute = vi.fn((..._args: unknown[]) => unregisterRoute);
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  registerPluginHttpRoute: (...args: unknown[]) => registerPluginHttpRoute(...args),
}));
vi.mock("openclaw/plugin-sdk/core", () => ({
  buildChannelConfigSchema: (shape: unknown) => shape,
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  resolveChannelPreviewStreamMode: () => "progress",
}));
vi.mock("./progress-draft.js", () => ({
  createMaxProgressDraft: () => ({
    compositor: {
      pushNarrationProgress: vi.fn(),
      pushReasoningProgress: vi.fn(),
      pushToolEvent: vi.fn(),
      pushItemEvent: vi.fn(),
      pushApprovalEvent: vi.fn(),
      markFinalReplyStarted: vi.fn(),
      markFinalReplyDelivered: vi.fn(),
    },
    currentMessageId: () => undefined,
    overwrite: vi.fn(),
    showPlaceholder: vi.fn(),
    remove: vi.fn(),
    detach: vi.fn(),
    close: vi.fn(),
  }),
  resolveMaxProgressLabel: () => "⏳ Работаю",
}));

const dispatch = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./runtime.js", () => ({
  getMaxRuntime: () => ({
    channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "agent:main:max:direct:42" }) },
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: (...a: unknown[]) => dispatch(...a),
      },
    },
  }),
}));

const webhookHandlerParams: Array<Record<string, unknown>> = [];
const createWebhookHandler = vi.fn((params: Record<string, unknown>) => {
  webhookHandlerParams.push(params);
  return async () => new Response("ok");
});
const handleUpdate = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: (...args: [Record<string, unknown>]) => createWebhookHandler(...args),
  handleUpdate: (...args: unknown[]) => handleUpdate(...args),
}));

const { createMaxPlugin, collectOutboundMedia, createStreamingDeliver } = await import(
  "./channel.js"
);

const plugin = createMaxPlugin();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = {
  text: "привет",
  senderId: "42",
  senderName: "IZ",
  chatId: "42",
  dialogChatId: "42",
  chatType: "direct",
  messageId: "mid-in",
  accountId: "default",
};

beforeEach(() => {
  vi.clearAllMocks();
  webhookHandlerParams.length = 0;
  client.sendTypingAction.mockResolvedValue(undefined);
  client.markSeen.mockResolvedValue(undefined);
  client.getBotInfo.mockResolvedValue({ name: "бот", username: "bot" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("вебхук", () => {
  const cfg = { channels: { max: { token: "tok", webhookUrl: "https://h.test/hook" } } };

  it("обработчик вебхука прогоняет сообщение через ход", async () => {
    const ctl = new AbortController();
    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();
    await started;

    const deliver = webhookHandlerParams[0]?.deliver as (msg: unknown) => Promise<unknown>;
    await expect(deliver(inbound)).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalled();
  });

  it("повторный запуск снимает устаревший маршрут", async () => {
    // Второй запуск ДО остановки первого: именно так выглядит перезагрузка
    // настроек, и без снятия старого маршрута их осталось бы два.
    const first = new AbortController();
    const firstStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: first.signal,
    });
    await Promise.resolve();
    await Promise.resolve();

    const second = new AbortController();
    const secondStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: second.signal,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Deregistering stale"));
    expect(unregisterRoute).toHaveBeenCalled();

    first.abort();
    second.abort();
    await Promise.all([firstStarted, secondStarted]);
  });

  it("при остановке снимается подписка, а её сбой не мешает", async () => {
    // Снятие подписки — уборка по мере возможности: если MAX недоступен,
    // останов канала всё равно должен завершиться.
    client.deleteWebhook.mockRejectedValueOnce(new Error("max unreachable"));
    const ctl = new AbortController();

    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();

    await expect(started).resolves.toBeUndefined();
    expect(client.deleteWebhook).toHaveBeenCalledWith("tok");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Stopping webhook mode"));
  });
});

describe("отметка о прочтении", () => {
  it("ставится один раз в начале хода", async () => {
    createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "392679003",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

    expect(client.markSeen).toHaveBeenCalledTimes(1);
    expect(client.markSeen).toHaveBeenCalledWith("tok", 392679003);
  });

  it("на нечисловом чате не шлётся", () => {
    createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "нечисло",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

    expect(client.markSeen).not.toHaveBeenCalled();
  });
});

describe("индикатор набора", () => {
  it("обновляется, пока идёт ход", async () => {
    // MAX гасит индикатор через несколько секунд, поэтому его шлют заново по
    // таймеру; без этого «печатает…» пропадает на длинном ходе.
    vi.useFakeTimers();
    const deliverer = createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "42",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

    expect(client.sendTypingAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(client.sendTypingAction.mock.calls.length).toBeGreaterThan(1);

    await deliverer.finish();
    const afterFinish = client.sendTypingAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    // После завершения хода индикатор больше не шлётся.
    expect(client.sendTypingAction).toHaveBeenCalledTimes(afterFinish);
  });
});

describe("длинный опрос", () => {
  const cfg = { channels: { max: { token: "tok" } } };

  it("обновление уходит обработчику, и тот прогоняет ход", async () => {
    const ctl = new AbortController();
    client.getUpdates.mockImplementation(async () => {
      ctl.abort();
      return { updates: [{ update_type: "message_created" }], marker: 3 };
    });

    await plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });

    const deliver = handleUpdate.mock.calls[0]?.[2] as (msg: unknown) => Promise<unknown>;
    await expect(deliver(inbound)).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalled();
  });

  it("ошибка опроса считается и ход повторяется после паузы", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    let calls = 0;
    client.getUpdates.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      ctl.abort();
      return { updates: [], marker: null };
    });

    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await started;

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Long polling error (1/"));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("после череды ошибок опрос останавливается", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    client.getUpdates.mockRejectedValue(new Error("network down"));

    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await started;

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Too many consecutive errors"));
  });

  it("прерывание во время ошибки не считается сбоем", async () => {
    const ctl = new AbortController();
    client.getUpdates.mockImplementation(async () => {
      ctl.abort();
      throw new Error("aborted mid-flight");
    });

    await plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });

    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining("Too many consecutive"));
  });
});

describe("вложение по ссылке", () => {
  const draftlessDeliverer = () =>
    createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "нечисло",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

  it("картинка по http скачивается перед загрузкой", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("img").buffer,
    } as never);
    client.getUploadUrl.mockResolvedValue("https://up.test");
    client.uploadFile.mockResolvedValue({ token: "img" });
    client.sendDmWithImage.mockResolvedValue("mid-img");
    const { deliver, finish } = draftlessDeliverer();

    await deliver({ text: "", mediaUrl: "https://cdn.test/a.png" }, { kind: "final" });
    await finish();

    expect(fetchSpy).toHaveBeenCalledWith("https://cdn.test/a.png");
    expect(client.sendDmWithImage).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("недоступная ссылка гасится и попадает в лог", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as never);
    const { deliver, finish } = draftlessDeliverer();

    await deliver({ text: "Готово", mediaUrl: "https://cdn.test/a.png" }, { kind: "final" });
    await finish();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("media fetch failed: 404"));
    fetchSpy.mockRestore();
  });

  it("ссылка с процентом в имени не мешает разбору", () => {
    expect(collectOutboundMedia({ mediaUrl: "https://cdn.test/100%.png" })[0]).toMatchObject({
      name: "100%.png",
      mimeType: "image/png",
    });
  });
});
