import { describe, expect, test } from "bun:test";
import {
  lookupAdvancedBang,
  lookupSnapOverride,
} from "../src/generated/bangs-sparse.js";
import { hashFNV1a } from "../src/shared/hash";
import { initializeBangData, lookupBang } from "../src/sw/bang-data";
import { decodeBangCatalog } from "../src/ui/bang-catalog";
import { loadTestBangData } from "./helpers/bang-data";

await loadTestBangData();

const bangs: Array<{
  domain: string;
  name: string;
  regex?: string;
  trigger: string;
  url: string;
}> = await Bun.file("data/bangs.json").json();
const customBangs: Record<string, { url: string }> = await Bun.file(
  "data/custom-bangs.json"
).json();

describe("codegen round-trip", () => {
  test("every 100th bang resolves to a non-null entry", () => {
    const sample = bangs.filter((_, i) => i % 100 === 0);
    for (const bang of sample) {
      const result =
        lookupBang(bang.trigger, hashFNV1a(bang.trigger)) ??
        lookupAdvancedBang(bang.trigger);
      expect(result).not.toBeNull();
    }
  });

  test("common bangs resolve correctly", () => {
    const common = ["g", "w", "yt", "gh", "mdn", "npm"];
    for (const trigger of common) {
      const result = lookupBang(trigger, hashFNV1a(trigger));
      expect(result).not.toBeNull();
      expect(result![0]).toContain("://");
    }
  });

  test("preserves upstream site-filter search templates", () => {
    const siteFiltered = bangs.filter(
      (bang) =>
        !bang.regex && /(?:site(?::|%3a)|(?:as_)?sitesearch=)/i.test(bang.url)
    );
    expect(siteFiltered.length).toBeGreaterThan(100);
    for (const bang of siteFiltered) {
      const generated = lookupBang(bang.trigger, hashFNV1a(bang.trigger));
      expect(generated).not.toBeNull();
      expect(`${generated![0]}{}${generated![1]}`).toBe(bang.url);
    }
  });

  test("applies every curated custom override", () => {
    for (const [trigger, bang] of Object.entries(customBangs)) {
      const generated = lookupBang(trigger, hashFNV1a(trigger));
      expect(generated).not.toBeNull();
      const placeholder = bang.url.indexOf("{}");
      expect(generated).toEqual(
        placeholder === -1
          ? [bang.url, null]
          : [
              bang.url.substring(0, placeholder),
              bang.url.substring(placeholder + 2),
            ]
      );
    }
  });

  test("materializes and caches URL tuples on demand", () => {
    const hash = hashFNV1a("g");
    const first = lookupBang("g", hash);
    expect(first).not.toBeNull();
    expect(lookupBang("g", hash)).toBe(first);
  });

  test("emits the binary lookup artifact", async () => {
    const binary = await Bun.file("src/generated/bangs.bin").arrayBuffer();
    const header = new Uint32Array(binary, 0, 13);
    expect(header[0]).toBe(0x31424246);
    expect(header[1]).toBe(3);
    expect(header[2]).toBe(bangs.filter((bang) => !bang.regex).length);
    expect(header[11]).toBe(binary.byteLength);
    expect(header[3] & (header[3] - 1)).toBe(0);
    expect([2, 4]).toContain(header[12]);
  });

  test("resolves every regular bang through the perfect hash", () => {
    for (const bang of bangs) {
      if (bang.regex) {
        continue;
      }
      const generated = lookupBang(bang.trigger, hashFNV1a(bang.trigger));
      expect(generated).not.toBeNull();
      expect(
        generated![1] === null
          ? generated![0]
          : `${generated![0]}{}${generated![1]}`
      ).toBe(bang.url);
    }
  });

  test("rejects unknown triggers after perfect-hash indexing", () => {
    for (let i = 0; i < bangs.length; i += 100) {
      const trigger = `${bangs[i].trigger}~missing`;
      expect(lookupBang(trigger, hashFNV1a(trigger))).toBeNull();
    }
  });

  test("preserves metadata records and sparse captures in source order", async () => {
    const binary = await Bun.file("src/generated/bangs-meta.bin").arrayBuffer();
    const header = new Uint32Array(binary, 0, 6);
    expect(header[0]).toBe(0x314d4246);
    expect(header[1]).toBe(1);
    expect(header[2]).toBe(bangs.length);
    expect(header[3]).toBe(bangs.filter((bang) => bang.regex).length);
    expect(header[5]).toBe(binary.byteLength);

    const catalog = decodeBangCatalog(binary);
    expect(catalog.entries).toHaveLength(bangs.length);
    for (let i = 0; i < bangs.length; i += 100) {
      expect(catalog.entries[i]).toMatchObject({
        capture: Boolean(bangs[i].regex),
        domain: bangs[i].domain,
        name: bangs[i].name,
        trigger: bangs[i].trigger,
      });
    }
  });

  test("rejects malformed metadata fields, captures, and UTF-8", async () => {
    const binary = await Bun.file("src/generated/bangs-meta.bin").arrayBuffer();
    const header = new Uint32Array(binary, 0, 6);

    const invalidCapture = binary.slice(0);
    new Uint32Array(invalidCapture, 24, header[3])[0] = header[2];
    expect(() => decodeBangCatalog(invalidCapture)).toThrow(
      "Invalid bang metadata capture indexes"
    );

    const invalidFields = binary.slice(0);
    new Uint8Array(invalidFields)[invalidFields.byteLength - 1] = 1;
    expect(() => decodeBangCatalog(invalidFields)).toThrow(
      "Invalid bang metadata fields"
    );

    const invalidUtf8 = binary.slice(0);
    new Uint8Array(invalidUtf8)[header[4]] = 0xff;
    expect(() => decodeBangCatalog(invalidUtf8)).toThrow();
  });

  test("rejects invalid binary lookup metadata", async () => {
    const binary = await Bun.file("src/generated/bangs.bin").arrayBuffer();
    for (const [word, value, message] of [
      [2, 0, "Invalid binary bang entry count"],
      [3, 0, "Invalid binary bang MPHF bucket count"],
      [3, 3, "Invalid binary bang MPHF bucket count"],
      [4, 0, "Invalid binary bang trigger length width"],
      [4, 3, "Invalid binary bang trigger length width"],
      [12, 0, "Invalid binary bang MPHF displacement width"],
      [12, 3, "Invalid binary bang MPHF displacement width"],
    ] as const) {
      const invalid = binary.slice(0);
      new Uint32Array(invalid, 0, 13)[word] = value;
      expect(() => initializeBangData(invalid)).toThrow(message);
    }

    const invalidDisplacement = binary.slice(0);
    const header = new Uint32Array(invalidDisplacement, 0, 13);
    const displacements =
      header[12] === 2
        ? new Int16Array(invalidDisplacement, 13 * 4, header[3])
        : new Int32Array(invalidDisplacement, 13 * 4, header[3]);
    displacements[0] = -(header[2] + 1);
    expect(() => initializeBangData(invalidDisplacement)).toThrow(
      "Invalid binary bang MPHF displacement"
    );
  });

  test("regex bangs are emitted only through the sparse advanced lookup", () => {
    expect(lookupBang("ktr", hashFNV1a("ktr"))).toBeNull();
    const advanced = lookupAdvancedBang("ktr");
    expect(advanced?.[0]).toBe("https://translate.kagi.com/");
    expect(advanced?.[2]).toEqual([1, 2]);
    expect(advanced?.[3].source).toBe("(\\w+)\\s+(.*)");
  });

  test("Kagi ad values are emitted through the hashed snap lookup", () => {
    expect(lookupSnapOverride("g", hashFNV1a("g"), false)).toBeNull();
    expect(lookupSnapOverride("not-hn", hashFNV1a("hn"), false)).toBeNull();
    expect(lookupSnapOverride("hn", hashFNV1a("hn"), false)).toBe(
      "+site:news.ycombinator.com"
    );
    expect(lookupSnapOverride("hn", hashFNV1a("hn"), true)).toBe(
      "https://news.ycombinator.com"
    );
    expect(lookupSnapOverride("nr", hashFNV1a("nr"), false)).toBe(
      "+site:github.com/NixOS/nixpkgs"
    );
    expect(lookupSnapOverride("sklearn", hashFNV1a("sklearn"), false)).toBe(
      "+site:scikit-learn.org/stable"
    );
    expect(lookupSnapOverride("saltstack", hashFNV1a("saltstack"), true)).toBe(
      "https://docs.saltproject.io/en/latest"
    );
  });
});
