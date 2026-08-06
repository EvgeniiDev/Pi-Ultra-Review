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

test("budget exhaustion responds to every real tool_call, then the model answers", async () => {
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
    // maxToolCalls=1: после исчерпания бюджета тулы убраны — модель отвечает.
    const content = [{ type: "text", text: "final" }]
    return {
      assistantMessage: { role: "assistant", content },
      content,
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
  expect(calls).toBe(2)
})

test("isLast branch answers each real tool_call and preserves the turn's text", async () => {
  let calls = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    // maxIterations=1 → isLast сразу; модель всё равно просит тулы и пишет текст.
    const content = [
      toolCall("call_1"),
      toolCall("call_2"),
      toolCall("call_3"),
      { type: "text", text: "verdict" },
    ]
    return { assistantMessage: { role: "assistant", content }, content, stopReason: "toolCalls" }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    executor,
    { maxIterations: 1, maxToolCalls: 10 },
    undefined,
  )
  // isLast-ветка ответила всем трём тулам (assertProtocol в chat это проверил)
  // и сохранила текст хода — без отдельного nudging-вызова.
  expect(res.text).toBe("verdict")
  expect(calls).toBe(1)
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

test("structured read_file calls are executed, then the verdict text is returned", async () => {
  let calls = 0
  const executed: Array<{ name: string; args: Record<string, unknown> }> = []
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    if (calls === 1) {
      const content = [
        toolCall("call_1", "read_file", { path: "src/a.ts" }),
        { type: "text", text: "reading…" },
      ]
      return { assistantMessage: { role: "assistant", content }, content, stopReason: "toolCalls" }
    }
    const text = '{"context":"FULL","findings":[{"severity":"HIGH","file":"src/a.ts","line":2,"title":"t"}]}'
    return {
      assistantMessage: { role: "assistant", content: [{ type: "text", text }] },
      content: [{ type: "text", text }],
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
  expect(res.text).toContain('"context":"FULL"')
  expect(calls).toBe(2)
})

test("prose verdict written alongside tool calls survives: text is tracked across turns", async () => {
  let calls = 0
  const chat = async (messages: unknown[], _tools: unknown[]) => {
    assertProtocol(messages as Msg[])
    calls++
    if (calls === 1) {
      const content = [
        toolCall("call_1", "read_file", { path: "src/a.ts" }),
        { type: "text", text: '{"context":"FULL","findings":[]}' },
      ]
      return { assistantMessage: { role: "assistant", content }, content, stopReason: "toolCalls" }
    }
    // Модель зациклилась: на isLast-итерации снова просит тул (их уже нет).
    const content = [toolCall("call_2", "read_file", { path: "src/b.ts" })]
    return { assistantMessage: { role: "assistant", content }, content, stopReason: "toolCalls" }
  }
  const res = await runAgentLoop(
    chat as never,
    [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
    [],
    async () => ({ ok: true, text: "contents" }),
    { maxIterations: 2, maxToolCalls: 30 },
    undefined,
  )
  // isLast-ветка отвечает call_2, break — вердикт из первой итерации сохранён.
  expect(res.text).toContain('"context":"FULL"')
  expect(calls).toBe(2)
})
