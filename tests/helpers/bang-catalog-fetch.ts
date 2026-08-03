import { spyOn } from "bun:test";

/**
 * Serves the generated bang metadata asset so UI modules that call
 * `loadBuiltinBangCatalog()` run against the real catalog. The loader caches its
 * promise per process, so this stays safe to install in more than one file.
 */
export function installBangCatalogFetch(): {
  restore: () => void;
} {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: unknown) => {
        const url = String(
          input instanceof Request ? input.url : (input as string)
        );
        if (url.endsWith("/bangs-meta.bin")) {
          return Promise.resolve(
            new Response(Bun.file("src/generated/bangs-meta.bin"))
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
      { preconnect: () => undefined }
    ) as unknown as typeof fetch
  );
  return {
    restore() {
      fetchSpy.mockRestore();
    },
  };
}
