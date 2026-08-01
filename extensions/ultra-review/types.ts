import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"

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
  /** Файлы в скоупе (манифест). Ревьюер читает их через read_file по частям. */
  files: string[]
  /** Git-диф изменений — только для git-скоупов (working_tree / branch). */
  diff?: string
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
  /** Финальный проход судьи: дедупликация + валидация находок. */
  judge: boolean
}

/** Находка, распарсенная из вывода ревьюера для судьи. */
export interface ParsedFinding {
  idx: number
  severity: string
  file: string
  line: string
  description: string
  agent: string
  spec: string
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
// pi-модели: типы берём напрямую из зависимостей pi (type-only импорты
// стираются при сборке — на рантайм не влияют, тесты в bun работают).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Лёгкий контракт модели для движка/мастера: Pick из реального Model<Api> pi.
 * Реальные модели из ctx.modelRegistry удовлетворяют ему структурно, а тестовым
 * заглушкам не нужно собирать все поля pi (api, baseUrl, reasoning, ...).
 */
export type PiModelLike = Pick<Model<Api>, "id" | "name" | "provider" | "cost">

/** Реестр моделей pi как есть — без дублирования интерфейса. */
export type PiRegistryLike = ModelRegistry

/** Авторизация из pi — выведена из сигнатуры реестра, а не скопирована. */
export type PiAuthResult = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>

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
