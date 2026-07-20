import {
  type CaptureEncoding,
  type CustomBangRecord,
  validateCaptureBang,
  validateSimpleBangUrl,
} from "../../shared/capture-template";
import { validateCustomTrigger } from "../../shared/custom-trigger";
import { validateSnapTarget } from "../../shared/snap-target";
import {
  DEFAULT_BANG_PREFIX,
  type TriggerPrefix,
} from "../../shared/trigger-prefix";
import type { DB } from "../db";
import { $, el } from "../dom";

type RunWrite = (write: () => Promise<unknown>) => Promise<boolean>;

async function renderCustom(
  db: DB,
  onChange: ((customBangs: CustomBangRecord[]) => void) | undefined,
  onEdit: (bang: CustomBangRecord) => void,
  onRemove: (trigger: string) => void,
  runWrite?: RunWrite,
  isCurrent: () => boolean = () => true,
  getBangPrefix: () => TriggerPrefix = () => DEFAULT_BANG_PREFIX
) {
  const custom = await db.getAllCustomBangs();
  if (!isCurrent()) {
    return;
  }
  onChange?.(custom);
  const list = $("#custom-list");
  if (custom.length === 0) {
    list.replaceChildren(
      el("div", "text-sm text-text-secondary", "No custom bangs yet")
    );
    return;
  }
  list.replaceChildren(
    ...custom.map((b) => {
      const row = el(
        "div",
        "flex items-center gap-2.5 p-2.5 mb-1.5 rounded-lg bg-bg-secondary"
      );
      const editBtn = el("button", "btn px-2 py-1 text-xs", "edit");
      editBtn.addEventListener("click", () => onEdit(b));
      const rmBtn = el("button", "btn-danger", "remove");
      rmBtn.addEventListener("click", async () => {
        rmBtn.disabled = true;
        const committed = runWrite
          ? await runWrite(() => db.removeCustomBang(b.trigger))
          : await db.removeCustomBang(b.trigger).then(() => true);
        if (!committed) {
          rmBtn.disabled = false;
          return;
        }
        onRemove(b.trigger);
        await renderCustom(
          db,
          onChange,
          onEdit,
          onRemove,
          runWrite,
          isCurrent,
          getBangPrefix
        );
      });
      row.append(
        el(
          "code",
          "px-1.5 py-0.5 rounded bg-bg-active text-xs min-w-15 text-center font-mono",
          `${getBangPrefix()}${b.trigger}`
        ),
        el("span", "flex-1 text-[13px] font-medium", b.name),
        ...(b.regex
          ? [
              el(
                "span",
                "rounded-full bg-bg-active px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary",
                "regex"
              ),
            ]
          : []),
        ...(b.snap
          ? [
              el(
                "span",
                "rounded-full bg-bg-active px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary",
                "snap"
              ),
            ]
          : []),
        editBtn,
        rmBtn
      );
      return row;
    })
  );
}

export function setupCustomBangs(
  db: DB,
  onChange?: (customBangs: CustomBangRecord[]) => void,
  runWrite?: RunWrite,
  getBangPrefix: () => TriggerPrefix = () => DEFAULT_BANG_PREFIX
) {
  const form = $<HTMLFormElement>("#add-bang-form");
  const shortcutInput = form.elements.namedItem("shortcut") as HTMLInputElement;
  const nameInput = form.elements.namedItem("name") as HTMLInputElement;
  const urlInput = form.elements.namedItem("url") as HTMLInputElement;
  const regexInput = form.elements.namedItem("regex") as HTMLInputElement;
  const snapInput = form.elements.namedItem("snap") as HTMLInputElement;
  const encodingInput = form.elements.namedItem(
    "encoding"
  ) as HTMLSelectElement;
  const advanced = form.querySelector("details") as HTMLDetailsElement;
  const submitButton = $<HTMLButtonElement>("#custom-bang-submit");
  const cancelButton = $<HTMLButtonElement>("#custom-bang-cancel");
  const error = $("#custom-bang-error");
  let editingTrigger: string | null = null;

  function resetForm(): void {
    editingTrigger = null;
    form.reset();
    advanced.open = false;
    submitButton.textContent = "Add Bang";
    cancelButton.classList.add("hidden");
    error.textContent = "";
    error.classList.add("hidden");
  }

  function editBang(bang: CustomBangRecord): void {
    editingTrigger = bang.trigger;
    shortcutInput.value = bang.trigger;
    nameInput.value = bang.name;
    urlInput.value = bang.url;
    regexInput.value = bang.regex ?? "";
    snapInput.value = bang.snap ?? "";
    encodingInput.value = bang.encoding ?? "percent";
    advanced.open = Boolean(bang.regex || bang.snap);
    submitButton.textContent = "Save Changes";
    cancelButton.classList.remove("hidden");
    error.textContent = "";
    error.classList.add("hidden");
    form.scrollIntoView({ block: "nearest" });
    shortcutInput.focus();
  }

  function removedBang(trigger: string): void {
    if (editingTrigger === trigger) {
      resetForm();
    }
  }

  let refreshVersion = 0;
  const refresh = () => {
    const version = ++refreshVersion;
    return renderCustom(
      db,
      onChange,
      editBang,
      removedBang,
      runWrite,
      () => version === refreshVersion,
      getBangPrefix
    );
  };

  void refresh();
  cancelButton.addEventListener("click", resetForm);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const rawTrigger = (fd.get("shortcut") as string).trim();
    const trigger = (
      rawTrigger.startsWith(getBangPrefix())
        ? rawTrigger.substring(1)
        : rawTrigger
    )
      .toLowerCase()
      .trim();
    const name = (fd.get("name") as string).trim();
    const url = (fd.get("url") as string).trim();
    const regex = (fd.get("regex") as string).trim();
    const snap = (fd.get("snap") as string).trim();
    const encoding = fd.get("encoding") as CaptureEncoding;
    error.textContent = "";
    error.classList.add("hidden");
    const triggerError = validateCustomTrigger(trigger);
    if (triggerError) {
      error.textContent = triggerError;
      error.classList.remove("hidden");
      return;
    }
    if (!(name && url)) {
      return;
    }
    const urlError = regex
      ? validateCaptureBang(url, regex)
      : validateSimpleBangUrl(url);
    const validationError =
      urlError ?? (snap ? validateSnapTarget(snap) : null);
    if (validationError) {
      error.textContent = validationError;
      error.classList.remove("hidden");
      return;
    }
    const bang: CustomBangRecord = {
      trigger,
      name,
      url,
      ...(regex ? { regex, encoding } : {}),
      ...(snap ? { snap } : {}),
    };
    const write =
      editingTrigger === null
        ? () => db.addCustomBang(bang)
        : () => db.updateCustomBang(editingTrigger as string, bang);
    const committed = runWrite
      ? await runWrite(write)
      : await write().then(() => true);
    if (!committed) {
      return;
    }
    resetForm();
    await refresh();
  });

  return () => {
    resetForm();
    return refresh();
  };
}
