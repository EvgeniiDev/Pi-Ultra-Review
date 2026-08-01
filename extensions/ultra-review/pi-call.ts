import { complete, type UserMessage } from "@earendil-works/pi-ai/compat"
import type { Api, Model } from "@earendil-works/pi-ai"
import { MODEL_MAX_TOKENS, MODEL_TEMPERATURE } from "./constants.ts"
import type { PiAuthResult, PiModelLike } from "./types.ts"

/**
 * Вызов модели через провайдерский слой pi (официальный паттерн из примера qna.ts):
 * - авторизация резолвится через ctx.modelRegistry.getApiKeyAndHeaders()
 *   (env-ключи, auth.json, OAuth, кастомные провайдеры — всё как в pi);
 * - формат ответа нормализует pi (openai/anthropic/google/mistral/...);
 * - вызовы можно запускать параллельно через Promise.all — сериализация
 *   существует только в агентском цикле, не здесь.
 */
export async function callViaPi(
  registry: { getApiKeyAndHeaders(model: PiModelLike): Promise<PiAuthResult> },
  model: PiModelLike,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const auth = await registry.getApiKeyAndHeaders(model)
  if (!auth.ok) throw new Error(`No credentials for ${model.provider}: ${auth.error ?? "unknown"}`)

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  }

  const response = await complete(model as Model<Api>, { messages: [userMessage] }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
    temperature: MODEL_TEMPERATURE,
    maxTokens: MODEL_MAX_TOKENS,
  })

  if (response.stopReason === "aborted") throw new Error(`${model.provider}/${model.id} aborted`)
  if (response.stopReason === "error") {
    throw new Error(`${model.provider}/${model.id} error: ${response.errorMessage ?? "unknown"}`)
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")

  // Пустой ответ модели не должен тихо превращаться в "UNKNOWN" в отчёте:
  // двигаем как ошибку, чтобы она попала в счётчик failed.
  if (!text.trim()) throw new Error(`${model.provider}/${model.id} empty response`)

  return text
}
