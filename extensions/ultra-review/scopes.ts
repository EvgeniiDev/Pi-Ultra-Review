import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { MAX_DIFF_CHARS } from "./constants.ts"
import { git } from "./git.ts"
import type { Scope } from "./types.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Скоупы
// ─────────────────────────────────────────────────────────────────────────────

export function getScopes(cwd: string): Scope[] {
  const scopes: Scope[] = []
  try {
    const status = git("git status --porcelain", cwd)
    if (status) {
      scopes.push({
        id: "working_tree",
        label: "Working tree",
        description: `${status.split("\n").length} changes`,
        diff: git("git diff HEAD", cwd),
      })
    }
  } catch {}

  // Полное содержимое текущей директории (не зависит от git)
  try {
    const diff = buildDirDiff(cwd)
    if (diff) {
      scopes.push({
        id: "current_dir",
        label: "Current dir",
        description: `Full directory contents (${(diff.length / 1024).toFixed(0)} KB)`,
        diff,
      })
    }
  } catch {}

  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    try {
      git(`git rev-parse --verify --quiet ${base}`, cwd)
      const diff = git(`git diff ${base}..HEAD`, cwd)
      if (diff) {
        scopes.push({
          id: `branch_vs_${base}`,
          label: `Branch vs ${base}`,
          description: `${git(`git rev-list --count ${base}..HEAD`, cwd)} commits ahead`,
          diff,
        })
        break
      }
    } catch {}
  }
  return scopes
}

// ─────────────────────────────────────────────────────────────────────────────
// Current dir: весь каталог как псевдо-diff (каждый файл = "new file")
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".pi", "reviews", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".idea", ".next", "target", ".cache",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".eggs",
])
const MAX_FILE_BYTES = 200 * 1024
// Чуть больше лимита промпта, чтобы buildPrompt сработал [DIFF TRUNCATED]
const MAX_TOTAL_CHARS = MAX_DIFF_CHARS * 2

function walkFiles(dir: string, root: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkFiles(join(dir, entry.name), root, out)
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)).replace(/\\/g, "/"))
    }
  }
}

export function buildDirDiff(cwd: string): string {
  const files: string[] = []
  walkFiles(cwd, cwd, files)
  files.sort()

  const chunks: string[] = []
  let total = 0
  for (const rel of files) {
    const p = join(cwd, rel)
    let stat
    try {
      stat = statSync(p)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue

    let content: string
    try {
      content = readFileSync(p, "utf-8")
    } catch {
      continue
    }
    if (content.includes("\u0000")) continue // бинарник

    const lines = content.split("\n")
    const diff = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`
    if (total + diff.length > MAX_TOTAL_CHARS) break
    chunks.push(diff)
    total += diff.length
  }
  return chunks.join("\n")
}
