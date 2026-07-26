interface StoreRecord {
  keyPath: string;
  records: Map<string, unknown>;
}

interface DbRecord {
  stores: Map<string, StoreRecord>;
  version: number;
}

type SuccessRequest<T> = IDBRequest<T> & {
  result: T;
  error: null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
};

type OpenRequest = IDBOpenDBRequest &
  SuccessRequest<IDBDatabase> & {
    onupgradeneeded:
      | ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown)
      | null;
  };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function makeRequest<T>(result: T, onSettled?: () => void): SuccessRequest<T> {
  const req = {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  } as unknown as SuccessRequest<T>;
  queueMicrotask(() => {
    req.onsuccess?.call(req, new Event("success"));
    onSettled?.();
  });
  return req;
}

class FakeObjectStore {
  constructor(
    private readonly store: StoreRecord,
    private readonly transaction?: FakeTransaction
  ) {}

  private request<T>(result: T): IDBRequest<T> {
    return this.transaction?.request(result) ?? makeRequest(result);
  }

  clear(): IDBRequest<undefined> {
    this.store.records.clear();
    return this.request(undefined);
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    this.store.records.delete(String(key));
    return this.request(undefined);
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    const value = this.store.records.get(String(key));
    return this.request(value === undefined ? undefined : clone(value));
  }

  getAll(): IDBRequest<unknown[]> {
    return this.request([...this.store.records.values()].map(clone));
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    const key = (value as Record<string, unknown>)[this.store.keyPath];
    this.store.records.set(String(key), clone(value));
    return this.request<IDBValidKey>(String(key));
  }
}

class FakeTransaction {
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;

  private completionQueued = false;
  private finished = false;
  private pending = 0;

  constructor(private readonly db: DbRecord) {
    this.queueCompletion();
  }

  request<T>(result: T): SuccessRequest<T> {
    this.pending++;
    return makeRequest(result, () => {
      this.pending--;
      this.queueCompletion();
    });
  }

  private queueCompletion(): void {
    if (this.completionQueued || this.finished) {
      return;
    }
    this.completionQueued = true;
    queueMicrotask(() => {
      this.completionQueued = false;
      if (this.pending !== 0 || this.finished) {
        return;
      }
      this.finished = true;
      this.oncomplete?.call(
        this as unknown as IDBTransaction,
        new Event("complete")
      );
    });
  }

  objectStore(name: string): IDBObjectStore {
    const store = this.db.stores.get(name);
    if (!store) {
      throw new Error(`Object store not found: ${name}`);
    }
    return new FakeObjectStore(store, this) as unknown as IDBObjectStore;
  }
}

class FakeDb {
  constructor(private readonly db: DbRecord) {}

  get objectStoreNames(): DOMStringList {
    const names = [...this.db.stores.keys()];
    return {
      ...names,
      length: names.length,
      contains(name: string): boolean {
        return names.includes(name);
      },
      item(index: number): string | null {
        return names[index] ?? null;
      },
    } as unknown as DOMStringList;
  }

  close(): void {
    // no-op
  }

  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters
  ): IDBObjectStore {
    const keyPath =
      typeof options?.keyPath === "string" && options.keyPath
        ? options.keyPath
        : "id";
    const record: StoreRecord = { keyPath, records: new Map() };
    this.db.stores.set(name, record);
    return new FakeObjectStore(record) as unknown as IDBObjectStore;
  }

  transaction(
    _storeNames: string | string[],
    _mode?: IDBTransactionMode
  ): IDBTransaction {
    return new FakeTransaction(this.db) as unknown as IDBTransaction;
  }
}

class FakeIndexedDb {
  private readonly dbs = new Map<string, DbRecord>();

  open(name: string, version?: number): IDBOpenDBRequest {
    const req = {
      result: undefined as unknown as IDBDatabase,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    } as OpenRequest;

    queueMicrotask(() => {
      const existing = this.dbs.get(name);
      const oldVersion = existing?.version ?? 0;
      const targetVersion = version ?? Math.max(oldVersion, 1);
      const dbRecord = existing ?? { version: 0, stores: new Map() };
      const fakeDb = new FakeDb(dbRecord) as unknown as IDBDatabase;

      if (oldVersion < targetVersion) {
        dbRecord.version = targetVersion;
        this.dbs.set(name, dbRecord);
        req.result = fakeDb;
        req.onupgradeneeded?.call(req, {
          oldVersion,
        } as unknown as IDBVersionChangeEvent);
      } else {
        this.dbs.set(name, dbRecord);
        req.result = fakeDb;
      }

      req.onsuccess?.call(req, new Event("success"));
    });

    return req;
  }
}

export function installFakeIndexedDb(): () => void {
  const previous = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB: unknown }).indexedDB = new FakeIndexedDb();
  return () => {
    if (previous === undefined) {
      (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
      return;
    }
    (globalThis as { indexedDB: unknown }).indexedDB = previous;
  };
}

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
