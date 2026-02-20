import { openDB, idbWrap } from "../shared/idb";

export class DB {
  private dbp: Promise<IDBDatabase> = openDB();

  private async store(name: string, mode: IDBTransactionMode = "readonly") {
    const db = await this.dbp;
    return db.transaction(name, mode).objectStore(name);
  }

  async getSetting(key: string): Promise<string | null> {
    const s = await this.store("settings");
    const r = await idbWrap(s.get(key));
    return (r as any)?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    const s = await this.store("settings", "readwrite");
    await idbWrap(s.put({ key, value }));
  }

  async getAllCustomBangs(): Promise<
    Array<{ trigger: string; name: string; url: string }>
  > {
    const s = await this.store("custom-bangs");
    return idbWrap(s.getAll()) as any;
  }

  async addCustomBang(bang: { trigger: string; name: string; url: string }) {
    const s = await this.store("custom-bangs", "readwrite");
    await idbWrap(s.put(bang));
  }

  async removeCustomBang(trigger: string) {
    const s = await this.store("custom-bangs", "readwrite");
    await idbWrap(s.delete(trigger));
  }

  async exportAll() {
    return {
      settings: {
        defaultBang: await this.getSetting("default-bang"),
        suggestProvider: await this.getSetting("suggest-provider"),
        suggestUrl: await this.getSetting("suggest-url"),
        luckyProvider: await this.getSetting("lucky-provider"),
        luckyUrl: await this.getSetting("lucky-url"),
      },
      customBangs: await this.getAllCustomBangs(),
      exported: new Date().toISOString(),
    };
  }

  async importAll(data: any) {
    if (data.settings?.defaultBang)
      await this.setSetting("default-bang", data.settings.defaultBang);
    if (data.settings?.suggestProvider)
      await this.setSetting("suggest-provider", data.settings.suggestProvider);
    if (data.settings?.suggestUrl)
      await this.setSetting("suggest-url", data.settings.suggestUrl);
    if (data.settings?.luckyProvider)
      await this.setSetting("lucky-provider", data.settings.luckyProvider);
    if (data.settings?.luckyUrl)
      await this.setSetting("lucky-url", data.settings.luckyUrl);
    if (Array.isArray(data.customBangs))
      for (const b of data.customBangs) await this.addCustomBang(b);
  }
}
