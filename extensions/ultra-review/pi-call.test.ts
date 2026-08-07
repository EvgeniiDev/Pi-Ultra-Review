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
let lastMessages: unknown[] = []
let lastOptions: Record<string, unknown> = {}

// Мокаем pi-ai compat и константы (вне рантайма пи модуль не резолвится;
// delay в тестах — 1ms вместо 1500ms). mock.module должен стоять до импорта.
mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: async (_m: unknown, req: { messages?: unknown[] }, opts: Record<string, unknown>) => {
    completeCalls++
    lastMessages = req?.messages ?? []
    lastOptions = opts ?? {}
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
  MAX_DIFF_CHARS: 60_000,
  REASONING_EFFORT: "max",
}))

const { chatViaPi, runAgent } = await import("./pi-call.ts")

const fakeRegistry = {
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {}, env: {} }),
}
// cost задан, чтобы reasoningEffortFor трактовал модель как платную (max).
const fakeModel = { provider: "test", id: "m", cost: { input: 1, output: 1 } }
const call = () => chatViaPi(fakeRegistry as never, fakeModel as never, "sys", [], undefined)
const callWithSession = (sessionId: string) => chatViaPi(fakeRegistry as never, fakeModel as never, "sys", [], undefined, undefined, undefined, undefined, sessionId)

