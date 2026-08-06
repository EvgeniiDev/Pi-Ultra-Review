import type { Severity, SpecId } from "./types.ts"

// Кап диффа в промпте: 100K символов (~25K токенов) — это 2.5% от 1M контекста
// deepseek-v4-flash, покрывает нормальные ветки целиком. Дифф — единственный
// источник «что изменилось» (read_file даёт только текущее состояние), поэтому
// для ревью изменений он важнее, чем экономия токенов. Кап остаётся только
// страховкой от патологических диффов (5MB уронили бы запрос context-overflow).
// Обрезка мягкая: по границе строки + список невидимых файлов в промпте.
export const MAX_DIFF_CHARS = 100_000

/** Версия промтов для отладки/evals: меняй при каждом изменении контракта. */
export const PROMPT_VERSION = "2026-08-07b.json"

// Параллельность ревью: не больше PROVIDER_MAX_CONCURRENCY одновременных
// запросов к одному провайдеру и не больше GLOBAL_MAX_CONCURRENCY всего,
// чтобы не долбить провайдера кучей запросов (rate-limit, socket exhaustion).
export const PROVIDER_MAX_CONCURRENCY = 4
export const GLOBAL_MAX_CONCURRENCY = 10

// Параметры вызова модели.
// temperature 0.3, а не 0: при 0 DeepSeek-класс модели заметно деградирует.
export const MODEL_TEMPERATURE = 0.3
// 64K output-токенов: под max reasoning (REASONING_EFFORT) модель тратит
// бюджет на мышление — 32K могло обрезать длинную цепочку рассуждений.
export const MODEL_MAX_TOKENS = 65536

// Уровень reasoning для всех моделей: deepseek-v4-flash (opencode-go)
// уверенно работает на max, вердикт получается после полного анализа.
export const REASONING_EFFORT = "max"

// Ретрай пустого ответа модели (иногда это временный затуп),
// задержка растёт линейно: delay, delay*2, ...
export const EMPTY_RESPONSE_RETRIES = 2
export const RETRY_DELAY_MS = 1500

// Бюджет агента simplify: циклы «поиск → чтение кандидата → подтверждение».
export const SIMPLIFY_MAX_ITERATIONS = 10
export const SIMPLIFY_MAX_TOOL_CALLS = 40

export const SPECIALIZATIONS: Record<SpecId, string> = {
  security: "Security (vuln, injection, auth, secrets, OWASP)",
  correctness: "Correctness (logic bugs, edge cases, race conditions)",
  performance: "Performance (complexity, N+1, memory leaks, blocking I/O)",
  maintainability: "Maintainability (duplication, complexity, dead code)",
  style: "Style & Idiom (conventions, naming, readability)",
  best_practices: "Best Practices (SOLID, DRY, error propagation)",
  simplify: "Simplify (reuse, dead code, thin wrappers, cleanup)",
}

// Модели, которые всегда показываем в мастере в первую очередь.
// Формат: "provider/modelId" из каталога pi.
export const EXTRA_MODELS = [
  "opencode-go/deepseek-v4-flash",
]

// Провайдеры, чьи модели скрываем из мастера выбора. Быстро вернуть:
// очистить массив ([]) или удалить строку — модели снова появятся в пуле.
export const BLOCKED_PROVIDERS = ["openrouter"]
