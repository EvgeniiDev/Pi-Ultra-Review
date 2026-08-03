import { test, expect, mock, beforeEach } from "bun:test"

// ─────────────────────────────────────────────────────────────────────────────
// Регрессия: "Stream ended without finish_reason" (оборванный апстримом стрим,
// типичен для free-тира через релей) и 429/rate-limit могут прийти ДВУМЯ путями:
//   а) исключение из complete() — ретраилось и раньше;
//   б) graceful error-ответ (stopReason === "error", errorMessage) — раньше
//      бросалось уже ПОСЛЕ retry-обёртки, т.е. без единого ретрая.
// Теперь error-stopReason с retryable-сообщением бросается из замыкания,
// чтобы его подхватил retryOnFailure.
// ─────────────────────────────────────────────────────────────────────────────

let completeCalls = 0
let completeImpl: () => Promise<unknown> = async () => ({ stopReason: "end_turn", content: [] })

// Мокаем pi-ai compat и константы (вне рантайма пи модуль не резолвится;
// delay в тестах — 1ms вместо 1500ms). mock.module должен стоять до импорта.
mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: async () => {
    completeCalls++
    return completeImpl()
  },
}))

mock.module("@sinclair/typebox", () => ({
  Type: { String: () => ({}), Number: () => ({}), Boolean: () => ({}), Optional: (x: unknown) => x, Array: (x: unknown) => x, Object: (x: unknown) => x },
}))

mock.module("./constants.ts", () => ({
  EMPTY_RESPONSE_RETRIES: 2,
  RETRY_DELAY_MS: 1, // в тестах — 1ms вместо 1500ms
  MODEL_MAX_TOKENS: 8192,
  MODEL_TEMPERATURE: 0.3,
  SIMPLIFY_MAX_ITERATIONS: 10,
  SIMPLIFY_MAX_TOOL_CALLS: 40,
}))

const { chatViaPi } = await import("./pi-call.ts")

const fakeRegistry = {
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
}
const fakeModel = { provider: "test", id: "m" }
const call = () => chatViaPi(fakeRegistry as never, fakeModel as never, "sys", [], undefined)

beforeEach(() => {
  completeCalls = 0
  completeImpl = async () => ({ stopReason: "end_turn", content: [] })
})

test("error-stopReason 'Stream ended' ретраится (2 попытки) и восстанавливается", async () => {
  let n = 0
  completeImpl = async () => {
    n++
    if (n <= 3) return { stopReason: "error", errorMessage: "Stream ended without finish_reason" }
    return { stopReason: "end_turn", content: [] }
  }
  const turn = await call()
  expect(turn.stopReason).toBe("end_turn")
  expect(completeCalls).toBe(4) // initial + 3 retries
})

test("error-stopReason 'Request timed out.' тоже retryable и ретраится", async () => {
  let n = 0
  completeImpl = async () => {
    n++
    if (n === 1) return { stopReason: "error", errorMessage: "Request timed out." }
    return { stopReason: "end_turn", content: [] }
  }
  const turn = await call()
  expect(turn.stopReason).toBe("end_turn")
  expect(completeCalls).toBe(2) // initial + 1 retry
})

test("исчерпание ретраев error-stopReason → пробрасывается как ошибка", async () => {
  completeImpl = async () => ({ stopReason: "error", errorMessage: "Stream ended without finish_reason" })
  await expect(call()).rejects.toThrow(/Stream ended without finish_reason/)
  expect(completeCalls).toBe(4) // initial + 3 retries, потом падение
})

test("не-retryable error-stopReason (401) → мгновенный бросок без ретраев", async () => {
  completeImpl = async () => ({ stopReason: "error", errorMessage: "401 unauthorized" })
  await expect(call()).rejects.toThrow(/401/)
  expect(completeCalls).toBe(1)
})

test("thrown 429 исключение ретраится и восстанавливается", async () => {
  let n = 0
  completeImpl = async () => {
    n++
    if (n <= 2) throw new Error("429 rate limit exceeded")
    return { stopReason: "end_turn", content: [] }
  }
  const turn = await call()
  expect(turn.stopReason).toBe("end_turn")
  expect(completeCalls).toBe(3) // initial + 2 retries
})

test("thrown не-retryable исключение → без ретраев", async () => {
  completeImpl = async () => {
    throw new Error("boom")
  }
  await expect(call()).rejects.toThrow(/boom/)
  expect(completeCalls).toBe(1)
})
