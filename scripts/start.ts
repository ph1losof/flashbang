import { normalize } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import {
  acceptsBangShardContentEncoding,
  createBangShardResponse,
} from "../src/server/bang-shard";
import {
  handleOpenSearchRequest,
  handleSuggestRequest,
} from "../src/server/handlers";
import {
  FALLBACK_SHELL_HEADERS,
  pageHeaders,
  SW_HEADERS,
} from "../src/server/headers";
import {
  bangShardPackAssetPath,
  binaryShardPackShardCount,
  materializeBinaryShard,
  parseBangShardPath,
} from "../src/shared/bang-shard-pack";
import { readPathname } from "../src/shared/raw-url";
import { extractInlineScriptHashes } from "./inline-script-hash";

let securityHeaders = pageHeaders("");
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const HASHED_ASSET_RE =
  /^\/(?:chunk-[a-z0-9_-]{8,}\.js|fallback-[a-z0-9_-]{8,}\.js|bangs(?:-meta|-pack)?-[a-f0-9]{8,}\.bin)$/i;
const DIST_DIR = process.env.DIST_DIR || "dist";
const DIST_PREFIX = `${DIST_DIR}/`;

export interface StaticAsset {
  br: Bun.BunFile | null;
  file: Bun.BunFile;
  type: string;
}

interface MaterializedBangShard {
  brotli: Uint8Array;
  identity: Uint8Array;
}

export function acceptsBrotli(header: string | null): boolean {
  return acceptsBangShardContentEncoding(header, "br");
}

export function cacheControlForAsset(assetPath: string): string {
  if (assetPath === "/index.html") {
    return FALLBACK_SHELL_HEADERS["Cache-Control"];
  }
  if (assetPath === "/sw.js" || assetPath.endsWith(".html")) {
    return "no-cache";
  }
  return HASHED_ASSET_RE.test(assetPath)
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL;
}

export function staticAssetHeaders(
  assetPath: string,
  contentType: string,
  compressed: boolean,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": cacheControlForAsset(assetPath),
    Vary: "Accept-Encoding",
    ...(compressed ? { "Content-Encoding": "br" } : {}),
    ...(assetPath === "/index.html" ? FALLBACK_SHELL_HEADERS : {}),
    ...securityHeaders,
    ...extraHeaders,
  };
}

export function buildStaticManifest(): Map<string, StaticAsset> {
  const files = [...new Bun.Glob("**/*").scanSync(DIST_DIR)];
  const byName = new Set(files);
  const map = new Map<string, StaticAsset>();

  for (const name of files) {
    if (name.endsWith(".br")) {
      continue;
    }
    const file = Bun.file(`${DIST_DIR}/${name}`);
    const br = byName.has(`${name}.br`)
      ? Bun.file(`${DIST_DIR}/${name}.br`)
      : null;
    map.set(`/${name}`, { file, br, type: file.type });
  }

  return map;
}

export function serveCompressed(
  manifest: ReadonlyMap<string, StaticAsset>,
  req: Request,
  assetPath: string,
  extraHeaders?: Record<string, string>
): Response | null {
  const asset = manifest.get(assetPath);
  if (!asset) {
    return null;
  }

  const compressed =
    asset.br !== null && acceptsBrotli(req.headers.get("accept-encoding"));
  return new Response(compressed ? asset.br : asset.file, {
    headers: staticAssetHeaders(
      assetPath,
      asset.type,
      compressed,
      extraHeaders
    ),
  });
}

