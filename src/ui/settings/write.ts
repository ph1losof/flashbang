import { $ } from "../dom";
import {
  beginHotBootUpdate,
  endHotBootUpdate,
  invalidateRedirectSettings,
} from "../sw-bridge";

export type SettingControl =
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLButtonElement;

export interface WriteOptions {
  key?: string;
  onCommit?: () => void;
  onFailure?: () => void;
}

export type RunWrite = (
  write: () => Promise<unknown>,
  options?: WriteOptions
) => Promise<boolean>;

export interface SettingsWriter {
  clearErrors: () => void;
  clearValidationError: (
    key: string,
    input?: HTMLInputElement | HTMLSelectElement
  ) => void;
  lock: (control: SettingControl) => void;
  run: RunWrite;
  showValidationError: (
    key: string,
    message: string,
    input?: HTMLInputElement | HTMLSelectElement
  ) => void;
}

export function createSettingsWriter(
  controls: readonly SettingControl[]
): SettingsWriter {
  const saveStatus = $("#settings-save-status");
  const savedIcon = $("#settings-saved-icon");
  const savingIcon = $("#settings-saving-icon");
  const errorIcon = $("#settings-error-icon");
  const permanentlyDisabled = new Set(
    controls.filter((control) => control.disabled)
  );
  let pendingWrites = 0;
  let completedWrites = 0;
  let showSavingIndicator = false;
  let savingIndicatorTimer: ReturnType<typeof setTimeout> | null = null;
  const failedWrites = new Set<string>();
  const validationErrors = new Map<string, string>();
  let writeChain: Promise<void> = Promise.resolve();

  function render(): void {
    saveStatus.dataset.pending = String(pendingWrites);
    saveStatus.dataset.writeCount = String(completedWrites);
    if (pendingWrites > 0) {
      saveStatus.dataset.state = "saving";
      if (showSavingIndicator) {
        saveStatus.setAttribute("aria-label", "Saving settings");
        saveStatus.removeAttribute("title");
        savedIcon.classList.add("hidden");
        savingIcon.classList.remove("hidden");
        errorIcon.classList.add("hidden");
      }
    } else if (validationErrors.size > 0 || failedWrites.size > 0) {
      const message =
        validationErrors.values().next().value || "Could not save settings";
      saveStatus.dataset.state = "error";
      saveStatus.dataset.failed = [...failedWrites].join(",");
      saveStatus.setAttribute("aria-label", message);
      saveStatus.setAttribute("title", message);
      savedIcon.classList.add("hidden");
      savingIcon.classList.add("hidden");
      errorIcon.classList.remove("hidden");
    } else {
      saveStatus.dataset.state = "saved";
      delete saveStatus.dataset.failed;
      saveStatus.setAttribute("aria-label", "Settings saved");
      saveStatus.removeAttribute("title");
      savedIcon.classList.remove("hidden");
      savingIcon.classList.add("hidden");
      errorIcon.classList.add("hidden");
    }
    for (const control of controls) {
      control.disabled = pendingWrites > 0 || permanentlyDisabled.has(control);
    }
  }

  const run: RunWrite = (write, options = {}) => {
    const key = options.key || "custom-bangs";
    const affectsHotBoot =
      key === "custom-bangs" ||
      key === "bang-prefix" ||
      key === "snap-prefix" ||
      key === "default-bang" ||
      key === "lucky-provider" ||
      key === "lucky-url" ||
      key === "import";
    const wasIdle = pendingWrites === 0;
    pendingWrites++;
    if (wasIdle) {
      showSavingIndicator = false;
      if (savingIndicatorTimer !== null) {
        clearTimeout(savingIndicatorTimer);
      }
      savingIndicatorTimer = setTimeout(() => {
        savingIndicatorTimer = null;
        if (pendingWrites > 0) {
          showSavingIndicator = true;
          render();
        }
      }, 250);
    }
    render();
    const task = writeChain.then(async () => {
      const hotBootToken = affectsHotBoot ? await beginHotBootUpdate() : null;
      try {
        await write();
      } catch (error) {
        if (hotBootToken) {
          await endHotBootUpdate(hotBootToken).catch(console.error);
        }
        throw error;
      }
      if (hotBootToken) {
        await endHotBootUpdate(hotBootToken).catch(console.error);
      } else if (affectsHotBoot) {
        await invalidateRedirectSettings();
      }
      failedWrites.delete(key);
      options.onCommit?.();
    });
    writeChain = task.then(
      () => undefined,
      () => undefined
    );
    return task
      .then(() => true)
      .catch((error) => {
        failedWrites.add(key);
        options.onFailure?.();
        console.error("Failed to save settings", error);
        return false;
      })
      .finally(() => {
        pendingWrites--;
        completedWrites++;
        if (pendingWrites === 0) {
          if (savingIndicatorTimer !== null) {
            clearTimeout(savingIndicatorTimer);
            savingIndicatorTimer = null;
          }
          showSavingIndicator = false;
        }
        render();
      });
  };

  window.addEventListener("beforeunload", (event) => {
    if (pendingWrites > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  render();

  return {
    clearErrors() {
      validationErrors.clear();
      failedWrites.clear();
      render();
    },
    clearValidationError(key, input) {
      validationErrors.delete(key);
      input?.removeAttribute("aria-invalid");
      render();
    },
    lock(control) {
      permanentlyDisabled.add(control);
      control.disabled = true;
    },
    run,
    showValidationError(key, message, input) {
      validationErrors.set(key, message);
      input?.setAttribute("aria-invalid", "true");
      render();
    },
  };
}
