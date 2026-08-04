import { complete, type UserMessage } from "@earendil-works/pi-ai/compat"
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai"
import { Type } from "@sinclair/typebox"
import { extractText, isToolMarkup, makeExecutor, runAgentLoop, type AgentChat, type AgentTurn } from "./agent.ts"
import { EMPTY_RESPONSE_RETRIES, MODEL_MAX_TOKENS, MODEL_TEMPERATURE, RETRY_DELAY_MS, SIMPLIFY_MAX_ITERATIONS, SIMPLIFY_MAX_TOOL_CALLS } from "./constants.ts"
import { buildFallbackReviewPrompt } from "./prompts.ts"
import { retryOnEmpty, retryOnFailure } from "./retry.ts"
import type { PiModelLike, PiRegistryLike } from "./types.ts"

/**
 * Тул read_file: агент-ревьюер сам читает файлы по частям (строками),
 * вместо того чтобы мы вливали весь контент в промпт.
 */
export function makeReadTool(): Tool {
  return {
    name: "read_file",
    description:
      "Read a file from the repository under review. Files can be large: read in chunks with startLine/endLine. Returns the requested lines with numbers and the file's total line count.",
    parameters: Type.Object({
      path: Type.String({ description: "Repository-relative path, e.g. src/engine.ts" }),
      startLine: Type.Optional(Type.Number({ description: "1-based first line (default 1)" })),
      endLine: Type.Optional(Type.Number({ description: "1-based last line (default: first 300 lines)" })),
    }),
  }
}

export function makeSearchTool(): Tool {
  return {
    name: "search_files",
    description:
      "Search the repository for a substring (case-insensitive). Returns up to 20 matches as path:line: snippet plus the total match count. Use it to find existing helpers, duplicates, or similar code anywhere in the repository before flagging reuse or duplication, then read the candidates with read_file.",
    parameters: Type.Object({
      query: Type.String({ description: "Substring to search for (case-insensitive)" }),
      path: Type.Optional(Type.String({ description: "Repository-relative directory or file to restrict the search to (default: repository root)" })),
    }),
  }
}

/**
 * Тул завершения: свободная модель (релей) упорно вызывает тулы и не пишет
 * JSON прозой — вердикт принимаем из аргумента этого тула (структурного или
 * текстового <invoke>).
 */
export function makeSubmitTool(): Tool {
  return {
    name: "submit_review",
    description:
      "Call this to finish the review: pass the COMPLETE final review as a JSON object in the verdict argument. The verdict JSON has the shape described in the review contract. Calling this ends the review.",
    parameters: Type.Object({
      verdict: Type.String({ description: "The complete final review JSON object" }),
    }),
  }
}

/** Per-spec опции агента: simplify получает search_files и больший бюджет. */
export function agentOptionsForSpec(specId: string): { extraTools: Tool[]; maxIterations: number; maxToolCalls: number } {
  if (specId === "simplify") {
    return { extraTools: [makeSearchTool()], maxIterations: SIMPLIFY_MAX_ITERATIONS, maxToolCalls: SIMPLIFY_MAX_TOOL_CALLS }
  }
  return { extraTools: [], maxIterations: 8, maxToolCalls: 30 }
}

