import { BANGS } from "../generated/bangs-min.js";

export interface RedirectSettings {
  defaultUrl: string;
  custom: Record<string, string>;
  luckyUrl: string | null;
}

function encode(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, "/");
}

function parse(q: string): { bang: string | null; term: string; lucky: boolean } {
  const s = q.trim();

  // "\query" — feeling lucky
  if (s.charCodeAt(0) === 92 && s.length > 1) {
    return { bang: null, term: s.substring(1), lucky: true };
  }

  // All "!" prefix patterns — single charCodeAt gate
  if (s.charCodeAt(0) === 33) {
    // "! query" — feeling lucky (leading bare bang)
    if (s.charCodeAt(1) === 32) {
      return { bang: null, term: s.substring(2), lucky: true };
    }
    // "!g cats" or "!g"
    const sp = s.indexOf(" ");
    if (sp === -1) return { bang: s.substring(1).toLowerCase(), term: "", lucky: false };
    return {
      bang: s.substring(1, sp).toLowerCase(),
      term: s.substring(sp + 1),
      lucky: false,
    };
  }

  // "query !" — feeling lucky (trailing bare bang)
  if (s.charCodeAt(s.length - 1) === 33 && s.charCodeAt(s.length - 2) === 32) {
    return { bang: null, term: s.substring(0, s.length - 2), lucky: true };
  }

  // All remaining patterns require "!" — find it once, bail if absent
  const excl = s.indexOf("!");
  if (excl === -1) return { bang: null, term: s, lucky: false };

  // "g! cats" — prefix suffix-bang
  if (excl < s.length - 1 && s.charCodeAt(excl + 1) === 32) {
    return {
      bang: s.substring(0, excl).toLowerCase(),
      term: s.substring(excl + 2),
      lucky: false,
    };
  }

  // "g!" — suffix-bang alone
  if (s.charCodeAt(s.length - 1) === 33 && s.indexOf(" ") === -1) {
    return { bang: s.substring(0, s.length - 1).toLowerCase(), term: "", lucky: false };
  }

  // "cats !g" — trailing prefix-bang
  const bi = s.lastIndexOf(" !");
  if (bi !== -1 && bi < s.length - 2) {
    const b = s.substring(bi + 2);
    if (b.indexOf(" ") === -1)
      return { bang: b.toLowerCase(), term: s.substring(0, bi), lucky: false };
  }

  // "cats g!" — trailing suffix-bang
  if (s.charCodeAt(s.length - 1) === 33) {
    const lastSpace = s.lastIndexOf(" ");
    if (lastSpace !== -1) {
      const b = s.substring(lastSpace + 1, s.length - 1);
      if (b.length > 0)
        return { bang: b.toLowerCase(), term: s.substring(0, lastSpace), lucky: false };
    }
  }

  return { bang: null, term: s, lucky: false };
}

export function redirect(
  query: string,
  { defaultUrl, custom, luckyUrl }: RedirectSettings,
): Response {
  if (query === "!") {
    return Response.redirect("/", 302);
  }

  const { bang, term, lucky } = parse(query);

  if (lucky && luckyUrl && term) {
    return Response.redirect(luckyUrl.replace("{}", encode(term)), 302);
  }

  let url: string | undefined;

  if (bang) {
    url = custom[bang] || BANGS[bang];

    if (!url) {
      return Response.redirect(defaultUrl.replace("{}", encode(query)), 302);
    }
  } else {
    url = defaultUrl;
  }

  if (!term) {
    try {
      return Response.redirect(new URL(url!.replace("{}", "")).origin, 302);
    } catch {
      return Response.redirect(url!.replace("{}", ""), 302);
    }
  }

  return Response.redirect(url!.replace("{}", encode(term)), 302);
}
