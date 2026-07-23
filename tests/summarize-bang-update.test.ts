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
});
