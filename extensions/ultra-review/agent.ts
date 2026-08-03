import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// Агентный слой: ревьюер читает файлы сам, по частям, через read_file.
// Модуль не зависит от pi-ai (тестируется в bun).
// ─────────────────────────────────────────────────────────────────────────────

export type ReadResult = { ok: true; text: string } | { ok: false; error: string }

const BLOCKED_DIRS = new Set([
  ".git", "node_modules", ".pi", "reviews", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".idea", ".next", "target", ".cache",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".eggs",
])
const MAX_FILE_BYTES = 100 * 1024
const DEFAULT_CHUNK = 500
// Суммарный объём результатов чтения в истории агента: больше — контекст
// раздувается на каждой итерации, слабые модели начинают сыпаться.
const MAX_AGENT_CONTEXT_CHARS = 150_000
const MAX_SEARCH_MATCHES = 20
const MAX_SEARCH_RESULT_CHARS = 8 * 1024
const MAX_QUERY_LEN = 200
const SNIPPET_LEN = 120

/**
 * Чтение файла в песочнице репозитория:
 * - путь обязан остаться внутри root (.. и абсолютные пути блокируются);
 * - заблокированы служебные каталоги (.git, node_modules, .pi, reviews, ...);
 * - бинарники и файлы > 100 КБ не читаются;
 * - по умолчанию возвращаются первые 300 строк с номерами + подсказка о чанках.
 */
