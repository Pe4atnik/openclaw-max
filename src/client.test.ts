/**
 * Клиент MAX Bot API: остальные вызовы.
 *
 * Отправка вложений вынесена в `client.attachments.test.ts` — там своя история
 * с токеном и ожиданием готовности.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const agentCalls: unknown[] = [];
const proxyCalls: unknown[] = [];

vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  FormData: globalThis.FormData,
  Agent: class {
    constructor(opts: unknown) {
      agentCalls.push(opts);
    }
  },
  ProxyAgent: class {
    constructor(opts: unknown) {
      proxyCalls.push(opts);
    }
  },
}));

const client = await import("./client.js");

const TOKEN = "tok";

function ok(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function fail(status = 500, body = "boom") {
  return { ok: false, status, text: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  agentCalls.length = 0;
  proxyCalls.length = 0;
});

describe("configureMaxTransport", () => {
  it("без прокси берёт обычный агент, доверяющий CA Минцифры", () => {
    client.configureMaxTransport({});
    expect(agentCalls).toHaveLength(1);
    expect(proxyCalls).toHaveLength(0);
  });

  it("с прокси берёт прокси-агент и тот же CA", () => {
    client.configureMaxTransport({ httpProxy: " http://proxy.test:3128 " });
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0]).toMatchObject({ uri: "http://proxy.test:3128" });
  });

  it("пустая строка прокси считается отсутствием прокси", () => {
    client.configureMaxTransport({ httpProxy: "   " });
    expect(proxyCalls).toHaveLength(0);
    expect(agentCalls).toHaveLength(1);
  });
});

describe("отправка и правка сообщений", () => {
  it("sendDm возвращает mid", async () => {
    fetchMock.mockResolvedValueOnce(ok({ message: { body: { mid: "mid-1" } } }));
    await expect(client.sendDm(TOKEN, 42, "привет")).resolves.toBe("mid-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("user_id=42");
  });

  it("sendDm на ошибке отдаёт null", async () => {
    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.sendDm(TOKEN, 42, "привет")).resolves.toBeNull();
  });

  it("sendToChat возвращает mid", async () => {
    fetchMock.mockResolvedValueOnce(ok({ message: { body: { mid: "mid-2" } } }));
    await expect(client.sendToChat(TOKEN, 7, "привет")).resolves.toBe("mid-2");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("chat_id=7");
  });

  it("sendToChat на ошибке отдаёт null", async () => {
    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.sendToChat(TOKEN, 7, "привет")).resolves.toBeNull();
  });

  it("editMessage сообщает об успехе", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await expect(client.editMessage(TOKEN, "mid-1", "новый текст")).resolves.toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("message_id=mid-1");
  });

  it("editMessage на ошибке отдаёт false", async () => {
    fetchMock.mockResolvedValueOnce(fail(404, "not found"));
    await expect(client.editMessage(TOKEN, "mid-1", "новый текст")).resolves.toBe(false);
  });

  it("deleteMessage сообщает об успехе и о провале", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await expect(client.deleteMessage(TOKEN, "mid-1")).resolves.toBe(true);
    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.deleteMessage(TOKEN, "mid-1")).resolves.toBe(false);
  });

  it("markSeen ставит вторую галку и молчит на сбое", async () => {
    // Действия `mark_seen` нет в документации MAX, но API его принимает —
    // проверено живой отправкой; без него сообщение собеседника остаётся с
    // одной галкой.
    fetchMock.mockResolvedValueOnce(ok({ success: true }));
    await expect(client.markSeen(TOKEN, 42)).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/chats/42/actions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ action: "mark_seen" });

    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.markSeen(TOKEN, 42)).resolves.toBeUndefined();
  });

  it("sendTypingAction не бросает на сбое", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(client.sendTypingAction(TOKEN, 42)).resolves.toBeUndefined();
  });

  it("sendDmWithImage и sendToChatWithImage возвращают mid", async () => {
    fetchMock.mockResolvedValueOnce(ok({ message: { body: { mid: "mid-img" } } }));
    await expect(client.sendDmWithImage(TOKEN, 42, "подпись", "img-token")).resolves.toBe("mid-img");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      attachments: [{ type: "image", payload: { token: "img-token" } }],
      text: "подпись",
    });

    fetchMock.mockResolvedValueOnce(ok({ message: { body: { mid: "mid-img2" } } }));
    await expect(client.sendToChatWithImage(TOKEN, 7, "", "img-token")).resolves.toBe("mid-img2");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      attachments: [{ type: "image", payload: { token: "img-token" } }],
    });
  });

  it("картинка на ошибке API отдаёт null, а не бросает", async () => {
    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.sendDmWithImage(TOKEN, 42, "", "img")).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.sendToChatWithImage(TOKEN, 7, "", "img")).resolves.toBeNull();
  });
});

describe("обновления и вебхук", () => {
  it("getUpdates отдаёт список и маркер", async () => {
    // Длинный опрос читает тело через `json()`, а не через `text()`, как
    // остальные вызовы: у него свой путь с таймаутом и отменой.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ updates: [{ update_type: "message_created" }], marker: 5 }),
    });
    await expect(client.getUpdates(TOKEN, 1, 30)).resolves.toEqual({
      updates: [{ update_type: "message_created" }],
      marker: 5,
    });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("marker=1");
    expect(url).toContain("timeout=30");
  });

  it("внешний сигнал прерывания складывается с таймаутом опроса", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ updates: [] }) });

    await client.getUpdates(TOKEN, null, 30, controller.signal);

    const passed = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed.aborted).toBe(false);
  });

  it("отмена длинного опроса — это пустой ответ, а не ошибка", async () => {
    // Иначе на каждой остановке канала в лог падал бы разрыв связи.
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    fetchMock.mockRejectedValueOnce(aborted);

    await expect(client.getUpdates(TOKEN, 7)).resolves.toEqual({ updates: [], marker: 7 });
  });

  it("ошибка длинного опроса пробрасывается", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "bad gateway" });

    await expect(client.getUpdates(TOKEN)).rejects.toThrow("502");
  });

  it("subscribeWebhook кладёт секрет и типы событий в тело", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));

    await expect(
      client.subscribeWebhook(TOKEN, "https://h.test/hook", "sec"),
    ).resolves.toBeUndefined();

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      url: "https://h.test/hook",
      update_types: ["message_created", "bot_started", "message_callback"],
      secret: "sec",
    });
  });

  it("ошибка подписки пробрасывается наружу", async () => {
    // Здесь молчать нельзя: без подписки вебхук не работает вовсе, и это
    // единственное место в клиенте, которое сознательно бросает.
    fetchMock.mockResolvedValueOnce(fail(403, "forbidden"));
    await expect(client.subscribeWebhook(TOKEN, "https://h.test/hook")).rejects.toThrow("403");
  });

  it("deleteWebhook уходит методом DELETE", async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    await expect(client.deleteWebhook(TOKEN)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("getBotInfo пробрасывает ответ", async () => {
    fetchMock.mockResolvedValueOnce(ok({ name: "Карамелька", username: "k_bot" }));
    await expect(client.getBotInfo(TOKEN)).resolves.toMatchObject({ username: "k_bot" });
  });
});

describe("загрузка файлов", () => {
  it("downloadFile отдаёт буфер", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("данные").buffer,
    });
    const buf = await client.downloadFile(TOKEN, "https://cdn.test/file");
    expect(buf?.toString()).toBe("данные");
  });

  it("downloadFile на отказе отдаёт null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(client.downloadFile(TOKEN, "https://cdn.test/file")).resolves.toBeNull();
  });

  it("downloadFile на сетевом сбое отдаёт null", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(client.downloadFile(TOKEN, "https://cdn.test/file")).resolves.toBeNull();
  });

  it("getUploadUrl отдаёт только адрес", async () => {
    fetchMock.mockResolvedValueOnce(ok({ url: "https://up.test/img" }));
    await expect(client.getUploadUrl(TOKEN, "image")).resolves.toBe("https://up.test/img");
    fetchMock.mockResolvedValueOnce(fail());
    await expect(client.getUploadUrl(TOKEN, "image")).resolves.toBeNull();
  });

  it("uploadFile понимает токен на верхнем уровне и в photos", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: "t1" }) });
    await expect(
      client.uploadFile("https://up.test", Buffer.from("x"), "image/png", "a.png"),
    ).resolves.toEqual({ token: "t1" });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ photos: { any: { token: "t2" } } }),
    });
    await expect(
      client.uploadFile("https://up.test", Buffer.from("x"), "image/png", "a.png"),
    ).resolves.toEqual({ token: "t2" });
  });

  it("uploadFile задаёт Content-Length для MAX multipart-загрузчика", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ photos: { id: { token: "t" } } }),
    });

    await client.uploadFile("https://up.test", Buffer.from("image"), "image/png", 'a"\r\n.png');

    const [, init] = fetchMock.mock.calls[0];
    const body = init?.body as Buffer;
    const headers = init?.headers as Record<string, string>;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers["Content-Length"]).toBe(String(body.length));
    expect(body.toString()).toContain('name="data"; filename="a___.png"');
    expect(body.includes(Buffer.from("image"))).toBe(true);
  });

  it("uploadFile без токена и на сбое отдаёт null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await expect(
      client.uploadFile("https://up.test", Buffer.from("x"), "image/png", "a.png"),
    ).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(
      client.uploadFile("https://up.test", Buffer.from("x"), "image/png", "a.png"),
    ).resolves.toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(
      client.uploadFile("https://up.test", Buffer.from("x"), "image/png", "a.png"),
    ).resolves.toBeNull();
  });
});
