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

test("review JSON wrapped in prose + ```json fence still parses", () => {
  const out = `This is all documentation. I reviewed the key files and found no real issues.\n\n\`\`\`json\n{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"x"}]}\n\`\`\`\n`
  const r = processTaskOutput(out, "correctness", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.context).toBe("FULL")
})

test("review JSON in plain prose (no fence) still parses", () => {
  const out = `I checked the code. Verdict: {"context":"PARTIAL","findings":[{"severity":"MEDIUM","file":"src/a.ts","line":3,"title":"y"}]}. Nothing else.`
  const r = processTaskOutput(out, "correctness", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.context).toBe("PARTIAL")
})

test("pure prose without JSON stays malformed (not a false positive)", () => {
  const r = processTaskOutput("Everything looks fine, no issues found.", "correctness", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(0)
  expect(r.malformed).toBeTruthy()
})

test("prose with braces in code samples + ```json fence still parses", () => {
  // Реальный кейс: проза анализа содержит { } в примерах кода — срез первого
  // { … последнего } захватывает мусор, но ```json-фенс вытаскивает вердикт.
  const out = `Line 22: \`end = text.find("\\n---", 4)\`. If the frontmatter is \`---\\nname: foo\\n---\\n\`, then \`{ a: 1 }\` and \`{"x": {"y": [1,2]}}\` — edge case, unlikely.\n\nGiven the scope, a clean review.\n\n\`\`\`json\n{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"z"}]}\n\`\`\`\n`
  const r = processTaskOutput(out, "correctness", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.context).toBe("FULL")
})

test("no fence: balanced {…} extracted from the last { despite braces in prose", () => {
  const out = `Example object \`{"k": 1}\` in prose. Final verdict: {"context":"PARTIAL","findings":[{"severity":"MEDIUM","file":"src/a.ts","line":2,"title":"q"}]} the end.`
  const r = processTaskOutput(out, "correctness", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(1)
  expect(r.context).toBe("PARTIAL")
})

test("multiple fences: code sample first, json verdict second", () => {
  const out = `\`\`\`python\n{"not": "json"}\n\`\`\`\nVerdict:\n\`\`\`json\n{"context":"FULL","findings":[]}\n\`\`\`\n`
  const r = processTaskOutput(out, "correctness", scopeFiles, readFiles)
  expect(r.findings).toHaveLength(0)
  expect(r.context).toBe("FULL")
})

test("judge output with braces inside quoted strings still parses (string-aware)", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ur-straware-"))
  const cfg: ReviewConfig = {
    scope: { id: "test", label: "test scope", description: "", files: ["src/a.ts"] },
    specs: ["security"],
    models: [{ id: "m", name: "m", provider: "p", cost: { input: 1, output: 1 } }],
    deep: false,
    judge: true,
  }
  const deps: ReviewDeps = {
    ui: { setStatus() {}, select: async () => "x", confirm: async () => true, notify() {} },
    callModel: async (_m, _p, specId) => {
      if (specId === "judge") {
        // Проза с незакрытой скобкой + rationale цитирует код с двумя } в строке.
        // Наивный depth-скан закрыл бы объект на первом } внутри строки.
        return {
          text: 'prose {unclosed {"verdicts":[{"idx":1,"verdict":"VALID","rationale":"a } b } c"}],"summary":{"valid":1},"kept":[1]}',
          toolCalls: 0,
          readFiles: [],
        }
      }
      return {
        text: '{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"naming"}]}',
        toolCalls: 1,
        readFiles: ["src/a.ts"],
      }
    },
  }
  const { filename } = await executeReview(deps, dir, cfg)
  const report = readFileSync(join(dir, "reviews", filename), "utf-8")
  // Судья распарсен: вердикт проставлен, находка осталась.
  expect(report).toContain("Final verdict (judge)")
  expect(report).not.toContain("could not be parsed")
  rmSync(dir, { recursive: true, force: true })
})

test("judge DOWNGRADE with new_severity HIGHER than original is ignored (no upgrade)", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ur-upgrade-"))
  const cfg: ReviewConfig = {
    scope: { id: "test", label: "test scope", description: "", files: ["src/a.ts"] },
    specs: ["security"],
    models: [{ id: "m", name: "m", provider: "p", cost: { input: 1, output: 1 } }],
    deep: false,
    judge: true,
  }
  const deps: ReviewDeps = {
    ui: { setStatus() {}, select: async () => "x", confirm: async () => true, notify() {} },
    callModel: async (_m, _p, specId) => {
      if (specId === "judge") {
        // Судья пометил LOW-находку как DOWNGRADE с new_severity CRITICAL —
        // это не понижение, а попытка апгрейда: игнорируем.
        return {
          text: '{"verdicts":[{"idx":1,"verdict":"DOWNGRADE","duplicate_of":null,"new_severity":"CRITICAL","rationale":"x"}],"summary":{"valid":0,"duplicate":0,"false_positive":0,"downgrade":1},"kept":[1]}',
          toolCalls: 0,
          readFiles: [],
        }
      }
      return {
        text: '{"context":"FULL","findings":[{"severity":"LOW","file":"src/a.ts","line":1,"title":"naming"}]}',
        toolCalls: 1,
        readFiles: ["src/a.ts"],
      }
    },
  }
  const { filename } = await executeReview(deps, dir, cfg)
  const report = readFileSync(join(dir, "reviews", filename), "utf-8")
  expect(report).toContain("(1) [LOW] src/a.ts:1 — naming")
  expect(report).not.toContain("→CRITICAL")
  expect(report).not.toContain("→HIGH")
  rmSync(dir, { recursive: true, force: true })
})

