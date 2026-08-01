export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"))
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error("aborted"))
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Повторяет fn, пока она не вернёт непустую строку — на случай временного
 * затупа модели с пустым ответом. После исчерпания попыток бросает ошибку,
 * чтобы вызов попал в счётчик failed, а не стал тихим "UNKNOWN".
 * Ретраи идут внутри одного слота лимитера (callModel вызывается в run()).
 */
export async function retryOnEmpty(
  label: string,
  fn: () => Promise<string>,
  retries: number,
  delayMs: number,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const text = await fn()
    if (text.trim()) return text
    if (attempt >= retries) {
      throw new Error(`${label} empty response (${attempt + 1} attempts)`)
    }
    await sleep(delayMs * (attempt + 1), signal)
  }
}

/**
 * Ретрай падающих вызовов по предикату (например, rate-limit 429):
 * тот же вызов, ограниченное число попыток, линейный backoff.
 */
export async function retryOnFailure<T>(
  label: string,
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean,
  retries: number,
  delayMs: number,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries || signal?.aborted || !isRetryable(err)) throw err
      await sleep(delayMs * (attempt + 1), signal)
    }
  }
}
