import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { BLOCKED_DIRS } from "./agent.ts"
import { extractFiles, git } from "./git.ts"
import type { Scope } from "./types.ts"

function walkFiles(dir: string, root: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (BLOCKED_DIRS.has(entry.name)) continue
      walkFiles(join(dir, entry.name), root, out)
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)).replace(/\\/g, "/"))
    }
  }
}

/**
 * Резолв scopeId в скоуп: точное совпадение; для семейства branch_vs_*
 * принимаем любой префикс (задокументированный "branch_vs_main" → реальный
 * "branch_vs_origin/main"). Неизвестный id → undefined (fail-fast у вызывающего).
 */
export function resolveScope(scopes: Scope[], scopeId: string): Scope | undefined {
  return (
    scopes.find((s) => s.id === scopeId) ??
    (scopeId.startsWith("branch_vs_") ? scopes.find((s) => s.id.startsWith("branch_vs_")) : undefined)
  )
}

/**
 * Скоупы — это манифесты файлов (плюс git-диф для git-скоупов).
 * Контент файлов агент-ревьюеры читают сами через read_file, по частям.
 */
export function getScopes(cwd: string): Scope[] {
  const scopes: Scope[] = []
  try {
    const status = git("git status --porcelain", cwd)
    if (status) {
      const diff = git("git diff HEAD", cwd)
      scopes.push({
        id: "working_tree",
        label: "Working tree",
        description: `${status.split("\n").length} changes`,
        files: extractFiles(diff),
        diff,
      })
    }
  } catch {}

  try {
    const files: string[] = []
    walkFiles(cwd, cwd, files)
    files.sort()
    if (files.length > 0) {
      scopes.push({
        id: "current_dir",
        label: "Current dir",
        description: `${files.length} files, agent reads on demand`,
        files,
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
          files: extractFiles(diff),
          diff,
        })
        break
      }
    } catch {}
  }

  // Скоуп последнего коммита: задокументирован в схеме тула, но не генерировался.
  try {
    git("git rev-parse --verify --quiet HEAD", cwd)
    const diff = git("git diff HEAD~1 HEAD", cwd)
    if (diff) {
      scopes.push({
        id: "last_commit",
        label: "Last commit",
        description: "files changed in HEAD",
        files: extractFiles(diff),
        diff,
      })
    }
  } catch {}
  return scopes
}
