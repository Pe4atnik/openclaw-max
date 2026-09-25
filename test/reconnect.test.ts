import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableError, retryWithBackoff, runResilientPolling } from "../src/reconnect.ts";

class StatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const immediate = async (): Promise<void> => {};

test("startup verification retries a transient failure then succeeds", async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await retryWithBackoff(async () => {
    calls += 1;
    if (calls === 1) throw new StatusError("temporary", 503);
    return { name: "bot" };
  }, { isRetryable: isRetryableError, sleep: immediate, random: () => 0,
    onRetry: (_error, attempt) => retries.push(attempt) });
  assert.deepEqual(result, { name: "bot" });
  assert.equal(calls, 2);
  assert.deepEqual(retries, [1]);
});

test("startup verification retries a request timeout", async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
    return "ok";
  }, { isRetryable: isRetryableError, sleep: immediate });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("startup verification does not retry permanent auth failures", async () => {
  let calls = 0;
  await assert.rejects(retryWithBackoff(async () => {
    calls += 1;
    throw new StatusError("unauthorized", 401);
  }, { isRetryable: isRetryableError, sleep: immediate }), /unauthorized/);
  assert.equal(calls, 1);
});

test("long polling recovers after more than five failures", async () => {
  const controller = new AbortController();
  let calls = 0;
  let restored = 0;
  await runResilientPolling({
    poll: async () => { calls += 1; if (calls <= 6) throw new TypeError("offline"); return "ok"; },
    onResult: () => controller.abort(), signal: controller.signal,
    isRetryable: isRetryableError, sleep: immediate,
    onConnectionRestored: () => { restored += 1; },
  });
  assert.equal(calls, 7);
  assert.equal(restored, 1);
});

test("result processing failures are not retried as transport failures", async () => {
  let polls = 0;
  let retries = 0;
  await assert.rejects(runResilientPolling({
    poll: async () => { polls += 1; return "batch"; },
    onResult: async () => { throw new TypeError("handler bug"); },
    isRetryable: isRetryableError,
    sleep: immediate,
    onRetry: () => { retries += 1; },
  }), /handler bug/);
  assert.equal(polls, 1);
  assert.equal(retries, 0);
});

test("a successful poll resets consecutive error backoff", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  let calls = 0;
  await runResilientPolling({
    poll: async () => { calls += 1; if (calls === 1 || calls === 3) throw new TypeError("offline"); return calls; },
    onResult: () => { if (calls === 4) controller.abort(); }, signal: controller.signal,
    isRetryable: isRetryableError, baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0,
    sleep: async (delay) => { delays.push(delay); },
  });
  assert.deepEqual(delays, [50, 50]);
});

test("abort interrupts backoff and stops cleanly", async () => {
  const controller = new AbortController();
  let polls = 0;
  const running = runResilientPolling({
    poll: async () => { polls += 1; throw new TypeError("offline"); },
    onResult: () => {}, signal: controller.signal, isRetryable: isRetryableError,
    baseDelayMs: 60_000, maxDelayMs: 60_000, random: () => 0,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await running;
  assert.equal(polls, 1);
});
