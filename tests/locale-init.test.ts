import { expect, test } from "bun:test";
import { substituteLocale } from "../src/sw/locale";

test("resolves from the browser without any explicit setActiveLocale call", () => {
  const url = substituteLocale(
    "https://{lang}.wikipedia.org/w/index.php?search="
  );
  expect(url).not.toContain("{");
  expect(url).toMatch(/^https:\/\/[a-z-]+\.wikipedia\.org\//);
});
