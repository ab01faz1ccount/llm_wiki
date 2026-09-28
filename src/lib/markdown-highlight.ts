import { visit } from "unist-util-visit"
import type { Root, Text, Element, ElementContent } from "hast"

export interface MarkdownHighlightSpec {
  id: string
  text: string
  color: string
}

export const MARKDOWN_HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(250, 204, 21, 0.45)",
  green: "rgba(74, 222, 128, 0.45)",
  blue: "rgba(96, 165, 250, 0.45)",
  pink: "rgba(244, 114, 182, 0.45)",
}
export const DEFAULT_MARKDOWN_HIGHLIGHT_COLOR = "yellow"

/**
 * Wraps stored highlight text in `<mark data-highlight-id>` elements as a
 * rehype tree pass, so highlights survive react-markdown's normal render
 * pipeline instead of needing a second DOM-manipulation pass afterward.
 *
 * Matching is deliberately simple, not a full re-anchoring system: each
 * highlight's exact `text` must appear within a single hast text node
 * (i.e. not split across inline formatting like **bold** or *italic*
 * boundaries), and only the first not-yet-consumed occurrence in document
 * order is wrapped. A highlight that was made across a formatting
 * boundary, or whose text no longer appears verbatim (the user edited
 * that part of the file), simply doesn't render — the same "best effort,
 * degrade quietly" approach used for PDF/EPUB anchoring elsewhere in the
 * reader, appropriate here since the underlying Markdown is user-editable
 * and highlight offsets would drift on every edit anyway.
 */
export function rehypeHighlightMarks(highlights: MarkdownHighlightSpec[]) {
  return (tree: Root) => {
    if (highlights.length === 0) return
    const pending = new Map<string, MarkdownHighlightSpec[]>()
    for (const highlight of highlights) {
      if (!highlight.text) continue
      const list = pending.get(highlight.text) ?? []
      list.push(highlight)
      pending.set(highlight.text, list)
    }
    if (pending.size === 0) return

    visit(tree, "text", (node: Text, index, parent) => {
      if (index === null || index === undefined || !parent) return
      for (const [text, queue] of pending) {
        const at = node.value.indexOf(text)
        if (at === -1 || queue.length === 0) continue
        const highlight = queue.shift() as MarkdownHighlightSpec
        if (queue.length === 0) pending.delete(text)

        const before = node.value.slice(0, at)
        const matched = node.value.slice(at, at + text.length)
        const after = node.value.slice(at + text.length)
        const color = MARKDOWN_HIGHLIGHT_COLORS[highlight.color] ?? MARKDOWN_HIGHLIGHT_COLORS[DEFAULT_MARKDOWN_HIGHLIGHT_COLOR]

        const mark: Element = {
          type: "element",
          tagName: "mark",
          properties: {
            "data-highlight-id": highlight.id,
            style: `background-color:${color};padding:0;border-radius:2px;cursor:pointer;`,
            title: "Click to remove highlight",
          },
          children: [{ type: "text", value: matched }],
        }
        const replacement: ElementContent[] = []
        if (before) replacement.push({ type: "text", value: before })
        replacement.push(mark)
        if (after) replacement.push({ type: "text", value: after })

        parent.children.splice(index, 1, ...replacement)
        // Continue the walk at the trailing "after" text node we just
        // created (if any), so a second highlight whose text falls later
        // in the same original node — e.g. two highlights both saved as
        // "cat" in "cat cat" — still gets a chance to match. Without an
        // "after" node there's nothing left to revisit from this split.
        return after ? index + replacement.length - 1 : index + replacement.length
      }
      return undefined
    })
  }
}
