import { test, expect } from "bun:test"
import { runAgentLoop, type AgentExecutor } from "./agent.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Инвариант протокола tool-calling: апстрим (DeepSeek/Console и др.) валидирует,
// что у КАЖДОГО assistant tool_call есть tool-ответ с соответствующим id.
// Регрессия: раньше при исчерпании бюджета пушился фейковый toolResult с
// toolCallId "limit" — следующий вызов падал с
//   "An assistant message with 'tool_calls' must be followed by tool messages
//    responding to each 'tool_call_id'... limit"
// ─────────────────────────────────────────────────────────────────────────────

interface Msg {
  role?: string
  content?: unknown[]
  toolCallId?: string
}

function toolCall(id: string, name = "read_file", args: Record<string, unknown> = { path: "x.py" }) {
  return { type: "toolCall", id, name, arguments: args }
}

function assistantMsg(calls: Array<{ id: string; name?: string }>) {
  return {
    role: "assistant",
    content: [
      ...calls.map((c) => toolCall(c.id, c.name)),
      { type: "text", text: "" },
    ],
  }
}

/** Бросает ошибку, если какой-то assistant tool_call остался без ответа. */
function assertProtocol(messages: Msg[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const calls = (m.content ?? []).filter(
      (e): e is { id?: string; name?: unknown } =>
        typeof e === "object" &&
        e !== null &&
        ((e as { type?: string }).type === "toolCall" ||
          typeof (e as { name?: unknown }).name === "string"),
    )
    const ids = new Set(calls.map((c) => c.id ?? "tool"))
    if (ids.size === 0) continue
    let j = i + 1
    const responded = new Set<string>()
    while (j < messages.length && messages[j].role === "toolResult") {
      responded.add(messages[j].toolCallId ?? "tool")
      j++
    }
    for (const id of ids) {
      if (!responded.has(id)) {
        throw new Error(`protocol violation: tool_call "${id}" has no tool response`)
      }
    }
  }
}

const executor: AgentExecutor = async () => ({ ok: true, text: "file contents (mock)" })

test("budget exhaustion responds to every real tool_call, not fake 'limit'", async () => {
  let calls = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    if (calls === 1) {
      return {
        assistantMessage: assistantMsg([{ id: "call_1" }, { id: "call_2" }]),
        content: [toolCall("call_1"), toolCall("call_2")],
        stopReason: "toolCalls",
      }
    }
    if (calls === 2) {
      // Модель снова просит тулы на фоне исчерпанного бюджета (maxToolCalls=1).
      return {
        assistantMessage: assistantMsg([{ id: "call_3" }, { id: "call_4" }]),
        content: [toolCall("call_3"), toolCall("call_4")],
        stopReason: "toolCalls",
      }
    }
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "final" }] },
      content: [{ type: "text", text: "final" }],
      stopReason: "end",
    }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    executor,
    { maxIterations: 5, maxToolCalls: 1 },
    undefined,
  )
  expect(res.text).toBe("final")
  expect(calls).toBe(3)
})

test("isLast branch responds to each real tool_call before the nudging final", async () => {
  let calls = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    if (calls === 1) {
      // maxIterations=1 → isLast сразу; модель всё равно запрашивает тулы.
      return {
        assistantMessage: assistantMsg([{ id: "call_1" }, { id: "call_2" }, { id: "call_3" }]),
        content: [toolCall("call_1"), toolCall("call_2"), toolCall("call_3")],
        stopReason: "toolCalls",
      }
    }
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "verdict" }] },
      content: [{ type: "text", text: "verdict" }],
      stopReason: "end",
    }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    executor,
    { maxIterations: 1, maxToolCalls: 10 },
    undefined,
  )
  expect(res.text).toBe("verdict")
  expect(calls).toBe(2)
})

test("no tool calls → single chat round, no protocol concerns", async () => {
  let calls = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "done" }] },
      content: [{ type: "text", text: "done" }],
      stopReason: "end",
    }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    executor,
    { maxIterations: 5, maxToolCalls: 10 },
    undefined,
  )
  expect(res.text).toBe("done")
  expect(calls).toBe(1)
})

// Модель прислала тул ТЕКСТОМ (релей не отдал структуру) — extractToolCalls
// должен распознать <invoke> и исполнить через makeExecutor, потом получить вердикт.
test("textual <invoke> tool call is parsed and executed, then verdict", async () => {
  let calls = 0
  const executed: Array<{ name: string; args: Record<string, unknown> }> = []
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    if (calls === 1) {
      const text =
        '<|tool_calls|>\n<invoke name="read_file">\n<parameter name="path" string="true">src/a.ts</parameter>\n<parameter name="startLine" value="1"/>\n</invoke>'
      return {
        assistantMessage: { role: "assistant", content: [{ type: "text", text }] },
        content: [{ type: "text", text }],
        stopReason: "text",
      }
    }
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] },
      content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }],
      stopReason: "end",
    }
  }
  const localExecutor: AgentExecutor = async (call) => {
    executed.push({ name: call.name ?? "", args: (call.arguments as Record<string, unknown>) ?? {} })
    return { ok: true, text: "contents of src/a.ts" }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    localExecutor,
    { maxIterations: 5, maxToolCalls: 10 },
    undefined,
  )
  expect(executed).toHaveLength(1)
  expect(executed[0].name).toBe("read_file")
  expect(executed[0].args).toEqual({ path: "src/a.ts", startLine: "1" })
  expect(res.text).toBe('{"context":"FULL","findings":[]}')
  expect(calls).toBe(2)
})

