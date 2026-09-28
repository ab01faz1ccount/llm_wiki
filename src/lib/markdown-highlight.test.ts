import { describe, it, expect } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import rehypeStringify from "rehype-stringify"
import { rehypeHighlightMarks, type MarkdownHighlightSpec } from "./markdown-highlight"

function render(markdown: string, highlights: MarkdownHighlightSpec[]): string {
  const file = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeHighlightMarks, highlights)
    .use(rehypeStringify)
    .processSync(markdown)
  return String(file)
}

describe("rehypeHighlightMarks", () => {
  it("wraps the highlighted text in a mark with the highlight id", () => {
    const html = render("The quick brown fox jumps.", [
      { id: "h1", text: "brown fox", color: "yellow" },
    ])
    expect(html).toContain('data-highlight-id="h1"')
    expect(html).toContain(">brown fox<")
    expect(html).toContain("<p>The quick <mark")
  })

  it("only wraps the first occurrence of repeated text", () => {
    const html = render("cat cat cat", [{ id: "h1", text: "cat", color: "yellow" }])
    const markCount = (html.match(/<mark/g) ?? []).length
    expect(markCount).toBe(1)
  })

  it("matches distinct highlights with the same text to separate occurrences in order", () => {
    const html = render("cat cat", [
      { id: "h1", text: "cat", color: "yellow" },
      { id: "h2", text: "cat", color: "green" },
    ])
    const ids = [...html.matchAll(/data-highlight-id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toEqual(["h1", "h2"])
  })

  it("renders nothing extra when the highlight text isn't found", () => {
    const html = render("Nothing to see here.", [{ id: "h1", text: "missing phrase", color: "yellow" }])
    expect(html).not.toContain("<mark")
  })

  it("does not match text split across an inline formatting boundary (documented limitation)", () => {
    const html = render("The **quick brown** fox.", [
      { id: "h1", text: "quick brown fox", color: "yellow" },
    ])
    // "quick brown" is inside <strong>, "fox" is in the surrounding text
    // node — no single text node contains the full phrase, so it's left
    // unhighlighted rather than partially/incorrectly wrapped.
    expect(html).not.toContain("<mark")
  })

  it("returns unmodified output when there are no highlights", () => {
    const html = render("Plain text.", [])
    expect(html).not.toContain("<mark")
  })
})