export async function readFileSafely(root: string, path: string, startLine?: number, endLine?: number): Promise<ReadResult> {
  // Симлинк-защита: resolve()/relative() — лексика, а stat/readFile идут по
  // симлинкам. Прогоняем оба пути через realpath и проверяем СОДЕРЖАНИЕ
  // (real-путь) внутри real-root — иначе симлинк evil -> ~/.ssh/id_rsa
  // внутри репо вытащит наружу секреты.
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return { ok: false, error: `repo root unavailable: ${root}` }
  }

  const resolved = resolve(root, path)
  let real: string
  try {
    real = await realpath(resolved)
  } catch {
    return { ok: false, error: `cannot resolve: ${path}` }
  }

  const realRel = relative(realRoot, real)
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    return { ok: false, error: `path escapes repo root (symlink?): ${path}` }
  }
  if (realRel.split(/[\\/]/).some((s) => BLOCKED_DIRS.has(s))) {
    return { ok: false, error: `path blocked: ${realRel}` }
  }

  let st
  try {
    st = await stat(real)
  } catch {
    return { ok: false, error: `cannot stat: ${realRel}` }
  }
  if (st.size === 0) return { ok: true, text: `${realRel} (empty file)` }
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, error: `file too large (${Math.round(st.size / 1024)} KB > 100 KB)` }
  }

  let content: string
  try {
    content = await readFile(real, "utf-8")
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}` }
  }
  if (content.includes("\u0000")) return { ok: false, error: `binary file: ${realRel}` }

  const lines = content.split("\n")
  const start = Math.max(1, startLine ?? 1)
  let end = Math.min(lines.length, endLine ?? (startLine ? start + DEFAULT_CHUNK - 1 : DEFAULT_CHUNK))
  if (start > end) end = start
  const slice = lines.slice(start - 1, end)

  const width = String(end).length
  const body = slice.map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join("\n")
  const more = lines.length - end
  const hint = more > 0 ? `\n…[${more} more lines; file has ${lines.length} total — read with startLine/endLine]` : ""
  return { ok: true, text: `${realRel} (${lines.length} lines)\n${body}${hint}` }
}

/**
 * Grep-поиск по репозиторию (подстрока, case-insensitive). Песочница как у
 * readFileSafely: realpath-контейнмент фильтра, BLOCKED_DIRS, пропуск
 * симлинков (не ходим за root), бинарников и файлов > 100 КБ.
 * Возвращает до MAX_SEARCH_MATCHES совпадений path:line: snippet.
 */
export async function searchFilesSafely(root: string, query: string, pathFilter?: string): Promise<ReadResult> {
  const q = query.trim().toLowerCase()
  if (!q) return { ok: false, error: "query required" }
  if (q.length > MAX_QUERY_LEN) return { ok: false, error: `query too long (> ${MAX_QUERY_LEN} chars)` }

  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    return { ok: false, error: `repo root unavailable: ${root}` }
  }

  // Фильтр-поддерево: тот же контейнмент, что у read_file.
  let filterReal: string | null = null
  let filterIsFile = false
  if (pathFilter) {
    let real: string
    try {
      real = await realpath(resolve(root, pathFilter))
    } catch {
      return { ok: false, error: `cannot resolve: ${pathFilter}` }
    }
    const rel = relative(realRoot, real)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, error: `path escapes repo root (symlink?): ${pathFilter}` }
    }
    filterReal = real
    try {
      filterIsFile = (await stat(real)).isFile()
    } catch {
      return { ok: false, error: `cannot stat: ${pathFilter}` }
    }
  }

  const matches: Array<{ path: string; line: number; snippet: string }> = []
  let total = 0
  let shown = 0

  const addFile = async (abs: string, relPath: string) => {
    let st
    try {
      st = await stat(abs)
    } catch {
      return
    }
    if (st.size > MAX_FILE_BYTES) return
    let content: string
    try {
      content = await readFile(abs, "utf-8")
    } catch {
      return
    }
    if (content.includes("\u0000")) return
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(q)) continue
      total++
      if (shown >= MAX_SEARCH_MATCHES) continue
      shown++
      matches.push({ path: relPath.split(/[\\/]/).join("/"), line: i + 1, snippet: lines[i].trim().slice(0, SNIPPET_LEN) })
    }
  }

  const walk = async (abs: string, relPath: string) => {
    // Пропускаем поддеревья, которые не содержат фильтр и не лежат внутри него:
    // идём по пути от root вниз до filterReal, дальше — только внутри filterReal.
    if (filterReal && abs !== filterReal && !filterReal.startsWith(abs + "/") && !filterReal.startsWith(abs + "\\") && !abs.startsWith(filterReal + "/") && !abs.startsWith(filterReal + "\\")) return
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue // не ходим по симлинкам за root
      const childAbs = join(abs, e.name)
      const childRel = join(relPath, e.name)
      if (e.isDirectory()) {
        if (BLOCKED_DIRS.has(e.name)) continue
        await walk(childAbs, childRel)
      } else if (e.isFile()) {
        await addFile(childAbs, childRel)
      }
    }
  }

  if (filterReal && filterIsFile) {
    // Файловый фильтр минует walk: контейнмент проверяется напрямую, как в
    // readFileSafely — включая BLOCKED_DIRS по сегментам относительного пути.
    const filterRel = relative(realRoot, filterReal)
    if (filterRel.split(/[\\/]/).some((s) => BLOCKED_DIRS.has(s))) {
      return { ok: false, error: `path blocked: ${filterRel}` }
    }
    await addFile(filterReal, filterRel.split(/[\\/]/).join("/"))
  } else {
    await walk(realRoot, "")
  }

  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
  const lines = [`search: "${query}" — ${total} match(es)${total > matches.length ? `, showing first ${matches.length}` : ""}`]
  for (const m of matches) {
    const line = `${m.path}:${m.line}: ${m.snippet}`
    if (lines.join("\n").length + line.length + 1 > MAX_SEARCH_RESULT_CHARS) break
    lines.push(line)
  }
  return { ok: true, text: lines.join("\n") }
}

// ─────────────────────────────────────────────────────────────────────────────
// Тул-цикл: chat может быть вызван несколько раз, между вызовами модель
// получает результаты read_file и решает, читать дальше или выносить вердикт.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Диспетчер тулов агента: read_file (с записью прочитанных путей для
 * валидации находок) и search_files (только для simplify-спека).
 */
export function makeExecutor(root: string, readFiles: Set<string>): AgentExecutor {
  return async (call) => {
    const args = call.arguments ?? {}
    const name = call.name ?? ""
    if (name === "search_files") {
      const query = String(args.query ?? "")
      const path = args.path === undefined ? undefined : String(args.path)
      return searchFilesSafely(root, query, path)
    }
    const path = String(args.path ?? "")
    if (path) readFiles.add(path)
    return readFileSafely(root, path, args.startLine as number | undefined, args.endLine as number | undefined)
  }
}

export interface AgentToolCall {
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}
export interface AgentTurn {
  /** Полное assistant-сообщение — подаётся обратно в историю как есть. */
  assistantMessage: unknown
  content: unknown[]
  stopReason?: string
  errorMessage?: string
}
export type AgentChat = (messages: unknown[], tools: unknown[], signal?: AbortSignal) => Promise<AgentTurn>
export type AgentExecutor = (call: AgentToolCall) => Promise<ReadResult>

export interface AgentLoopResult {
  text: string
  iterations: number
  toolCalls: number
}

export function extractText(content: unknown[]): string {
  return content
    .filter((e): e is { text: string } => typeof e === "object" && e !== null && typeof (e as { text?: unknown }).text === "string")
    .map((e) => e.text)
    .join("\n")
    .trim()
}

// Иногда (free-тир через релей) модель не возвращает тулы структурно — она
// печатает их ТЕКСТОМ в Anthropic-нотации `<invoke name="read_file">` c
// `<parameter name="path">./x</parameter>`. extractToolCalls их не видел, цикл
// завершался без чтения и без вердикта → "malformed". Распознаём и исполняем.
let textToolCallId = 0

function parseInvokeToolCalls(text: string): AgentToolCall[] {
  const out: AgentToolCall[] = []
  const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi
  for (const m of text.matchAll(invokeRe)) {
    const name = m[1]
    const body = m[2]
    const args: Record<string, unknown> = {}
    // Модель пишет параметры двумя способами, с любыми доп. атрибутами:
    //   <parameter name="path" string="true">.swarm/x</parameter>  — вложенный
    //   <parameter name="startLine" value="1"/>                 — атрибут
    const paramRe = /<parameter\s+name="([^"]+)"\s*([^>]*)>/gi
    for (const mm of body.matchAll(paramRe)) {
      const pname = mm[1]
      const attrs = mm[2]
      const valAttr = /value="([^"]*)"/.exec(attrs)
      if (valAttr) {
        args[pname] = valAttr[1]
        continue
      }
      const rest = body.slice(mm.index + mm[0].length)
      const endM = /<\/parameter\s*>/i.exec(rest)
      if (endM) args[pname] = rest.slice(0, endM.index).trim()
    }
    out.push({ id: `text-${++textToolCallId}`, name, arguments: args })
  }
  return out
}

export function extractToolCalls(content: unknown[]): AgentToolCall[] {
  const structured = content.filter((e): e is AgentToolCall => {
    if (typeof e !== "object" || e === null) return false
    const c = e as { type?: unknown; name?: unknown; arguments?: unknown }
    return c.type === "toolCall" || (typeof c.name === "string" && typeof c.arguments === "object" && c.arguments !== null)
  })
  // Структурные тулы предпочтительнее; только если их нет — ищем текстовые
  // <invoke> в текстовых блоках (релей не отдал тулы структурно).
  if (structured.length > 0) return structured
  const textual: AgentToolCall[] = []
  for (const e of content) {
    if (typeof e !== "object" || e === null) continue
    const t = (e as { text?: unknown }).text
    if (typeof t === "string") textual.push(...parseInvokeToolCalls(t))
  }
  return textual
}

/**
 * Многошаговый диалог с моделью:
 * - вызывает chat, пока модель не перестанет запрашивать тулы;
 * - исполняет запросы read_file (параллельно) и возвращает результаты модели;
 * - жёстко ограничен: maxIterations итераций, maxToolCalls чтений,
 *   maxContextChars накопленного контекста;
 * - на последней итерации тулы убираются (модель обязана ответить), если
 *   финальный текст пуст — один nudging-вызов вместо рестарта всего цикла.
 * Рестарт всего цикла на пустом ответе — главная причина "очень длинных"
 * прогонов: каждая попытка заново читает все файлы.
 */
export async function runAgentLoop(
  chat: AgentChat,
  initialMessages: unknown[],
  tools: unknown[],
  execute: AgentExecutor,
  opts: { maxIterations?: number; maxToolCalls?: number; maxContextChars?: number } = {},
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? 6
  const maxToolCalls = opts.maxToolCalls ?? 30
  const maxContextChars = opts.maxContextChars ?? MAX_AGENT_CONTEXT_CHARS
  const messages = [...initialMessages]
  let toolCalls = 0
  let contextChars = 0
  let forceFinish = false
  let text = ""

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Последняя итерация (или исчерпанный бюджет) — без тулов: модель обязана ответить.
    const isLast = iteration === maxIterations - 1 || forceFinish
    const turn = await chat(messages, isLast ? [] : tools, signal)
    const calls = extractToolCalls(turn.content)
    const textPart = extractText(turn.content)
    if (textPart) text = textPart

    if (calls.length === 0) {
      return { text: textPart || text, iterations: iteration + 1, toolCalls }
    }
    if (isLast) {
      // Модель всё ещё просит тулы, хотя их больше нет — уходим к nudging-финалу.
      // Отвечаем КАЖДОМУ реальному tool_call: апстрим валидирует, что у каждого
      // assistant tool_call есть tool-ответ (фейковый id "limit" это ломает).
      messages.push(turn.assistantMessage)
      for (const c of calls) {
        messages.push({
          role: "toolResult",
          toolCallId: c.id ?? "tool",
          toolName: c.name ?? "tool",
          content: [{ type: "text", text: "No more tool calls allowed. Output your final verdict now." }],
          isError: true,
          timestamp: Date.now(),
        })
      }
      break
    }

    toolCalls += calls.length
    messages.push(turn.assistantMessage)
    if (toolCalls > maxToolCalls || contextChars > maxContextChars) {
      forceFinish = true
      // Тот же протокол: отвечаем каждому реальному tool_call, а не одному
      // фейковому id — иначе апстрим отклоняет историю сообщений целиком.
      for (const c of calls) {
        messages.push({
          role: "toolResult",
          toolCallId: c.id ?? "tool",
          toolName: c.name ?? "tool",
          content: [{ type: "text", text: "Read budget reached. Output your final verdict now based on what you have." }],
          isError: true,
          timestamp: Date.now(),
        })
      }
      continue
    }

    const results = await Promise.all(calls.map(async (c) => ({ c, res: await execute(c) })))
    for (const { c, res } of results) {
      const payload = res.ok ? res.text : `ERROR: ${res.error}`
      contextChars += payload.length
      messages.push({
        role: "toolResult",
        toolCallId: c.id ?? "tool",
        toolName: c.name ?? "read_file",
        content: [{ type: "text", text: payload }],
        isError: !res.ok,
        timestamp: Date.now(),
      })
    }
  }

  // Финальный nudging-вызов без тулов вместо рестарта всего цикла.
  if (!text.trim()) {
    const nudge = await chat(
      [...messages, { role: "user", content: [{ type: "text", text: "Output your final verdict JSON now based on what you have read." }], timestamp: Date.now() }],
      [],
      signal,
    )
    text = extractText(nudge.content)
  }
  return { text, iterations: maxIterations, toolCalls }
}
