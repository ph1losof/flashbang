import { BANGS } from "../generated/bangs-min.js";

export interface RedirectSettings {
  defaultUrl: string;
  custom: Record<string, string>;
}

function encode(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, "/");
}

function parse(q: string): { bang: string | null; term: string } {
  const s = q.trim();

  // "!g cats" or "!g"
  if (s.charCodeAt(0) === 33) {
    const sp = s.indexOf(" ");
    if (sp === -1) return { bang: s.substring(1).toLowerCase(), term: "" };
    return {
      bang: s.substring(1, sp).toLowerCase(),
      term: s.substring(sp + 1),
    };
  }

  // "g! cats" — prefix suffix-bang
  const excl = s.indexOf("!");
  if (excl > 0 && excl < s.length - 1 && s.charCodeAt(excl + 1) === 32) {
    return {
      bang: s.substring(0, excl).toLowerCase(),
      term: s.substring(excl + 2),
    };
  }

  // "g!" — suffix-bang alone
  if (s.endsWith("!") && !s.includes(" ")) {
    return { bang: s.slice(0, -1).toLowerCase(), term: "" };
  }

  // "cats !g" — trailing prefix-bang
  const bi = s.lastIndexOf(" !");
  if (bi !== -1 && bi < s.length - 2) {
    const b = s.substring(bi + 2);
    if (!b.includes(" "))
      return { bang: b.toLowerCase(), term: s.substring(0, bi) };
  }

  // "cats g!" — trailing suffix-bang
  if (s.endsWith("!")) {
    const lastSpace = s.lastIndexOf(" ");
    if (lastSpace !== -1) {
      const b = s.substring(lastSpace + 1, s.length - 1);
      if (b.length > 0)
        return { bang: b.toLowerCase(), term: s.substring(0, lastSpace) };
    }
  }

  return { bang: null, term: s };
}

export function redirect(
  query: string,
  { defaultUrl, custom }: RedirectSettings,
): Response {
  if (query === "!") {
    return Response.redirect("/", 302);
  }

  const { bang, term } = parse(query);
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
