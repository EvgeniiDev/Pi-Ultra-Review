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
 * "branch_vs_origin/main"); для last_N_commits синтезируем дифф HEAD~N..HEAD
 * на лету. Неизвестный id → undefined (fail-fast у вызывающего).
 */
export function resolveScope(scopes: Scope[], scopeId: string, cwd?: string): Scope | undefined {
  const exact = scopes.find((s) => s.id === scopeId)
  if (exact) return exact
  if (scopeId.startsWith("branch_vs_")) {
    const b = scopes.find((s) => s.id.startsWith("branch_vs_"))
    if (b) return b
  }
  const m = /^last_(\d+)_commits$/.exec(scopeId)
  if (m && cwd) {
    try {
      // HEAD~N не резолвится, когда история короче N коммитов (HEAD~N за корнем):
      // тогда дифф считаем от пустого дерева — это «все коммиты истории».
      let diff: string
      try {
        diff = git(`git diff HEAD~${m[1]} HEAD`, cwd)
      } catch {
        diff = git("git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD", cwd)
      }
      if (diff) {
        return {
          id: scopeId,
          label: `Last ${m[1]} commits`,
          description: `files changed in the last ${m[1]} commits`,
          files: extractFiles(diff),
          diff,
          commits: commitHistory(cwd, `git log -${m[1]} --pretty=format:"%h %s%n%b"`),
        }
      }
    } catch {}
  }
  return undefined
}

/** Коммит-история для скоупа: undefined, если git её не дал (нет истории). */
function commitHistory(cwd: string, cmd: string): string | undefined {
  try {
    const out = git(cmd, cwd)
    return out || undefined
  } catch {
    return undefined
  }
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
        commits: commitHistory(cwd, 'git log -10 --pretty=format:"%h %s"'),
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
          commits: commitHistory(cwd, `git log --max-count=150 --pretty=format:"%h %s%n%b" ${base}..HEAD`),
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
        commits: commitHistory(cwd, "git show -s --format=fuller HEAD"),
      })
    }
  } catch {}
  return scopes
}
