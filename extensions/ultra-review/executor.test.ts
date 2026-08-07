import { afterAll, beforeAll, describe, expect, test, mock } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// pi-call.ts импортирует модули, которые вне рантайма pi не резолвятся, —
// мокаем до импорта pi-call (тесты ниже используют только makeReadTool).
mock.module("@earendil-works/pi-ai/compat", () => ({ complete: async () => ({ stopReason: "end_turn", content: [] }) }))
mock.module("@sinclair/typebox", () => ({ Type: { String: () => ({}), Number: () => ({}), Boolean: () => ({}), Optional: (x: unknown) => x, Array: (x: unknown) => x, Object: (x: unknown) => x } }))
mock.module("./constants.ts", () => ({
  EMPTY_RESPONSE_RETRIES: 2,
  RETRY_DELAY_MS: 1, // в тестах — 1ms вместо 1500ms
  MODEL_MAX_TOKENS: 8192,
  MODEL_TEMPERATURE: 0.3,
  SIMPLIFY_MAX_ITERATIONS: 10,
  SIMPLIFY_MAX_TOOL_CALLS: 40,
  MAX_AGENT_ITERATIONS: 10,
  MAX_AGENT_TOOL_CALLS: 40,
}))

// Динамический импорт — статические хоистятся и загрузились бы ДО mock.module.
const { makeExecutor, runAgentLoop } = await import("./agent.ts")
const { agentOptionsForSpec, makeReadTool, makeSearchTool } = await import("./pi-call.ts")

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ur-exec-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "const needle = 1\n")
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(root, "node_modules", "pkg", "x.js"), "const blocked = 1\n")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("makeExecutor records normalized forward-slash paths in readFiles", async () => {
  const readFiles = new Set<string>()
  const exec = makeExecutor(root, readFiles)
  // Backslash-путь (как модель цитирует то, что увидела в ответе read_file на Windows).
  await exec({ name: "read_file", arguments: { path: "src\\a.ts" } })
  expect(readFiles.has("src/a.ts")).toBe(true)
  const ok = await exec({ name: "read_file", arguments: { path: "src/a.ts" } })
  expect(ok.ok).toBe(true)
})

test("makeExecutor records only successful reads in readFiles", async () => {
  const readFiles = new Set<string>()
  const exec = makeExecutor(root, readFiles)
  // Заблокированный каталог: чтение падает, путь НЕ должен попасть в readFiles —
  // иначе галлюцинация на .git/config или node_modules/x пройдёт серверную
  // валидацию находок (файл считается «прочитанным», хотя контента модель не видела).
  const blocked = await exec({ name: "read_file", arguments: { path: "node_modules/pkg/x.js" } })
  expect(blocked.ok).toBe(false)
  expect(readFiles.has("node_modules/pkg/x.js")).toBe(false)
  const missing = await exec({ name: "read_file", arguments: { path: "nope.ts" } })
  expect(missing.ok).toBe(false)
  expect(readFiles.has("nope.ts")).toBe(false)
  const ok = await exec({ name: "read_file", arguments: { path: "src/a.ts" } })
  expect(ok.ok).toBe(true)
  expect(readFiles.has("src/a.ts")).toBe(true)
})

test("makeExecutor rejects unknown tools explicitly", async () => {
  const readFiles = new Set<string>()
  const exec = makeExecutor(root, readFiles)
  const res = await exec({ name: "submit_review", arguments: { verdict: "x" } })
  expect(res.ok).toBe(false)
  expect((res as { ok: false; error: string }).error).toMatch(/unknown tool/)
  expect(readFiles.size).toBe(0)
})

test("makeExecutor dispatches read_file and search_files by name", async () => {
  const readFiles = new Set<string>()
  const exec = makeExecutor(root, readFiles)
  const r1 = await exec({ name: "read_file", arguments: { path: "src/a.ts" } })
  expect(r1.ok).toBe(true)
  expect(readFiles.has("src/a.ts")).toBe(true)
  const r2 = await exec({ name: "search_files", arguments: { query: "needle", path: "src" } })
  expect(r2.ok).toBe(true)
  expect((r2 as { ok: true; text: string }).text).toContain("src/a.ts:1:")
})

test("runAgentLoop executes search_files through makeExecutor", async () => {
  const exec = makeExecutor(root, new Set<string>())
  let n = 0
  const chat = async () => {
    n++
    if (n === 1) {
      return { assistantMessage: {}, content: [{ type: "toolCall", id: "t1", name: "search_files", arguments: { query: "needle" } }], stopReason: "toolUse" }
    }
    return { assistantMessage: {}, content: [{ type: "text", text: "final" }], stopReason: "end_turn" }
  }
  const res = await runAgentLoop(chat, [], [makeReadTool(), makeSearchTool()], exec, { maxIterations: 4 })
  expect(res.text).toBe("final")
  expect(res.toolCalls).toBe(1)
})

test("agentOptionsForSpec gives search tool and budget to simplify only", () => {
  const s = agentOptionsForSpec("simplify")
  expect(s.extraTools).toHaveLength(1)
  expect(s.extraTools[0].name).toBe("search_files")
  expect(s.maxIterations).toBe(10)
  expect(s.maxToolCalls).toBe(40)
  const o = agentOptionsForSpec("security")
  expect(o.extraTools).toEqual([])
  expect(o.maxIterations).toBe(10)
  expect(o.maxToolCalls).toBe(40)
})
