import { test, expect } from "bun:test"
import { afterAll, beforeAll } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildModelPool, pickModels, runWizard } from "./wizard.ts"
import type { PiModelLike } from "./types.ts"

const DONE = "--- DONE ---"
const NEXT = "→ Next page"

function model(id: string, provider = "opencode", cost = { input: 1, output: 1 }): PiModelLike {
  return { id, name: id, provider, cost }
}

const fakeRegistry = {
  find: () => undefined,
  getAll: () => [
    { id: "deepseek-v4-flash", name: "D", provider: "opencode-go", cost: { input: 1, output: 1 } },
    { id: "claude-sonnet", name: "C", provider: "openrouter", cost: { input: 1, output: 1 } },
    { id: "deepseek-r1", name: "R", provider: "openrouter", cost: { input: 1, output: 1 } },
    { id: "kimi", name: "K", provider: "opencode", cost: { input: 1, output: 1 } },
    { id: "glm", name: "G", provider: "openrouter", cost: { input: 1, output: 1 } },
  ],
}

test("buildModelPool excludes openrouter models by default (BLOCKED_PROVIDERS)", () => {
  const pool = buildModelPool(fakeRegistry as never)
  expect(pool.map((m) => m.provider)).not.toContain("openrouter")
  expect(pool.map((m) => m.id).sort()).toEqual(["deepseek-v4-flash", "kimi"])
})

test("buildModelPool: экстры первыми, без дублей, блокированные провайдеры скрыты", () => {
  const registry = {
    find: (p: string, id: string) => (p === "opencode-go" && id === "deepseek-v4-flash" ? model("deepseek-v4-flash", "opencode-go") : undefined),
    getAll: () => [
      model("deepseek-v4-flash", "opencode-go"), // дубль экстры — должен срезаться
      model("kimi"),
      model("claude", "openrouter"), // заблокированный провайдер
    ],
  }
  const pool = buildModelPool(registry as never)
  expect(pool.map((m) => m.id)).toEqual(["deepseek-v4-flash", "kimi"])
  expect(pool[0].provider).toBe("opencode-go") // экстра сверху
})

test("pickModels: пагинация и мультиселект через ui.select", async () => {
  const models = Array.from({ length: 25 }, (_, i) => model(`m${i}`))
  const answers = ["first", "next", "first", "done"]
  const ui = {
    select: async (_title: string, choices: string[]) => {
      const q = answers.shift()
      if (q === "first") return choices[0]
      if (q === "next") return choices[choices.length - 1] // NEXT на стр.1 — последний
      return DONE
    },
  }
  const selected = await pickModels({ ui } as never, models)
  // стр.1: m0; перелистнули; стр.2: m13; потом DONE.
  expect(selected.map((m) => m.id)).toEqual(["m0", "m13"])
  expect(answers).toHaveLength(0)
})

test("pickModels: DONE без выбора → пустой результат", async () => {
  const ui = { select: async () => DONE }
  const selected = await pickModels({ ui } as never, [model("m0")])
  expect(selected).toHaveLength(0)
})

test("runWizard: полный флоу — скоуп, точка зрения, модели, deep/judge", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ur-wizard-"))
  try {
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    git("init -q -b main")
    git("config user.email t@t")
    git("config user.name t")
    writeFileSync(join(repo, "a.ts"), "const a = 1\n")
    git("add -A")
    git("commit -qm init")

    const specAnswers = ["security", "correctness"]
    const modelAnswers = ["first", "done"]
    const ui = {
      select: async (title: string, choices: string[]) => {
        if (title.startsWith("Review scope")) return choices.find((c) => c.includes("Current dir"))!
        if (title.startsWith("Add specialization")) {
          const next = specAnswers.shift()
          return next ? choices.find((c) => c.startsWith(next + ": "))! : DONE
        }
        if (title.startsWith("Add model")) {
          return modelAnswers.shift() === "first" ? choices[0] : DONE
        }
        throw new Error(`unexpected select: ${title}`)
      },
      confirm: async (title: string) => title.startsWith("Deep mode"),
      notify() {},
    }
    const registry = {
      find: (p: string, id: string) => (p === "opencode-go" && id === "deepseek-v4-flash" ? model("deepseek-v4-flash", "opencode-go") : undefined),
      getAll: () => [model("kimi")],
    }

    const cfg = await runWizard({ ui, modelRegistry: registry } as never, repo)
    expect(cfg.scope.id).toBe("current_dir")
    expect(cfg.specs).toEqual(["security", "correctness"])
    expect(cfg.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"])
    expect(cfg.deep).toBe(true)
    expect(cfg.judge).toBe(false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test("empty blocked list restores openrouter models (fast revert mechanics)", () => {
  // Механика «быстро вернуть»: BLOCKED_PROVIDERS = [] в constants.ts
  // даёт ровно тот же результат, что передача [] сюда.
  const pool = buildModelPool(fakeRegistry as never, [])
  expect(pool.map((m) => m.provider)).toContain("openrouter")
  expect(pool.map((m) => m.id).sort()).toEqual(["claude-sonnet", "deepseek-r1", "deepseek-v4-flash", "glm", "kimi"])
})
