import {
  initializeBangData,
  isBangDataInitialized,
} from "../../src/sw/bang-data";

let dataPromise: Promise<ArrayBuffer> | null = null;

export async function loadTestBangData(): Promise<void> {
  if (!dataPromise) {
    dataPromise = Bun.file("src/generated/bangs.bin").arrayBuffer();
  }
  const buffer = await dataPromise;
  if (!isBangDataInitialized()) {
    initializeBangData(buffer);
  }
}