beforeEach(() => {
  completeCalls = 0
  completeImpl = async () => ({ stopReason: "end_turn", content: [] })
  lastMessages = []
  lastOptions = {}
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

test("5xx upstream error ('fetch failed') ретраится", async () => {
  completeImpl = async () => ({ stopReason: "error", errorMessage: '502: {"message":"upstream error: TypeError: fetch failed"}' })
  await expect(call()).rejects.toThrow(/fetch failed/)
  expect(completeCalls).toBe(4) // initial + 3 retries, потом падение
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

test("runAgent: пустой вердикт → ретрай продолжает ту же беседу (нодж, без рестарта)", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "ur-continue-"))
  try {
    await writeFile(join(dir, "a.py"), "x = 1\n")
    const verdict = '{"context":"FULL","findings":[]}'
    let n = 0
    completeImpl = async () => {
      n++
      if (n === 1) {
        // maxIterations=1 → isLast сразу: модель просит тул → пусто.
        const content = [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.py" } }]
        return { stopReason: "toolUse", content, assistantMessage: { role: "assistant", content } }
      }
      if (n === 2) {
        // Нодж №1 (no-tools): модель снова пишет тул-разметку текстом.
        return { stopReason: "text", content: [{ type: "text", text: '<tool_calls>\n<invoke name="read_file">' }], assistantMessage: { role: "assistant", content: [{ type: "text", text: '<tool_calls>' }] } }
      }
      if (n === 3) {
        // Нодж №2 (JSON-шаблон): всё ещё разметка → retryOnEmpty продолжает беседу.
        return { stopReason: "text", content: [{ type: "text", text: '<tool_calls>\n<invoke name="read_file">' }], assistantMessage: { role: "assistant", content: [{ type: "text", text: '<tool_calls>' }] } }
      }
      // Ретрай: та же история (с toolResult и ноджами) → вердикт.
      return { stopReason: "end_turn", content: [{ type: "text", text: verdict }], assistantMessage: { role: "assistant", content: [{ type: "text", text: verdict }] } }
    }

    const res = await runAgent(fakeRegistry as never, fakeModel as never, "sys", dir, undefined, { maxIterations: 1, maxToolCalls: 10 })
    expect(res.text).toBe(verdict)
    expect(n).toBe(4)
    const history = JSON.stringify(lastMessages)
    expect(history).toContain("call-1") // toolResult первой попытки в истории
    expect(history).toContain("previous response was empty") // ретрай-нодж в ту же беседу
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("runAgent: проза без JSON-контракта → ретрай до вердикта", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "ur-prose-"))
  try {
    await writeFile(join(dir, "a.py"), "x = 1\n")
    const verdict = '{"context":"FULL","findings":[]}'
    let n = 0
    completeImpl = async () => {
      n++
      if (n === 1) {
        // Модель ответила рассуждением без JSON-контракта (нет "findings").
        const text = "I reviewed the code and it looks fine overall."
        return { stopReason: "end_turn", content: [{ type: "text", text }], assistantMessage: { role: "assistant", content: [{ type: "text", text }] } }
      }
      return { stopReason: "end_turn", content: [{ type: "text", text: verdict }], assistantMessage: { role: "assistant", content: [{ type: "text", text: verdict }] } }
    }
    const res = await runAgent(fakeRegistry as never, fakeModel as never, "sys", dir, undefined, { maxIterations: 2, maxToolCalls: 10 })
    expect(res.text).toBe(verdict)
    expect(n).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("runAgent: вердикт пишется прямо, без submit_review", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "ur-plain-"))
  try {
    await writeFile(join(dir, "a.py"), "def f():\n    return undefined_var\n")

    const verdict = '{"context":"FULL","findings":[{"severity":"critical","category":"logic","file":"a.py","line":2,"lineEnd":null,"title":"t","description":"d","evidence":"e"}]}'
    let n = 0
    completeImpl = async () => {
      n++
      if (n === 1) {
        // Структурный read_file — цикл исполняет чтение.
        const content = [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.py" } }]
        return { stopReason: "toolUse", content, assistantMessage: { role: "assistant", content } }
      }
      // Модель отвечает JSON-вердиктом напрямую.
      return { stopReason: "end_turn", content: [{ type: "text", text: verdict }], assistantMessage: { role: "assistant", content: [{ type: "text", text: verdict }] } }
    }

    const res = await runAgent(fakeRegistry as never, fakeModel as never, "sys", dir, undefined, { maxIterations: 3, maxToolCalls: 10 })
    expect(res.text).toBe(verdict)
    expect(n).toBe(2) // чтение + вердикт, без нуджей и фолбэков
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// judgeViaPi: свежий no-tools вызов судьи без спирали чтения. Возвращает текст
// JSON-вердикта; на пусто/тул-разметку повторяет попытку.
// ─────────────────────────────────────────────────────────────────────────────

test("sessionId прокидывается в options complete (один id на прогон ревью)", async () => {
  await callWithSession("sess-abc")
  expect(lastOptions.sessionId).toBe("sess-abc")
})

test("chatViaPi без sessionId не шлёт его", async () => {
  await call()
  expect(lastOptions.sessionId).toBeUndefined()
})

test("judgeViaPi возвращает JSON-вердикт судьи", async () => {
  const json = '{"verdicts":[{"idx":1,"verdict":"VALID","duplicate_of":null,"new_severity":null,"rationale":"ok"}],"summary":{"valid":1},"kept":[1]}'
  completeImpl = async () => ({ stopReason: "end_turn", content: [{ type: "text", text: json }] })
  const { judgeViaPi } = await import("./pi-call.ts")
  const out = await judgeViaPi(fakeRegistry as never, fakeModel as never, "judge prompt")
  expect(out.text).toBe(json)
  expect(completeCalls).toBe(1)
})

test("judgeViaPi: пустой ответ → повтор, потом вердикт", async () => {
  const json = '{"verdicts":[{"idx":1,"verdict":"VALID","duplicate_of":null,"new_severity":null,"rationale":"ok"}],"summary":{"valid":1},"kept":[1]}'
  let n = 0
  completeImpl = async () => {
    n++
    if (n === 1) return { stopReason: "end_turn", content: [] }
    return { stopReason: "end_turn", content: [{ type: "text", text: json }] }
  }
  const { judgeViaPi } = await import("./pi-call.ts")
  const out = await judgeViaPi(fakeRegistry as never, fakeModel as never, "judge prompt")
  expect(out.text).toBe(json)
  expect(completeCalls).toBe(2) // пусто → повтор
})
