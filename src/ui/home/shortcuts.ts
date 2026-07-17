import type { TriggerPrefix } from "../../shared/trigger-prefix";

export function setupHomeShortcuts(
  input: HTMLInputElement,
  getPrefixes: () => readonly [TriggerPrefix, TriggerPrefix]
): void {
  let awaitingInputKey = false;
  let inputKeyTimer = 0;

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;
    const key = event.key.toLowerCase();
    const unmodified = !(event.altKey || event.ctrlKey || event.metaKey);
    if (!typing && awaitingInputKey && unmodified && key === "i") {
      event.preventDefault();
      window.clearTimeout(inputKeyTimer);
      awaitingInputKey = false;
      input.focus();
      return;
    }
    awaitingInputKey = false;
    window.clearTimeout(inputKeyTimer);
    const [bangPrefix, snapPrefix] = getPrefixes();
    if (
      !typing &&
      unmodified &&
      (event.key === bangPrefix || event.key === snapPrefix)
    ) {
      event.preventDefault();
      input.focus();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.setRangeText(event.key, start, end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (!typing && unmodified && key === "g" && !event.repeat) {
      awaitingInputKey = true;
      inputKeyTimer = window.setTimeout(() => {
        awaitingInputKey = false;
      }, 700);
      return;
    }
    if (
      (!typing && event.key === "/") ||
      ((event.metaKey || event.ctrlKey) && key === "k")
    ) {
      event.preventDefault();
      input.focus();
    }
  });
}