test("textual tool calls to the last iteration trigger a final no-tools verdict nudge", async () => {
  let calls = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    // Проверяем: финальный нодж должен прийти БЕЗ тулов и требовать вердикт.
    const lastUser = [...messages].reverse().find((m) => (m as Msg).role === "user")
    const askedVerdict = JSON.stringify(lastUser?.content ?? "").includes("verdict JSON")
    calls++
    if (calls === 1) {
      // До isLast модель печатает текстовый тул (релей не отдаёт структуру).
      const text =
        '<tool_calls>\n<invoke name="read_file">\n<parameter name="path" string="true">src/a.ts</parameter>\n</invoke>\n</tool_calls>'
      return {
        assistantMessage: { role: "assistant", content: [{ type: "text", text }] },
        content: [{ type: "text", text }],
        stopReason: "text",
      }
    }
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] },
      content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }],
      stopReason: "end",
    }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    executor,
    { maxIterations: 1, maxToolCalls: 10 }, // isLast сразу → после break нодж
    undefined,
  )
  expect(res.text).toBe('{"context":"FULL","findings":[]}')
  expect(calls).toBe(2) // 1 (тул-текст) + финальный нодж
})

test("DSML fullwidth <｜DSML｜invoke> tool call is normalized, parsed and executed", async () => {
  let calls = 0
  const executed: Array<{ name: string; args: Record<string, unknown> }> = []
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    if (calls === 1) {
      // Полная ширина (U+FF5C ｜, U+FF1C ＜, U+FF1E ＞) + DSML-префиксы.
      const text =
        '＜｜DSML｜tool_calls＞\n＜｜DSML｜invoke name="read_file"＞\n＜｜DSML｜parameter name="path" string="true"＞src/a.ts＜／｜DSML｜parameter＞\n＜／｜DSML｜invoke＞\n＜／｜DSML｜tool_calls＞'
      return {
        assistantMessage: { role: "assistant", content: [{ type: "text", text }] },
        content: [{ type: "text", text }],
        stopReason: "text",
      }
    }
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] },
      content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }],
      stopReason: "end",
    }
  }
  const localExecutor: AgentExecutor = async (call) => {
    executed.push({ name: call.name ?? "", args: (call.arguments as Record<string, unknown>) ?? {} })
    return { ok: true, text: "contents of src/a.ts" }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    localExecutor,
    { maxIterations: 5, maxToolCalls: 10 },
    undefined,
  )
  expect(executed).toHaveLength(1)
  expect(executed[0].name).toBe("read_file")
  expect(executed[0].args).toEqual({ path: "src/a.ts" })
  expect(res.text).toBe('{"context":"FULL","findings":[]}')
  expect(calls).toBe(2)
})

test("textual <invoke submit_review> verdict is extracted and returned without executing read tools", async () => {
  let calls = 0
  let executed = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    const text =
      '<tool_calls>\n<invoke name="submit_review">\n<parameter name="verdict" string="true">{"context":"FULL","findings":[{"severity":"high","file":"src/a.ts","line":3,"title":"t","description":"d","evidence":"e"}]}</parameter>\n</invoke>\n</tool_calls>'
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text }] },
      content: [{ type: "text", text }],
      stopReason: "text",
    }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    async () => { executed++; return { ok: true, text: "x" } },
    { maxIterations: 5, maxToolCalls: 10 },
    undefined,
  )
  expect(executed).toBe(0)
  expect(res.text).toBe('{"context":"FULL","findings":[{"severity":"high","file":"src/a.ts","line":3,"title":"t","description":"d","evidence":"e"}]}')
  expect(calls).toBe(1)
})

test("structured submit_review with object verdict is JSON-stringified", async () => {
  const verdictObj = { context: "FULL", findings: [] }
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    const content = [{ type: "toolCall" as const, id: "call-1", name: "submit_review", arguments: { verdict: verdictObj } }]
    return {
      assistantMessage: { role: "assistant", content },
      content,
      stopReason: "toolUse",
    }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    async () => ({ ok: true, text: "x" }),
    { maxIterations: 5, maxToolCalls: 10 },
    undefined,
  )
  expect(res.text).toBe(JSON.stringify(verdictObj))
})