export function createStaticFetchHandler(
  staticManifest: ReadonlyMap<string, StaticAsset>,
  securityHeaderEntries = Object.entries(securityHeaders)
): (req: Request) => Promise<Response> {
  const materializedBangShards = new Map<
    string,
    Promise<MaterializedBangShard>
  >();

  const loadBangShard = (
    version: string,
    shardId: number
  ): Promise<MaterializedBangShard> => {
    const key = `${version}/${shardId}`;
    const existing = materializedBangShards.get(key);
    if (existing) {
      return existing;
    }
    const loading = (async () => {
      const packAsset = staticManifest.get(bangShardPackAssetPath(version));
      if (!packAsset) {
        throw new Error("Missing binary bang shard pack");
      }
      const pack = new Uint8Array(await packAsset.file.arrayBuffer());
      if (shardId >= binaryShardPackShardCount(pack)) {
        throw new RangeError("Invalid binary bang shard id");
      }
      const identity = materializeBinaryShard(pack, shardId);
      return {
        brotli: brotliCompressSync(identity, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          },
        }),
        identity,
      };
    })();
    materializedBangShards.set(key, loading);
    loading.catch(() => materializedBangShards.delete(key));
    return loading;
  };

  return async (req) => {
    const pathname = readPathname(req.url);

    if (pathname === "/health") {
      return new Response("ok", { headers: securityHeaders });
    }

    if (pathname === "/suggest") {
      const res = await handleSuggestRequest(req);
      for (const [k, v] of securityHeaderEntries) {
        res.headers.set(k, v);
      }
      return res;
    }

    if (pathname === "/opensearch.xml") {
      const res = handleOpenSearchRequest(req);
      for (const [k, v] of securityHeaderEntries) {
        res.headers.set(k, v);
      }
      return res;
    }

    if (pathname.startsWith("/bang-shard/")) {
      const requested = parseBangShardPath(pathname);
      if (!requested) {
        return new Response("Not found", {
          status: 404,
          headers: securityHeaders,
        });
      }
      try {
        const cacheHit = materializedBangShards.has(
          `${requested.version}/${requested.shardId}`
        );
        const shard = await loadBangShard(requested.version, requested.shardId);
        const compressed = acceptsBrotli(req.headers.get("accept-encoding"));
        return createBangShardResponse(
          compressed ? shard.brotli : shard.identity,
          compressed ? "br" : null,
          [
            ...securityHeaderEntries,
            ["X-Flashbang-Shard-Cache", cacheHit ? "hit" : "miss"],
          ]
        );
      } catch (error) {
        const missing =
          error instanceof RangeError ||
          (error instanceof Error &&
            error.message === "Missing binary bang shard pack");
        if (!missing) {
          console.error("Unable to materialize bang shard", error);
        }
        return new Response(missing ? "Not found" : "Invalid bang shard pack", {
          status: missing ? 404 : 500,
          headers: securityHeaders,
        });
      }
    }

    if (pathname === "/sw.js") {
      return serveCompressed(staticManifest, req, "/sw.js", SW_HEADERS)!;
    }

    if (pathname === "/bench") {
      return serveCompressed(staticManifest, req, "/bench.html")!;
    }

    const path = pathname === "/" ? "/index.html" : pathname;
    const normalized = normalize(`${DIST_DIR}${path}`);
    if (!normalized.startsWith(DIST_PREFIX)) {
      return new Response("Not found", {
        status: 404,
        headers: securityHeaders,
      });
    }
    const fromDist = serveCompressed(
      staticManifest,
      req,
      `/${normalized.substring(DIST_PREFIX.length)}`
    );
    if (fromDist) {
      return fromDist;
    }

    const htmlNormalized = normalize(`${DIST_DIR}${path}.html`);
    if (htmlNormalized.startsWith(DIST_PREFIX)) {
      const fromHtml = serveCompressed(
        staticManifest,
        req,
        `/${htmlNormalized.substring(DIST_PREFIX.length)}`
      );
      if (fromHtml) {
        return fromHtml;
      }
    }

    return serveCompressed(staticManifest, req, "/index.html")!;
  };
}

async function main(): Promise<void> {
  const distIndex = Bun.file(`${DIST_DIR}/index.html`);
  if (!(await distIndex.exists())) {
    console.error(
      `${DIST_DIR}/index.html not found. Run \`bun run build\` first.`
    );
    process.exit(1);
  }

  const pageHtml = await Promise.all(
    ["index.html", "home.html", "bench.html"].map((name) =>
      Bun.file(`${DIST_DIR}/${name}`).text()
    )
  );
  const scriptHashes = [
    ...new Set(pageHtml.flatMap(extractInlineScriptHashes)),
  ];
  securityHeaders = pageHeaders(scriptHashes.join(" "));
  const securityHeaderEntries = Object.entries(securityHeaders);

  const staticManifest = buildStaticManifest();
  const port = Number(process.env.PORT) || 3000;
  console.log(`Production server: http://localhost:${port}`);

  Bun.serve({
    port,
    fetch: createStaticFetchHandler(staticManifest, securityHeaderEntries),
  });
}

if (import.meta.main) {
  await main();
}
