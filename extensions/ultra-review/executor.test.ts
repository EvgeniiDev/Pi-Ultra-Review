import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BLOCKED_DIRS, readFileSafely } from "./agent.ts"

// Песочница чтения: путь обязан остаться внутри root, служебные папки
// заблокированы, симлинки за пределы не выпускаются.

let root: string
let outsideDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ur-sandbox-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "const needle = 1\nconst needle = 2\n")
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(root, "node_modules", "pkg", "x.js"), "const blocked = 1\n")
  writeFileSync(join(root, "big.ts"), "needle\n".repeat(15000)) // ~105 КБ > 100 КБ
  writeFileSync(join(root, "bin.dat"), "needle\u0000binary\n")
  // Реальный файл ЗА пределами песочницы.
  outsideDir = mkdtempSync(join(tmpdir(), "ur-outside-"))
  writeFileSync(join(outsideDir, "secret.txt"), "secret\n")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

test("readFileSafely: обычный файл читается с номерами строк", async () => {
  const res = await readFileSafely(root, "src/a.ts")
  expect(res.ok).toBe(true)
  const text = (res as { ok: true; text: string }).text
  expect(text).toContain("1| const needle = 1")
  expect(text).toContain("2| const needle = 2")
})

test("readFileSafely: служебные папки заблокированы", async () => {
  const res = await readFileSafely(root, "node_modules/pkg/x.js")
  expect(res.ok).toBe(false)
  expect((res as { ok: false; error: string }).error).toMatch(/blocked/)
})

test("readFileSafely: выход за пределы репозитория отклонён", async () => {
  const res = await readFileSafely(root, `../${outsideDir.split(/[\\/]/).pop()}/secret.txt`)
  expect(res.ok).toBe(false)
  expect((res as { ok: false; error: string }).error).toMatch(/escapes/)
})

test("readFileSafely: большие и бинарные файлы не читаются", async () => {
  const big = await readFileSafely(root, "big.ts")
  expect(big.ok).toBe(false)
  expect((big as { ok: false; error: string }).error).toMatch(/too large/)
  const bin = await readFileSafely(root, "bin.dat")
  expect(bin.ok).toBe(false)
  expect((bin as { ok: false; error: string }).error).toMatch(/binary/)
})

test("readFileSafely: несуществующий файл — понятная ошибка", async () => {
  const res = await readFileSafely(root, "nope.ts")
  expect(res.ok).toBe(false)
})

test("BLOCKED_DIRS: единый список песочницы (без дрейфа)", () => {
  for (const dir of [".git", "node_modules", ".pi", "reviews", ".venv", "__pycache__", "dist", "build"]) {
    expect(BLOCKED_DIRS.has(dir), dir).toBe(true)
  }
})
