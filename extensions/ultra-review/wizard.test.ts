import { test, expect } from "bun:test"
import { buildModelPool } from "./wizard.ts"

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

test("empty blocked list restores openrouter models (fast revert mechanics)", () => {
  // Механика «быстро вернуть»: BLOCKED_PROVIDERS = [] в constants.ts
  // даёт ровно тот же результат, что передача [] сюда.
  const pool = buildModelPool(fakeRegistry as never, [])
  expect(pool.map((m) => m.provider)).toContain("openrouter")
  expect(pool.map((m) => m.id).sort()).toEqual(["claude-sonnet", "deepseek-r1", "deepseek-v4-flash", "glm", "kimi"])
})
