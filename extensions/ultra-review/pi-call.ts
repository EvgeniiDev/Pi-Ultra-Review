import { complete, type UserMessage } from "@earendil-works/pi-ai/compat"
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai"
import { Type } from "@sinclair/typebox"
import { extractText, isToolMarkup, makeExecutor, runAgentLoop, MAX_AGENT_CONTEXT_CHARS, type AgentChat, type AgentTurn } from "./agent.ts"
import { EMPTY_RESPONSE_RETRIES, MAX_AGENT_ITERATIONS, MAX_AGENT_TOOL_CALLS, MODEL_MAX_TOKENS, MODEL_TEMPERATURE, REASONING_EFFORT, RETRY_DELAY_MS, SIMPLIFY_MAX_ITERATIONS, SIMPLIFY_MAX_TOOL_CALLS } from "./constants.ts"
import { retryOnEmpty, retryOnFailure } from "./retry.ts"
import type { PiModelLike, PiRegistryLike, ReasoningEffort } from "./types.ts"

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
      endLine: Type.Optional(Type.Number({ description: "1-based last line (default: first 500 lines)" })),
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

/** Per-spec опции агента: simplify получает search_files; бюджеты — единые константы. */
export function agentOptionsForSpec(specId: string): { extraTools: Tool[]; maxIterations: number; maxToolCalls: number } {
  if (specId === "simplify") {
    return { extraTools: [makeSearchTool()], maxIterations: SIMPLIFY_MAX_ITERATIONS, maxToolCalls: SIMPLIFY_MAX_TOOL_CALLS }
  }
  return { extraTools: [], maxIterations: MAX_AGENT_ITERATIONS, maxToolCalls: MAX_AGENT_TOOL_CALLS }
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
  reasoningEffort?: ReasoningEffort,
  sessionId?: string,
): Promise<AgentTurn> {
  const fullModel = model as Model<Api>
  const auth = await registry.getApiKeyAndHeaders(fullModel)
  if (!auth.ok) throw new Error(`No credentials for ${model.provider}: ${auth.error ?? "unknown"}`)

  // Некоторые провайдеры не декларируют supportsReasoningEffort, из-за чего
  // pi-ai молча выбрасывает reasoning_effort и модель думает на полную:
  // мышление накапливается в контексте и генерация обрывается. Патчим compat
  // на лету, чтобы reasoning_effort дошёл. sendSessionAffinityHeaders — чтобы
  // sessionId (один на прогон ревью) уходил в x-session-id/x-session-affinity:
  // если бэкенд маршрутизирует по сессии, спеки прогона попадают на тёплый узел
  // с разогретым prefix-кэшем. Незнакомые заголовки провайдеры игнорируют.
  const effectiveModel = Object.create(Object.getPrototypeOf(fullModel)) as Model<Api>
  Object.assign(effectiveModel, fullModel)
  ;(effectiveModel as { compat?: Record<string, unknown> }).compat = {
    ...((fullModel as { compat?: Record<string, unknown> }).compat ?? {}),
    supportsReasoningEffort: true,
    sendSessionAffinityHeaders: true,
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
  // Провайдер отверг параметр (типичные 400: reasoning_effort/max_tokens/
  // session-заголовки не поддерживаются) — градационная деградация: повторяем
  // вызов без параметра. deepseek-v4-flash получает max reasoning + session,
  // несовместимая модель из пула — рабочий вызов без них.
  const isParamRejected = (e: unknown) =>
    /reasoning_effort|max_tokens|max_completion_tokens|x-session-id|session-affinity|session_id|unknown parameter|unsupported parameter|invalid parameter|unknown field|400 bad request/i.test(
      (e as Error).message ?? "",
    )
  const degradeSteps = [
    { maxTokens: maxTokens ?? MODEL_MAX_TOKENS, effort: reasoningEffort, withSession: true },
    { maxTokens: maxTokens ?? MODEL_MAX_TOKENS, effort: undefined, withSession: true },
    { maxTokens: Math.min(16384, maxTokens ?? MODEL_MAX_TOKENS), effort: undefined, withSession: false },
  ]
  let paramError: unknown
  for (const step of degradeSteps) {
    try {
      const response = await retryOnFailure(
        `${model.provider}/${model.id}`,
        () =>
          complete(effectiveModel, { systemPrompt, messages: messages as Message[], tools }, {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            signal,
            temperature: MODEL_TEMPERATURE,
            maxTokens: step.maxTokens,
            reasoningEffort: step.effort,
            sessionId: step.withSession ? sessionId : undefined,
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
    } catch (e) {
      if (signal?.aborted) throw e
      if (!isParamRejected(e)) throw e // не параметр — не деградируем
      paramError = e
    }
  }
  throw paramError instanceof Error ? paramError : new Error(String(paramError))
}

export async function judgeViaPi(
  registry: PiRegistryLike,
  model: PiModelLike,
  prompt: string,
  signal?: AbortSignal,
  attempts = 2,
  sessionId?: string,
): Promise<{ text: string }> {
  const user = "Emit your JSON verdict now — exactly the schema from the prompt."
  // Свежий no-tools вызов: у судьи нет тулов, спираль невозможна.
  // Не-abort ошибки провайдера пробрасываем после последней попытки — иначе
  // «Judge output could not be parsed» в отчёте скрывало бы реальную причину
  // (401/5xx/timeout).
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const turn = await chatViaPi(
        registry,
        model,
        prompt,
        [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
        undefined, // без тулов
        signal,
        MODEL_MAX_TOKENS,
        REASONING_EFFORT,
        sessionId,
      )
      // Попытка выполнилась без исключения — прошлая ошибка была транзиентной.
      // Иначе удачная попытка с пустым ответом бросала бы УСТАРЕВШУЮ ошибку.
      lastError = undefined
      const text = extractText(turn.content)
      if (text) return { text }
    } catch (e) {
      if (signal?.aborted) throw e
      lastError = e
    }
  }
  if (lastError !== undefined) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  return { text: "" }
}

/**
 * Полный агентный прогон ревью: модель сама читает файлы из репозитория
 * (root) через read_file и выносит вердикт. Пустой итог ретраится.
 */
export async function runAgent(
  registry: PiRegistryLike,
  model: PiModelLike,
  prompt: string,
  root: string,
  signal?: AbortSignal,
  opts: { extraTools?: Tool[]; maxIterations?: number; maxToolCalls?: number } = {},
  sessionId?: string,
): Promise<{ text: string; toolCalls: number; readFiles: string[] }> {
  const label = `${model.provider}/${model.id}`
  const tools: Tool[] = [makeReadTool(), ...(opts.extraTools ?? [])]
  const initialMessages: UserMessage[] = [
    { role: "user", content: [{ type: "text", text: "Review the files in scope and output your verdict." }], timestamp: Date.now() },
  ]
  const readFiles = new Set<string>()
  const executor = makeExecutor(root, readFiles)
  const effort = REASONING_EFFORT

  let toolCalls = 0
  let messages: unknown[] = initialMessages
  // Кумулятивный бюджет на ВСЕ ретраи: runAgentLoop получает ОСТАТОК лимитов
  // (maxIterations/maxToolCalls/maxContextChars) — раньше каждый ретрай
  // начинал с нуля, и суммарный расход превышал заявленные капы.
  let iterationsBudget = opts.maxIterations ?? MAX_AGENT_ITERATIONS
  let toolBudget = opts.maxToolCalls ?? MAX_AGENT_TOOL_CALLS
  let contextBudget = MAX_AGENT_CONTEXT_CHARS
  const attempt = async (): Promise<string> => {
    const chat: AgentChat = (msgs, toolsList, s) =>
      chatViaPi(registry, model, prompt, msgs, toolsList as Tool[], s, undefined, effort, sessionId)
    const loop = await runAgentLoop(chat, messages, tools, executor, {
      maxIterations: Math.max(1, iterationsBudget),
      maxToolCalls: Math.max(0, toolBudget),
      maxContextChars: Math.max(0, contextBudget),
    }, signal)
    toolCalls += loop.toolCalls
    iterationsBudget -= loop.iterations
    toolBudget -= loop.toolCalls
    contextBudget -= loop.contextChars
    messages = loop.messages
    // Вердикт — только цельный JSON-объект с "findings": начинается с "{",
    // заканчивается "}". Проза с упоминанием слова или битый JSON
    // ({"context":"FULL","findings": [) через гейт не проходят → ретрай.
    const isVerdict = /^\{[\s\S]*"findings"[\s\S]*\}$/.test(loop.text.trim())
    // Не вердикт (тул-разметка, пусто, проза, битый JSON) — считаем пустым,
    // чтобы retryOnEmpty продолжил беседу С тулами: модель дочитает
    // и выдаст вердикт по контракту.
    const finalText = isToolMarkup(loop.text) || !loop.text.trim() || !isVerdict ? "" : loop.text
    if (!finalText.trim()) {
      // Продолжаем ТУ ЖЕ беседу, а не рестартуем: файлы уже прочитаны,
      // контекст накоплен, префикс в кэше провайдера.
      messages.push({
        role: "user",
        content: [{ type: "text", text: "Your previous response was empty or not a verdict. Produce the final review verdict JSON now based on what you have read. You may read additional files if you need more context." }],
        timestamp: Date.now(),
      })
    }
    return finalText
  }

  let text: string
  try {
    text = await retryOnEmpty(label, attempt, EMPTY_RESPONSE_RETRIES, RETRY_DELAY_MS, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(`${label} agent call failed (read_file): ${(err as Error).message}`)
  }
  return { text, toolCalls, readFiles: [...readFiles] }
}
