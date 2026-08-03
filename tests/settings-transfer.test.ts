import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupSettingsTransfer } from "../src/ui/settings/transfer";
import { fire } from "./helpers/dom";
import {
  createSettingsHarness,
  type SettingsHarness,
  type SettingsHarnessOptions,
} from "./helpers/settings-dom";

let harness: SettingsHarness | null = null;
let consoleError: ReturnType<typeof spyOn> | null = null;

interface TransferFixture {
  exportButton: HTMLButtonElement;
  harness: SettingsHarness;
  importFile: HTMLInputElement;
  imported: number;
  objectUrls: string[];
  revokedUrls: string[];
  status: HTMLElement;
}

async function setup(
  options: SettingsHarnessOptions = {}
): Promise<TransferFixture> {
  consoleError ??= spyOn(console, "error").mockImplementation(() => undefined);
  harness = await createSettingsHarness(options);
  const active = harness;
  const exportButton = active.query<HTMLButtonElement>("#export-btn");
  const importFile = active.query<HTMLInputElement>("#import-file");
  const fixture: TransferFixture = {
    exportButton,
    harness: active,
    importFile,
    imported: 0,
    objectUrls: [],
    revokedUrls: [],
    status: active.query("#import-status"),
  };

  // `URL.createObjectURL` is not implemented for the fake Blob plumbing.
  const createObjectURL = spyOn(URL, "createObjectURL").mockImplementation(
    () => {
      const url = `blob:flashbang/${fixture.objectUrls.length}`;
      fixture.objectUrls.push(url);
      return url;
    }
  );
  const revokeObjectURL = spyOn(URL, "revokeObjectURL").mockImplementation(
    (url: string) => {
      fixture.revokedUrls.push(url);
    }
  );
  objectUrlSpies = [createObjectURL, revokeObjectURL];

  setupSettingsTransfer({
    db: active.db,
    exportButton,
    importFile,
    onImported: () => {
      fixture.imported++;
      return Promise.resolve();
    },
    runWrite: active.writer.run,
  });
  return fixture;
}

let objectUrlSpies: ReturnType<typeof spyOn>[] = [];

afterEach(() => {
  for (const spy of objectUrlSpies) {
    spy.mockRestore();
  }
  objectUrlSpies = [];
  consoleError?.mockRestore();
  consoleError = null;
  harness?.restore();
  harness = null;
});

function selectFile(fixture: TransferFixture, contents: string): void {
  fixture.importFile.files = [
    new File([contents], "flashbang.json", { type: "application/json" }),
  ] as unknown as FileList & readonly File[];
}

const VALID_EXPORT = JSON.stringify({
  schemaVersion: 2,
  exported: "2026-01-01T00:00:00.000Z",
  settings: { defaultBang: "ddg" },
  customBangs: [{ trigger: "me", name: "Me", url: "https://me.test/?q={}" }],
});

describe("exporting settings", () => {
  test("downloads a dated JSON snapshot and reports success", async () => {
    const fixture = await setup();

    fire(fixture.exportButton, "click");
    await fixture.harness.handle.settle();

    expect(fixture.objectUrls).toHaveLength(1);
    expect(fixture.revokedUrls).toEqual(fixture.objectUrls);
    expect(fixture.status.textContent).toBe("Exported settings successfully");
    expect(fixture.status.className).toContain("text-success");
  });

  test("reports the failure message when the export cannot be built", async () => {
    const fixture = await setup();
    const failing = spyOn(fixture.harness.db, "exportAll").mockImplementation(
      () => Promise.reject(new Error("custom bangs are invalid"))
    );

    fire(fixture.exportButton, "click");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toBe(
      "Export failed: custom bangs are invalid"
    );
    expect(fixture.status.className).toContain("text-danger");
    failing.mockRestore();
  });

  test("falls back to a generic message for a non-Error rejection", async () => {
    const fixture = await setup();
    const failing = spyOn(fixture.harness.db, "exportAll").mockImplementation(
      () => Promise.reject("nope")
    );

    fire(fixture.exportButton, "click");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toBe("Export failed");
    failing.mockRestore();
  });
});

describe("importing settings", () => {
  test("previews, confirms, then applies the import", async () => {
    const fixture = await setup({ confirm: true });
    selectFile(fixture, VALID_EXPORT);

    fire(fixture.importFile, "change");
    await fixture.harness.handle.settle();

    expect(fixture.harness.handle.confirmCalls[0]).toContain(
      "Replace current settings?"
    );
    expect(fixture.imported).toBe(1);
    expect(fixture.status.textContent).toContain("Imported:");
    expect(fixture.status.className).toContain("text-success");
    expect(await fixture.harness.db.getSetting("default-bang")).toBe("ddg");
    // The file input is always cleared so re-picking the same file re-fires.
    expect(fixture.importFile.value).toBe("");
  });

  test("cancelling leaves the database untouched", async () => {
    const fixture = await setup({ confirm: false });
    selectFile(fixture, VALID_EXPORT);

    fire(fixture.importFile, "change");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toContain("Import canceled:");
    expect(fixture.imported).toBe(0);
    expect(await fixture.harness.db.getSetting("default-bang")).toBeNull();
  });

  test("does nothing when no file is selected", async () => {
    const fixture = await setup();

    fire(fixture.importFile, "change");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toBe("");
    expect(fixture.harness.handle.confirmCalls).toHaveLength(0);
  });

  test("surfaces a parse failure as an error", async () => {
    const fixture = await setup();
    selectFile(fixture, "{ not json");

    fire(fixture.importFile, "change");
    await fixture.harness.handle.settle();

    expect(fixture.status.className).toContain("text-danger");
    expect(fixture.status.textContent).not.toBe("");
    expect(fixture.imported).toBe(0);
    expect(fixture.importFile.value).toBe("");
  });

  test("reports a rejected custom bang count as a warning", async () => {
    const fixture = await setup({ confirm: true });
    selectFile(
      fixture,
      JSON.stringify({
        schemaVersion: 2,
        exported: "2026-01-01T00:00:00.000Z",
        settings: { defaultBang: "g" },
        customBangs: [
          { trigger: "ok", name: "Ok", url: "https://ok.test/?q={}" },
          { trigger: "bad", name: "Bad", url: "not a url" },
        ],
      })
    );

    fire(fixture.importFile, "change");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toContain("1 rejected");
    expect(fixture.status.className).toContain("text-danger");
  });

  test("treats a failed commit as an import failure", async () => {
    const fixture = await setup({ confirm: true });
    selectFile(fixture, VALID_EXPORT);
    let call = 0;
    const failing = spyOn(fixture.harness.db, "importAll").mockImplementation(
      () => {
        call++;
        // The preview pass must still succeed so the confirm prompt appears.
        if (call === 1) {
          return Promise.resolve({
            acceptedCustomBangs: 1,
            importedSettings: 1,
            rejectedCustomBangs: 0,
            replaced: true,
          });
        }
        return Promise.reject(new Error("write blocked"));
      }
    );

    fire(fixture.importFile, "change");
    await fixture.harness.handle.settle();

    expect(fixture.status.textContent).toBe("Import failed");
    expect(fixture.imported).toBe(0);
    failing.mockRestore();
  });
});
