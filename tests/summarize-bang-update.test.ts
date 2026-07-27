import { describe, expect, test } from "bun:test";
import { summarizeBangUpdate } from "../scripts/summarize-bang-update";

describe("summarizeBangUpdate", () => {
  test("reports added, removed, and field-level updates", () => {
    const summary = summarizeBangUpdate(
      [
        {
          trigger: "kept",
          name: "Kept",
          domain: "old.example",
          url: "https://old.example/?q={}",
          relevance: 1,
        },
        {
          trigger: "removed",
          name: "Removed",
          domain: "removed.example",
          url: "https://removed.example/?q={}",
          relevance: 0,
        },
      ],
      [
        {
          trigger: "added",
          name: "Added",
          domain: "added.example",
          url: "https://added.example/?q={}",
          relevance: 0,
        },
        {
          trigger: "kept",
          name: "Kept",
          domain: "new.example",
          url: "https://new.example/?q={}",
          relevance: 1,
        },
      ]
    );

    expect(summary).toContain("Total bangs: 2 to 2 (0)");
    expect(summary).toContain("Added: 1");
    expect(summary).toContain("Removed: 1");
    expect(summary).toContain("Updated: 1");
    expect(summary).toContain("<code>!added</code> Added");
    expect(summary).toContain("<code>!removed</code> Removed");
    expect(summary).toContain(
      "<code>domain</code> changed from <code>old.example</code> to <code>new.example</code>"
    );
    expect(summary).toContain(
      "<code>url</code> changed from <code>https://old.example/?q={}</code> to <code>https://new.example/?q={}</code>"
    );
  });

  test("escapes upstream text before rendering HTML", () => {
    const summary = summarizeBangUpdate(
      [],
      [
        {
          trigger: "<unsafe>",
          name: "A & B",
          domain: 'example.com" onclick="bad',
        },
      ]
    );

    expect(summary).toContain("<code>!&lt;unsafe&gt;</code> A &amp; B");
    expect(summary).toContain(
      "<code>example.com&quot; onclick=&quot;bad</code>"
    );
    expect(summary).not.toContain('example.com" onclick="bad');
  });

  test("renders unchanged and large updates without unbounded detail", () => {
    const unchanged = {
      trigger: "same",
      name: "Same",
      domain: "same.example",
      optional: undefined,
    };
    const summary = summarizeBangUpdate(
      [unchanged],
      [
        unchanged,
        ...Array.from({ length: 52 }, (_, index) => ({
          trigger: `added-${index}`,
          name: `Added ${index}`,
          domain: "added.example",
        })),
      ]
    );

    expect(summary).toContain("Updated: 0");
    expect(summary).toContain("### Removed (0)\nNone.");
    expect(summary).toContain("- 2 more not shown");
    expect(summary).not.toContain("!added-51");
  });

  test("renders non-string and removed field values", () => {
    const summary = summarizeBangUpdate(
      [
        {
          trigger: "typed",
          name: "Typed",
          domain: "typed.example",
          metadata: { rank: 1 },
          optional: "present",
        },
      ],
      [
        {
          trigger: "typed",
          name: "Typed",
          domain: "typed.example",
          metadata: { rank: 2 },
        },
      ]
    );

    expect(summary).toContain(
      "<code>metadata</code> changed from <code>{&quot;rank&quot;:1}</code> to <code>{&quot;rank&quot;:2}</code>"
    );
    expect(summary).toContain(
      "<code>optional</code> changed from <code>present</code> to <code>not set</code>"
    );
  });
});
