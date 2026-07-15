export const TOP_K = 8;
export const MAX_FRECENCY_ENTRIES = 64;
export const FRECENCY_BOOST_MULTIPLIER = 10;
export const FRECENCY_BOOST_CAP = 2000;

export const DEFAULT_URL = "https://www.google.com/search?q={}";

export const LUCKY_URLS: Record<string, string> = {
  google: "https://www.google.com/search?q={}&btnI=1",
  ddg: "https://duckduckgo.com/?q=\\{}",
  kagi: "https://kagi.com/search?q=\\{}",
};
export const LUCKY_TRIGGER_PROVIDERS: Readonly<Record<string, string>> = {
  g: "google",
  google: "google",
  ddg: "ddg",
  kagi: "kagi",
};
export const DEFAULT_LUCKY_PROVIDER = "ddg";
export const DEFAULT_LUCKY_URL = LUCKY_URLS[DEFAULT_LUCKY_PROVIDER];

export const SUGGEST_URLS: Record<string, string> = {
  google:
    "https://www.google.com/complete/search?client=firefox&channel=fen&q={}",
  ddg: "https://duckduckgo.com/ac/?q={}&type=list",
  bing: "https://www.bing.com/osjson.aspx?query={}",
  brave: "https://search.brave.com/api/suggest?q={}&rich=false",
  yahoo: "https://ff.search.yahoo.com/gossip?output=fxjson&command={}",
  ecosia: "https://ac.ecosia.org/autocomplete?q={}&type=list",
  kagi: "https://kagi.com/api/autosuggest?q={}",
  qwant: "https://api.qwant.com/v3/suggest/?q={}&client=opensearch",
  startpage: "https://www.startpage.com/osuggestions?q={}",
  yandex: "https://suggest.yandex.com/suggest-ff.cgi?part={}",
  baidu: "https://suggestion.baidu.com/su?wd={}&action=opensearch",
};
export const SUGGEST_TRIGGER_PROVIDERS: Readonly<Record<string, string>> = {
  g: "google",
  google: "google",
  ddg: "ddg",
  duckduckgo: "ddg",
  b: "bing",
  bing: "bing",
  brave: "brave",
  y: "yahoo",
  yahoo: "yahoo",
  ec: "ecosia",
  ecosia: "ecosia",
  kagi: "kagi",
  qw: "qwant",
  qwant: "qwant",
  qwt: "qwant",
  qww: "qwant",
  s: "startpage",
  sp: "startpage",
  startpage: "startpage",
  ya: "yandex",
  yandex: "yandex",
  bd: "baidu",
  baidu: "baidu",
};

export const FRECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const COOKIE_MAX_AGE_S = 31_536_000; // 365 days in seconds

export const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
} as const;

export const DB_VERSION = 1;
