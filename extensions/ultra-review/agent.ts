import { readFile, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

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
const DEFAULT_CHUNK = 300

/**
 * Чтение файла в песочнице репозитория:
 * - путь обязан остаться внутри root (.. и абсолютные пути блокируются);
 * - заблокированы служебные каталоги (.git, node_modules, .pi, reviews, ...);
 * - бинарники и файлы > 100 КБ не читаются;
 * - по умолчанию возвращаются первые 300 строк с номерами + подсказка о чанках.
 */
export async function readFileSafely(root: string, path: string, startLine?: number, endLine?: number): Promise<ReadResult> {
  const resolved = resolve(root, path)
  const rel = relative(root, resolved)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `path escapes repo root: ${path}` }
  }
  const segs = rel.split(/[\\/]/)
  if (segs.some((s) => BLOCKED_DIRS.has(s))) {
    return { ok: false, error: `path blocked: ${rel}` }
  }

  let st
  try {
    st = await stat(resolved)
  } catch {
    return { ok: false, error: `cannot stat: ${rel}` }
  }
  if (st.size === 0) return { ok: true, text: `${rel} (empty file)` }
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, error: `file too large (${Math.round(st.size / 1024)} KB > 100 KB)` }
  }

  let content: string
  try {
    content = await readFile(resolved, "utf-8")
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}` }
  }
  if (content.includes("\u0000")) return { ok: false, error: `binary file: ${rel}` }

  const lines = content.split("\n")
  let start = Math.max(1, startLine ?? 1)
  let end = Math.min(lines.length, endLine ?? (startLine ? start + DEFAULT_CHUNK - 1 : DEFAULT_CHUNK))
  if (start > end) end = start
  const slice = lines.slice(start - 1, end)

  const width = String(end).length
  const body = slice.map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join("\n")
  const more = lines.length - end
  const hint = more > 0 ? `\n…[${more} more lines; file has ${lines.length} total — read with startLine/endLine]` : ""
  return { ok: true, text: `${rel} (${lines.length} lines)\n${body}${hint}` }
}

// ─────────────────────────────────────────────────────────────────────────────
// Тул-цикл: chat может быть вызван несколько раз, между вызовами модель
// получает результаты read_file и решает, читать дальше или выносить вердикт.
// ─────────────────────────────────────────────────────────────────────────────

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

export function extractToolCalls(content: unknown[]): AgentToolCall[] {
  return content.filter((e): e is AgentToolCall => {
    if (typeof e !== "object" || e === null) return false
    const c = e as { type?: unknown; name?: unknown; arguments?: unknown }
    return c.type === "toolCall" || (typeof c.name === "string" && typeof c.arguments === "object" && c.arguments !== null)
  })
}

/**
 * Многошаговый диалог с моделью:
 * - вызывает chat, пока модель не перестанет запрашивать тулы;
 * - исполняет запросы read_file (параллельно) и возвращает результаты модели;
 * - ограничен по итерациям (maxIterations) и общему числу чтений (maxToolCalls);
 * - если лимит исчерпан — возвращает накопленный текст.
 */
export async function runAgentLoop(
  chat: AgentChat,
  initialMessages: unknown[],
  tools: unknown[],
  execute: AgentExecutor,
  opts: { maxIterations?: number; maxToolCalls?: number } = {},
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? 8
  const maxToolCalls = opts.maxToolCalls ?? 30
  const messages = [...initialMessages]
  let toolCalls = 0
  let text = ""

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const turn = await chat(messages, tools, signal)
    const calls = extractToolCalls(turn.content)
    const textPart = extractText(turn.content)
    if (textPart) text = textPart

    if (calls.length === 0) return { text, iterations: iteration + 1, toolCalls }

    toolCalls += calls.length
    messages.push(turn.assistantMessage)
    if (toolCalls > maxToolCalls) {
      messages.push({
        role: "toolResult",
        toolCallId: "limit",
        toolName: "read_file",
        content: [{ type: "text", text: "Tool call limit reached. Finish with your verdict based on what you have read." }],
        isError: true,
        timestamp: Date.now(),
      })
      continue
    }

    const results = await Promise.all(
      calls.map(async (c) => ({ c, res: await execute(c) })),
    )
    for (const { c, res } of results) {
      messages.push({
        role: "toolResult",
        toolCallId: c.id ?? "tool",
        toolName: c.name ?? "read_file",
        content: res.ok ? [{ type: "text", text: res.text }] : [{ type: "text", text: `ERROR: ${res.error}` }],
        isError: !res.ok,
        timestamp: Date.now(),
      })
    }
  }
  return { text, iterations: maxIterations, toolCalls }
}
