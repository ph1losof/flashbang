import { afterEach, describe, expect, test } from "bun:test";
import { HOT_BOOT_SENTINEL } from "../src/shared/hot-boot";
import {
  beginHotBootUpdate,
  endHotBootUpdate,
  invalidateRedirectSettings,
  notifySW,
} from "../src/ui/sw-bridge";
import { type DomHandle, installDom } from "./helpers/dom";
import {
  createServiceWorkerStub,
  type ServiceWorkerStub,
  type ServiceWorkerStubOptions,
} from "./helpers/service-worker";

let dom: DomHandle | null = null;

function setup(options: ServiceWorkerStubOptions = {}): {
  handle: DomHandle;
  sw: ServiceWorkerStub;
} {
  const sw = createServiceWorkerStub(options);
  dom = installDom({ serviceWorker: sw.navigator.serviceWorker });
  return { handle: dom, sw };
}

afterEach(() => {
  dom?.restore();
  dom = null;
});

describe("notifySW", () => {
  test("posts to the controlling worker", () => {
    const { sw } = setup({ controller: true });

    notifySW("invalidate");

    expect(sw.messages).toHaveLength(1);
    expect(sw.messages[0].data).toEqual({ type: "invalidate" });
  });

  test("is a no-op when no worker controls the page", () => {
    const { sw } = setup({ controller: false });

    notifySW("invalidate");

    expect(sw.messages).toHaveLength(0);
  });
});

describe("beginHotBootUpdate", () => {
  test("primes navigation preload and returns an acknowledged token", async () => {
    const { sw } = setup({ controller: true });

    const token = await beginHotBootUpdate();

    expect(token).toBeTruthy();
    expect(sw.headerValues).toEqual([HOT_BOOT_SENTINEL]);
    expect(sw.preloadDisabled).toBe(1);
    expect(sw.messages[0].data).toEqual({
      type: "hot-boot-begin",
      token,
    });
  });

  test("returns null when the page has no service worker support", async () => {
    dom = installDom();

    expect(await beginHotBootUpdate()).toBeNull();
  });

  test("returns null when there is no registration", async () => {
    setup({ registration: "missing" });

    expect(await beginHotBootUpdate()).toBeNull();
  });

  test("returns null when the registration cannot be read", async () => {
    setup({ registration: "reject" });

    expect(await beginHotBootUpdate()).toBeNull();
  });

  test("returns null when navigation preload is unsupported", async () => {
    setup({ navigationPreload: false });

    expect(await beginHotBootUpdate()).toBeNull();
  });

  test("gives up on a registration lookup that never settles", async () => {
    const { handle } = setup({ registration: "never" });

    const pending = beginHotBootUpdate();
    await handle.advance(500);

    expect(await pending).toBeNull();
  });

  test("throws when the worker declines the update", async () => {
    setup({ controller: true, reply: false });

    await expect(beginHotBootUpdate()).rejects.toThrow(
      "Could not safely prepare redirect settings update"
    );
  });

  test("throws when no worker can receive the request", async () => {
    setup({ active: false, controller: false });

    await expect(beginHotBootUpdate()).rejects.toThrow(
      "Could not safely prepare redirect settings update"
    );
  });

  test("falls back to the registration's active worker", async () => {
    const { sw } = setup({ controller: false });

    expect(await beginHotBootUpdate()).toBeTruthy();
    expect(sw.messages).toHaveLength(1);
  });

  test("times out when the worker never acknowledges", async () => {
    const { handle } = setup({ controller: true, reply: "silent" });

    const pending = beginHotBootUpdate();
    const settled = pending.then(
      () => null,
      (error: Error) => error
    );
    await handle.advance(2_000);

    expect((await settled)?.message).toBe(
      "Service Worker settings update timed out"
    );
  });

  test("uses the crypto fallback when randomUUID is unavailable", async () => {
    const { sw } = setup({ controller: true });
    const originalRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });

    try {
      const token = await beginHotBootUpdate();
      expect(token).toMatch(/^[\da-z]+(-[\da-z]+){3}$/);
      expect(sw.messages[0].data.token).toBe(token);
    } finally {
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: originalRandomUUID,
      });
    }
  });
});

describe("endHotBootUpdate", () => {
  test("resolves once the worker acknowledges the token", async () => {
    const { sw } = setup({ controller: true });

    await endHotBootUpdate("token-1");

    expect(sw.messages[0].data).toEqual({
      type: "hot-boot-end",
      token: "token-1",
    });
  });

  test("throws when there is no registration", async () => {
    setup({ registration: "missing" });

    await expect(endHotBootUpdate("token-1")).rejects.toThrow(
      "Could not refresh redirect startup metadata"
    );
  });

  test("throws when the worker rejects the token", async () => {
    setup({ controller: true, reply: false });

    await expect(endHotBootUpdate("token-1")).rejects.toThrow(
      "Could not refresh redirect startup metadata"
    );
  });
});

describe("invalidateRedirectSettings", () => {
  test("acknowledged invalidation does not need the broadcast fallback", async () => {
    const { sw } = setup({ controller: true });

    await invalidateRedirectSettings();

    expect(sw.messages).toHaveLength(1);
    expect(sw.messages[0].data).toEqual({ type: "invalidate" });
  });

  test("broadcasts to the controller when the request is not acknowledged", async () => {
    const { sw } = setup({ controller: true, reply: false });

    await invalidateRedirectSettings();

    expect(sw.messages).toHaveLength(2);
    expect(sw.messages[1].data).toEqual({ type: "invalidate" });
    expect(sw.messages[1].ports).toHaveLength(0);
  });

  test("broadcasts when the request rejects outright", async () => {
    const { handle, sw } = setup({ controller: true, reply: "silent" });

    const pending = invalidateRedirectSettings();
    await handle.advance(2_000);
    await pending;

    expect(sw.messages).toHaveLength(2);
    expect(sw.messages[1].ports).toHaveLength(0);
  });

  test("does nothing without a registration", async () => {
    const { sw } = setup({ registration: "missing", controller: true });

    await invalidateRedirectSettings();

    expect(sw.messages).toHaveLength(0);
  });
});
