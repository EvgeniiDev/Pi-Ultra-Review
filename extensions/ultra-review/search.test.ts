import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// pi-call.ts импортирует модули, которые вне рантайма pi не резолвятся, —
import { searchFilesSafely } from "./agent.ts"

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ur-search-"))
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "const needle = 1\n")
  writeFileSync(join(root, "src", "b.ts"), "nothing here\n")
  writeFileSync(join(root, "src", "c.ts"), "needle\n".repeat(30)) // 30 совпадений — cap 20
  writeFileSync(join(root, "node_modules", "pkg", "x.js"), "needle inside node_modules\n")
  writeFileSync(join(root, "src", "binary.bin"), "needle\u0000binary\n")
  writeFileSync(join(root, "src", "big.ts"), "needle\n".repeat(15000)) // 105 КБ > 100 КБ
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("finds matches, skips blocked dirs, binaries, and large files", async () => {
  const res = await searchFilesSafely(root, "needle")
  expect(res.ok).toBe(true)
  const text = (res as { ok: true; text: string }).text
  expect(text).toContain("src/a.ts:1:")
  expect(text).toContain("src/c.ts:1:")
  expect(text).toContain("31 match(es)")
  expect(text).toContain("showing first 20")
  expect(text).not.toContain("node_modules")
  expect(text).not.toContain("binary.bin")
  expect(text).not.toContain("big.ts")
})

test("respects path filter", async () => {
  const res = await searchFilesSafely(root, "needle", "src")
  expect(res.ok).toBe(true)
  expect((res as { ok: true; text: string }).text).toContain("src/a.ts:1:")
})

test("no matches returns zero count", async () => {
  const res = await searchFilesSafely(root, "zzz")
  expect(res.ok).toBe(true)
  expect((res as { ok: true; text: string }).text).toContain("0 match(es)")
})

test("rejects file filter inside a blocked dir", async () => {
  const res = await searchFilesSafely(root, "needle", "node_modules/pkg/x.js")
  expect(res.ok).toBe(false)
  expect((res as { ok: false; error: string }).error).toMatch(/blocked/)
})

test("searchFilesSafely respects the scan budget (maxFiles)", async () => {
  // Бюджет 0: ни один файл не сканируется → 0 совпадений.
  const res = await searchFilesSafely(root, "needle", undefined, 0)
  expect(res.ok).toBe(true)
  expect((res as { ok: true; text: string }).text).toContain("0 match(es)")
  // Бюджет 1: максимум один файл просканирован + пометка о неполном покрытии.
  const one = await searchFilesSafely(root, "needle", undefined, 1)
  const text = (one as { ok: true; text: string }).text
  expect(text).toMatch(/^search: "needle" — \d+ match\(es\)/)
  expect(text).toContain("scan capped at 1 files")
})

test("rejects empty query and path escapes", async () => {
  const empty = await searchFilesSafely(root, "   ")
  expect(empty.ok).toBe(false)
  const esc = await searchFilesSafely(root, "needle", "../outside")
  expect(esc.ok).toBe(false)
})

