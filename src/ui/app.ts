import { DB } from "./db";
import { initLiquidMetal } from "./liquid-metal";

const db = new DB();

let bangsFull: Record<string, { s: string; d: string; u: string }> | null =
  null;
async function getFull() {
  if (!bangsFull) {
    const mod = await import("../generated/bangs-full.js");
    bangsFull = (mod as any).BANGS;
  }
  return bangsFull!;
}

function $<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

function notifySW(type: string) {
  navigator.serviceWorker.controller?.postMessage({ type });
}

function flashAnim(el: HTMLElement) {
  el.classList.remove("flash-anim");
  void el.offsetWidth;
  el.classList.add("flash-anim");
  setTimeout(() => el.classList.remove("flash-anim"), 300);
}

function shakeAnim(el: HTMLElement) {
  el.classList.remove("shake-anim");
  void el.offsetWidth;
  el.classList.add("shake-anim");
  setTimeout(() => el.classList.remove("shake-anim"), 200);
}

function setupModal() {
  const modal = $("#settings-modal");
  const gearBtn = $("#gear-btn");
  const closeBtn = $("#modal-close");
  const card = modal.querySelector('[role="dialog"]') as HTMLElement;

  function openModal() {
    modal.classList.replace("opacity-0", "opacity-100");
    modal.classList.replace("invisible", "visible");
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    card.classList.replace("translate-y-2", "translate-y-0");
    gearBtn.classList.add("rotate-180");
    document.body.style.overflow = "hidden";
    closeBtn.focus();
  }

  function closeModal() {
    modal.classList.replace("opacity-100", "opacity-0");
    modal.classList.replace("visible", "invisible");
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    card.classList.replace("translate-y-0", "translate-y-2");
    gearBtn.classList.remove("rotate-180");
    document.body.style.overflow = "";
    gearBtn.focus();
  }

  gearBtn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) {
      closeModal();
    }
  });

  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusable = card.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return { openModal };
}

async function init() {
  $<HTMLInputElement>("#setup-url").value = `${location.origin}?q=%s`;

  const metal = initLiquidMetal(
    $<HTMLCanvasElement>("#metal-canvas"),
    "flashbang",
    '800 128px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  );
  $(".wordmark").classList.add("has-shader");

  $("#copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(
      $<HTMLInputElement>("#setup-url").value,
    );
    flashAnim($<HTMLInputElement>("#setup-url"));
    metal.flash();
    $("#copy-btn").textContent = "Copied!";
    setTimeout(() => ($("#copy-btn").textContent = "Copy"), 1500);
  });

  const defaultBang = (await db.getSetting("default-bang")) || "g";
  const defaultInput = $<HTMLInputElement>("#default-bang");
  defaultInput.value = defaultBang;

  const full = await getFull();
  $("#bang-status").textContent = full[defaultBang]?.s || "Unknown";

  defaultInput.addEventListener("change", async () => {
    const val = defaultInput.value.replace(/^!+/, "").toLowerCase().trim();
    const f = await getFull();
    if (f[val]) {
      await db.setSetting("default-bang", val);
      notifySW("invalidate");
      flashAnim(defaultInput);
      $("#bang-status").textContent = f[val].s;
      $("#bang-status").className = "text-sm text-success";
    } else {
      shakeAnim(defaultInput);
      $("#bang-status").textContent = "Unknown bang";
      $("#bang-status").className = "text-sm text-danger";
    }
  });

  $("#bang-count").textContent =
    `${Object.keys(full).length.toLocaleString()} bangs available`;

  let timer: ReturnType<typeof setTimeout>;
  $<HTMLInputElement>("#bang-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
    if (!q) {
      $("#bang-results").innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      const f = await getFull();
      const hits = Object.entries(f)
        .filter(
          ([t, b]) =>
            t.includes(q) || b.s.toLowerCase().includes(q) || b.d.includes(q),
        )
        .sort((a, b) => {
          const as_ = a[0].startsWith(q) ? 0 : 1;
          const bs_ = b[0].startsWith(q) ? 0 : 1;
          return as_ - bs_ || a[0].length - b[0].length;
        })
        .slice(0, 20);
      $("#bang-results").innerHTML =
        hits.length === 0
          ? '<div class="py-3 text-center text-sm text-text-secondary">No matches</div>'
          : hits
              .map(
                ([t, b]) =>
                  `<div class="flex items-center gap-3 px-2.5 py-2 rounded-lg bg-bg-secondary mb-1">
              <code class="px-1.5 py-0.5 rounded bg-bg-active text-xs min-w-15 text-center font-mono">!${t}</code>
              <span class="flex-1 text-[13px] font-medium">${b.s}</span>
              <span class="text-[11px] text-text-secondary max-w-30 overflow-hidden text-ellipsis whitespace-nowrap">${b.d}</span>
            </div>`,
              )
              .join("");
    }, 200);
  });

  await renderCustom();
  $<HTMLFormElement>("#add-bang-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const trigger = (fd.get("shortcut") as string)
      .replace(/^!+/, "")
      .toLowerCase()
      .trim();
    const name = (fd.get("name") as string).trim();
    const url = (fd.get("url") as string).trim();
    if (!trigger || !name || !url) return;
    await db.addCustomBang({ trigger, name, url });
    notifySW("invalidate");
    form.reset();
    await renderCustom();
  });

  $("#export-btn").addEventListener("click", async () => {
    const data = await db.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `flashbang-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $<HTMLInputElement>("#import-file").addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await db.importAll(data);
      notifySW("invalidate");
      $("#import-status").textContent = "Imported successfully";
      $("#import-status").className = "text-sm mt-2 block text-success";
      setTimeout(() => location.reload(), 1000);
    } catch {
      $("#import-status").textContent = "Invalid file";
      $("#import-status").className = "text-sm mt-2 block text-danger";
    }
  });

  const { openModal } = setupModal();
  if (location.pathname === "/settings") {
    openModal();
    history.replaceState(null, "", "/");
  }
}

async function renderCustom() {
  const custom = await db.getAllCustomBangs();
  if (custom.length === 0) {
    $("#custom-list").innerHTML =
      '<div class="text-sm text-text-secondary">No custom bangs yet</div>';
    return;
  }
  $("#custom-list").innerHTML = custom
    .map(
      (b) =>
        `<div class="flex items-center gap-2.5 p-2.5 mb-1.5 rounded-lg bg-bg-secondary">
      <code class="px-1.5 py-0.5 rounded bg-bg-active text-xs min-w-15 text-center font-mono">!${b.trigger}</code>
      <span class="flex-1 text-[13px] font-medium">${b.name}</span>
      <button class="btn-danger" data-rm="${b.trigger}">remove</button>
    </div>`,
    )
    .join("");
  $("#custom-list")
    .querySelectorAll("[data-rm]")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        await db.removeCustomBang((btn as HTMLElement).dataset.rm!);
        notifySW("invalidate");
        await renderCustom();
      });
    });
}

init();
