/**
 * Per-language edition data for hosts that carry a {lang} marker.
 *
 * Kept apart from locale-tag.ts because this module is the only heavy half:
 * loading it is what the cold fallback defers until a destination needs it.
 */
import type { LocalePattern, LocaleSplit } from "./locale-tag";

export type { LocalePattern, LocaleSplit };

// Deliberately not imported from locale-tag: a runtime edge to that module
// makes the bundler hoist it into a chunk shared with the cold entry, which
// costs the cold path an extra request. This module must stay standalone so
// its dynamic import is one self-contained file.
const LOCALE_MARKER = "{lang}";

export const LOCALE_PATTERNS: readonly LocalePattern[] = [
  {
    aliases: "in:id iw:he ji:yi nb:no zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wikipedia.org",
    snap: "wikipedia.org",
    supported:
      "ab ace ady af alt am ami an ang ann anp ar arc ary arz as ast atj av avk awa ay az azb ba ban bar bbc bcl bdr be be-tarask bew bg bh bi bjn blk bm bn bo bol bpy br bs btm bug bxr ca cbk-zam cdo ce ceb ch chr chy ckb co crh cs csb cu cv cy da dag de dga din diq dsb dtp dty dv dz ee el eml en eo es et eu ext fa fat ff fi fj fo fon fr frp frr fur fy ga gag gan gcr gd gl glk gn gom gor got gpe gu guc gur guw gv ha hak haw he hi hif hr hsb ht hu hy hyw ia iba id ie ig igl ik ilo inh io is isv it iu ja jam jbo jv ka kaa kab kai kaj kbd kbp kcg kg kge ki kk km kn knc ko koi krc ks ksh ku kus kv kw ky la lad lb lbe lez lfn lg li lij lld lmo ln lo lt ltg lv mad mag mai map-bms mdf mg mhr mi min mk ml mn mni mnw mos mr mrj ms mt mwl my myv mzn nah nap nds nds-nl ne new nia nl nn no nov nqo nr nrm nso nup nv ny oc olo om or os pa pag pam pap pcd pcm pdc pfl pi pl pms pnb pnt ppl ps pt pwn qu rki rm rmy rn ro roa-tara rsk ru rue rw sa sah sat sc scn sco sd se sg sh shi shn si sk skr sl sm smn sn so sq sr srn ss st stq su sv sw syl szl szy ta tay tcy tdd te tet tg th ti tig tk tl tly tn to tok tpi tr trv ts tt tum tw ty tyv udm ug uk ur uz ve vec vep vi vls vo wa war wo wuu xal xh xmf yi yo za zea zgh zh zu",
  },
  {
    aliases: "in:id iw:he ji:yi nb:no zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wiktionary.org",
    snap: "wiktionary.org",
    supported:
      "af am an ang ar ast ay az bcl be bew bg bjn blk bn br bs btm ca chr ckb co cs csb cy da de diq dv el en eo es et eu fa fi fj fo fr fy ga gd gl gn gom gor gu guw gv ha he hi hif hr hsb hu hy ia id ie ig io is it iu ja jbo jv ka kaa kbd kcg kk kl km kn ko ks ku kw ky la lb li lmo ln lo lt lv mad mg mi min mk ml mn mni mnw mr ms mt my na nah nds ne nia nl nn no oc om or pa pl pnb ps pt qu ro ru rw sa sat scn sd sg sh shn shy si sk skr sl sm so sq sr ss st su sv sw ta tcy te tg th ti tk tl tn tpi tr ts tt ug uk ur uz vec vi vo wa wo yi yue zgh zh zu",
  },
  {
    aliases: "in:id iw:he ji:yi nb:no zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wikisource.org",
    snap: "wikisource.org",
    supported:
      "ar as az ban bcl be bg bn br bs ca cs cy da de el en eo es et eu fa fi fo fr gl gu he hi hr hu hy id is it ja jv ka kn ko la li lij lt mad min mk ml mr ms my nap nl no or pa pl pms pt ro ru sa sah sk sl sr su sv ta tcy te th tl tr uk ur vec vi wa yi zh",
  },
  {
    aliases: "in:id iw:he nb:no zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wikibooks.org",
    snap: "wikibooks.org",
    supported:
      "af ar az ba be bg bn bs ca cs cv cy da de el en eo es et eu fa fi fr fy gl he hi hr hu hy ia id is it ja ka kk km ko ku la li lt mg min mk ml mr ms ne nl no oc pa pl pt ro ru sa shn si sk sl sq sr sv ta te tg th tl tr tt uk ur vi zh",
  },
  {
    aliases: "in:id iw:he nb:no zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wikiquote.org",
    snap: "wikiquote.org",
    supported:
      "af ar as az bcl be bg bjn bn br bs ca cs cy da de el en eo es et eu fa fi fr gl gor gu guw he hi hr hu hy id ig is it ja ka kn ko ku ky la li lt min ml mr ms nl nn no pcm pl pt ro ru sa sah sk sl sq sr su sv ta te th tl tr uk ur uz vi zh",
  },
  {
    aliases: "in:id iw:he zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wikivoyage.org",
    snap: "wikivoyage.org",
    supported:
      "bn cs de el en eo es fa fi fr he hi id it ja nl pl ps pt ro ru shn sv tr uk vi zh",
  },
  {
    aliases: "zh-hans:zh zh-hant:zh",
    fallback: "en",
    host: "{lang}.wikiversity.org",
    snap: "wikiversity.org",
    supported: "ar cs de el en es fi fr hi it ja ko pt ru sl sv zh",
  },
];

