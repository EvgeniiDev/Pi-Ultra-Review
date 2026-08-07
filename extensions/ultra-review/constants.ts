import type { SpecId } from "./types.ts"

// Кап диффа в промпте: 100K символов (~25K токенов) — это 2.5% от 1M контекста
// deepseek-v4-flash, покрывает нормальные ветки целиком. Дифф — единственный
// источник «что изменилось» (чтение файлов даёт только текущее состояние),
// поэтому для ревью изменений он важнее, чем экономия токенов. Кап остаётся
// страховкой от патологических диффов (5MB уронили бы запрос context-overflow).
export const MAX_DIFF_CHARS = 100_000

/** Версия промтов для отладки/evals: меняй при каждом изменении контракта. */
export const PROMPT_VERSION = "2026-08-07b.json"

// Параллельность ревью: не больше PROVIDER_MAX_CONCURRENCY одновременных
// запросов к одному провайдеру и не больше GLOBAL_MAX_CONCURRENCY всего.
export const PROVIDER_MAX_CONCURRENCY = 4
export const GLOBAL_MAX_CONCURRENCY = 10

// Глубина «размышлений» модели (thinkingLevel в pi). Токены, температура
// и ретраи — под управлением агентного рантайма pi, здесь их не задаём.
export const REASONING_EFFORT = "max"

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
