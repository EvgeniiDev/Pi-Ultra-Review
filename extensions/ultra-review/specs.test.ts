import { describe, expect, test } from "bun:test"
import { REVIEW_SPECS } from "./prompts.ts"
import { assertSpecId, SPEC_IDS } from "./types.ts"

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
