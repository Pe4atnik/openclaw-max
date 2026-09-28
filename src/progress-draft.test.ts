/**
 * Черновик хода: создание, правка на месте, удаление и запечатывание.
 *
 * Компоновщик здесь подменён: его поведение — забота ядра, а проверяем мы две
 * операции, которые ядро про MAX не знает, и метку, которую ядро не ставит.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendDm = vi.fn();
const sendToChat = vi.fn();
const editMessage = vi.fn();
const deleteMessage = vi.fn();

vi.mock("./client.js", () => ({
  sendDm: (...args: unknown[]) => sendDm(...args),
  sendToChat: (...args: unknown[]) => sendToChat(...args),
  editMessage: (...args: unknown[]) => editMessage(...args),
  deleteMessage: (...args: unknown[]) => deleteMessage(...args),
}));

const compositorParams: Array<Record<string, unknown>> = [];

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  createChannelProgressDraftCompositor: (params: Record<string, unknown>) => {
    compositorParams.push(params);
    return { marker: "compositor" };
  },
  resolveChannelProgressDraftConfig: (entry: { streaming?: { progress?: { label?: unknown } } }) => ({
    label: entry?.streaming?.progress?.label,
  }),
}));

const { createMaxProgressDraft, resolveMaxProgressLabel } = await import("./progress-draft.js");

const account = { accountId: "default", token: "tok", enabled: true } as never;

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeDraft(entry: unknown = { streaming: { progress: { label: "⏳ Работаю" } } }) {
  return createMaxProgressDraft({
    account,
    chatId: "42",
    chatType: "direct",
    entry: entry as never,
    mode: "progress" as never,
    seed: "seed-1",
    log,
  });
}

beforeEach(() => {
  sendDm.mockReset();
  sendToChat.mockReset();
  editMessage.mockReset();
  deleteMessage.mockReset();
  compositorParams.length = 0;
  log.info.mockClear();
  log.debug.mockClear();
  log.error.mockClear();
});

describe("resolveMaxProgressLabel", () => {
  it("берёт явную метку", () => {
    expect(resolveMaxProgressLabel({ streaming: { progress: { label: " ⏳ Работаю " } } } as never)).toBe(
      "⏳ Работаю",
    );
  });

  it("false прячет заголовок", () => {
    expect(resolveMaxProgressLabel({ streaming: { progress: { label: false } } } as never)).toBeUndefined();
  });

  it("«auto» и незаданная метка дают умолчание", () => {
    // «auto» просит ядро выбрать заголовок — печатать это слово строкой нельзя,
    // а оставлять шаги вовсе без заголовка значит потерять нынешний вид.
    expect(resolveMaxProgressLabel({ streaming: { progress: { label: "auto" } } } as never)).toBe(
      "⏳ обрабатываю…",
    );
    expect(resolveMaxProgressLabel(undefined as never)).toBe("⏳ обрабатываю…");
  });
});

describe("createMaxProgressDraft", () => {
  it("текст компоновщика уходит как есть: метку рисует ядро", async () => {
    // `formatChannelProgressDraftText` в ядре сам добавляет блок метки. Если
    // приписать её ещё и здесь, в черновике окажутся два заголовка подряд.
    sendDm.mockResolvedValueOnce("mid-1");
    const draft = makeDraft();

    await expect(draft.overwrite("⏳ Работаю\n\n🛠️ Bash")).resolves.toBe(true);

    expect(sendDm).toHaveBeenCalledWith("tok", 42, "⏳ Работаю\n\n🛠️ Bash");
    expect(draft.currentMessageId()).toBe("mid-1");
  });

  it("пустой текст ничего не шлёт", async () => {
    await expect(makeDraft().overwrite("   ")).resolves.toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("плашка показывает настроенную метку", async () => {
    sendDm.mockResolvedValueOnce("mid-1");

    await makeDraft().showPlaceholder();

    expect(sendDm).toHaveBeenCalledWith("tok", 42, "⏳ Работаю");
  });

  it("без настроенной метки плашка показывает умолчание", async () => {
    sendDm.mockResolvedValueOnce("mid-1");

    await makeDraft({}).showPlaceholder();

    expect(sendDm).toHaveBeenCalledWith("tok", 42, "⏳ обрабатываю…");
  });

  it("со скрытым заголовком плашки нет вовсе", async () => {
    await expect(
      makeDraft({ streaming: { progress: { label: false } } }).showPlaceholder(),
    ).resolves.toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("следующие отрисовки правят то же сообщение", async () => {
    sendDm.mockResolvedValueOnce("mid-1");
    editMessage.mockResolvedValueOnce(true);
    const draft = makeDraft();

    await draft.overwrite("шаг один");
    await draft.overwrite("шаг два");

    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith("tok", "mid-1", "шаг два");
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("progress draft edited mid=mid-1"));
  });

  it("detach забывает сообщение, и remove его уже не трогает", async () => {
    // Черновик, ставший ответом, удалять нельзя: в ВК 08.09.2026 на этом у
    // собеседника исчез текст ответа.
    sendDm.mockResolvedValueOnce("mid-1");
    const draft = makeDraft();
    await draft.overwrite("шаг");

    draft.detach();
    await draft.remove();

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(draft.currentMessageId()).toBeUndefined();
    await expect(draft.overwrite("поздний шаг")).resolves.toBe(false);
  });

  it("неудачная правка забывает сообщение, следующая отрисовка шлёт новое", async () => {
    // Иначе черновик застревает на мёртвом сообщении и шаги молча теряются.
    sendDm.mockResolvedValueOnce("mid-1").mockResolvedValueOnce("mid-2");
    editMessage.mockResolvedValueOnce(false);
    const draft = makeDraft();

    await draft.overwrite("шаг один");
    await expect(draft.overwrite("шаг два")).resolves.toBe(false);
    expect(draft.currentMessageId()).toBeUndefined();

    await draft.overwrite("шаг три");
    expect(sendDm).toHaveBeenCalledTimes(2);
    expect(draft.currentMessageId()).toBe("mid-2");
  });

  it("исключение при правке тоже забывает сообщение и не пробрасывается", async () => {
    sendDm.mockResolvedValueOnce("mid-1");
    editMessage.mockRejectedValueOnce(new Error("edit window closed"));
    const draft = makeDraft();

    await draft.overwrite("шаг один");
    await expect(draft.overwrite("шаг два")).resolves.toBe(false);
    expect(draft.currentMessageId()).toBeUndefined();
  });

  it("групповой чат шлёт через sendToChat", async () => {
    sendToChat.mockResolvedValueOnce("mid-1");

    await createMaxProgressDraft({
      account,
      chatId: "77",
      chatType: "group",
      entry: {} as never,
      mode: "progress" as never,
      seed: "seed",
    }).overwrite("шаг");

    expect(sendToChat).toHaveBeenCalledWith("tok", 77, "шаг");
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("нечисловой идентификатор чата ничего не шлёт", async () => {
    const draft = createMaxProgressDraft({
      account,
      chatId: "max:user:abc",
      chatType: "direct",
      entry: {} as never,
      mode: "progress" as never,
      seed: "seed",
    });

    await expect(draft.overwrite("шаг")).resolves.toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("remove удаляет черновик и забывает его", async () => {
    sendDm.mockResolvedValueOnce("mid-1");
    const draft = makeDraft();
    await draft.overwrite("шаг");

    await draft.remove();

    expect(deleteMessage).toHaveBeenCalledWith("tok", "mid-1");
    expect(draft.currentMessageId()).toBeUndefined();
    await draft.remove();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("close запрещает дальнейшие отрисовки", async () => {
    // Опоздавшая отрисовка компоновщика не должна родить новое сообщение уже
    // после того, как ответ отправлен.
    const draft = makeDraft();
    draft.close();

    await expect(draft.overwrite("поздний шаг")).resolves.toBe(false);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("создание и удаление черновика видны в логе", async () => {
    sendDm.mockResolvedValueOnce("mid-1");
    const draft = makeDraft();

    await draft.overwrite("шаг");
    await draft.remove();

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("progress draft sent mid=mid-1"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("progress draft removed"));
  });

  it("сбой правки и сбой удаления попадают в лог, а не наружу", async () => {
    sendDm.mockResolvedValueOnce("mid-1");
    editMessage.mockRejectedValueOnce(new Error("edit failed"));
    deleteMessage.mockRejectedValueOnce(new Error("delete failed"));
    const draft = makeDraft();

    await draft.overwrite("шаг один");
    await draft.overwrite("шаг два");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("progress draft failed"));

    sendDm.mockResolvedValueOnce("mid-2");
    await draft.overwrite("шаг три");
    await expect(draft.remove()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("remove failed"));
  });

  it("компоновщику отданы обе операции и режим", () => {
    makeDraft();

    expect(compositorParams).toHaveLength(1);
    expect(compositorParams[0]).toMatchObject({ mode: "progress", seed: "seed-1", active: true });
    expect(typeof compositorParams[0].update).toBe("function");
    expect(typeof compositorParams[0].deleteCurrent).toBe("function");
  });
});
