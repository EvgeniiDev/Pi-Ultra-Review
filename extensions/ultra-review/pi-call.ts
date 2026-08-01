import { complete, type UserMessage } from "@earendil-works/pi-ai/compat"
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai"
import { Type } from "@sinclair/typebox"
import { readFileSafely, runAgentLoop, type AgentChat, type AgentTurn } from "./agent.ts"
import { EMPTY_RESPONSE_RETRIES, MODEL_MAX_TOKENS, MODEL_TEMPERATURE, RETRY_DELAY_MS } from "./constants.ts"
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
  const isRateLimit = (e: unknown) => /429|rate\s*limit/i.test((e as Error).message ?? "")
  const response = await retryOnFailure(
    `${model.provider}/${model.id}`,
    () => complete(fullModel, { systemPrompt, messages: messages as Message[], tools }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      temperature: MODEL_TEMPERATURE,
      maxTokens: MODEL_MAX_TOKENS,
    }),
    isRateLimit,
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
): Promise<{ text: string; toolCalls: number; readFiles: string[] }> {
  const label = `${model.provider}/${model.id}`
  const tools: Tool[] = [makeReadTool()]
  const initialMessages: UserMessage[] = [
    { role: "user", content: [{ type: "text", text: "Review the files in scope and output your verdict." }], timestamp: Date.now() },
  ]
  const readFiles = new Set<string>()
  const executor = async (call: { id?: string; name?: string; arguments?: Record<string, unknown> }) => {
    const args = call.arguments ?? {}
    const path = String(args.path ?? "")
    if (path) readFiles.add(path)
    return readFileSafely(root, path, args.startLine as number | undefined, args.endLine as number | undefined)
  }

  let toolCalls = 0
  const attempt = async (): Promise<string> => {
    const chat: AgentChat = (messages, toolsList, s) =>
      chatViaPi(registry, model, prompt, messages, toolsList as Tool[], s)
    const loop = await runAgentLoop(chat, initialMessages, tools, executor, { maxIterations: 8 }, signal)
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
