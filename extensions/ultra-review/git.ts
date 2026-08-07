import { execSync } from "node:child_process"

export function git(cmd: string, cwd: string): string {
  // stderr глушим: ожидаемые сбои (нет ветки, HEAD~1 в первом коммите)
  // обрабатываются try/catch у вызывающих, а не шумят в консоль.
  return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim()
}

/**
 * Достает список файлов из diff.
 * Берем b-сторону (конечное имя): корректно для rename-записей
 * ("a/old b/new", "a/{old => new}.ts", пути с пробелами в кавычках).
 */
export function extractFiles(diff: string): string[] {
  const files = new Set<string>()
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/)
    if (!m) continue
    let path = m[2]
    // rename с фигурными скобками: "src/{old => new}.ts" -> "src/new.ts"
    path = path.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/"/g, "")
    if (path) files.add(path)
  }
  return [...files]
}
