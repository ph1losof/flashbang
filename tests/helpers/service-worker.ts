/**
 * Stubs for the `navigator.serviceWorker` surface that `src/ui/sw-bridge.ts`
 * talks to. The worker replies on the port it is handed, which is how the
 * bridge's request/acknowledge round trip is driven from a test.
 */

export interface WorkerMessage {
  data: Record<string, unknown>;
  ports: readonly MessagePort[];
}

export type ReplyMode = "silent" | ((data: Record<string, unknown>) => unknown);

export interface ServiceWorkerStubOptions {
  /** Whether `navigator.serviceWorker.controller` is present. */
  controller?: boolean;
  /** Whether the registration exposes an `active` worker. */
  active?: boolean;
  /** Whether the registration exposes `navigationPreload`. */
  navigationPreload?: boolean;
  /** Registration returned by `getRegistration`; `null` resolves undefined. */
  registration?: "missing" | "never" | "reject" | "present";
  /**
   * What the worker posts back on the transferred port. `"silent"` never
   * replies, which exercises the bridge's timeout path.
   */
  reply?: unknown | ReplyMode;
}

export interface ServiceWorkerStub {
  headerValues: string[];
  messages: WorkerMessage[];
  navigator: { serviceWorker: Record<string, unknown> };
  preloadDisabled: number;
}

/** Builds a `navigator.serviceWorker` stub plus the log a test asserts on. */
export function createServiceWorkerStub(
  options: ServiceWorkerStubOptions = {}
): ServiceWorkerStub {
  const messages: WorkerMessage[] = [];
  const headerValues: string[] = [];
  const stub: ServiceWorkerStub = {
    headerValues,
    messages,
    navigator: { serviceWorker: {} },
    preloadDisabled: 0,
  };
  const reply = options.reply ?? true;

  const worker = {
    postMessage(data: Record<string, unknown>, ports: MessagePort[] = []) {
      messages.push({ data, ports });
      if (reply === "silent") {
        return;
      }
      const value = typeof reply === "function" ? reply(data) : reply;
      ports[0]?.postMessage(value);
    },
  };

  const navigationPreload = {
    disable() {
      stub.preloadDisabled++;
      return Promise.resolve();
    },
    setHeaderValue(value: string) {
      headerValues.push(value);
      return Promise.resolve();
    },
  };

  const registration: Record<string, unknown> = {};
  if (options.active !== false) {
    registration.active = worker;
  }
  if (options.navigationPreload !== false) {
    registration.navigationPreload = navigationPreload;
  }

  const mode = options.registration ?? "present";
  stub.navigator.serviceWorker = {
    getRegistration(): Promise<unknown> {
      if (mode === "reject") {
        return Promise.reject(new Error("registration unavailable"));
      }
      if (mode === "never") {
        return new Promise(() => undefined);
      }
      return Promise.resolve(mode === "missing" ? undefined : registration);
    },
  };
  if (options.controller) {
    stub.navigator.serviceWorker.controller = worker;
  }
  return stub;
}
