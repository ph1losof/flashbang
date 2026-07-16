import { describe, expect, spyOn, test } from "bun:test";
import { BANG_COUNT } from "../src/generated/bangs-sparse.js";
import {
  createBangMeta,
  loadBuiltinBangCatalog,
  searchBangs,
} from "../src/ui/bang-catalog";

describe("bang catalog", () => {
  test("bounded search applies the shared ranking order", () => {
    const entries = [
      createBangMeta("z", "Other", "example.x.dev"),
      createBangMeta("m", "Prefix x value", "m.dev"),
      createBangMeta("ax", "Other", "ax.dev"),
      createBangMeta("d", "Other", "x.example"),
      createBangMeta("n", "Xylophone", "n.dev"),
      createBangMeta("xa", "Other", "xa.dev"),
      createBangMeta("x", "Other", "x.dev"),
    ];

    expect(
      searchBangs(entries, " X ", 7).map((entry) => entry.trigger)
    ).toEqual(["x", "xa", "n", "d", "ax", "m", "z"]);
    expect(searchBangs(entries, "x", 3).map((entry) => entry.trigger)).toEqual([
      "x",
      "xa",
      "n",
    ]);
  });

  test("normalizes built-ins once and reuses the catalog", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Bun.file("src/generated/bangs-meta.bin"))
    );
    const first = loadBuiltinBangCatalog();
    const second = loadBuiltinBangCatalog();
    expect(first).toBe(second);

    try {
      const catalog = await first;
      expect(catalog.entries).toHaveLength(BANG_COUNT);
      const google = catalog.byTrigger.get("g");
      expect(google?.name).toBe("Google");
      expect(google?.capture).toBe(false);
      expect(catalog.byTrigger.get("ktr")?.capture).toBe(true);
      expect(catalog.entries).toContain(google);
      expect(fetchSpy).toHaveBeenCalledWith("/bangs-meta.bin");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
