import type { SpecId } from "./types.ts"

export const MAX_DIFF_CHARS = 20_000

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
