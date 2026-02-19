const DB_NAME = "flashbang";
const DB_VERSION = 1;

export class DB {
  private dbp: Promise<IDBDatabase>;

  constructor() {
    this.dbp = new Promise((ok, err) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("settings"))
          db.createObjectStore("settings", { keyPath: "key" });
        if (!db.objectStoreNames.contains("custom-bangs"))
          db.createObjectStore("custom-bangs", { keyPath: "trigger" });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => err(r.error);
    });
  }

  private async store(name: string, mode: IDBTransactionMode = "readonly") {
    const db = await this.dbp;
    return db.transaction(name, mode).objectStore(name);
  }

  private wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((ok, err) => {
      req.onsuccess = () => ok(req.result);
      req.onerror = () => err(req.error);
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const s = await this.store("settings");
    const r = await this.wrap(s.get(key));
    return (r as any)?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    const s = await this.store("settings", "readwrite");
    await this.wrap(s.put({ key, value }));
  }

  async getAllCustomBangs(): Promise<
    Array<{ trigger: string; name: string; url: string }>
  > {
    const s = await this.store("custom-bangs");
    return this.wrap(s.getAll()) as any;
  }

  async addCustomBang(bang: { trigger: string; name: string; url: string }) {
    const s = await this.store("custom-bangs", "readwrite");
    await this.wrap(s.put(bang));
  }

  async removeCustomBang(trigger: string) {
    const s = await this.store("custom-bangs", "readwrite");
    await this.wrap(s.delete(trigger));
  }

  async exportAll() {
    return {
      settings: {
        defaultBang: await this.getSetting("default-bang"),
        suggestProvider: await this.getSetting("suggest-provider"),
        suggestUrl: await this.getSetting("suggest-url"),
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
    if (Array.isArray(data.customBangs))
      for (const b of data.customBangs) await this.addCustomBang(b);
  }
}
