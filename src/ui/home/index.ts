import type { DB } from "../db";
import { setupAddressBarSheet } from "./address-bar-setup";
import { setupBangCommand } from "./command";
import { setupHomeShortcuts } from "./shortcuts";

export function initHome(db: DB): () => Promise<void> {
  const { input, refresh } = setupBangCommand(db);
  setupHomeShortcuts(input);
  setupAddressBarSheet();
  return refresh;
}
