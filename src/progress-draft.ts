/**
 * Черновик хода: ОДНО сообщение, которое переписывается на месте списком шагов
 * работы (🛠️ вызовы инструментов, 💭 размышления) и в конце уступает место
 * ответу.
 *
 * Сложное — задержку старта, дедупликацию, обрезку и многострочную отрисовку —
 * делает ядро: `createChannelProgressDraftCompositor` из
 * `openclaw/plugin-sdk/channel-outbound`. Тем же компоновщиком живут Telegram и
 * плагин ВК, так что вид и настройки у каналов общие. Здесь — только две
 * операции, которых ядро про MAX не знает:
 *   • `update(text)`   — создать сообщение, а дальше править его на месте;
 *   • `deleteCurrent()` — убрать черновик.
 *
 * Зачем это вместо прежней самодельной плашки: та жила только до первого куска
 * ответа. Ядро шлёт живой текст (`onPartialReply`) и куски ответа (`deliver`)
 * двумя разными потоками, и оба писались в то же сообщение — статус пропадал
 * на середине хода, а пришедший позже рассказ затирал готовый ответ.
 */
import {
  createChannelProgressDraftCompositor,
  resolveChannelProgressDraftConfig,
} from "openclaw/plugin-sdk/channel-outbound";
import { deleteMessage, editMessage, sendDm, sendToChat } from "./client.js";
import type { ResolvedMaxAccount } from "./types.js";

/** Что показать, пока ход только начался, а метка в настройках не задана. */
const DEFAULT_LABEL = "⏳ обрабатываю…";

/** Настройки канала в том виде, в каком их читает ядро (`channels.max`). */
export type MaxStreamingEntry = Parameters<typeof resolveChannelProgressDraftConfig>[0];

/** Режим потока, как его называет ядро: progress | block | partial | off. */
export type MaxProgressDraftMode = Parameters<
  typeof createChannelProgressDraftCompositor
>[0]["mode"];

type MaxProgressDraftParams = {
  account: ResolvedMaxAccount;
  /** Числовой идентификатор собеседника или чата, строкой. */
  chatId: string;
  chatType: string;
  entry: MaxStreamingEntry;
  mode: MaxProgressDraftMode;
  /** Стабильная примета хода, чтобы компоновщик отличал ходы друг от друга. */
  seed: string;
  log?: {
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

export type MaxProgressDraftHandle = {
  compositor: ReturnType<typeof createChannelProgressDraftCompositor>;
  /** mid живого черновика, либо undefined до первой отрисовки и после удаления. */
  currentMessageId(): string | undefined;
  /** Переписать черновик. `false` — текст не дошёл; ход из-за этого не падает. */
  overwrite(text: string): Promise<boolean>;
  /** Показать метку «работаю», пока шагов ещё нет. */
  showPlaceholder(): Promise<boolean>;
  /** Убрать черновик, если он есть. */
  remove(): Promise<void>;
  /**
   * Забыть сообщение, не удаляя его. Нужен, когда черновик СТАЛ ответом:
   * иначе `remove()` на позднем приходе сотрёт сообщение с ответом — ровно так
   * в ВК 08.09.2026 у собеседника исчез текст.
   */
  detach(): void;
  /**
   * Запечатать: после этого `overwrite` ничего не делает. Нужен, чтобы
   * опоздавшая отрисовка компоновщика не создала новое сообщение уже после
   * того, как ответ отправлен.
   */
  close(): void;
};

/**
 * Метка живого черновика (`streaming.progress.label`).
 *
 * Ядро само её не подставляет ни на одном пути, поэтому дописываем здесь —
 * в единственной точке записи, чтобы она была и на шагах, и на кусках текста.
 *
 * Три случая: `false` прячет заголовок совсем; явная строка печатается как
 * есть; `"auto"` и незаданное значение дают умолчание — иначе у того, кто
 * ничего не настраивал, шаги остались бы без заголовка, хотя раньше плашка
 * всегда начиналась с «⏳ обрабатываю…».
 */
export function resolveMaxProgressLabel(entry: MaxStreamingEntry): string | undefined {
  const label = resolveChannelProgressDraftConfig(entry).label;
  if (label === false) return undefined;
  return typeof label === "string" && label.trim() && label.trim() !== "auto"
    ? label.trim()
    : DEFAULT_LABEL;
}

export function createMaxProgressDraft(params: MaxProgressDraftParams): MaxProgressDraftHandle {
  const numericId = parseInt(params.chatId, 10);
  let messageId: string | undefined;
  let closed = false;

  const send = async (text: string): Promise<string | null> =>
    params.chatType === "direct"
      ? sendDm(params.account.token, numericId, text)
      : sendToChat(params.account.token, numericId, text);

  const overwrite = async (text: string): Promise<boolean> => {
    // Метку рисует само ядро (`formatChannelProgressDraftText`, блок метки), и
    // приписывать её здесь нельзя — в черновике окажутся два заголовка.
    if (closed || isNaN(numericId) || !text.trim()) return false;
    try {
      if (messageId === undefined) {
        const mid = await send(text);
        messageId = mid ?? undefined;
        params.log?.info?.(
          `[openclaw-max] progress draft sent mid=${messageId ?? "?"} len=${text.length}`,
        );
        return messageId !== undefined;
      }
      const ok = await editMessage(params.account.token, messageId, text);
      params.log?.debug?.(
        `[openclaw-max] progress draft edited mid=${messageId} ok=${ok} len=${text.length}`,
      );
      if (!ok) {
        // Сообщение пропало или окно правки закрылось — забываем его, чтобы
        // следующая отрисовка начала новый черновик, а не молча потеряла шаги.
        messageId = undefined;
      }
      return ok;
    } catch (err) {
      messageId = undefined;
      params.log?.error?.(
        `[openclaw-max] progress draft failed: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  };

  /**
   * Пока компоновщик ничего не нарисовал, показать одну метку: иначе первые
   * секунды хода в чате пусто, а именно на это и жаловались.
   */
  const showPlaceholder = async (): Promise<boolean> => {
    const label = resolveMaxProgressLabel(params.entry);
    // `label: false` — просьба не показывать заголовок вовсе; плашка целиком
    // из него и состоит, так что и её быть не должно.
    if (!label) return false;
    return overwrite(label);
  };

  const remove = async (): Promise<void> => {
    if (messageId === undefined) return;
    const id = messageId;
    messageId = undefined;
    try {
      await deleteMessage(params.account.token, id);
      params.log?.info?.(`[openclaw-max] progress draft removed mid=${id}`);
    } catch (err) {
      params.log?.error?.(
        `[openclaw-max] progress draft remove failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  const compositor = createChannelProgressDraftCompositor({
    entry: params.entry,
    mode: params.mode,
    active: true,
    seed: params.seed,
    update: overwrite,
    deleteCurrent: remove,
  });

  return {
    compositor,
    currentMessageId: () => messageId,
    overwrite,
    showPlaceholder,
    remove,
    detach: () => {
      messageId = undefined;
      closed = true;
    },
    close: () => {
      closed = true;
    },
  };
}
