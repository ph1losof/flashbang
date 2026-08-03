import { afterEach, describe, expect, test } from "bun:test";
import { COOKIE_MAX_AGE_S } from "../src/shared/constants";
import { encodeSuggestCookieValue } from "../src/shared/suggest-cookie";
import { flashAnim, shakeAnim } from "../src/ui/animations";
import { setSuggestCookie } from "../src/ui/cookie";
import { setupVimBlurShortcut } from "../src/ui/keyboard";
import { type DomHandle, installDom, pressKey } from "./helpers/dom";

let dom: DomHandle | null = null;

function setup(html: string): DomHandle {
  dom = installDom({ html });
  return dom;
}

afterEach(() => {
  dom?.restore();
  dom = null;
});

describe("flash and shake animations", () => {
  test("restarts the animation class and clears it after the CSS duration", async () => {
    const handle = setup('<div id="target" class="flash-anim"></div>');
    const target = handle.document.querySelector("#target") as HTMLElement;

    flashAnim(target);
    expect(target.classList.contains("flash-anim")).toBe(true);

    await handle.advance(299);
    expect(target.classList.contains("flash-anim")).toBe(true);

    await handle.advance(1);
    expect(target.classList.contains("flash-anim")).toBe(false);
  });

  test("shake uses its own shorter duration and class", async () => {
    const handle = setup('<input id="target">');
    const target = handle.document.querySelector("#target") as HTMLElement;

    shakeAnim(target);
    expect(target.classList.contains("shake-anim")).toBe(true);
    expect(target.classList.contains("flash-anim")).toBe(false);

    await handle.advance(200);
    expect(target.classList.contains("shake-anim")).toBe(false);
  });

  test("re-triggering does not cancel the in-flight cleanup timer", async () => {
    const handle = setup('<div id="target"></div>');
    const target = handle.document.querySelector("#target") as HTMLElement;

    flashAnim(target);
    await handle.advance(150);
    flashAnim(target);

    // Neither call clears the other's timer, so the first one still lands at
    // 300ms and cuts the replay short. This mirrors the browser exactly.
    await handle.advance(150);
    expect(target.classList.contains("flash-anim")).toBe(false);
  });
});

describe("suggest cookie", () => {
  test("writes the encoded value with the shared max age", () => {
    const handle = setup("");

    setSuggestCookie("google", "g", "", ["gh", "so"]);

    const expected = encodeSuggestCookieValue(
      "google",
      "g",
      "",
      ["gh", "so"],
      null,
      "!",
      "@"
    );
    expect(handle.document.cookie).toBe(
      `suggest=${expected};path=/;max-age=${COOKIE_MAX_AGE_S};SameSite=Lax;Secure`
    );
  });

  test("round trips custom prefixes and a custom provider URL", () => {
    const handle = setup("");

    setSuggestCookie(
      "custom",
      "ddg",
      "https://example.com/s?q={}",
      undefined,
      "$",
      ":"
    );

    const expected = encodeSuggestCookieValue(
      "custom",
      "ddg",
      "https://example.com/s?q={}",
      undefined,
      null,
      "$",
      ":"
    );
    expect(handle.document.cookie).toContain(`suggest=${expected};`);
    expect(handle.document.cookie).toContain("SameSite=Lax;Secure");
  });
});

describe("vim blur shortcut", () => {
  const html = `
    <input id="text">
    <textarea id="area"></textarea>
    <select id="picker"><option value="a">a</option></select>
    <button id="button">go</button>
  `;

  test("blurs a focused text field on Ctrl+[", () => {
    const handle = setup(html);
    setupVimBlurShortcut();
    const input = handle.document.querySelector("#text") as HTMLInputElement;
    input.focus();
    expect(handle.document.activeElement).toBe(input);

    const event = pressKey(handle.document, "[", { ctrlKey: true });

    expect(handle.document.activeElement).not.toBe(input);
    expect(event.defaultPrevented).toBe(true);
  });

  test("also blurs textareas and selects", () => {
    const handle = setup(html);
    setupVimBlurShortcut();

    for (const selector of ["#area", "#picker"]) {
      const control = handle.document.querySelector(selector) as HTMLElement;
      control.focus();
      pressKey(handle.document, "[", { ctrlKey: true });
      expect(handle.document.activeElement).not.toBe(control);
    }
  });

  test("ignores the shortcut when the focused element is not a form control", () => {
    const handle = setup(html);
    setupVimBlurShortcut();
    const button = handle.document.querySelector("#button") as HTMLElement;
    button.focus();

    const event = pressKey(handle.document, "[", { ctrlKey: true });

    expect(handle.document.activeElement).toBe(button);
    expect(event.defaultPrevented).toBe(false);
  });

  test.each([
    ["a different key", { ctrlKey: true }, "]"],
    ["no ctrl modifier", {}, "["],
    ["ctrl with alt", { ctrlKey: true, altKey: true }, "["],
    ["ctrl with meta", { ctrlKey: true, metaKey: true }, "["],
    ["ctrl with shift", { ctrlKey: true, shiftKey: true }, "["],
  ])("ignores %s", (_label, init, key) => {
    const handle = setup(html);
    setupVimBlurShortcut();
    const input = handle.document.querySelector("#text") as HTMLInputElement;
    input.focus();

    const event = pressKey(handle.document, key, init);

    expect(handle.document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(false);
  });
});
