import { describe, expect, test } from "bun:test"
import { buildJudgePrompt, buildPrompt, truncateCommits } from "./prompts.ts"

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

test("judge prompt does not promise read_file (judge has no tools)", () => {
  const p = buildJudgePrompt({ files: ["src/a.ts"] }, [])
  expect(p).not.toContain("read_file")
})

test("prompt no longer instructs submit_review — verdict is plain JSON output", () => {
  for (const spec of ["security", "simplify"] as const) {
    const p = buildPrompt(scope, spec)
    expect(p).not.toContain("submit_review")
    expect(p).toContain("Return only a single valid JSON object")
  }
})

test("shared prefix precedes spec-specific sections (prefix-cache friendly)", () => {
  // Общий для всех спеков блок (INPUT/TRUST BOUNDARY/TRUSTED CONTEXT) идёт
  // ПЕРВЫМ, и дифф-блок использует ОДИН nonce (как в executeReview) — тогда
  // у security/correctness/etc. одинаковый префикс запроса, и prefix-кэш
  // провайдера отдаёт его как cache hit для всех спеков.
  const nonce = "TESTNONCE"
  const security = buildPrompt(scope, "security", nonce)
  const correctness = buildPrompt(scope, "correctness", nonce)
  const prefixS = security.slice(0, security.indexOf("# ROLE"))
  const prefixC = correctness.slice(0, correctness.indexOf("# ROLE"))
  expect(prefixS).toBe(prefixC)
  expect(prefixS).toContain("# INPUT")
  expect(prefixS).toContain("# TRUST BOUNDARY")
  expect(prefixS).toContain("# TRUSTED CONTEXT")
  expect(prefixS).not.toContain("# PRIMARY OBJECTIVE")
  expect(prefixS).not.toContain("# SPECIALIST SCOPE")
})

test("output contract documents the rule field", () => {
  const p = buildPrompt(scope, "security")
  expect(p).toContain('"rule": "string"')
  expect(p).toContain("REQUIRED for HIGH and CRITICAL findings")
})

test("simplify prompt documents two tools (read_file + search_files)", () => {
  const p = buildPrompt(scope, "simplify")
  expect(p).toContain("You have two tools:")
  expect(p).toContain("search_files(query, path?)")
  const s = buildPrompt(scope, "security")
  expect(s).toContain("You have one tool:")
  expect(s).not.toContain("You have two tools:")
})

test("test_integrity prompt lifts the test-file severity cap (tests are the subject)", () => {
  const p = buildPrompt({ files: ["src/a.test.ts"], diff: "+test" }, "test_integrity")
  expect(p).toContain("primary subject of this review")
  expect(p).not.toContain("severity capped at MEDIUM")
  const s = buildPrompt({ files: ["src/a.test.ts"], diff: "+test" }, "security")
  expect(s).toContain("severity capped at MEDIUM")
})

test("test-file severity notes are absent when the scope has no test files", () => {
  const noTests = { files: ["src/a.ts"], diff: "+x" }
  const ti = buildPrompt(noTests, "test_integrity")
  expect(ti).not.toContain("primary subject of this review")
  const sec = buildPrompt(noTests, "security")
  expect(sec).not.toContain("severity capped at MEDIUM")
})

test("cap note does not quote the old test-policy string verbatim", () => {
  const s = buildPrompt({ files: ["src/a.test.ts"], diff: "+test" }, "security")
  expect(s).toContain("severity capped at MEDIUM")
  expect(s).not.toContain('"kind=test — severity capped at MEDIUM"')
})

test("test-file note renders with clean single-blank-line spacing", () => {
  const s = buildPrompt({ files: ["src/a.test.ts"], diff: "+test" }, "security")
  const note = "Note: test files remain under the usual test-file rule for this perspective: severity capped at MEDIUM; skip style noise."
  expect(s.indexOf(note)).toBeGreaterThan(-1)
  expect(s.slice(s.indexOf(note), s.indexOf("A concern outside this scope"))).toBe(`${note}\n\n`)
})

test("shared prefix stays identical across specs even with test files", () => {
  const nonce = "TESTNONCE"
  const scopeWithTest = { files: ["src/a.test.ts"], diff: "+x" }
  const ti = buildPrompt(scopeWithTest, "test_integrity", nonce)
  const sec = buildPrompt(scopeWithTest, "security", nonce)
  expect(ti.slice(0, ti.indexOf("# ROLE"))).toBe(sec.slice(0, sec.indexOf("# ROLE")))
})

test("maintainability prompt documents named heuristics", () => {
  const p = buildPrompt(scope, "maintainability")
  expect(p).toContain("Cyclomatic complexity above 15")
  expect(p).toContain("Feature envy")
  expect(p).toContain("Cohesion problems")
  expect(p).toContain("Command-query separation violations")
  expect(p).toContain("Parse-don't-validate")
})

test("style prompt documents X-Out names test and naming-over-comments", () => {
  const p = buildPrompt(scope, "style")
  expect(p).toContain("X-Out names test")
  expect(p).toContain("better name or type")
})

test("commit history section rendered when scope.commits present, absent otherwise", () => {
  const withCommits = buildPrompt({ files: ["src/a.ts"], diff: "+x", commits: "abc123 second\n" }, "change_quality")
  expect(withCommits).toContain("# COMMIT HISTORY (untrusted)")
  expect(withCommits).toContain("BEGIN UNTRUSTED COMMIT HISTORY")
  expect(withCommits).toContain("abc123 second")
  const without = buildPrompt({ files: ["src/a.ts"], diff: "+x" }, "change_quality")
  expect(without).not.toContain("# COMMIT HISTORY")
})

test("commit history is truncated at line boundaries (cap)", () => {
  const big = "line1\n" + "x".repeat(25_000) + "\nlast\n"
  const { text, truncated } = truncateCommits(big)
  expect(truncated).toBe(true)
  expect(text.length).toBeLessThanOrEqual(20_000)
  expect(text.length === 20_000 || big[text.length] === "\n").toBe(true)
})

test("commit history shares the prefix with other specs (prefix-cache friendly)", () => {
  const nonce = "TESTNONCE"
  const scope = { files: ["src/a.ts"], diff: "+x", commits: "abc123 second\n" }
  const cq = buildPrompt(scope, "change_quality", nonce)
  const sec = buildPrompt(scope, "security", nonce)
  expect(cq.slice(0, cq.indexOf("# ROLE"))).toBe(sec.slice(0, sec.indexOf("# ROLE")))
})
