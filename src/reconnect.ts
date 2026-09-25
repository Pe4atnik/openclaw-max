export interface BackoffOptions {
  signal?: AbortSignal;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface RetryOptions extends BackoffOptions {
  isRetryable: (error: unknown) => boolean;
  onRetry?: (error: unknown, consecutiveErrors: number, delayMs: number) => void;
}

export interface PollingOptions<T> extends RetryOptions {
  poll: () => Promise<T>;
  onResult: (result: T) => Promise<void> | void;
  onConnectionLost?: (error: unknown) => void;
  onConnectionRestored?: () => void;
}

export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError";
}

export function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  // Request-local timeouts surface as AbortError/TimeoutError. A caller's
  // AbortSignal is checked separately before retrying.
  if (isAbortError(error) || (error as { name?: unknown } | null)?.name === "TimeoutError") return true;
  if (error instanceof TypeError) return true;
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code
    ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && [
    "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
    "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  ].includes(code);
}

export function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(finish, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelay(
  consecutiveErrors: number,
  baseDelayMs = 1_000,
  maxDelayMs = 30_000,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, consecutiveErrors - 1));
  return Math.round(exponential * (0.5 + Math.max(0, Math.min(1, random())) * 0.5));
}

export async function retryWithBackoff<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let consecutiveErrors = 0;
  const sleep = options.sleep ?? abortableSleep;

  while (true) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!options.isRetryable(error)) throw error;
      consecutiveErrors += 1;
      const delayMs = backoffDelay(
        consecutiveErrors,
        options.baseDelayMs,
        options.maxDelayMs,
        options.random,
      );
      options.onRetry?.(error, consecutiveErrors, delayMs);
      await sleep(delayMs, options.signal);
      if (options.signal?.aborted) throw abortError();
    }
  }
}

export async function runResilientPolling<T>(options: PollingOptions<T>): Promise<void> {
  let consecutiveErrors = 0;
  let disconnected = false;
  const sleep = options.sleep ?? abortableSleep;

  while (!options.signal?.aborted) {
    try {
      const result = await options.poll();
      if (options.signal?.aborted) break;
      await options.onResult(result);
      consecutiveErrors = 0;
      if (disconnected) {
        disconnected = false;
        options.onConnectionRestored?.();
      }
    } catch (error) {
      if (options.signal?.aborted) break;
      if (!options.isRetryable(error)) throw error;
      consecutiveErrors += 1;
      if (!disconnected) {
        disconnected = true;
        options.onConnectionLost?.(error);
      }
      const delayMs = backoffDelay(
        consecutiveErrors,
        options.baseDelayMs,
        options.maxDelayMs,
        options.random,
      );
      options.onRetry?.(error, consecutiveErrors, delayMs);
      await sleep(delayMs, options.signal);
    }
  }
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
