import { createAgentSession, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { BLOCKED_DIRS, readFileSafely, searchFilesSafely } from "./agent.ts"
import { REASONING_EFFORT } from "./constants.ts"
import type { PiModelLike } from "./types.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Ревью на агентном рантайме pi: вместо ручного цикла «модель → тул → модель»
// (который мы писали сами) используем createAgentSession из SDK. pi сам
// крутит цикл, исполняет тулы, ретраит сбои и обрывы, ограничивает
// зацикливание. Мы передаём только свои песочные тулы (read_file/search_files)
// — системных (bash и т.п.) ревьюер не получает.
// ─────────────────────────────────────────────────────────────────────────────

let modelRuntimePromise: Promise<ModelRuntime> | undefined

function getModelRuntime(): Promise<ModelRuntime> {
  // Один рантайм на процесс: читает те же auth.json/models.json, что и pi.
  if (!modelRuntimePromise) modelRuntimePromise = ModelRuntime.create()
  return modelRuntimePromise
}

/** Минимальный загрузчик: только наш системный промпт, без расширений/скиллов. */
async function makeLoader(systemPrompt: string): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: "~/.pi/agent",
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt,
  })
  // reload() обязателен ДО createAgentSession: без await сессия прочитала бы
  // пустой системный промпт (в smoke-тесте модель не видела манифест файлов).
  await loader.reload()
  return loader
}

const VERDICT_RE = /^\{[\s\S]*"findings"[\s\S]*\}$/

/** Текст из последнего assistant-сообщения сессии. */
function lastAssistantText(session: AgentSession): string {
  const messages = session.agent.state.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const content = m.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

/** Создаёт сессию с нашими тулами и гоняет один прогон ревью. */
async function runSession(
  model: PiModelLike,
  systemPrompt: string,
  root: string,
  signal: AbortSignal | undefined,
  opts: { search?: boolean },
): Promise<{ text: string; toolCalls: number; readFiles: string[] }> {
  const readFiles = new Set<string>()
  let toolCalls = 0
  // Страховка от зацикливания поверх собственного guard'а pi: бюджет вызовов тулов.
  let budget = 40

  const readTool = defineTool({
    name: "read_file",
    label: "Read file",
    description: "Read a file from the repository under review. Files can be large: read in chunks with startLine/endLine. Returns the requested lines with numbers and the file's total line count.",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative path, e.g. src/engine.ts" }),
      startLine: Type.Optional(Type.Number({ description: "1-based first line (default 1)" })),
      endLine: Type.Optional(Type.Number({ description: "1-based last line" })),
    }),
    execute: async (_id, params: { path?: unknown; startLine?: unknown; endLine?: unknown }) => {
      if (budget-- <= 0) {
        return { content: [{ type: "text", text: "ERROR: read budget reached. Output your final verdict now based on what you have read." }], details: {}, terminate: true }
      }
      const path = String(params.path ?? "")
      const res = await readFileSafely(root, path, params.startLine as number | undefined, params.endLine as number | undefined)
      if (res.ok && path) readFiles.add(path.replace(/\\/g, "/").replace(/^\.\//, ""))
      return {
        content: [{ type: "text", text: res.ok ? res.text : `ERROR: ${res.error}` }],
        details: { isError: !res.ok },
      }
    },
  })

  const searchTool = defineTool({
    name: "search_files",
    label: "Search files",
    description: "Search the repository for a substring (case-insensitive). Returns up to 20 matches as path:line: snippet plus the total match count. Use it to find existing helpers, duplicates, or similar code anywhere in the repository before flagging reuse or duplication, then read the candidates with read_file.",
    parameters: Type.Object({
      query: Type.String({ description: "Substring to search for (case-insensitive)" }),
      path: Type.Optional(Type.String({ description: "Repository-relative directory or file to restrict the search to (default: repository root)" })),
    }),
    execute: async (_id, params: { query?: unknown; path?: unknown }) => {
      if (budget-- <= 0) {
        return { content: [{ type: "text", text: "ERROR: search budget reached. Output your final verdict now based on what you have." }], details: {}, terminate: true }
      }
      const query = String(params.query ?? "")
      const path = params.path === undefined ? undefined : String(params.path)
      const res = await searchFilesSafely(root, query, path)
      return {
        content: [{ type: "text", text: res.ok ? res.text : `ERROR: ${res.error}` }],
        details: { isError: !res.ok },
      }
    },
  })

  const tools = opts.search ? [readTool, searchTool] : [readTool]
  const runtime = await getModelRuntime()
  const resourceLoader = await makeLoader(systemPrompt)

  const { session } = await createAgentSession({
    cwd: root,
    modelRuntime: runtime,
    model: runtime.getModel(model.provider, model.id),
    thinkingLevel: REASONING_EFFORT,
    // ТОЛЬКО наши тулы: системные (read, bash, edit, write) не включаем.
    tools: tools.map((t) => t.name),
    customTools: tools,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  })

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") toolCalls++
  })

  // Отмена ревью прерывает сессию: иначе abort-сигнал игнорировался бы
  // и задача продолжала крутить модель впустую.
  const onAbort = () => {
    void session.abort()
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    await session.prompt("Review the files in scope and output your verdict.")
    let text = lastAssistantText(session)
    // Вердикт — цельный JSON с "findings". Если модель ответила прозой или
    // разметкой — один followUp-запрос вердикта (pi сам обработает ответ).
    if (text && !VERDICT_RE.test(text.trim())) {
      await session.followUp("Output the final review verdict as a single JSON object with a findings array. Do not write tool calls.")
      text = lastAssistantText(session)
    }
    return { text, toolCalls, readFiles: [...readFiles] }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    session.dispose()
  }
}

/** Ревью-задача: модель читает файлы через read_file и выносит вердикт. */
export async function runAgent(
  model: PiModelLike,
  prompt: string,
  root: string,
  signal?: AbortSignal,
  opts: { search?: boolean } = {},
): Promise<{ text: string; toolCalls: number; readFiles: string[] }> {
  try {
    return await runSession(model, prompt, root, signal, opts)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(`${model.provider}/${model.id} agent call failed: ${(err as Error).message}`)
  }
}

/** Судья: тот же рантайм, но без тулов — только JSON-вердикт по находкам. */
export async function judgeViaPi(
  model: PiModelLike,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const runtime = await getModelRuntime()
  const resourceLoader = await makeLoader(prompt)
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    modelRuntime: runtime,
    model: runtime.getModel(model.provider, model.id),
    thinkingLevel: REASONING_EFFORT,
    noTools: "all",
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
  })
  const onAbort = () => {
    void session.abort()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    await session.prompt("Emit your JSON verdict now — exactly the schema from the prompt.")
    return { text: lastAssistantText(session) }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    session.dispose()
  }
}

// BLOCKED_DIRS используется песочницей чтения — держим реэкспорт для тестов.
export { BLOCKED_DIRS }
