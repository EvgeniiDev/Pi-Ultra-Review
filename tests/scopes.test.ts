import { afterAll, beforeAll, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getScopes, resolveScope } from "../extensions/ultra-review/scopes.ts"

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

let repo: string
let dirty: string

beforeAll(() => {
  // Чистый репо: A (origin/main) → B (HEAD), плюс node_modules для проверки skip.
  repo = mkdtempSync(join(tmpdir(), "ur-scopes-"))
  git(repo, "init -q -b main")
  git(repo, "config user.email t@t")
  git(repo, "config user.name t")
  writeFileSync(join(repo, "a.ts"), "const a = 1\n")
  git(repo, "add -A")
  git(repo, "commit -qm init")
  git(repo, "branch origin/main") // origin/main = A
  writeFileSync(join(repo, "b.ts"), "const b = 2\n")
  writeFileSync(join(repo, ".gitignore"), "node_modules\n")
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(repo, "node_modules", "pkg", "x.js"), "x\n")
  git(repo, "add -A")
  git(repo, "commit -qm second") // HEAD = B (дерево чистое: node_modules в gitignore)

  // Грязное дерево: незакоммиченное изменение → рабочий скоуп.
  dirty = mkdtempSync(join(tmpdir(), "ur-dirty-"))
  git(dirty, "init -q -b main")
  git(dirty, "config user.email t@t")
  git(dirty, "config user.name t")
  writeFileSync(join(dirty, "a.ts"), "const a = 1\n")
  git(dirty, "add -A")
  git(dirty, "commit -qm init")
  writeFileSync(join(dirty, "a.ts"), "const a = 2\n")
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(dirty, { recursive: true, force: true })
})

test("getScopes: чистое дерево → current_dir, branch_vs_origin/main, last_commit в этом порядке", () => {
  const scopes = getScopes(repo)
  expect(scopes.map((s) => s.id)).toEqual(["current_dir", "branch_vs_origin/main", "last_commit"])
  // current_dir: все файлы, forward-slash, BLOCKED_DIRS пропущены.
  expect(scopes[0].files).toContain("a.ts")
  expect(scopes[0].files).toContain("b.ts")
  expect(scopes[0].files).not.toContain("node_modules/pkg/x.js")
  // branch_vs_origin/main: дифф A..B — b.ts и .gitignore, 1 коммит впереди.
  expect(scopes[1].files.sort()).toEqual([".gitignore", "b.ts"])
  expect(scopes[1].description).toContain("1 commits ahead")
  expect(scopes[1].diff).toContain("diff --git")
  // last_commit: дифф HEAD~1..HEAD — те же файлы.
  expect(scopes[2].id).toBe("last_commit")
  expect(scopes[2].files.sort()).toEqual([".gitignore", "b.ts"])
})

test("getScopes: грязное дерево → working_tree первым, с диффом изменений", () => {
  const scopes = getScopes(dirty)
  expect(scopes[0].id).toBe("working_tree")
  expect(scopes[0].files).toContain("a.ts")
  expect(scopes[0].diff).toContain("diff --git")
})

test("resolveScope: точное совпадение, branch_vs_*-префикс, неизвестный → undefined", () => {
  const scopes = getScopes(repo)
  expect(resolveScope(scopes, "current_dir")?.id).toBe("current_dir")
  expect(resolveScope(scopes, "last_commit")?.id).toBe("last_commit")
  // Документированный "branch_vs_main" → реальный "branch_vs_origin/main".
  expect(resolveScope(scopes, "branch_vs_main")?.id).toBe("branch_vs_origin/main")
  // Любой branch_vs_*-префикс матчит веточный скоуп (семейство).
  expect(resolveScope(scopes, "branch_vs_whatever")?.id).toBe("branch_vs_origin/main")
  // Мусорный id — fail-fast у вызывающего.
  expect(resolveScope(scopes, "nope")).toBeUndefined()
  expect(resolveScope([], "branch_vs_main")).toBeUndefined()
})

test("getScopes: git-скоупы получают коммит-историю, current_dir — нет", () => {
  const scopes = getScopes(repo)
  const byId = Object.fromEntries(scopes.map((s) => [s.id, s]))
  // branch: история A..B — формат "%h %s%n%b": короткий хэш + subject.
  expect(byId["branch_vs_origin/main"].commits).toMatch(/^[0-9a-f]{7,} second/)
  // last_commit: fuller-вывод содержит автора.
  expect(byId["last_commit"].commits).toContain("Author:")
  // current_dir — истории нет.
  expect(byId["current_dir"].commits).toBeUndefined()
})

test("getScopes: working_tree в грязном дереве получает недавнюю историю", () => {
  const scopes = getScopes(dirty)
  expect(scopes[0].id).toBe("working_tree")
  expect(scopes[0].commits).toContain("init")
})

test("resolveScope: last_N_commits синтезирует историю", () => {
  const scopes = getScopes(repo)
  const s = resolveScope(scopes, "last_2_commits", repo)
  expect(s?.id).toBe("last_2_commits")
  expect(s?.commits).toContain("init")
  expect(s?.commits).toContain("second")
})
