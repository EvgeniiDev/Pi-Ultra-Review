import { EXTRA_MODELS, SPECIALIZATIONS } from "./constants.ts"
import { getScopes } from "./scopes.ts"
import {
  SPEC_IDS,
  modelKey,
  modelLabel,
  parseModelKey,
  type PiModelLike,
  type PiRegistryLike,
  type ReviewConfig,
  type SpecId,
  type UiLike,
} from "./types.ts"

// Сколько моделей показывать в одном окне выбора (пагинация)
const MODEL_PAGE_SIZE = 12
const DONE_MARKER = "--- DONE ---"
const PREV_PAGE = "← Previous page"
const NEXT_PAGE = "→ Next page"

/**
 * Пул для выбора: доп. модели (EXTRA_MODELS) + весь каталог pi, без дублей,
 * предпочтительные сверху.
 */
export function buildModelPool(registry: PiRegistryLike): PiModelLike[] {
  const extra = EXTRA_MODELS
    .map(parseModelKey)
    .map(({ provider, modelId }) => registry.find(provider, modelId))
    .filter((m): m is NonNullable<typeof m> => !!m)
  const all = registry.getAll()
  const seen = new Set<string>()
  return [...extra, ...all].filter((m) => (seen.has(modelKey(m)) ? false : (seen.add(modelKey(m)), true)))
}

/**
 * Мультиселект моделей с пагинацией: окно select не умеет ограничивать
 * высоту, поэтому при большом списке режем его на страницы и листаем.
 */
export async function pickModels(ctx: { ui: UiLike }, models: PiModelLike[]): Promise<PiModelLike[]> {
  const selected: PiModelLike[] = []
  let page = 0

  while (true) {
    const remaining = models.filter((m) => !selected.some((s) => modelKey(s) === modelKey(m)))
    if (remaining.length === 0) break

    const pageCount = Math.ceil(remaining.length / MODEL_PAGE_SIZE)
    if (page >= pageCount) page = pageCount - 1 // страница могла опустеть после выбора

    const pageItems = remaining.slice(page * MODEL_PAGE_SIZE, (page + 1) * MODEL_PAGE_SIZE)
    const choices = pageItems.map(modelLabel)
    choices.push(DONE_MARKER)
    if (page > 0) choices.push(PREV_PAGE)
    if (page < pageCount - 1) choices.push(NEXT_PAGE)

    const title = `Add model (${selected.length} selected) — page ${page + 1}/${pageCount}`
    const pick = await ctx.ui.select(title, choices)
    if (!pick || pick === DONE_MARKER) break
    if (pick === PREV_PAGE) { page--; continue }
    if (pick === NEXT_PAGE) { page++; continue }

    // Матчим по полному ключу с разделителем, а не по префиксу:
    // "openrouter/deepseek/deepseek-v4-flash …" не должно совпасть с соседним id.
    const matched = pageItems.find((m) => pick.startsWith(modelKey(m) + " "))
    if (matched) selected.push(matched)
  }

  return selected
}

export async function runWizard(
  ctx: { ui: UiLike; modelRegistry: PiRegistryLike },
  cwd: string,
): Promise<ReviewConfig> {
  const scopes = getScopes(cwd)
  if (scopes.length === 0) throw new Error("No reviewable git scopes found")

  // 1. Scope
  const scopeLabels = scopes.map(s => `${s.label} — ${s.description}`)
  const pickedScope = await ctx.ui.select("Review scope", scopeLabels)
  if (!pickedScope) throw new Error("Wizard cancelled")
  const scope = scopes[scopeLabels.indexOf(pickedScope)]

  // 2. Specializations (Multi-select loop)
  const selectedSpecs: SpecId[] = []
  const allSpecIds = [...SPEC_IDS]
  while (true) {
    const remaining = allSpecIds.filter(s => !selectedSpecs.includes(s))
    if (remaining.length === 0) break
    const choices = [...remaining.map(s => `${s}: ${SPECIALIZATIONS[s]}`), DONE_MARKER]
    const pick = await ctx.ui.select(`Add specialization (${selectedSpecs.length} selected)`, choices)
    if (!pick || pick === DONE_MARKER) break
    const id = allSpecIds.find(s => pick.startsWith(`${s}: `))
    if (id) selectedSpecs.push(id)
  }
  if (selectedSpecs.length === 0) throw new Error("No specializations selected")

  // 3. Models (EXTRA_MODELS + весь каталог pi)
  const modelsToPickFrom = buildModelPool(ctx.modelRegistry)

  const selectedModels = await pickModels(ctx, modelsToPickFrom)
  if (selectedModels.length === 0) throw new Error("No models selected")

  // 4. Deep mode
  const deep = await ctx.ui.confirm("Deep mode?", `Full matrix: ${selectedModels.length} × ${selectedSpecs.length} reviews. Off = round-robin.`)

  // 5. Judge pass: финальный проход дедуплицирует и валидирует находки
  const judge = await ctx.ui.confirm("Judge pass?", "After reviews, a final pass deduplicates and validates findings (recommended).")

  return { scope, specs: selectedSpecs, models: selectedModels, deep, judge }
}
