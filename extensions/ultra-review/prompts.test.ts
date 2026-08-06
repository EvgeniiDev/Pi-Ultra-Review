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

test("prompt no longer instructs submit_review — verdict is plain JSON output", () => {
  for (const spec of ["security", "simplify"] as const) {
    const p = buildPrompt(scope, spec)
    expect(p).not.toContain("submit_review")
    expect(p).toContain("Return only a single valid JSON object")
  }
})

test("simplify prompt documents two tools (read_file + search_files)", () => {
  const p = buildPrompt(scope, "simplify")
  expect(p).toContain("You have two tools:")
  expect(p).toContain("search_files(query, path?)")
  const s = buildPrompt(scope, "security")
  expect(s).toContain("You have one tool:")
  expect(s).not.toContain("You have two tools:")
})
