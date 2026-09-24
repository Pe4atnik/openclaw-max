/**
 * Обвязка хода: что плагин отдаёт ядру на входящее сообщение.
 *
 * Проверяются три вещи, каждая из которых ломалась живьём:
 *  - строка «Agent reply started» пишется один раз за ход, а не каждые 5 секунд;
 *  - посимвольный поток подписывается только в режиме "partial" — в остальных
 *    он затирал черновик хода;
 *  - ключ сессии берётся у ядра, а не собирается вручную.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const draft = {
  compositor: {
    pushNarrationProgress: vi.fn(),
    pushReasoningProgress: vi.fn(),
    pushToolEvent: vi.fn(),
    pushItemEvent: vi.fn(),
    pushApprovalEvent: vi.fn(),
    markFinalReplyStarted: vi.fn(),
    markFinalReplyDelivered: vi.fn(),
  },
  currentMessageId: vi.fn(() => undefined),
  overwrite: vi.fn(),
  showPlaceholder: vi.fn(),
  remove: vi.fn(),
  detach: vi.fn(),
  close: vi.fn(),
};
vi.mock("./progress-draft.js", () => ({
  createMaxProgressDraft: () => draft,
  resolveMaxProgressLabel: () => "⏳ Работаю",
}));

const streamMode = { value: "progress" };
vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  resolveChannelPreviewStreamMode: () => streamMode.value,
}));
// Новые подпути SDK, которые тянет channel.ts: без них набор падает в CI, где ядра нет.
vi.mock("openclaw/plugin-sdk/secret-input", async () => {
  const { z } = await import("zod");
  return {
    buildOptionalSecretInputSchema: () =>
      z.union([z.string(), z.object({ source: z.string(), provider: z.string(), id: z.string() })]).optional(),
  };
});
vi.mock("./secret-contract.js", () => ({
  secretTargetRegistryEntries: [],
  collectRuntimeConfigAssignments: () => {},
}));
vi.mock("openclaw/plugin-sdk/core", () => ({
  buildChannelConfigSchema: (shape: unknown) => shape,
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({ registerPluginHttpRoute: vi.fn() }));
vi.mock("./webhook-handler.js", () => ({ createWebhookHandler: vi.fn(), handleUpdate: vi.fn() }));

const dispatch = vi.fn((..._args: unknown[]) => Promise.resolve());
const finalizeInboundContext = vi.fn((...args: unknown[]) => args[0]);
const resolveAgentRoute = vi.fn((..._args: unknown[]) => ({
  sessionKey: "agent:main:max:direct:42",
}));
vi.mock("./runtime.js", () => ({
  getMaxRuntime: () => ({
    channel: {
      routing: { resolveAgentRoute: (...a: unknown[]) => resolveAgentRoute(...a) },
      reply: {
        finalizeInboundContext: (...a: unknown[]) => finalizeInboundContext(...a),
        dispatchReplyWithBufferedBlockDispatcher: (...a: unknown[]) => dispatch(...a),
      },
    },
  }),
}));

const { deliverMessage } = await import("./channel.js");

/** То, что плагин отдал ядру на последнем ходе. */
type DispatchedTurn = {
  dispatcherOptions: { deliver: (...a: unknown[]) => Promise<void>; onReplyStart: () => unknown };
  replyOptions: Record<string, ((payload?: unknown) => Promise<void>) | unknown>;
};
const dispatched = () => dispatch.mock.calls[0]?.[0] as DispatchedTurn;

const account = { accountId: "default", token: "tok", enabled: true } as never;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = {
  text: "что с лимоном?",
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
  streamMode.value = "progress";
  client.sendTypingAction.mockResolvedValue(undefined);
  client.markSeen.mockResolvedValue(undefined);
  client.sendDm.mockResolvedValue("mid-out");
  dispatch.mockResolvedValue(undefined);
});

describe("deliverMessage", () => {
  it("ключ сессии берётся у маршрутизатора ядра", async () => {
    await deliverMessage(inbound, account, {}, log);

    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "max", peer: { kind: "direct", id: "42" } }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ SessionKey: "agent:main:max:direct:42", ChatType: "direct" }),
    );
  });

  it("групповой чат помечается как group", async () => {
    await deliverMessage({ ...inbound, chatType: "group" }, account, {}, log);

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ ChatType: "group" }),
    );
  });

  it("в режиме progress посимвольный поток не подписывается", async () => {
    await deliverMessage(inbound, account, {}, log);

    const options = dispatched();
    expect(options.replyOptions.onPartialReply).toBeUndefined();
    expect(options.replyOptions.suppressDefaultToolProgressMessages).toBe(true);
  });

  it("в режиме partial поток подписывается и правит черновик", async () => {
    streamMode.value = "partial";

    await deliverMessage(inbound, account, {}, log);

    const options = dispatched();
    expect(options.replyOptions.onPartialReply).toBeTypeOf("function");
    await (options.replyOptions.onPartialReply as (p?: unknown) => Promise<void>)({ text: "часть" });
    expect(draft.overwrite).toHaveBeenCalledWith("часть …");
  });

  it("строка о начале ответа пишется один раз за ход", async () => {
    // Ядро зовёт `onReplyStart` каждые ~5 секунд, пока идёт работа.
    await deliverMessage(inbound, account, {}, log);
    const options = dispatched();

    await options.dispatcherOptions.onReplyStart();
    await options.dispatcherOptions.onReplyStart();
    await options.dispatcherOptions.onReplyStart();

    const started = log.info.mock.calls.filter((c) => String(c[0]).includes("reply started"));
    expect(started).toHaveLength(1);
  });

  it("события работы доходят до черновика", async () => {
    await deliverMessage(inbound, account, {}, log);
    const options = dispatched();

    await (options.replyOptions.onReasoningStream as (p?: unknown) => Promise<void>)({});
    await (options.replyOptions.onToolStart as (p?: unknown) => Promise<void>)({ name: "Bash" });
    await (options.replyOptions.onItemEvent as (p?: unknown) => Promise<void>)({ title: "шаг" });
    await (options.replyOptions.onApprovalEvent as (p?: unknown) => Promise<void>)({ phase: "requested" });

    expect(draft.compositor.pushReasoningProgress).toHaveBeenCalled();
    expect(draft.compositor.pushToolEvent).toHaveBeenCalled();
    expect(draft.compositor.pushItemEvent).toHaveBeenCalled();
    expect(draft.compositor.pushApprovalEvent).toHaveBeenCalled();
  });

  it("входящие картинки уходят агенту", async () => {
    await deliverMessage(
      { ...inbound, images: [{ data: "AAA", mimeType: "image/png" }] },
      account,
      {},
      log,
    );

    expect(dispatched().replyOptions.images).toEqual([
      { type: "image", mimeType: "image/png", data: "AAA" },
    ]);
  });

  it("ход закрывается даже если ядро бросило", async () => {
    // `finish` гасит индикатор набора и убирает черновик — без него ход
    // оставил бы «работаю» висеть навсегда.
    dispatch.mockRejectedValueOnce(new Error("core failed"));

    await expect(deliverMessage(inbound, account, {}, log)).rejects.toThrow("core failed");

    expect(draft.compositor.markFinalReplyDelivered).toHaveBeenCalled();
    expect(draft.remove).toHaveBeenCalled();
  });
});
