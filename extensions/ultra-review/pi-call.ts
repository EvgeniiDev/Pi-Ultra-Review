import { complete, type UserMessage } from "@earendil-works/pi-ai/compat"
import type { Api, Model } from "@earendil-works/pi-ai"
import { EMPTY_RESPONSE_RETRIES, MODEL_MAX_TOKENS, MODEL_TEMPERATURE, RETRY_DELAY_MS } from "./constants.ts"
import { retryOnEmpty } from "./retry.ts"
import type { PiModelLike, PiRegistryLike } from "./types.ts"

/**
 * Вызов модели через провайдерский слой pi (официальный паттерн из примера qna.ts):
 * - авторизация резолвится через ctx.modelRegistry.getApiKeyAndHeaders()
 *   (env-ключи, auth.json, OAuth, кастомные провайдеры — всё как в pi);
 * - формат ответа нормализует pi (openai/anthropic/google/mistral/...);
 * - вызовы можно запускать параллельно через Promise.all — сериализация
 *   существует только в агентском цикле, не здесь.
 */
export async function callViaPi(
  registry: PiRegistryLike,
  model: PiModelLike,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  // В проде model — реальный Model<Api> из реестра pi (типизирован как
  // PiModelLike), поэтому каст безопасен.
  const fullModel = model as Model<Api>
  const auth = await registry.getApiKeyAndHeaders(fullModel)
  if (!auth.ok) throw new Error(`No credentials for ${model.provider}: ${auth.error ?? "unknown"}`)

  const label = `${model.provider}/${model.id}`
  const attempt = async () => {
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    }

    const response = await complete(fullModel, { messages: [userMessage] }, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      temperature: MODEL_TEMPERATURE,
      maxTokens: MODEL_MAX_TOKENS,
    })

    if (response.stopReason === "aborted") throw new Error(`${label} aborted`)
    if (response.stopReason === "error") {
      throw new Error(`${label} error: ${response.errorMessage ?? "unknown"}`)
    }

    return response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
  }

  // Пустой ответ — не ошибка с первого раза: это может быть временный затуп.
  // retryOnEmpty сам кинет ошибку, если все попытки пустые (попадёт в failed).
  return retryOnEmpty(label, attempt, EMPTY_RESPONSE_RETRIES, RETRY_DELAY_MS, signal)
}
