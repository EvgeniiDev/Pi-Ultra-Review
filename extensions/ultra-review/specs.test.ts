import { describe, expect, test } from "bun:test"
import { SPECIALIZATIONS } from "./constants.ts"
import { REVIEW_SPECS } from "./prompts.ts"
import { assertSpecId, SPEC_IDS } from "./types.ts"

describe("spec contract", () => {
  test("SPEC_IDS ↔ SPECIALIZATIONS ↔ REVIEW_SPECS консистентны (никакого дрейфа)", () => {
    expect(Object.keys(SPECIALIZATIONS).sort()).toEqual([...SPEC_IDS].sort())
    for (const id of SPEC_IDS) {
      const spec = REVIEW_SPECS[id]
      expect(spec, `REVIEW_SPECS.${id}`).toBeDefined()
      expect(spec.role).toBeTruthy()
      expect(spec.mission).toBeTruthy()
      expect(spec.investigate.length).toBeGreaterThan(0)
      expect(spec.ignore.length).toBeGreaterThan(0)
      expect(spec.severityGuidance.length).toBeGreaterThan(0)
      expect(spec.allowedSeverities.length).toBeGreaterThan(0)
      for (const sev of spec.allowedSeverities) {
        expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(sev)
      }
    }
  })

  test("assertSpecId: валидные id проходят, мусор бросает", () => {
    for (const id of SPEC_IDS) expect(assertSpecId(id)).toBe(id)
    expect(() => assertSpecId("nope")).toThrow(/Unknown review spec/)
    expect(() => assertSpecId(undefined)).toThrow(/Unknown review spec/)
  })
})

describe("simplify spec", () => {
  test("is registered in SPEC_IDS and accepted by assertSpecId", () => {
    expect(SPEC_IDS).toContain("simplify")
    expect(assertSpecId("simplify")).toBe("simplify")
  })

  test("REVIEW_SPECS.simplify exists with LOW/MEDIUM/HIGH only and full rule set", () => {
    const s = REVIEW_SPECS.simplify
    expect(s).toBeDefined()
    expect(s.allowedSeverities).toEqual(["LOW", "MEDIUM", "HIGH"])
    expect(s.investigate).toHaveLength(22)
    expect(s.ignore).toHaveLength(9)
    expect(s.severityGuidance).toHaveLength(5)
    expect(s.role).toContain("simplification")
  })
})