/** Один ход диалога через провайдерский слой pi (авторизация pi, нормализация pi). */
export async function chatViaPi(
  registry: PiRegistryLike,
  model: PiModelLike,
  systemPrompt: string,
  messages: unknown[],
  tools: Tool[] | undefined,
  signal?: AbortSignal,
  maxTokens?: number,
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
): Promise<AgentTurn> {
  const fullModel = model as Model<Api>
  const auth = await registry.getApiKeyAndHeaders(fullModel)
  if (!auth.ok) throw new Error(`No credentials for ${model.provider}: ${auth.error ?? "unknown"}`)

  // zen-relay не декларирует supportsReasoningEffort, из-за чего pi-ai молча
  // выбрасывает reasoning_effort и free-модель думает на полную: мышление
  // накапливается в контексте (до 180K токенов) и релей абортит генерацию
  // (502 AbortError). Патчим compat на лету, чтобы reasoning_effert дошёл.
  const effectiveModel = Object.create(Object.getPrototypeOf(fullModel)) as Model<Api>
  Object.assign(effectiveModel, fullModel)
  ;(effectiveModel as { compat?: Record<string, unknown> }).compat = {
    ...((fullModel as { compat?: Record<string, unknown> }).compat ?? {}),
    supportsReasoningEffort: true,
  }

  // Free-tier релей отдаёт разные временные транспортные сбои: 429, 5xx,
  // "Stream ended without finish_reason", "Request timed out.", "fetch failed",
  // upstream-ошибки. Все они ретраятся до 3 раз (не весь агентный цикл — просто
  // повторный вызов complete). 401/403 (авторизация) намеренно НЕ в списке —
  // это постоянная ошибка, ретрай бессмыслен.
  // Ошибка может прийти ДВУМЯ путями: исключение из complete() либо graceful
  // error-ответ (stopReason === "error") — второй путь ретраится здесь же,
  // бросая retryable-ошибку из замыкания, чтобы её подхватил retryOnFailure.
  const isRetryable = (e: unknown) =>
    /429|5\d\d|rate\s*limit|stream ended|timed out|timeout|took too long|fetch failed|upstream|socket|econn|enotfound|network/i.test(
      (e as Error).message ?? "",
    )
  const response = await retryOnFailure(
    `${model.provider}/${model.id}`,
    () =>
      complete(effectiveModel, { systemPrompt, messages: messages as Message[], tools }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        temperature: MODEL_TEMPERATURE,
        maxTokens: maxTokens ?? MODEL_MAX_TOKENS,
        reasoningEffort,
      }).then((r) => {
        if (r.stopReason === "error" && isRetryable(new Error(r.errorMessage ?? ""))) {
          throw new Error(`${model.provider}/${model.id} error: ${r.errorMessage}`)
        }
        return r
      }),
    isRetryable,
    3,
    RETRY_DELAY_MS,
    signal,
  )

  if (response.stopReason === "aborted") throw new Error(`${model.provider}/${model.id} aborted`)
  if (response.stopReason === "error") {
    throw new Error(`${model.provider}/${model.id} error: ${response.errorMessage ?? "unknown"}`)
  }
  return { assistantMessage: response, content: response.content, stopReason: response.stopReason, errorMessage: response.errorMessage }
}

/**
 * Свежий no-tools ревью-фолбэк: агентный цикл прочитал файлы (readResults),
 * но модель так и не выдала вердикт — тул-история держит free-модель в
 * режиме «читать вечно». Отдаём эксцерпты НАПРЯМУЮ в новый диалог без тулов
 * и без тул-истории: модель отвечает полноценным JSON-вердиктом.
 */
async function fallbackReview(
  registry: PiRegistryLike,
  model: PiModelLike,
  readResults: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const excerpts = readResults.join("\n\n---\n\n").slice(0, 60_000)
  if (!excerpts.trim()) return null
  const user = `FILE EXCERPTS (numbered lines):\n\n${excerpts}`
  // Free-модель может ответить пустотой или тул-разметкой даже на свежий
  // no-tools вызов — пробуем до двух раз. Вёрдикт обязан быть JSON'ом.
  for (let attempt = 0; attempt < 2; attempt++) {
    const turn = await chatViaPi(
      registry,
      model,
      buildFallbackReviewPrompt(),
      [{ role: "user", content: [{ type: "text", text: user }] }],
      undefined, // без тулов
      signal,
      32_000, // вердикт с находками
      "low",
    )
    const text = extractText(turn.content)
    // ВРЕМЕННЫЙ дебаг-лог: понять, что реально возвращает free-модель на
    // свежий no-tools вызов (пусто/тул-разметка/вердикт). Убрать после.
    try {
      const { appendFileSync } = await import("node:fs")
      const blocks = (turn.content ?? []) as Array<{ type?: string; text?: string; thinking?: string }>
      const reasoningChars = blocks.filter((c) => c.type === "thinking").reduce((a, c) => a + (c.thinking?.length ?? 0), 0)
      appendFileSync(
        "C:/Users/user/.pi/ultra-review-fallback-debug.log",
        `${new Date().toISOString()} attempt=${attempt} stop=${turn.stopReason} hasToolCalls=${blocks.some((c) => c.type === "toolCall")} contentLen=${text.length} reasoningChars=${reasoningChars} err=${turn.errorMessage ?? ""} preview=${JSON.stringify(text.slice(0, 300))}\n`,
      )
    } catch {}
    if (text && !isToolMarkup(text)) return text
  }
  return null
}

