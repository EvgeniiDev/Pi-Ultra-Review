import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { executeReview, processTaskOutput, type ReviewDeps } from "./engine.ts"
import type { ReviewConfig } from "./types.ts"

const scopeFiles = new Set(["src/a.ts"])
const readFiles = new Set<string>()

test("simplify: valid risk/action/reuseTarget pass through", () => {
  const out = `{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"dead code","risk":"safe","action":"delete","reuseTarget":"x in src/y.ts"}]}`
  const r = processTaskOutput(out, "simplify", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.findings[0].risk).toBe("safe")
  expect(r.findings[0].action).toBe("delete")
  expect(r.findings[0].reuseTarget).toBe("x in src/y.ts")
})

test("simplify: missing or invalid risk/action rejected", () => {
  const noFields = `{"findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"x"}]}`
  const r1 = processTaskOutput(noFields, "simplify", scopeFiles, readFiles)
  expect(r1.findings).toHaveLength(0)
  expect(r1.rejectedCount).toBe(1)
  const badRisk = `{"findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"x","risk":"maybe","action":"delete"}]}`
  const r2 = processTaskOutput(badRisk, "simplify", scopeFiles, readFiles)
  expect(r2.findings).toHaveLength(0)
  expect(r2.rejectedCount).toBe(1)
})

test("security: risk/action fields ignored, finding kept without them", () => {
  const out = `{"findings":[{"severity":"MEDIUM","file":"src/a.ts","line":1,"title":"x","risk":"safe","action":"delete"}]}`
  const r = processTaskOutput(out, "security", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.findings[0].risk).toBeUndefined()
  expect(r.findings[0].action).toBeUndefined()
})

test("executeReview renders risk/action and reuseTarget into the report", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ur-report-"))
  const cfg: ReviewConfig = {
    scope: { id: "test", label: "test scope", description: "", files: ["src/a.ts"] },
    specs: ["simplify"],
    models: [{ id: "m", name: "m", provider: "p", cost: { input: 0, output: 0 } }],
    deep: false,
    judge: false,
  }
  const deps: ReviewDeps = {
    ui: { setStatus() {}, select: async () => "x", confirm: async () => true, notify() {} },
    callModel: async () => ({
      text: `{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"dead code","risk":"safe","action":"delete","reuseTarget":"x in src/y.ts"}]}`,
      toolCalls: 1,
      readFiles: ["src/a.ts"],
    }),
  }
  const { filename } = await executeReview(deps, dir, cfg)
  const report = readFileSync(join(dir, "reviews", filename), "utf-8")
  expect(report).toContain("(risk: safe, action: delete)")
  expect(report).toContain("reuse: x in src/y.ts")
  rmSync(dir, { recursive: true, force: true })
})
