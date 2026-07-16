import { initializeBangData } from "../../src/sw/bang-data";

let loadPromise: Promise<void> | null = null;

export function loadTestBangData(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Bun.file("src/generated/bangs.bin")
      .arrayBuffer()
      .then(initializeBangData);
  }
  return loadPromise;
}
