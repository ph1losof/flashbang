import { describe, expect, test } from "bun:test";
import {
  computeGeneratedInputStamp,
  GENERATED_INPUT_STAMP_PATH,
  type GeneratedInputStamp,
  generatedInputStampMismatch,
} from "../scripts/codegen";

const stamp = (inputs: Record<string, string>): GeneratedInputStamp => ({
  inputs,
  version: 1,
});

describe("generated input stamp", () => {
  test("accepts a stamp that still describes the tree", () => {
    const current = stamp({
      "data/bangs.json": "a",
      "data/bang-router.json": "b",
    });
    expect(
      generatedInputStampMismatch(stamp(current.inputs), current)
    ).toBeNull();
  });

  test("names the input whose contents changed", () => {
    const reason = generatedInputStampMismatch(
      stamp({ "data/bangs.json": "old", "data/bang-router.json": "b" }),
      stamp({ "data/bangs.json": "new", "data/bang-router.json": "b" })
    );
    expect(reason).toContain("data/bangs.json");
    expect(reason).not.toContain("data/bang-router.json");
  });

  test("names an input that appeared or disappeared", () => {
    expect(
      generatedInputStampMismatch(
        stamp({ "data/bangs.json": "a" }),
        stamp({ "data/bangs.json": "a", "data/suggest-sites.json": "c" })
      )
    ).toContain("data/suggest-sites.json");
    expect(
      generatedInputStampMismatch(
        stamp({ "data/bangs.json": "a", "data/suggest-sites.json": "c" }),
        stamp({ "data/bangs.json": "a" })
      )
    ).toContain("data/suggest-sites.json");
  });

  test("rejects a missing stamp or one from another codegen version", () => {
    const current = stamp({ "data/bangs.json": "a" });
    expect(generatedInputStampMismatch(null, current)).not.toBeNull();
    expect(
      generatedInputStampMismatch(
        { inputs: current.inputs, version: 0 },
        current
      )
    ).not.toBeNull();
  });

  test("tracks every committed build input", async () => {
    const current = await computeGeneratedInputStamp();
    expect(Object.keys(current.inputs).sort()).toEqual([
      "data/bang-prefixes.txt",
      "data/bang-router.json",
      "data/bang-strings-meta.json",
      "data/bang-suffixes.txt",
      "data/bangs.json",
      "data/suggest-sites.json",
    ]);
    for (const [path, digest] of Object.entries(current.inputs)) {
      expect(digest, `No digest recorded for ${path}`).toMatch(
        /^[0-9a-f]{64}$/
      );
    }
  });

  // The invariant the stamp exists to protect: what is in `src/generated/` was
  // built from the data currently on disk. `tests/helpers/preload.ts`
  // regenerates when it is not, so a failure here means that guard is broken.
  test("matches the generated tree on disk", async () => {
    const recorded: GeneratedInputStamp = await Bun.file(
      GENERATED_INPUT_STAMP_PATH
    ).json();
    expect(
      generatedInputStampMismatch(recorded, await computeGeneratedInputStamp())
    ).toBeNull();
  });
});
