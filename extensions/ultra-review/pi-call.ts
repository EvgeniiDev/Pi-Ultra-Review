import { complete, type UserMessage } from "@earendil-works/pi-ai/compat"
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai"
import { Type } from "@sinclair/typebox"
import { makeExecutor, runAgentLoop, type AgentChat, type AgentTurn } from "./agent.ts"
import { EMPTY_RESPONSE_RETRIES, MODEL_MAX_TOKENS, MODEL_TEMPERATURE, RETRY_DELAY_MS, SIMPLIFY_MAX_ITERATIONS, SIMPLIFY_MAX_TOOL_CALLS } from "./constants.ts"
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
): Promise<AgentTurn> {
  const fullModel = model as Model<Api>
  const auth = await registry.getApiKeyAndHeaders(fullModel)
  if (!auth.ok) throw new Error(`No credentials for ${model.provider}: ${auth.error ?? "unknown"}`)

  // 429/rate-limit — временный сбой провайдера: ретраится ОДИН вызов complete
  // (не весь агентный цикл — рестарт цикла на каждой попытке раздувает прогон).
  // "Stream ended without finish_reason" — оборванный апстримом стрим (часто
  // на free-тире через релей): тоже временный сбой, ретраим один раз.
  // Ошибка может прийти ДВУМЯ путями: исключение из complete() либо graceful
  // error-ответ (stopReason === "error") — второй путь ретраится здесь же,
  // бросая retryable-ошибку из замыкания, чтобы её подхватил retryOnFailure.
  const isRetryable = (e: unknown) =>
    /429|rate\s*limit|stream ended without finish_reason/i.test(
      (e as Error).message ?? "",
    )
  const response = await retryOnFailure(
    `${model.provider}/${model.id}`,
    () =>
      complete(fullModel, { systemPrompt, messages: messages as Message[], tools }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
        temperature: MODEL_TEMPERATURE,
        maxTokens: MODEL_MAX_TOKENS,
      }).then((r) => {
        if (r.stopReason === "error" && isRetryable(new Error(r.errorMessage ?? ""))) {
          throw new Error(`${model.provider}/${model.id} error: ${r.errorMessage}`)
        }
        return r
      }),
    isRetryable,
    2,
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
  const tools: Tool[] = [makeReadTool(), ...(opts.extraTools ?? [])]
  const initialMessages: UserMessage[] = [
    { role: "user", content: [{ type: "text", text: "Review the files in scope and output your verdict." }], timestamp: Date.now() },
  ]
  const readFiles = new Set<string>()
  const executor = makeExecutor(root, readFiles)

  let toolCalls = 0
  const attempt = async (): Promise<string> => {
    const chat: AgentChat = (messages, toolsList, s) =>
      chatViaPi(registry, model, prompt, messages, toolsList as Tool[], s)
    const loop = await runAgentLoop(chat, initialMessages, tools, executor, {
      maxIterations: opts.maxIterations ?? 8,
      maxToolCalls: opts.maxToolCalls ?? 30,
    }, signal)
    toolCalls = loop.toolCalls
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
