import { describe, expect, spyOn, test } from "bun:test";
import { extractSiteFilterDomain, validateBangs } from "../scripts/codegen";

describe("validateBangs", () => {
  test("rejects regular bangs that fail custom URL validation", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {
      /* Expected validation warnings. */
    });
    try {
      const result = validateBangs([
        {
          domain: "example.com",
          name: "Valid",
          relevance: 1,
          trigger: "valid",
          url: "https://example.com/search?q={}",
        },
        {
          domain: "example.com",
          name: "Missing placeholder",
          relevance: 1,
          trigger: "missing",
          url: "https://example.com/search",
        },
        {
          domain: "example.com",
          name: "Unsafe scheme",
          relevance: 1,
          trigger: "unsafe",
          url: "javascript:alert({})",
        },
        {
          domain: "flashbang",
          name: "Settings",
          relevance: 1,
          trigger: "settings",
          url: "/settings",
        },
      ]);

      expect(result.map((bang) => bang.trigger)).toEqual(["valid", "settings"]);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("extractSiteFilterDomain", () => {
  describe("site: literal pattern", () => {
    test("kagi q={}+site:domain", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q={}+site:4chan.org"
      );
      expect(result).toEqual({ domain: "4chan.org", pattern: "site:" });
    });

    test("kagi q={}+site:subdomain.domain", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q={}+site:wiki.asterisk.org"
      );
      expect(result).toEqual({ domain: "wiki.asterisk.org", pattern: "site:" });
    });

    test("google q=site:domain+{}", () => {
      const result = extractSiteFilterDomain(
        "https://www.google.com/search?q=site:reddit.com+{}"
      );
      expect(result).toEqual({ domain: "reddit.com", pattern: "site:" });
    });

    test("google q={} site:domain (space separated)", () => {
      const result = extractSiteFilterDomain(
        "https://www.google.com/search?q={} site:wikipedia.org"
      );
      expect(result).toEqual({ domain: "wikipedia.org", pattern: "site:" });
    });

    test("strips https:// protocol from site: target", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q={}+site:https://httpd.apache.org/docs/current/"
      );
      expect(result).toEqual({
        domain: "httpd.apache.org",
        pattern: "site:",
      });
    });

    test("strips http:// protocol from site: target", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q={}+site:http://example.com/path/"
      );
      expect(result).toEqual({ domain: "example.com", pattern: "site:" });
    });

    test("strips trailing slashes from site: path", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q={}+site:artsites.ucsc.edu/GDead/agdl/"
      );
      expect(result).toEqual({
        domain: "artsites.ucsc.edu",
        pattern: "site:",
      });
    });

    test("lowercases the domain", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q={}+site:GitHub.COM"
      );
      expect(result).toEqual({ domain: "github.com", pattern: "site:" });
    });
  });

  describe("site%3A URL-encoded pattern", () => {
    test("kagi q=site%3Adomain+{}", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q=site%3Awww.ada-auth.org+{}"
      );
      expect(result).toEqual({
        domain: "www.ada-auth.org",
        pattern: "site%3A",
      });
    });

    test("ddg q=site%3Ahttp%3A%2F%2Fdomain%2Fpath+{} (fully encoded)", () => {
      const result = extractSiteFilterDomain(
        "https://duckduckgo.com/?q=site%3Ahttp%3A%2F%2Fellislab.com%2Fforums%2F+{}"
      );
      expect(result).toEqual({ domain: "ellislab.com", pattern: "site%3A" });
    });

    test("uppercase %3A variant", () => {
      const result = extractSiteFilterDomain(
        "https://kagi.com/search?q=site%3Aadjective1.com+{}"
      );
      expect(result).toEqual({
        domain: "adjective1.com",
        pattern: "site%3A",
      });
    });
  });

  describe("sitesearch= parameter pattern", () => {
    test("sitesearch=domain", () => {
      const result = extractSiteFilterDomain(
        "https://www.google.com/search?domains=NewsMax.com&sitesearch=Newsmax.com&q={}"
      );
      expect(result).toEqual({ domain: "newsmax.com", pattern: "sitesearch=" });
    });

    test("sitesearch=http://domain/path/ (with protocol)", () => {
      const result = extractSiteFilterDomain(
        "https://www.google.com/search?sitesearch=http://www.freedesktop.org/wiki/&q={}&gws_rd=ssl"
      );
      expect(result).toEqual({
        domain: "www.freedesktop.org",
        pattern: "sitesearch=",
      });
    });

    test("as_sitesearch=domain", () => {
      const result = extractSiteFilterDomain(
        "https://ndpr.nd.edu/search/?search_keyword=&as_sitesearch=ndpr.nd.edu&q={}"
      );
      expect(result).toEqual({
        domain: "ndpr.nd.edu",
        pattern: "sitesearch=",
      });
    });
  });

  describe("exclusions", () => {
    test("returns null for negative site: (-site:)", () => {
      expect(
        extractSiteFilterDomain(
          "https://duckduckgo.com/?q=-site:pinterest.com+{}&iar=images"
        )
      ).toBeNull();
    });

    test("returns null for negative site%3A (-site%3A)", () => {
      expect(
        extractSiteFilterDomain(
          "https://duckduckgo.com/?q=-site%3Apinterest.com+{}"
        )
      ).toBeNull();
    });

    test("returns null for meta-bang site:{}", () => {
      expect(
        extractSiteFilterDomain("https://duckduckgo.com/?q=site%3A{}")
      ).toBeNull();
    });

    test("returns null for empty sitesearch=", () => {
      expect(
        extractSiteFilterDomain(
          "https://webmineral.com/cgi-bin/search/search.pl?sitesearch=&Terms={}"
        )
      ).toBeNull();
    });

    test("returns null for URL without any site-filtering", () => {
      expect(
        extractSiteFilterDomain("https://www.google.com/search?q={}")
      ).toBeNull();
    });

    test("does not match site=param (no colon)", () => {
      expect(
        extractSiteFilterDomain(
          "https://search.tugraz.at/search?q={}&site=Alle&btnG=Suchen"
        )
      ).toBeNull();
    });
  });
});
