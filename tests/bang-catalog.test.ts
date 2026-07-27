import { describe, expect, test } from "bun:test";
import { BANG_COUNT } from "../src/generated/bangs-sparse.js";
import {
  createBangMeta,
  decodeBangCatalog,
  loadBuiltinBangCatalog,
  searchBangs,
} from "../src/ui/bang-catalog";
import {
  BANG_META_HEADER_WORDS,
  BANG_META_MAGIC,
  BANG_META_VERSION,
} from "./helpers/bang-binary";
import { installManagedFetchSpy } from "./helpers/http";

const fetchSpy = installManagedFetchSpy();

describe("bang catalog", () => {
  test("bounded search applies the shared ranking order", () => {
    const entries = [
      createBangMeta("z", "Other", "example.x.dev"),
      createBangMeta("m", "Prefix x value", "m.dev"),
      createBangMeta("ax", "Other", "ax.dev"),
      createBangMeta("d", "Other", "x.example"),
      createBangMeta("n", "Xylophone", "n.dev"),
      createBangMeta("xa", "Other", "xa.dev"),
      createBangMeta("x", "Other", "x.dev"),
    ];

    expect(
      searchBangs(entries, " X ", 7).map((entry) => entry.trigger)
    ).toEqual(["x", "xa", "n", "d", "ax", "m", "z"]);
    expect(searchBangs(entries, "x", 3).map((entry) => entry.trigger)).toEqual([
      "x",
      "xa",
      "n",
    ]);
    expect(searchBangs(entries, "   ", 3)).toEqual([]);
    expect(searchBangs(entries, "x", 0)).toEqual([]);

    const reverse = [
      createBangMeta("zz", "Match", "zz.dev"),
      createBangMeta("aa", "Match", "aa.dev"),
      createBangMeta("mm", "Match", "mm.dev"),
    ];
    expect(
      searchBangs(reverse, "match", 3).map((entry) => entry.trigger)
    ).toEqual(["aa", "mm", "zz"]);
  });

  test("retries failures, then normalizes built-ins once", async () => {
    let attempts = 0;
    const fetchMock: typeof fetch = Object.assign(
      () => {
        attempts++;
        return Promise.resolve(
          attempts === 1
            ? new Response(null, { status: 503, statusText: "Unavailable" })
            : new Response(Bun.file("src/generated/bangs-meta.bin"))
        );
      },
      { preconnect: () => undefined }
    );
    fetchSpy.mockImplementation(fetchMock);

    const failed = loadBuiltinBangCatalog();
    expect(loadBuiltinBangCatalog()).toBe(failed);
    await expect(failed).rejects.toThrow(
      "Failed to load /bangs-meta.bin: 503 Unavailable"
    );

    const first = loadBuiltinBangCatalog();
    const second = loadBuiltinBangCatalog();
    expect(first).toBe(second);
    const catalog = await first;
    expect(catalog.entries).toHaveLength(BANG_COUNT);
    const google = catalog.byTrigger.get("g");
    if (!google) {
      throw new Error("Generated bang catalog is missing Google");
    }
    expect(google.name).toBe("Google");
    expect(google.capture).toBe(false);
    expect(catalog.byTrigger.get("ktr")?.capture).toBe(true);
    expect(catalog.entries).toContain(google);
    expect(fetchSpy).toHaveBeenCalledWith("/bangs-meta.bin");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("rejects malformed bang metadata headers and layouts", () => {
    expect(() => decodeBangCatalog(new ArrayBuffer(0))).toThrow(
      "Truncated bang metadata"
    );

    const header = new Uint32Array(BANG_META_HEADER_WORDS);
    header[0] = BANG_META_MAGIC;
    header[1] = BANG_META_VERSION;
    header[5] = header.byteLength;

    const unsupported = header.slice();
    unsupported[1] = 2;
    expect(() => decodeBangCatalog(unsupported.buffer)).toThrow(
      "Unsupported bang metadata"
    );

    const truncated = header.slice();
    truncated[5]++;
    expect(() => decodeBangCatalog(truncated.buffer)).toThrow(
      "Truncated bang metadata"
    );

    const invalidLayout = header.slice();
    invalidLayout[4] = header.byteLength + 4;
    expect(() => decodeBangCatalog(invalidLayout.buffer)).toThrow(
      "Invalid bang metadata layout"
    );

    const invalidCapture = new ArrayBuffer(header.byteLength + 4);
    const captureHeader = new Uint32Array(invalidCapture, 0, 6);
    captureHeader.set([
      BANG_META_MAGIC,
      BANG_META_VERSION,
      1,
      1,
      header.byteLength + 4,
      invalidCapture.byteLength,
    ]);
    new Uint32Array(invalidCapture, header.byteLength, 1)[0] = 1;
    expect(() => decodeBangCatalog(invalidCapture)).toThrow(
      "Invalid bang metadata capture indexes"
    );

    const invalidFields = new ArrayBuffer(header.byteLength + 1);
    const fieldsHeader = new Uint32Array(invalidFields, 0, 6);
    fieldsHeader.set([
      BANG_META_MAGIC,
      BANG_META_VERSION,
      1,
      0,
      header.byteLength,
      invalidFields.byteLength,
    ]);
    new Uint8Array(invalidFields)[header.byteLength] = 0x78;
    expect(() => decodeBangCatalog(invalidFields)).toThrow(
      "Invalid bang metadata fields"
    );
  });
});
