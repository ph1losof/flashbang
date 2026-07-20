import { HOT_BOOT_SENTINEL } from "../shared/hot-boot";

export function notifySW(type: string) {
  navigator.serviceWorker.controller?.postMessage({ type });
}

function requestSW(
  registration: ServiceWorkerRegistration,
  data: Record<string, unknown>
): Promise<boolean> {
  return Promise.resolve().then(() => {
    const worker = navigator.serviceWorker.controller ?? registration.active;
    if (!worker) {
      return false;
    }
    return new Promise<boolean>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(
        () => reject(new Error("Service Worker settings update timed out")),
        2_000
      );
      channel.port1.onmessage = (event: MessageEvent<boolean>) => {
        window.clearTimeout(timeout);
        resolve(event.data === true);
      };
      worker.postMessage(data, [channel.port2]);
    });
  });
}

function registrationWithTimeout(): Promise<ServiceWorkerRegistration | null> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(null), 500);
    navigator.serviceWorker.getRegistration().then(
      (registration) => {
        window.clearTimeout(timeout);
        resolve(registration ?? null);
      },
      () => {
        window.clearTimeout(timeout);
        resolve(null);
      }
    );
  });
}

function updateToken(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const values = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(values, (value) => value.toString(36)).join("-");
}

export async function beginHotBootUpdate(): Promise<string | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await registrationWithTimeout();
  const navigationPreload = registration?.navigationPreload;
  if (!(registration && navigationPreload)) {
    return null;
  }
  await navigationPreload.setHeaderValue(HOT_BOOT_SENTINEL);
  await navigationPreload.disable();
  const token = updateToken();
  if (!(await requestSW(registration, { type: "hot-boot-begin", token }))) {
    throw new Error("Could not safely prepare redirect settings update");
  }
  return token;
}

export async function endHotBootUpdate(token: string): Promise<void> {
  const registration = await registrationWithTimeout();
  if (
    !(
      registration &&
      (await requestSW(registration, { type: "hot-boot-end", token }))
    )
  ) {
    throw new Error("Could not refresh redirect startup metadata");
  }
}

export async function invalidateRedirectSettings(): Promise<void> {
  const registration = await registrationWithTimeout();
  if (!registration) {
    return;
  }
  const acknowledged = await requestSW(registration, {
    type: "invalidate",
  }).catch(() => false);
  if (!acknowledged) {
    notifySW("invalidate");
  }
}
