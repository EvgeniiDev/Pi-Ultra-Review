import { describe, expect, test } from "bun:test"
import { buildJudgePrompt, type JudgeFindingInput } from "./prompts.ts"

test("judge prompt includes risk/action and the consistency rule when present", () => {
  const f: JudgeFindingInput = { idx: 1, severity: "LOW", file: "src/a.ts", line: 1, title: "dead code", risk: "safe", action: "delete", agent: "a", spec: "simplify" }
  const p = buildJudgePrompt({ files: ["src/a.ts"] }, [f])
  expect(p).toContain("risk: safe, action: delete")
  expect(p).toContain("Action/risk consistency")
})

test("judge prompt omits risk/action when absent", () => {
  const f: JudgeFindingInput = { idx: 1, severity: "MEDIUM", file: "src/a.ts", line: 1, title: "bug", agent: "a", spec: "security" }
  const p = buildJudgePrompt({ files: ["src/a.ts"] }, [f])
  expect(p).not.toContain("risk: safe")
})
