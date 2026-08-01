import type { SpecId } from "./types.ts"

export const MAX_DIFF_CHARS = 20_000

// Параллельность ревью: не больше PROVIDER_MAX_CONCURRENCY одновременных
// запросов к одному провайдеру и не больше GLOBAL_MAX_CONCURRENCY всего,
// чтобы не долбить провайдера кучей запросов (rate-limit, socket exhaustion).
export const PROVIDER_MAX_CONCURRENCY = 2
export const GLOBAL_MAX_CONCURRENCY = 10

// Параметры вызова модели.
// temperature 0.3, а не 0: при 0 DeepSeek-класс модели заметно деградирует.
export const MODEL_TEMPERATURE = 0.3
export const MODEL_MAX_TOKENS = 8192

export const SPECIALIZATIONS: Record<SpecId, string> = {
  security: "Security (vuln, injection, auth, secrets, OWASP)",
  correctness: "Correctness (logic bugs, edge cases, race conditions)",
  performance: "Performance (complexity, N+1, memory leaks, blocking I/O)",
  maintainability: "Maintainability (duplication, complexity, dead code)",
  style: "Style & Idiom (conventions, naming, readability)",
  best_practices: "Best Practices (SOLID, DRY, error propagation)",
}

// Платные модели, которые всегда показываем в мастере помимо бесплатных.
// Формат: "provider/modelId" из каталога pi.
export const EXTRA_MODELS = [
  "openrouter/deepseek/deepseek-v4-flash",
]
