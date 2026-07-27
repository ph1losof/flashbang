import { describe, expect, spyOn, test } from "bun:test";
import {
  buildGeneratedArtifacts,
  generateBinary,
  generateMeta,
  generateSparse,
  jsEscape,
  jsonEscape,
  mergeSources,
  parseCustom,
  parseDdg,
  parseKagi,
  validateBangs,
} from "../scripts/codegen";

describe("codegen string escaping", () => {
  test("preserves the minimal custom escape sets", () => {
    expect(jsEscape(`a'b\\c\nd\re"f\t`)).toBe(`a\\'b\\\\c\\nd\\re"f\t`);
    expect(jsonEscape(`a"b\\c\nd\re'f\t`)).toBe(`a\\"b\\\\c\\nd\\re'f\t`);
  });
});

describe("codegen source transforms", () => {
  test("normalizes DuckDuckGo entries and aliases", () => {
    expect(
      parseDdg(
        JSON.stringify([
          {
            t: "GH",
            ts: ["GitHub"],
            s: "GitHub",
            d: "github.com",
            u: "/?q={{{s}}}",
            r: 42,
          },
        ])
      )
    ).toEqual([
      {
        trigger: "gh",
        name: "GitHub",
        domain: "github.com",
        url: "https://duckduckgo.com/?q={}",
        relevance: 42,
      },
      {
        trigger: "github",
        name: "GitHub",
        domain: "github.com",
        url: "https://duckduckgo.com/?q={}",
        relevance: 42,
      },
    ]);
  });

  test("preserves Kagi capture encoding and snap metadata", () => {
    expect(
      parseKagi(
        JSON.stringify([
          {
            t: "Tr",
            ts: ["Translate"],
            s: "Translate",
            d: "translate.kagi.com",
            u: "/search?text={{{s}}}",
            x: "(\\w+)\\s+(.*)",
            fmt: "url_encode_placeholder",
            ad: "+site:docs.example.com",
          },
          {
            t: "Raw",
            s: "Raw Capture",
            d: "example.com",
            u: "https://example.com/{}",
            x: "(.*)",
            fmt: "raw_placeholder",
          },
        ])
      )
    ).toEqual([
      {
        trigger: "tr",
        name: "Translate",
        domain: "translate.kagi.com",
        url: "https://kagi.com/search?text={}",
        relevance: 0,
        regex: "(\\w+)\\s+(.*)",
        captureEncoding: 1,
        snap: "+site:docs.example.com",
      },
      {
        trigger: "translate",
        name: "Translate",
        domain: "translate.kagi.com",
        url: "https://kagi.com/search?text={}",
        relevance: 0,
        regex: "(\\w+)\\s+(.*)",
        captureEncoding: 1,
        snap: "+site:docs.example.com",
      },
      {
        trigger: "raw",
        name: "Raw Capture",
        domain: "example.com",
        url: "https://example.com/{}",
        relevance: 0,
        regex: "(.*)",
        captureEncoding: 0,
      },
    ]);
  });

  test("custom bangs override by trigger while preserving previous snap fallbacks", () => {
    const custom = parseCustom({
      GH: {
        name: "Custom GitHub",
        domain: "github.com",
        url: "https://github.com/search?q={}",
      },
      docs: {
        name: "Docs",
        domain: "docs.example.com",
        url: "https://docs.example.com/search?q={}",
        snap: "https://docs.example.com",
      },
    });

    expect(
      mergeSources([
        {
          name: "kagi",
          bangs: [
            {
              trigger: "gh",
              name: "GitHub",
              domain: "github.com",
              url: "https://kagi.com/search?q={}",
              relevance: 3,
              snap: "+site:github.com",
            },
          ],
        },
        { name: "custom", bangs: custom },
      ])
    ).toEqual([
      {
        trigger: "docs",
        name: "Docs",
        domain: "docs.example.com",
        url: "https://docs.example.com/search?q={}",
        relevance: 0,
        snap: "https://docs.example.com",
      },
      {
        trigger: "gh",
        name: "Custom GitHub",
        domain: "github.com",
        url: "https://github.com/search?q={}",
        relevance: 3,
        snap: "+site:github.com",
      },
    ]);
  });
});
describe("codegen artifact generators", () => {
  const sampleBangs = [
    {
      trigger: "g",
      name: "Google",
      domain: "google.com",
      url: "https://google.com/search?q={}",
      relevance: 100,
      snap: "https://google.com",
    },
    {
      trigger: "raw",
      name: "Raw",
      domain: "example.com",
      url: "https://example.com/{}",
      relevance: 5,
    },
    {
      trigger: "cap",
      name: "Capture",
      domain: "example.com",
      url: "https://example.com/$1/$2",
      relevance: 1,
      regex: "(\\w+)\\s+(.*)",
      captureEncoding: 1,
    },
  ];
  test("emits binary, sparse, trie, and metadata artifacts for regular and capture bangs", () => {
    const artifacts = buildGeneratedArtifacts(sampleBangs);

    expect(new Uint32Array(artifacts.binary.buffer, 0, 2)).toEqual(
      new Uint32Array([0x31424246, 7])
    );
    expect(new Uint32Array(artifacts.meta.buffer, 0, 2)).toEqual(
      new Uint32Array([0x314d4246, 1])
    );
    expect(artifacts.sparseJs).toContain("lookupAdvancedBang");
    expect(artifacts.sparseJs).toContain("lookupSnapOverride");
    expect(artifacts.trieJs).toContain("export const NODES");
  });

  test("keeps binary and metadata generation deterministic", () => {
    expect(generateBinary(sampleBangs)).toEqual(generateBinary(sampleBangs));
    expect(generateMeta(sampleBangs)).toEqual(generateMeta(sampleBangs));
    expect(generateSparse(sampleBangs)).toBe(generateSparse(sampleBangs));
  });
});
describe("validateBangs", () => {
  test("rejects regular bangs that fail custom URL validation", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      /* Expected validation warnings. */
    });
    try {
      const result = validateBangs([
        {
          domain: "example.com",
          name: "Valid",
          relevance: 1,
          trigger: "valid",
          url: "https://example.com/search?q={}",
        },
        {
          domain: "example.com",
          name: "Missing placeholder",
          relevance: 1,
          trigger: "missing",
          url: "https://example.com/search",
        },
        {
          domain: "example.com",
          name: "Unsafe scheme",
          relevance: 1,
          trigger: "unsafe",
          url: "javascript:alert({})",
        },
        {
          domain: "flashbang",
          name: "Settings",
          relevance: 1,
          trigger: "settings",
          url: "/settings",
        },
      ]);

      expect(result.map((bang) => bang.trigger)).toEqual(["valid", "settings"]);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
