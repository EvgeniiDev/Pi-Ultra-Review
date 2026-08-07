import { test, expect, mock, beforeEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// Тесты агентного слоя на SDK pi: мокаем @earendil-works/pi-coding-agent,
// проверяем, что runAgent/judgeViaPi создают сессию с НАШИМИ тулами (без
// системных bash/read), вызывают prompt, извлекают текст, делают followUp
// при не-вердикте и всегда dispose().
// ─────────────────────────────────────────────────────────────────────────────

let sessionOpts: any = null
let promptCalls: string[] = []
let followUpCalls: string[] = []
let disposed = 0
let aborted = 0
let fakeMessages: any[] = []
let autoReadPath: string | null = null
let holdPrompt = false
let promptResolve: (() => void) | null = null

// typebox — peer-зависимость pi (в рантайме есть, в bun-тестах нет).
mock.module("@sinclair/typebox", () => ({
  Type: { String: () => ({}), Number: () => ({}), Boolean: () => ({}), Optional: (x: unknown) => x, Array: (x: unknown) => x, Object: (x: unknown) => x },
}))

mock.module("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: async (opts: any) => {
    sessionOpts = opts
    return {
      session: {
        prompt: async (text: string) => {
          promptCalls.push(text)
          // Имитируем модель, читающую файл через наш read_file внутри сессии.
          if (autoReadPath) {
            await sessionOpts.customTools.find((t: any) => t.name === "read_file").execute("id", { path: autoReadPath })
          }
          // Для теста отмены: держим prompt, пока abort() не отпустит его.
          if (holdPrompt) {
            await new Promise<void>((resolve) => {
              promptResolve = resolve
            })
          }
        },
        followUp: async (text: string) => {
          followUpCalls.push(text)
          // После followUp модель «отвечает» вердиктом.
          fakeMessages = [{ role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] }]
        },
        dispose: () => {
          disposed++
        },
        abort: () => {
          aborted++
          promptResolve?.()
          promptResolve = null
        },
        subscribe: () => () => {},
        agent: {
          state: {
            get messages() {
              return fakeMessages
            },
          },
        },
      },
    }
  },
  defineTool: (def: any) => def,
  DefaultResourceLoader: class {
    constructor(_o: any) {}
    async reload() {}
  },
  ModelRuntime: {
    create: async () => ({ getModel: (p: string, id: string) => ({ provider: p, id }) }),
  },
  SessionManager: { inMemory: () => ({}) },
  SettingsManager: { inMemory: () => ({}) },
}))

const { runAgent, judgeViaPi } = await import("../extensions/ultra-review/pi-call.ts")

const model = { provider: "test", id: "m", name: "m", cost: { input: 1, output: 1 } }

beforeEach(() => {
  sessionOpts = null
  promptCalls = []
  followUpCalls = []
  disposed = 0
  aborted = 0
  fakeMessages = []
  autoReadPath = null
  holdPrompt = false
  promptResolve = null
})

test("runAgent: сессия с нашими тулами (без системных), prompt, вердикт, dispose", async () => {
  fakeMessages = [{ role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] }]
  const res = await runAgent(model, "review prompt", process.cwd())
  expect(res.text).toBe('{"context":"FULL","findings":[]}')
  expect(promptCalls).toEqual(["Review the files in scope and output your verdict."])
  // Только наши тулы — никаких read/bash/edit/write.
  expect(sessionOpts.tools).toEqual(["read_file"])
  expect(sessionOpts.customTools.map((t: any) => t.name)).toEqual(["read_file"])
  expect(sessionOpts.noTools).toBeUndefined()
  expect(disposed).toBe(1)
  expect(followUpCalls).toHaveLength(0)
})

test("runAgent simplify: получает и search_files", async () => {
  fakeMessages = [{ role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] }]
  await runAgent(model, "review prompt", process.cwd(), undefined, { search: true })
  expect(sessionOpts.tools.sort()).toEqual(["read_file", "search_files"])
})

test("runAgent: проза без вердикта → followUp, текст из ответа на него", async () => {
  fakeMessages = [{ role: "assistant", content: [{ type: "text", text: "I reviewed the code and it looks fine." }] }]
  const res = await runAgent(model, "review prompt", process.cwd())
  expect(followUpCalls).toHaveLength(1)
  expect(res.text).toBe('{"context":"FULL","findings":[]}')
})

test("runAgent: read_file тул ходит в песочницу, прочитанные пути попадают в результат", async () => {
  const root = mkdtempSync(join(tmpdir(), "ur-sess-"))
  try {
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "a.ts"), "const a = 1\n")
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(root, "node_modules", "pkg", "x.js"), "x\n")
    fakeMessages = [{ role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] }]

    // Модель читает обычный файл — путь записан в результат.
    autoReadPath = "src/a.ts"
    const res = await runAgent(model, "review prompt", root)
    expect(res.readFiles).toEqual(["src/a.ts"])

    // Модель пытается прочитать заблокированный — путь НЕ записан, тул вернул ошибку.
    autoReadPath = "node_modules/pkg/x.js"
    const res2 = await runAgent(model, "review prompt", root)
    expect(res2.readFiles).toEqual([])

    const readTool = sessionOpts.customTools.find((t: any) => t.name === "read_file")
    const blocked = await readTool.execute("id", { path: "node_modules/pkg/x.js" })
    expect(blocked.content[0].text).toContain("blocked")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runAgent: отмена (abort-сигнал) прерывает сессию", async () => {
  fakeMessages = [{ role: "assistant", content: [{ type: "text", text: '{"context":"FULL","findings":[]}' }] }]
  holdPrompt = true // prompt не завершается, пока abort() не отпустит
  const controller = new AbortController()
  const resPromise = runAgent(model, "review prompt", process.cwd(), controller.signal)
  await new Promise((r) => setTimeout(r, 10)) // даём prompt стартовать
  controller.abort()
  const res = await resPromise
  expect(aborted).toBe(1) // сессия прервана по сигналу
  expect(res.text).toBe('{"context":"FULL","findings":[]}')
  expect(disposed).toBe(1)
})

test("judgeViaPi: без тулов (noTools all), промпт судьи, текст из сообщений", async () => {
  fakeMessages = [{ role: "assistant", content: [{ type: "text", text: '{"verdicts":[]}' }] }]
  const out = await judgeViaPi(model, "judge prompt")
  expect(out.text).toBe('{"verdicts":[]}')
  expect(sessionOpts.noTools).toBe("all")
  expect(promptCalls).toEqual(["Emit your JSON verdict now — exactly the schema from the prompt."])
  expect(disposed).toBe(1)
})
