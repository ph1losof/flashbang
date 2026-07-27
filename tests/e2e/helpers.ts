import type { CDPSession } from "@playwright/test";

export function disableServiceWorkers(): void {
  Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
}

export async function closeServiceWorkerTarget(
  cdp: CDPSession,
  matches: (url: string) => boolean,
  missingMessage = "Service Worker target not found"
): Promise<void> {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const worker = targetInfos.find(
    (target) => target.type === "service_worker" && matches(target.url)
  );
  if (!worker) {
    throw new Error(missingMessage);
  }
  await cdp.send("Target.closeTarget", { targetId: worker.targetId });
}
