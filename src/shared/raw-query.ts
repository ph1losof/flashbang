import { CH_PERCENT, CH_PLUS } from "./chars";

const UTF8_DECODER = new TextDecoder();

function hexNibble(code: number): number {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  const lc = code | 32;
  if (lc >= 97 && lc <= 102) {
    return lc - 87;
  }
  return -1;
}

function decodeQueryComponent(raw: string): string {
  const hasPercent = raw.includes("%");
  const hasPlus = raw.includes("+");
  if (!(hasPercent || hasPlus)) {
    return raw;
  }
  if (!hasPercent) {
    return raw.replace(/\+/g, " ");
  }
  try {
    return decodeURIComponent(hasPlus ? raw.replace(/\+/g, " ") : raw);
  } catch {
    // Fall back to tolerant decode loop below.
  }

  let out = "";
  const bytes: number[] = [];

  const flush = () => {
    if (bytes.length) {
      out += UTF8_DECODER.decode(new Uint8Array(bytes));
      bytes.length = 0;
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);

    if (c === CH_PLUS) {
      flush();
      out += " ";
      continue;
    }

    if (c === CH_PERCENT && i + 2 < raw.length) {
      const hi = hexNibble(raw.charCodeAt(i + 1));
      const lo = hexNibble(raw.charCodeAt(i + 2));
      if (hi !== -1 && lo !== -1) {
        bytes.push((hi << 4) | lo);
        i += 2;
        continue;
      }
    }

    flush();
    out += raw[i];
  }

  flush();
  return out;
}

export function readQueryParam(rawUrl: string, key: string): string | null {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    return null;
  }
  const hPos = rawUrl.indexOf("#", qPos + 1);
  const end = hPos === -1 ? rawUrl.length : hPos;
  const keyLen = key.length;

  let i = qPos + 1;
  while (i < end) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;

    if (keyEnd - i === keyLen && rawUrl.startsWith(key, i)) {
      if (eq === -1 || eq > amp) {
        return "";
      }
      return decodeQueryComponent(rawUrl.substring(eq + 1, amp));
    }

    i = amp + 1;
  }

  return null;
}

export function readTwoQueryParams(
  rawUrl: string,
  keyA: string,
  keyB: string
): readonly [string | null, string | null] {
  if (keyA === keyB) {
    const value = readQueryParam(rawUrl, keyA);
    return [value, value];
  }

  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    return [null, null];
  }
  const hPos = rawUrl.indexOf("#", qPos + 1);
  const end = hPos === -1 ? rawUrl.length : hPos;
  const keyALen = keyA.length;
  const keyBLen = keyB.length;

  let a: string | null = null;
  let b: string | null = null;
  let i = qPos + 1;

  while (i < end && (a === null || b === null)) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;

    if (a === null && keyEnd - i === keyALen && rawUrl.startsWith(keyA, i)) {
      a =
        eq === -1 || eq > amp
          ? ""
          : decodeQueryComponent(rawUrl.substring(eq + 1, amp));
    } else if (
      b === null &&
      keyEnd - i === keyBLen &&
      rawUrl.startsWith(keyB, i)
    ) {
      b =
        eq === -1 || eq > amp
          ? ""
          : decodeQueryComponent(rawUrl.substring(eq + 1, amp));
    }

    i = amp + 1;
  }

  return [a, b];
}

export function readSuggestQueryParams(
  rawUrl: string
): readonly [
  q: string | null,
  sp: string | null,
  bp: string | null,
  np: string | null,
] {
  const qPos = rawUrl.indexOf("?");
  if (qPos === -1) {
    return [null, null, null, null];
  }
  const hPos = rawUrl.indexOf("#", qPos + 1);
  const end = hPos === -1 ? rawUrl.length : hPos;
  let q: string | null = null;
  let sp: string | null = null;
  let bp: string | null = null;
  let np: string | null = null;
  let i = qPos + 1;

  while (i < end) {
    let amp = rawUrl.indexOf("&", i);
    if (amp === -1 || amp > end) {
      amp = end;
    }
    const eq = rawUrl.indexOf("=", i);
    const keyEnd = eq === -1 || eq > amp ? amp : eq;
    const keyLength = keyEnd - i;
    let slot = -1;
    if (keyLength === 1 && rawUrl.charCodeAt(i) === 113) {
      slot = 0;
    } else if (keyLength === 2 && rawUrl.charCodeAt(i + 1) === 112) {
      const first = rawUrl.charCodeAt(i);
      if (first === 115) {
        slot = 1;
      } else if (first === 98) {
        slot = 2;
      } else if (first === 110) {
        slot = 3;
      }
    }

    let current: string | null = null;
    if (slot === 0) {
      current = q;
    } else if (slot === 1) {
      current = sp;
    } else if (slot === 2) {
      current = bp;
    } else if (slot === 3) {
      current = np;
    }
    if (slot !== -1 && current === null) {
      const value =
        eq === -1 || eq > amp
          ? ""
          : decodeQueryComponent(rawUrl.substring(eq + 1, amp));
      if (slot === 0) {
        q = value;
      } else if (slot === 1) {
        sp = value;
      } else if (slot === 2) {
        bp = value;
      } else {
        np = value;
      }
    }
    i = amp + 1;
  }

  return [q, sp, bp, np];
}
