export const SPEC_IDS = [
  "security",
  "correctness",
  "performance",
  "maintainability",
  "style",
  "best_practices",
] as const

export type SpecId = (typeof SPEC_IDS)[number]

export interface Scope {
  id: string
  label: string
  description: string
  diff: string
}

export interface ReviewSpec {
  role: string
  mission: string
  investigate: string[]
  ignore: string[]
  severityGuidance: string[]
}

export interface ReviewConfig {
  scope: Scope
  specs: SpecId[]
  models: PiModelLike[]
  deep: boolean
}

/**
 * Минимальный набор UI-методов, который нужен движку и мастеру.
 * Позволяет не тащить полный ExtensionContext и легко тестировать логику.
 * notify() принимает любой тип намеренно: TUI в рантайме переживает "success".
 */
export interface UiLike {
  setStatus(name: string, status: string | undefined): void
  select(title: string, options: string[]): Promise<string | undefined>
  confirm(title: string, message: string): Promise<boolean>
  notify(message: string, type?: string): void
}

// ─────────────────────────────────────────────────────────────────────────────
// pi-модели: структурные типы без импорта pi-ai (удобно для тестов и
// устойчиво к внутренним изменениям pi). Реальные Model<Api> из
// ctx.modelRegistry удовлетворяют этим интерфейсам структурно.
// ─────────────────────────────────────────────────────────────────────────────

export interface PiModelLike {
  id: string
  name: string
  provider: string
  cost: { input: number; output: number }
}

export interface PiAuthResult {
  ok: boolean
  apiKey?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  error?: string
}

export interface PiRegistryLike {
  getAll(): PiModelLike[]
  find(provider: string, modelId: string): PiModelLike | undefined
  getApiKeyAndHeaders(model: PiModelLike): Promise<PiAuthResult>
}

export const isFreeModel = (m: PiModelLike): boolean => m.cost.input === 0 && m.cost.output === 0

/** "provider/modelId" — композитный ключ, который видит пользователь. */
export const modelKey = (m: PiModelLike): string => `${m.provider}/${m.id}`

export const modelLabel = (m: PiModelLike): string =>
  `${modelKey(m)} ${isFreeModel(m) ? "(FREE)" : "(PAID)"} — ${m.name}`

/** Разбирает "openrouter/deepseek/deepseek-v4-flash" на provider + modelId. */
export const parseModelKey = (key: string): { provider: string; modelId: string } => {
  const i = key.indexOf("/")
  return i < 0 ? { provider: key, modelId: "" } : { provider: key.slice(0, i), modelId: key.slice(i + 1) }
}
