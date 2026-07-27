import { describe, expect, test } from "bun:test";
import { compileCaptureUrl } from "../src/shared/capture-template";
import { compileSnapTarget } from "../src/shared/snap-target";
import {
  type CustomUrlParts,
  compileTriggerSyntax,
  type RedirectSettings,
  redirectRawUrl,
  redirectUrl,
  type UrlParts,
} from "../src/sw/redirect";
import { loadTestBangData } from "./helpers/bang-data";
import {
  referenceRedirectRawUrl,
  referenceRedirectUrl,
} from "./helpers/reference-redirect";

await loadTestBangData();

const DEFAULT_URL: UrlParts = ["https://default.example/search?q=", ""];
const LUCKY_URL: UrlParts = ["https://lucky.example/?q=", ""];

function splitUrl(template: string): UrlParts {
  const placeholder = template.indexOf("{}");
  return placeholder === -1
    ? [template, null]
    : [template.substring(0, placeholder), template.substring(placeholder + 2)];
}

const capturePercent = compileCaptureUrl(
  "https://capture.example/$1/$2",
  "(\\w+)\\s+(.*)",
  "percent"
)!;
const capturePlus = compileCaptureUrl(
  "https://plus.example/$1?q=$2",
  "(\\w+)\\s+(.*)",
  "plus"
)!;
const captureRaw = compileCaptureUrl("https://raw.example/?$1", "(.*)", "raw")!;
const docsSnap = compileSnapTarget("docs.example/reference")!;

const CUSTOM: Record<string, CustomUrlParts> = {
  cap: capturePercent,
  docs: ["https://search.example/?q=", "", docsSnap],
  g: splitUrl("https://google.example/search?q={}"),
  gh: splitUrl("https://github.example/search?q={}"),
  mdn: splitUrl("https://mdn.example/search?q={}"),
  multi: ["https://multi.example/u/", "/again/{}?q={}"],
  path: splitUrl("https://path.example/u/{}"),
  pluscap: capturePlus,
  rawcap: captureRaw,
  so: splitUrl("https://stackoverflow.example/search?q={}"),
  w: splitUrl("https://wikipedia.example/search?q={}"),
};

const SETTINGS: Array<readonly [string, RedirectSettings]> = [
  ["default", { custom: CUSTOM, defaultUrl: DEFAULT_URL, luckyUrl: LUCKY_URL }],
  [
    "custom syntax",
    {
      custom: CUSTOM,
      defaultUrl: DEFAULT_URL,
      luckyUrl: LUCKY_URL,
      syntax: compileTriggerSyntax("$", "~"),
    },
  ],
  ["no lucky", { custom: CUSTOM, defaultUrl: DEFAULT_URL, luckyUrl: null }],
  [
    "default suffix",
    {
      custom: CUSTOM,
      defaultUrl: ["https://default.example/search?q=", "&lang=en"],
      luckyUrl: LUCKY_URL,
    },
  ],
];

function assertRaw(query: string, settings: RedirectSettings, context: string) {
  const expected = referenceRedirectRawUrl(query, settings);
  const actual = redirectRawUrl(query, settings);
  expect(actual, `${context}\nraw query: ${JSON.stringify(query)}`).toBe(
    expected
  );
}

function assertDecoded(
  query: string,
  settings: RedirectSettings,
  context: string
) {
  let expected: string | Error;
  let actual: string | Error;
  try {
    expected = referenceRedirectUrl(query, settings);
  } catch (error) {
    expected = error as Error;
  }
  try {
    actual = redirectUrl(query, settings);
  } catch (error) {
    actual = error as Error;
  }
  const normalizedExpected =
    expected instanceof Error
      ? `${expected.name}:${expected.message}`
      : expected;
  const normalizedActual =
    actual instanceof Error ? `${actual.name}:${actual.message}` : actual;
  expect(
    normalizedActual,
    `${context}\ndecoded query: ${JSON.stringify(query)}`
  ).toBe(normalizedExpected);
}

