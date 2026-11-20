import { describe, expect, it } from "vitest"
import { lookupLabel } from "../../plugins/database"

describe("lookupLabel", () => {
  const nc = { dateinit: "2026-11-20T00:00:00Z", ncdescription: "Late delivery" }
  const provider = { address: "2 rue Kellermann", criticity_level: "critical", name: "OVH" }

  it("uses the declared column when the row has a value", () => {
    expect(lookupLabel(nc, 7, "ncdescription")).toBe("Late delivery")
  })
  it("falls back to the id when the declared column is absent and there is no name", () => {
    expect(lookupLabel(nc, 7, "idnc")).toBe("7")
  })
  it("uses name when no column is declared", () => {
    expect(lookupLabel(provider, 3)).toBe("OVH")
  })
  it("uses name when the declared column is empty", () => {
    expect(lookupLabel({ ...provider, address: "" }, 3, "address")).toBe("OVH")
  })
  it("never picks an unrelated text column", () => {
    expect(lookupLabel({ address: "x" }, 3)).toBe("3")
  })
})