export function localeChain(tags: readonly string[]): string[] {
  const chain: string[] = [];
  for (const tag of tags) {
    let end = tag.length;
    while (end > 0) {
      const candidate = end === tag.length ? tag : tag.substring(0, end);
      if (!chain.includes(candidate)) {
        chain.push(candidate);
      }
      end = tag.lastIndexOf("-", end - 1);
    }
  }
  return chain;
}

function listHas(list: string, value: string): boolean {
  let at = list.indexOf(value);
  while (at !== -1) {
    const startsWord = at === 0 || list.charCodeAt(at - 1) === 32;
    const end = at + value.length;
    const endsWord = end === list.length || list.charCodeAt(end) === 32;
    if (startsWord && endsWord) {
      return true;
    }
    at = list.indexOf(value, at + 1);
  }
  return false;
}

function aliasFor(list: string, value: string): string | null {
  let at = list.indexOf(value);
  while (at !== -1) {
    const startsWord = at === 0 || list.charCodeAt(at - 1) === 32;
    const colon = at + value.length;
    if (startsWord && list.charCodeAt(colon) === 58) {
      const space = list.indexOf(" ", colon);
      return space === -1
        ? list.substring(colon + 1)
        : list.substring(colon + 1, space);
    }
    at = list.indexOf(value, at + 1);
  }
  return null;
}

export function resolveLocaleValue(
  pattern: LocalePattern,
  chain: readonly string[]
): string {
  const aliases = pattern.aliases;
  for (const candidate of chain) {
    if (listHas(pattern.supported, candidate)) {
      return candidate;
    }
    const mapped = aliases.length === 0 ? null : aliasFor(aliases, candidate);
    if (mapped !== null && listHas(pattern.supported, mapped)) {
      return mapped;
    }
  }
  return pattern.fallback;
}

function authorityStart(prefix: string): number {
  const protocolEnd = prefix.indexOf("://");
  return protocolEnd === -1 ? -1 : protocolEnd + 3;
}

function authorityEnd(prefix: string, start: number): number {
  let end = prefix.length;
  const slash = prefix.indexOf("/", start);
  if (slash !== -1) {
    end = slash;
  }
  const query = prefix.indexOf("?", start);
  if (query !== -1 && query < end) {
    end = query;
  }
  const fragment = prefix.indexOf("#", start);
  if (fragment !== -1 && fragment < end) {
    end = fragment;
  }
  return end;
}

const splitCache = new Map<string, LocaleSplit | null>();

export function localeSplitOf(prefix: string): LocaleSplit | null {
  const cached = splitCache.get(prefix);
  if (cached !== undefined) {
    return cached;
  }
  const split = computeLocaleSplit(prefix);
  splitCache.set(prefix, split);
  return split;
}

function computeLocaleSplit(prefix: string): LocaleSplit | null {
  const start = authorityStart(prefix);
  if (start === -1) {
    return null;
  }
  const at = prefix.indexOf(LOCALE_MARKER, start);
  if (at === -1) {
    return null;
  }
  const end = authorityEnd(prefix, start);
  if (at >= end) {
    return null;
  }
  const group = patternIndexAt(prefix, start, end);
  if (group === -1) {
    return null;
  }
  return {
    group,
    head: prefix.substring(0, at),
    pattern: LOCALE_PATTERNS[group],
    tail: prefix.substring(at + LOCALE_MARKER.length),
  };
}

function patternIndexAt(prefix: string, start: number, end: number): number {
  const length = end - start;
  for (let i = 0; i < LOCALE_PATTERNS.length; i++) {
    const host = LOCALE_PATTERNS[i].host;
    if (host.length === length && prefix.startsWith(host, start)) {
      return i;
    }
  }
  return -1;
}
