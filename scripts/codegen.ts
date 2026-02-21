import { $ } from "bun";
import { parse as parseTOML } from "smol-toml";

interface Bang {
  domain: string;
  name: string;
  relevance: number;
  trigger: string;
  url: string;
}

interface RawDdgEntry {
  d: string;
  r?: number;
  s: string;
  t: string;
  ts?: string[];
  u: string;
}

interface RawKagiEntry {
  d: string;
  s: string;
  t: string;
  ts?: string[];
  u: string;
}

function normalizeUrl(u: string): string {
  return u.replaceAll("{{{s}}}", "{}");
}

function parseDdg(raw: string): Bang[] {
  const entries: RawDdgEntry[] = JSON.parse(raw);
  const bangs: Bang[] = [];

  for (const entry of entries) {
    const url = normalizeUrl(entry.u);
    const relevance = entry.r ?? 0;

    bangs.push({
      trigger: entry.t.toLowerCase(),
      name: entry.s,
      domain: entry.d,
      url,
      relevance,
    });

    if (entry.ts) {
      for (const alias of entry.ts) {
        bangs.push({
          trigger: alias.toLowerCase(),
          name: entry.s,
          domain: entry.d,
          url,
          relevance,
        });
      }
    }
  }

  return bangs;
}

function parseKagi(raw: string): Bang[] {
  const entries: RawKagiEntry[] = JSON.parse(raw);
  const bangs: Bang[] = [];

  for (const entry of entries) {
    const url = normalizeUrl(entry.u);

    bangs.push({
      trigger: entry.t.toLowerCase(),
      name: entry.s,
      domain: entry.d,
      url,
      relevance: 0,
    });

    if (entry.ts) {
      for (const alias of entry.ts) {
        bangs.push({
          trigger: alias.toLowerCase(),
          name: entry.s,
          domain: entry.d,
          url,
          relevance: 0,
        });
      }
    }
  }

  return bangs;
}

function parseCustom(raw: string): Bang[] {
  const file = parseTOML(raw) as {
    bangs: Record<string, { name: string; url: string; domain: string }>;
  };
  return Object.entries(file.bangs).map(([trigger, b]) => ({
    trigger: trigger.toLowerCase(),
    name: b.name,
    domain: b.domain,
    url: b.url,
    relevance: 0,
  }));
}

function merge(sources: [string, Bang[]][]): Bang[] {
  const map = new Map<string, Bang>();

  for (const [, bangs] of sources) {
    for (const bang of bangs) {
      const existing = map.get(bang.trigger);
      if (existing) {
        map.set(bang.trigger, {
          ...bang,
          relevance: Math.max(existing.relevance, bang.relevance),
        });
      } else {
        map.set(bang.trigger, bang);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.trigger.localeCompare(b.trigger));
}

function validate(bangs: Bang[]): Bang[] {
  return bangs.filter((b) => {
    if (!b.trigger) {
      return false;
    }
    if (!b.url.includes("{}")) {
      console.error(`Warning: bang !${b.trigger} has no {} placeholder in URL`);
    }
    return true;
  });
}

function jsEscape(s: string): string {
  let out = "";
  for (const c of s) {
    switch (c) {
      case "\\":
        out += "\\\\";
        break;
      case "'":
        out += "\\'";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += c;
    }
  }
  return out;
}

function generateMin(bangs: Bang[]): string {
  let js = "export const BANGS={__proto__:null,";
  for (let i = 0; i < bangs.length; i++) {
    if (i > 0) {
      js += ",";
    }
    js += `'${jsEscape(bangs[i].trigger)}':'${jsEscape(bangs[i].url)}'`;
  }
  js += "};";
  return js;
}

function generateFull(bangs: Bang[]): string {
  let js = "export const BANGS={__proto__:null,";
  for (let i = 0; i < bangs.length; i++) {
    if (i > 0) {
      js += ",";
    }
    const b = bangs[i];
    js += `'${jsEscape(b.trigger)}':{s:'${jsEscape(b.name)}',d:'${jsEscape(b.domain)}',u:'${jsEscape(b.url)}',r:${b.relevance}}`;
  }
  js += "};";
  return js;
}

function generateKeys(bangs: Bang[]): string {
  let js = "export const BANG_KEYS=[";
  for (let i = 0; i < bangs.length; i++) {
    if (i > 0) {
      js += ",";
    }
    js += `'${jsEscape(bangs[i].trigger)}'`;
  }
  js += "];";
  return js;
}

function generateMeta(bangs: Bang[]): string {
  return JSON.stringify({
    count: bangs.length,
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}

const noFetch = process.argv.includes("--no-fetch");

if (!noFetch) {
  console.log("=== Fetch bang sources ===");
  await $`mkdir -p data`;
  await $`curl -sfo data/kagi.json https://raw.githubusercontent.com/kagisearch/bangs/main/data/bangs.json`;
  await $`curl -sfo data/ddg.json https://duckduckgo.com/bang.js`;
}

console.log("=== Parse sources ===");

const allSources: [string, Bang[]][] = [];

const ddgRaw = await Bun.file("data/ddg.json").text();
const ddgBangs = parseDdg(ddgRaw);
console.log(`DDG: ${ddgBangs.length} bangs parsed`);
allSources.push(["ddg", ddgBangs]);

const kagiRaw = await Bun.file("data/kagi.json").text();
const kagiBangs = parseKagi(kagiRaw);
console.log(`Kagi: ${kagiBangs.length} bangs parsed`);
allSources.push(["kagi", kagiBangs]);

const customRaw = await Bun.file("config/custom.toml").text();
const customBangs = parseCustom(customRaw);
console.log(`Custom: ${customBangs.length} bangs parsed`);
allSources.push(["custom", customBangs]);

console.log("=== Merge + validate ===");
const merged = merge(allSources);
console.log(`Merged: ${merged.length} unique bangs`);

const valid = validate(merged);
console.log(`Valid: ${valid.length} bangs after validation`);

console.log("=== Generate ===");
const outDir = "src/generated";
await $`mkdir -p ${outDir}`;

const minJs = generateMin(valid);
await Bun.write(`${outDir}/bangs-min.js`, minJs);
console.log(`  bangs-min.js: ${minJs.length} bytes`);

const fullJs = generateFull(valid);
await Bun.write(`${outDir}/bangs-full.js`, fullJs);
console.log(`  bangs-full.js: ${fullJs.length} bytes`);

const keysJs = generateKeys(valid);
await Bun.write(`${outDir}/bangs-keys.js`, keysJs);
console.log(`  bangs-keys.js: ${keysJs.length} bytes`);

const metaJson = generateMeta(valid);
await Bun.write(`${outDir}/bangs-meta.json`, metaJson);

console.log(`Generated ${valid.length} bangs in ${outDir}/`);
