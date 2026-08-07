import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"

export const SPEC_IDS = [
  "security",
  "correctness",
  "performance",
  "maintainability",
  "style",
  "best_practices",
  "simplify",
  "test_integrity",
  "change_quality",
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
  /** Git-история изменения (для change_quality). Только git-скоупы. */
  commits?: string
}

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export type SimplifyRisk = "safe" | "confirm" | "review"
export type SimplifyAction = "delete" | "inline" | "refactor" | "parallelize"

export interface ReviewSpec {
  role: string
  mission: string
  investigate: string[]
  ignore: string[]
  severityGuidance: string[]
  /** Какие severity разрешены для этого спека (style не может выдавать CRITICAL). */
  allowedSeverities: Severity[]
}

export interface ReviewConfig {
  scope: Scope
  specs: SpecId[]
  models: PiModelLike[]
  deep: boolean
  /** Финальный проход судьи: дедупликация + валидация находок. */
  judge: boolean
}

/** Runtime-валидация specId: тип существует только в compile-time. */
export function assertSpecId(value: unknown): SpecId {
  if (typeof value === "string" && (SPEC_IDS as readonly string[]).includes(value)) {
    return value as SpecId
  }
  throw new Error(`Unknown review spec: ${String(value)}`)
}

/** Находка, распарсенная из вывода ревьюера для судьи. */
// (ParsedFinding удалён — мёртвый код; судья работает с JudgedFinding.)

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

/** Уровень reasoning для вызова модели (см. REASONING_EFFORT в constants). */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** "provider/modelId" — композитный ключ, который видит пользователь. */
export const modelKey = (m: PiModelLike): string => `${m.provider}/${m.id}`

export const modelLabel = (m: PiModelLike): string => `${modelKey(m)} — ${m.name}`

/**
 * Нормализация пути для валидации находок: backslash → forward slash (Windows
 * возвращает "src\\a.ts", манифест хранит "src/a.ts"), срезаем ведущий "./".
 */
export const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "")

/** Разбирает "openrouter/deepseek/deepseek-v4-flash" на provider + modelId. */
export const parseModelKey = (key: string): { provider: string; modelId: string } => {
  const i = key.indexOf("/")
  return i < 0 ? { provider: key, modelId: "" } : { provider: key.slice(0, i), modelId: key.slice(i + 1) }
}