describe("redirect differential grammar", () => {
  test("covers every bang syntax position and raw structural encoding", () => {
    const terms = ["cats", "two+words", "two%20words", "%E7%8C%AB", "%ZZ"];
    const spaces = ["+", "%20"];
    const markers = ["!", "%21"];
    for (const trigger of ["g", "GH", "cap", "missingzz"]) {
      for (const term of terms) {
        for (const space of spaces) {
          for (const marker of markers) {
            for (const query of [
              `${marker}${trigger}${space}${term}`,
              `${trigger}${marker}${space}${term}`,
              `${term}${space}${marker}${trigger}`,
              `${term}${space}${trigger}${marker}`,
            ]) {
              assertRaw(query, SETTINGS[0][1], "bang syntax matrix");
            }
          }
        }
      }
    }
  });

  test("covers trimming, unicode, percent encodings, and malformed encodings", () => {
    const queries = [
      "",
      "+%20+",
      "+!g+cats+",
      "%20%21g%20cats%20",
      "!g+%E4%B8%AD%E6%96%87",
      "!g+%F0%9F%98%80",
      "!g+%E0%A4%A",
      "!g+%",
      "!g+%2",
      "!g+%GG",
      "!g+a%2Fb%2fc",
      "!g+a%26b%3Dc%3Fd",
      "!path+two+words%2Fchild",
      "!multi+two+words%2Fchild",
      "literal raw spaces",
      "!g+\u4e2d\u6587",
      "!g+\ud83d\ude00",
      "!g+\u0000",
    ];
    for (const query of queries) {
      assertRaw(query, SETTINGS[0][1], "encoding corpus");
    }
  });

  test("covers bang and snap precedence", () => {
    for (const query of [
      "!g+@w+cats",
      "%21g+%40w+cats",
      "@w+!g+cats",
      "%40w+%21g+cats",
      "cats+@w+!g",
      "cats+!g+@w",
      "cats+@w+g!",
      "cats+gh!+@w",
      "cats+@missingzz+!missingzz",
    ]) {
      assertRaw(query, SETTINGS[0][1], "bang/snap precedence corpus");
    }
  });

  test("recognizes an encoded trailing bang after an earlier literal bang", () => {
    const query = "noise!x+cats+g%21";
    assertRaw(query, SETTINGS[0][1], "mixed marker-width regression");
    expect(redirectRawUrl(query, SETTINGS[0][1])).toBe(
      "https://google.example/search?q=noise!x+cats"
    );
  });

  test("covers custom capture templates and capture failures", () => {
    for (const query of [
      "!cap+en+hello+world",
      "en+hello+world+cap!",
      "hello+world+!cap",
      "!pluscap+en+hello+world",
      "!rawcap+q%3Dhello%26lang%3Den",
      "!cap+missing-group",
      "!cap+en+%E0%A4%A",
      `!cap+en+${"a".repeat(2049)}`,
      "@cap+translation",
    ]) {
      assertRaw(query, SETTINGS[0][1], "capture corpus");
    }
  });

  test("covers snap chains, limits, duplicates, and encoded separators", () => {
    for (const query of [
      "@gh+query",
      "%40gh%2Cso+query",
      "query+@gh,so,mdn,w",
      "@docs,gh+query",
      "@gh,gh,so+query",
      "@gh,,so+query",
      "@gh,missingzz+query",
      "@g,gh,so,mdn,w,docs,cap,path+query",
      "@g,gh,so,mdn,w,docs,cap,path,rawcap+query",
      "@gh,so",
      "query+%40gh%2cso",
    ]) {
      assertRaw(query, SETTINGS[0][1], "snap chain corpus");
    }
  });

  test("covers configured marker pairs", () => {
    const customSyntax = SETTINGS[1][1];
    for (const query of [
      "$g+cats",
      "%24g%20cats",
      "g$+cats",
      "cats+$g",
      "cats+g$",
      "~gh+query",
      "%7Egh%2Cso+query",
      "query+~docs",
      "!g+cats",
      "@gh+query",
    ]) {
      assertRaw(query, customSyntax, "configured syntax corpus");
    }
  });
});

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function choose<T>(next: () => number, values: readonly T[]): T {
  return values[next() % values.length];
}