export async function judgeViaPi(
  registry: PiRegistryLike,
  model: PiModelLike,
  prompt: string,
  signal?: AbortSignal,
  attempts = 2,
): Promise<{ text: string }> {
  const user = "Emit your JSON verdict now — exactly the schema from the prompt."
  // Свежий no-tools вызов: у судьи нет тулов, спираль невозможна, мышление low.
  for (let i = 0; i < attempts; i++) {
    try {
      const turn = await chatViaPi(
        registry,
        model,
        prompt,
        [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
        undefined, // без тулов
        signal,
        32_000, // verdicts[] может быть большим при множестве находок
        "low",
      )
      const text = extractText(turn.content)
      if (text && !isToolMarkup(text)) return { text }
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  return { text: "" }
}

/**
 * Полный агентный прогон ревью: модель сама читает файлы из репозитория
 * (root) через read_file и выносит вердикт. Пустой итог ретраится.
 * Фолбэка без тулов НЕТ: если провайдер/модель не поддерживает тулы —
 * задача падает с явной ошибкой (в отчёте — failed + текст ошибки).
 */
export async function runAgent(
  registry: PiRegistryLike,
  model: PiModelLike,
  prompt: string,
  root: string,
  signal?: AbortSignal,
  opts: { extraTools?: Tool[]; maxIterations?: number; maxToolCalls?: number } = {},
): Promise<{ text: string; toolCalls: number; readFiles: string[] }> {
  const label = `${model.provider}/${model.id}`
  const tools: Tool[] = [makeReadTool(), makeSubmitTool(), ...(opts.extraTools ?? [])]
  const initialMessages: UserMessage[] = [
    { role: "user", content: [{ type: "text", text: "Review the files in scope and output your verdict." }], timestamp: Date.now() },
  ]
  const readFiles = new Set<string>()
  const executor = makeExecutor(root, readFiles)

  let toolCalls = 0
  const attempt = async (): Promise<string> => {
    const chat: AgentChat = (messages, toolsList, s) =>
      chatViaPi(registry, model, prompt, messages, toolsList as Tool[], s, undefined, "low")
    const loop = await runAgentLoop(chat, initialMessages, tools, executor, {
      maxIterations: opts.maxIterations ?? 8,
      maxToolCalls: opts.maxToolCalls ?? 30,
    }, signal)
    toolCalls = loop.toolCalls
    // Финальный текст — не вердикт (тул-спираль/пусто)? Тогда свежий no-tools
    // ревью-фолбэк по прочитанным эксцерптам. Диагностика подтвердила: free-
    // модель отлично ревьюит, когда ей дают содержимое напрямую и без тулов.
    if (isToolMarkup(loop.text) || !loop.text.trim() || !loop.text.includes('"findings"')) {
      const fresh = await fallbackReview(registry, model, loop.readResults, signal)
      if (fresh) return fresh
    }
    return loop.text
  }

  let text: string
  try {
    text = await retryOnEmpty(label, attempt, EMPTY_RESPONSE_RETRIES, RETRY_DELAY_MS, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    // Провайдер мог не принять tools или модель упала — без тихого деграда,
    // задача уйдёт в failed с понятной причиной.
    throw new Error(`${label} agent call failed (read_file): ${(err as Error).message}`)
  }
  return { text, toolCalls, readFiles: [...readFiles] }
}
