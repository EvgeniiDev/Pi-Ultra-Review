import { describe, expect, test } from "bun:test"
import { buildPrompt } from "./prompts.ts"

const scope = { files: ["src/a.ts"], diff: "diff --git a/src/a.ts b/src/a.ts\n+needle" }

test("simplify prompt documents search_files and the risk/action contract", () => {
  const p = buildPrompt(scope, "simplify")
  expect(p).toContain("search_files(query, path?)")
  expect(p).toContain('risk: "safe" | "confirm" | "review"')
  expect(p).toContain('action: "delete" | "inline" | "refactor" | "parallelize"')
  expect(p).toContain("reuseTarget")
})

test("security prompt does not mention search_files or simplify fields", () => {
  const p = buildPrompt(scope, "security")
  expect(p).not.toContain("search_files")
  expect(p).not.toContain("reuseTarget")
  expect(p).not.toContain('risk: "safe"')
})