test("consensus is not APPROVED when most tasks failed (quorum)", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ur-quorum-"))
  const cfg: ReviewConfig = {
    scope: { id: "test", label: "test scope", description: "", files: ["src/a.ts"] },
    specs: ["security", "correctness", "performance"],
    models: [{ id: "m", name: "m", provider: "p", cost: { input: 1, output: 1 } }],
    deep: false,
    judge: false,
  }
  const deps: ReviewDeps = {
    ui: { setStatus() {}, select: async () => "x", confirm: async () => true, notify() {} },
    callModel: async (_m, _p, specId) => {
      if (specId !== "performance") throw new Error("provider down")
      return {
        text: '{"context":"FULL","findings":[]}',
        toolCalls: 1,
        readFiles: ["src/a.ts"],
      }
    },
  }
  const { filename } = await executeReview(deps, dir, cfg)
  const report = readFileSync(join(dir, "reviews", filename), "utf-8")
  // 2 задачи упали, 1 одобрила — APPROVED быть не должен (иначе 1/3 = зелёный свет).
  expect(report).toContain("**Consensus:** REQUIRES_HUMAN_REVIEW")
  expect(report).not.toContain("**Consensus:** APPROVED")
  rmSync(dir, { recursive: true, force: true })
})

test("missing or unknown context is treated as INSUFFICIENT (fail-closed)", () => {
  const noContext = processTaskOutput('{"findings":[]}', "correctness", scopeFiles, readFiles)
  expect(noContext.context).toBe("INSUFFICIENT")
  const bogus = processTaskOutput('{"context":"bogus","findings":[]}', "correctness", scopeFiles, readFiles)
  expect(bogus.context).toBe("INSUFFICIENT")
})

test("finding file with backslash or ./ spelling passes validation after normalization", () => {
  const backslash = processTaskOutput('{"context":"FULL","findings":[{"severity":"LOW","file":"src\\\\a.ts","line":1,"title":"x"}]}', "correctness", scopeFiles, readFiles)
  expect(backslash.findings).toHaveLength(1)
  expect(backslash.findings[0].file).toBe("src/a.ts")
  const dot = processTaskOutput('{"context":"FULL","findings":[{"severity":"LOW","file":"./src/a.ts","line":1,"title":"x"}]}', "correctness", scopeFiles, readFiles)
  expect(dot.findings).toHaveLength(1)
  expect(dot.findings[0].file).toBe("src/a.ts")
})

test("judge DOWNGRADE with invalid new_severity keeps the original severity", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const dir = mkdtempSync(join(tmpdir(), "ur-judge-"))
  const cfg: ReviewConfig = {
    scope: { id: "test", label: "test scope", description: "", files: ["src/a.ts"] },
    specs: ["security"],
    models: [{ id: "m", name: "m", provider: "p", cost: { input: 0, output: 0 } }],
    deep: false,
    judge: true,
  }
  const deps: ReviewDeps = {
    ui: { setStatus() {}, select: async () => "x", confirm: async () => true, notify() {} },
    callModel: async (_m, _p, specId) => {
      if (specId === "judge") {
        // Модель-судья выдала мусорный new_severity — находка должна остаться как есть.
        return {
          text: '{"verdicts":[{"idx":1,"verdict":"DOWNGRADE","duplicate_of":null,"new_severity":"banana","rationale":"x"}],"summary":{"valid":0,"duplicate":0,"false_positive":0,"downgrade":1},"kept":[1]}',
          toolCalls: 0,
          readFiles: [],
        }
      }
      return {
        text: '{"context":"FULL","findings":[{"severity":"HIGH","file":"src/a.ts","line":1,"title":"injection"}]}',
        toolCalls: 1,
        readFiles: ["src/a.ts"],
      }
    },
  }
  const { filename } = await executeReview(deps, dir, cfg)
  const report = readFileSync(join(dir, "reviews", filename), "utf-8")
  expect(report).toContain("(1) [HIGH] src/a.ts:1 — injection")
  expect(report).not.toContain("banana")
  rmSync(dir, { recursive: true, force: true })
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