function randomText(next: () => number, maxLength = 24): string {
  const atoms = [
    "a",
    "Z",
    "0",
    "-",
    "_",
    ".",
    "+",
    "%20",
    "%2F",
    "%2f",
    "%21",
    "%40",
    "%2C",
    "%",
    "%2",
    "%GG",
    "%E0%A4%A",
    "%E4%B8%AD",
    "!",
    "@",
    "$",
    "~",
    "\\",
    ",",
    "&",
    "=",
    "?",
    "\u4e2d",
    "\ud83d\ude00",
  ];
  const count = next() % (maxLength + 1);
  let result = "";
  for (let index = 0; index < count; index++) {
    result += choose(next, atoms);
  }
  return result;
}

function randomTrigger(next: () => number): string {
  return choose(next, [
    "g",
    "gh",
    "w",
    "docs",
    "cap",
    "pluscap",
    "rawcap",
    `missingzz${next() % 100}`,
  ]);
}

function randomRawCase(next: () => number, customSyntax: boolean): string {
  const bang = customSyntax
    ? choose(next, ["$", "%24"])
    : choose(next, ["!", "%21"]);
  const snap = customSyntax
    ? choose(next, ["~", "%7E", "%7e"])
    : choose(next, ["@", "%40"]);
  const space = choose(next, ["+", "%20"]);
  const comma = choose(next, [",", "%2C", "%2c"]);
  const trigger = randomTrigger(next);
  const term = randomText(next, 8);
  const chainLength = 1 + (next() % 10);
  const chain = Array.from({ length: chainLength }, () =>
    randomTrigger(next)
  ).join(comma);
  const query = choose(next, [
    term,
    `${bang}${trigger}${space}${term}`,
    `${trigger}${bang}${space}${term}`,
    `${term}${space}${bang}${trigger}`,
    `${term}${space}${trigger}${bang}`,
    `${bang}${space}${term}`,
    `${term}${space}${bang}`,
    `${snap}${chain}${space}${term}`,
    `${term}${space}${snap}${chain}`,
    `${snap}${trigger}${space}${bang}${randomTrigger(next)}${space}${term}`,
    randomText(next),
  ]);
  return `${choose(next, ["", "+", "%20"])}${query}${choose(next, ["", "+", "%20"])}`;
}

describe("redirect deterministic fuzz", () => {
  test("compares structured random raw queries", () => {
    const seed = 0x5eedc0de;
    const next = xorshift32(seed);
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const settingIndex = next() % SETTINGS.length;
      const [name, settings] = SETTINGS[settingIndex];
      const query = randomRawCase(next, name === "custom syntax");
      assertRaw(
        query,
        settings,
        `structured fuzz seed=0x${seed.toString(16)} iteration=${iteration} settings=${name}`
      );
    }
  });

  test("compares arbitrary random raw input", () => {
    const seed = 0xa11ce5ed;
    const next = xorshift32(seed);
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const [name, settings] = SETTINGS[next() % SETTINGS.length];
      const query = randomText(next, 32);
      assertRaw(
        query,
        settings,
        `arbitrary fuzz seed=0x${seed.toString(16)} iteration=${iteration} settings=${name}`
      );
    }
  });

  test("compares decoded unicode and arbitrary JavaScript strings", () => {
    const seed = 0xdec0ded;
    const next = xorshift32(seed);
    const decodedAtoms = [
      "a",
      "Z",
      " ",
      "!",
      "@",
      "$",
      "~",
      "/",
      "&",
      "=",
      "?",
      "\\",
      "\u00e9",
      "\u4e2d",
      "\ud83d\ude00",
      "\ud800",
      "\udfff",
    ];
    for (let iteration = 0; iteration < 5_000; iteration++) {
      const [name, settings] = SETTINGS[next() % SETTINGS.length];
      const count = next() % 32;
      let query = "";
      for (let index = 0; index < count; index++) {
        query += choose(next, decodedAtoms);
      }
      assertDecoded(
        query,
        settings,
        `decoded fuzz seed=0x${seed.toString(16)} iteration=${iteration} settings=${name}`
      );
    }
  });
});
