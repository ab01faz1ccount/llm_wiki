import { useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { openPath } from "@tauri-apps/plugin-opener"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import "katex/dist/katex.min.css"
import "@/components/reader/pdf-text-layer.css"
import {
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  FileSpreadsheet,
  FileQuestion,
  Code2,
  ExternalLink,
  RefreshCw,
  Maximize2,
  Minus,
  Plus,
  StickyNote,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist"
import { getFileSize, readFileAsBase64 } from "@/commands/fs"
import {
  getFileCategory,
  getCodeLanguage,
  getFileExtension,
  isExtractedTextPreviewFile,
} from "@/lib/file-types"
import type { FileCategory } from "@/lib/file-types"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { resolveMarkdownImageSrc } from "@/lib/markdown-image-resolver"
import { transformImageEmbeds } from "@/lib/wikilink-transform"
import { detectLanguage } from "@/lib/detect-language"
import { getHtmlLang, getTextDirection } from "@/lib/language-metadata"
import { parseFrontmatter } from "@/lib/frontmatter"
import { FrontmatterPanel } from "@/components/editor/frontmatter-panel"
import { useWikiStore } from "@/stores/wiki-store"
import { sourceIdentityForPath } from "@/lib/source-identity"
import { addHighlight, deleteHighlight, getReadingState, listHighlights, setReadingState, type Highlight } from "@/lib/reader-db"
import { ReaderSidePanel } from "@/components/reader/reader-side-panel"
import { MermaidDiagram, unwrapMermaidPre } from "@/components/mermaid-diagram"
import { FileHistoryButton } from "@/components/editor/file-history-panel"

interface FilePreviewProps {
  filePath: string
  textContent: string
}

/** A selection rectangle stored as a fraction of the page's rendered
 * width/height, not absolute pixels — the page container always fills
 * 100% of itself regardless of zoom, so percentages stay correct across
 * zoom changes without any recalculation. */
interface NormalizedRect {
  xPct: number
  yPct: number
  wPct: number
  hPct: number
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(250, 204, 21, 0.45)",
  green: "rgba(74, 222, 128, 0.45)",
  blue: "rgba(96, 165, 250, 0.45)",
  pink: "rgba(244, 114, 182, 0.45)",
}
const DEFAULT_HIGHLIGHT_COLOR = "yellow"

export function FilePreview({ filePath, textContent }: FilePreviewProps) {
  return <div className="relative h-full min-h-0">
    <FilePreviewContent filePath={filePath} textContent={textContent} />
    <FileHistoryButton filePath={filePath} currentContent={textContent} />
  </div>
}

function FilePreviewContent({ filePath, textContent }: FilePreviewProps) {
  const category = getFileCategory(filePath)
  const fileName = getFileName(filePath)
  const extension = getFileExtension(filePath)

  switch (category) {
    case "image":
      return <ImagePreview filePath={filePath} fileName={fileName} />
    case "video":
      return <VideoPreview filePath={filePath} fileName={fileName} />
    case "audio":
      return <AudioPreview filePath={filePath} fileName={fileName} />
    case "pdf":
      return <PdfPreview filePath={filePath} content={textContent} />
    case "code":
      if (extension === "mmd" || extension === "mermaid") {
        return <StandaloneMermaidPreview filePath={filePath} content={textContent} />
      }
      if (extension === "svg" && isAgentWorkspacePath(filePath)) {
        return <ImagePreview filePath={filePath} fileName={fileName} />
      }
      if (extension === "html" || extension === "htm") {
        return <HtmlPreview filePath={filePath} fileName={fileName} content={textContent} />
      }
      return <CodePreview filePath={filePath} content={textContent} />
    case "data":
      if (extension === "csv" || extension === "tsv") {
        return <DelimitedTablePreview filePath={filePath} content={textContent} delimiter={extension === "tsv" ? "\t" : ","} />
      }
      return <CodePreview filePath={filePath} content={textContent} />
    case "text":
      return <TextPreview filePath={filePath} content={textContent} label="Text" />
    case "document":
      if (extension === "epub") {
        return <EpubPreview filePath={filePath} />
      }
      if (isExtractedTextPreviewFile(filePath)) {
        return <TextPreview filePath={filePath} content={textContent} label={extractedTextLabel(filePath)} />
      }
      return <BinaryPlaceholder filePath={filePath} fileName={fileName} category={category} />
    default:
      return <BinaryPlaceholder filePath={filePath} fileName={fileName} category={category} />
  }
}

function PdfPreview({ filePath, content }: { filePath: string; content: string }) {
  const { t } = useTranslation()
  const [showText, setShowText] = useState(false)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(100)
  const [reloadKey, setReloadKey] = useState(0)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textLayerRef = useRef<HTMLDivElement | null>(null)
  const pageContainerRef = useRef<HTMLDivElement | null>(null)
  const project = useWikiStore((state) => state.project)
  const sourceIdentity = useMemo(
    () => (project ? sourceIdentityForPath(project.path, filePath) : null),
    [project, filePath],
  )
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [pendingHighlight, setPendingHighlight] = useState<{
    rects: NormalizedRect[]
    text: string
    prefix: string
    suffix: string
    anchorXPct: number
    anchorYPct: number
  } | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [prefillHighlightId, setPrefillHighlightId] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let loadingTask: PDFDocumentLoadingTask | null = null
    let loadedDocument: PDFDocumentProxy | null = null

    setLoading(true)
    setLoadError(null)
    setDocument(null)
    setPageCount(0)
    setPage(1)

    void (async () => {
      try {
        // PDF.js receives bytes over Tauri IPC because WebView-native PDF
        // plugins and custom asset URLs are not portable across WebView2 and
        // WebKitGTK. Base64 temporarily expands memory, so very large files
        // must stay on the streaming system-reader path instead.
        const fileSize = await getFileSize(filePath)
        if (fileSize > MAX_INLINE_PDF_BYTES) throw new Error(t("preview.pdfTooLarge"))
        const [{ getDocument, GlobalWorkerOptions }, workerModule, file] = await Promise.all([
          // The legacy build includes the URL/Promise/AbortSignal polyfills
          // required by older WebKitGTK runtimes still shipped by supported
          // Linux distributions. Windows WebView2 also uses this same path.
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
          readFileAsBase64(filePath),
        ])
        GlobalWorkerOptions.workerSrc = workerModule.default
        loadingTask = getDocument({ data: decodeBase64(file.base64) })
        loadedDocument = await loadingTask.promise
        if (disposed) {
          await loadedDocument.destroy()
          return
        }
        setDocument(loadedDocument)
        setPageCount(loadedDocument.numPages)
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!disposed) setLoading(false)
      }
    })()

    return () => {
      disposed = true
      if (loadingTask) void loadingTask.destroy()
      else if (loadedDocument) void loadedDocument.destroy()
    }
  }, [filePath, reloadKey, t])

  useEffect(() => {
    if (!document || showText) return
    const canvas = canvasRef.current
    const textContainer = textLayerRef.current
    if (!canvas) return
    let disposed = false
    let renderTask: RenderTask | null = null
    let textLayer: { cancel: () => void } | null = null

    void (async () => {
      try {
        const pdfPage = await document.getPage(Math.min(page, document.numPages))
        if (disposed) return
        const viewport = pdfPage.getViewport({ scale: (zoom / 100) * 1.25 })
        const pixelRatio = window.devicePixelRatio || 1
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Canvas 2D rendering is unavailable")
        canvas.width = Math.floor(viewport.width * pixelRatio)
        canvas.height = Math.floor(viewport.height * pixelRatio)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        })
        // Size the text layer to the CSS viewport so selectable text lines up
        // with the canvas at every zoom level.
        if (textContainer) {
          textContainer.replaceChildren()
          textContainer.style.width = canvas.style.width
          textContainer.style.height = canvas.style.height
          textContainer.style.setProperty("--total-scale-factor", String(viewport.scale))
        }
        await renderTask.promise
        if (disposed || !textContainer) return
        const { TextLayer } = await import("pdfjs-dist/legacy/build/pdf.mjs")
        if (disposed) return
        const layer = new TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          container: textContainer,
          viewport,
        })
        textLayer = layer
        await layer.render()
      } catch (error) {
        if (!disposed && !(error instanceof Error && error.name === "RenderingCancelledException")) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }
    })()

    return () => {
      disposed = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [document, page, showText, zoom])

  useEffect(() => {
    if (!project || !sourceIdentity) {
      setHighlights([])
      return
    }
    let disposed = false
    void listHighlights(project.path, sourceIdentity)
      .then((items) => {
        if (!disposed) setHighlights(items)
      })
      .catch(() => {
        if (!disposed) setHighlights([])
      })
    return () => {
      disposed = true
    }
  }, [project, sourceIdentity])

  useEffect(() => {
    setPendingHighlight(null)
  }, [page, zoom])

  const restoredPageForRef = useRef<string | null>(null)

  // Restore the last-read page once per document, before the save effect
  // below starts persisting page changes (guarded by the same ref so a
  // save can't race ahead of the restore and overwrite it with page 1).
  useEffect(() => {
    if (!project || !sourceIdentity || pageCount <= 0) return
    if (restoredPageForRef.current === sourceIdentity) return
    restoredPageForRef.current = sourceIdentity
    void getReadingState(project.path, sourceIdentity)
      .then((state) => {
        if (state?.page && state.page >= 1 && state.page <= pageCount) {
          setPage(state.page)
        }
      })
      .catch(() => {})
  }, [project, sourceIdentity, pageCount])

  useEffect(() => {
    if (!project || !sourceIdentity || pageCount <= 0 || loading) return
    if (restoredPageForRef.current !== sourceIdentity) return
    const timeout = window.setTimeout(() => {
      void setReadingState(
        { projectPath: project.path, sourceIdentity, title: getFileName(filePath), docType: "pdf" },
        { page, percent: Math.round((page / pageCount) * 1000) / 10, status: "reading" },
      ).catch(() => {})
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [project, sourceIdentity, pageCount, page, loading, filePath])

  function handlePageMouseUp() {
    const container = pageContainerRef.current
    const selection = window.getSelection()
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPendingHighlight(null)
      return
    }
    const range = selection.getRangeAt(0)
    const text = selection.toString().trim()
    if (!text || !container.contains(range.commonAncestorContainer)) {
      setPendingHighlight(null)
      return
    }
    const box = container.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return
    const rects: NormalizedRect[] = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        xPct: (rect.left - box.left) / box.width,
        yPct: (rect.top - box.top) / box.height,
        wPct: rect.width / box.width,
        hPct: rect.height / box.height,
      }))
    if (rects.length === 0) return
    // Best-effort surrounding context, derived from the rendered text layer
    // rather than the underlying PDF text stream — good enough to help a
    // human recognize the spot later, not exact enough to re-anchor by.
    const fullText = container.textContent ?? ""
    const idx = fullText.indexOf(text)
    const prefix = idx > 0 ? fullText.slice(Math.max(0, idx - 40), idx) : ""
    const suffix = idx >= 0 ? fullText.slice(idx + text.length, idx + text.length + 40) : ""
    const last = rects[rects.length - 1]
    setPendingHighlight({
      rects,
      text,
      prefix,
      suffix,
      anchorXPct: last.xPct + last.wPct,
      anchorYPct: last.yPct + last.hPct,
    })
  }

  async function confirmPendingHighlight(color: string) {
    if (!pendingHighlight || !project || !sourceIdentity) return
    const saved = await addHighlight(
      { projectPath: project.path, sourceIdentity, title: getFileName(filePath), docType: "pdf" },
      {
        page,
        rects: pendingHighlight.rects,
        text: pendingHighlight.text,
        prefix: pendingHighlight.prefix,
        suffix: pendingHighlight.suffix,
        color,
      },
    )
    setHighlights((prev) => [...prev, saved])
    setPendingHighlight(null)
    window.getSelection()?.removeAllRanges()
  }

  async function removeHighlight(id: string) {
    if (!project) return
    setHighlights((prev) => prev.filter((item) => item.id !== id))
    await deleteHighlight(project.path, id).catch(() => {
      // Best effort: if the delete failed, the next reload of this
      // document will bring the highlight back rather than silently
      // desyncing the on-screen list from the database.
    })
  }

  return <div className="flex h-full min-h-0 flex-col p-4">
    <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
      <button type="button" className="rounded border px-2 py-1 hover:bg-muted" onClick={() => setShowText((value) => !value)}>{showText ? t("preview.pdfDocument") : t("preview.pdfText")}</button>
      {!showText && <><button type="button" className="rounded p-1 hover:bg-muted" onClick={() => setZoom((value) => Math.max(50, value - 25))}><Minus className="h-3.5 w-3.5" /></button><span className="w-10 text-center">{zoom}%</span><button type="button" className="rounded p-1 hover:bg-muted" onClick={() => setZoom((value) => Math.min(300, value + 25))}><Plus className="h-3.5 w-3.5" /></button><label className="ml-1 flex items-center gap-1">{t("preview.pdfPage")}<input value={page} min={1} max={pageCount || undefined} type="number" onChange={(event) => setPage(clampPdfPage(Number(event.target.value) || 1, pageCount))} className="w-14 rounded border bg-background px-1 py-0.5" /></label><span>/ {pageCount || "–"}</span>{pageCount > 0 && <span className="text-muted-foreground/70">({Math.round((page / pageCount) * 100)}%)</span>}</>}
      <button type="button" onClick={() => void openPath(filePath)} className="rounded p-1 hover:bg-muted" title={t("preview.openWithSystem")} aria-label={t("preview.openWithSystem")}><ExternalLink className="h-3.5 w-3.5" /></button>
      {!showText && project && sourceIdentity && (
        <button
          type="button"
          onClick={() => setPanelOpen((value) => !value)}
          className={`rounded p-1 hover:bg-muted ${panelOpen ? "bg-muted" : ""}`}
          title={t("reader.togglePanel")}
          aria-label={t("reader.togglePanel")}
        >
          <StickyNote className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    <div className="flex min-h-0 flex-1 gap-2">
    <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-white">
      {showText ? <TextPreview filePath={filePath} content={content} label="PDF text" /> : loading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("preview.pdfLoading")}</div>
      ) : loadError ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <FileQuestion className="h-8 w-8" />
          <p>{t("preview.pdfLoadError")}</p>
          <p className="max-w-xl break-words text-xs opacity-70">{loadError}</p>
          <button type="button" className="rounded border px-3 py-1.5 hover:bg-muted" onClick={() => setReloadKey((value) => value + 1)}>{t("preview.reload")}</button>
        </div>
      ) : (
        <div className="h-full overflow-auto bg-muted/30 p-4">
          <div
            ref={pageContainerRef}
            className="relative mx-auto w-fit bg-white shadow-sm"
            onMouseUp={handlePageMouseUp}
          >
            <canvas ref={canvasRef} className="block" />
            <div className="pointer-events-none absolute inset-0">
              {highlights
                .filter((highlight) => highlight.page === page)
                .flatMap((highlight) => {
                  let rects: NormalizedRect[] = []
                  try {
                    rects = JSON.parse(highlight.rectsJson) as NormalizedRect[]
                  } catch {
                    return []
                  }
                  const color = HIGHLIGHT_COLORS[highlight.color] ?? HIGHLIGHT_COLORS[DEFAULT_HIGHLIGHT_COLOR]
                  return rects.map((rect, index) => (
                    <div
                      key={`${highlight.id}-${index}`}
                      className="group pointer-events-auto absolute"
                      style={{
                        left: `${rect.xPct * 100}%`,
                        top: `${rect.yPct * 100}%`,
                        width: `${rect.wPct * 100}%`,
                        height: `${rect.hPct * 100}%`,
                        backgroundColor: color,
                        mixBlendMode: "multiply",
                      }}
                      title={highlight.text}
                    >
                      {index === rects.length - 1 && (
                        <div className="absolute -right-2 -top-2 hidden items-center gap-0.5 group-hover:flex" style={{ mixBlendMode: "normal" }}>
                          <button
                            type="button"
                            className="flex h-4 w-4 items-center justify-center rounded-full bg-background text-[10px] leading-none text-muted-foreground shadow hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation()
                              setPrefillHighlightId(highlight.id)
                              setPanelOpen(true)
                            }}
                            aria-label={t("reader.addNote")}
                          >
                            <StickyNote className="h-2.5 w-2.5" />
                          </button>
                          <button
                            type="button"
                            className="flex h-4 w-4 items-center justify-center rounded-full bg-background text-[10px] leading-none text-muted-foreground shadow hover:text-destructive"
                            onClick={(event) => {
                              event.stopPropagation()
                              void removeHighlight(highlight.id)
                            }}
                            aria-label={t("preview.pdfDeleteHighlight")}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                })}
            </div>
            {pendingHighlight && (
              <div
                className="absolute z-10 flex items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
                style={{
                  left: `${pendingHighlight.anchorXPct * 100}%`,
                  top: `${pendingHighlight.anchorYPct * 100}%`,
                }}
              >
                {Object.entries(HIGHLIGHT_COLORS).map(([name, color]) => (
                  <button
                    key={name}
                    type="button"
                    className="h-5 w-5 rounded-full border border-black/10"
                    style={{ backgroundColor: color }}
                    title={name}
                    onClick={() => void confirmPendingHighlight(name)}
                  />
                ))}
                <button
                  type="button"
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted"
                  onClick={() => setPendingHighlight(null)}
                  aria-label={t("preview.cancel")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <div ref={textLayerRef} className="textLayer" />
          </div>
        </div>
      )}
    </div>
    {panelOpen && project && sourceIdentity && !showText && (
      <ReaderSidePanel
        projectPath={project.path}
        sourceIdentity={sourceIdentity}
        title={getFileName(filePath)}
        docType="pdf"
        currentPage={page}
        onJumpToPage={(target) => setPage(clampPdfPage(target, pageCount))}
        currentBookmark={{ location: JSON.stringify({ page }), label: `${t("preview.pdfPage")} ${page}` }}
        onJumpToBookmark={(location) => {
          try {
            const parsed = JSON.parse(location) as { page?: number }
            if (typeof parsed.page === "number") setPage(clampPdfPage(parsed.page, pageCount))
          } catch {
            // Not a PDF-shaped bookmark location; nothing sensible to jump to.
          }
        }}
        currentNoteLocation={JSON.stringify({ page })}
        onJumpToNoteLocation={(location) => {
          try {
            const parsed = JSON.parse(location) as { page?: number }
            if (typeof parsed.page === "number") setPage(clampPdfPage(parsed.page, pageCount))
          } catch {
            // Not a PDF-shaped note location; nothing sensible to jump to.
          }
        }}
        highlights={highlights}
        prefillHighlightId={prefillHighlightId}
        onConsumePrefill={() => setPrefillHighlightId(null)}
        onClose={() => setPanelOpen(false)}
      />
    )}
    </div>
  </div>
}

/** EPUB reader. Unlike the PDF path above (where we drive pdf.js's canvas
 * and text layer by hand), epub.js owns rendering itself — it mounts an
 * iframe into `viewerRef` and repaginates on resize/font changes. We just
 * feed it file bytes and react to its `relocated`/`selected` events.
 *
 * Positions are EPUB CFIs (strings), not page numbers — reflowable EPUBs
 * don't have a fixed page count, so reading progress and bookmarks store
 * the CFI directly. Saved highlights reuse the PDF/EPUB-agnostic
 * `rects_json` column to carry `{ "cfi": "..." }` instead of pixel rects.
 *
 * Known gap: freestanding (not highlight-linked) notes are stamped with
 * `page: null` here, since the reader.db notes table has no CFI/location
 * column of its own (only `page: INTEGER`) — they show up in the notes
 * panel with their body and, if linked to a highlight, the highlighted
 * text for context, but can't be jumped back to directly the way PDF page
 * notes can. Giving notes a proper location column is a small additive
 * migration if this turns out to matter in practice. */
function EpubPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation()
  const viewerRef = useRef<HTMLDivElement | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- epub.js's own types leave Book/Rendition's event payloads as `any`.
  const bookRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renditionRef = useRef<any>(null)
  const appliedHighlightsRef = useRef<Map<string, string>>(new Map())
  const restoredForRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [locationCfi, setLocationCfi] = useState<string | null>(null)
  const [percent, setPercent] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const [prefillHighlightId, setPrefillHighlightId] = useState<string | null>(null)
  const [pendingHighlight, setPendingHighlight] = useState<{ cfiRange: string; text: string } | null>(null)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const project = useWikiStore((state) => state.project)
  const sourceIdentity = useMemo(
    () => (project ? sourceIdentityForPath(project.path, filePath) : null),
    [project, filePath],
  )

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setLoadError(null)
    setLocationCfi(null)
    setPercent(0)
    appliedHighlightsRef.current = new Map()

    void (async () => {
      try {
        const fileSize = await getFileSize(filePath)
        if (fileSize > MAX_INLINE_EPUB_BYTES) throw new Error(t("preview.epubTooLarge"))
        const [{ default: ePub }, file] = await Promise.all([
          import("epubjs"),
          readFileAsBase64(filePath),
        ])
        if (disposed) return
        const bytes = decodeBase64(file.base64)
        const book = ePub(bytes.buffer as ArrayBuffer)
        bookRef.current = book
        await book.ready
        if (disposed) {
          void book.destroy()
          return
        }
        const container = viewerRef.current
        if (!container) return
        const rendition = book.renderTo(container, { width: "100%", height: "100%", flow: "paginated" })
        renditionRef.current = rendition
        rendition.on("relocated", (location: { start: { cfi: string; percentage: number } }) => {
          if (disposed) return
          setLocationCfi(location.start.cfi)
          setPercent(Math.round(location.start.percentage * 1000) / 10)
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rendition.on("selected", (cfiRange: string, contents: any) => {
          if (disposed) return
          const text = (contents?.window?.getSelection?.()?.toString() ?? "").trim()
          if (text) setPendingHighlight({ cfiRange, text })
        })
        await rendition.display()
        if (!disposed) setLoading(false)
      } catch (error) {
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : String(error))
          setLoading(false)
        }
      }
    })()

    return () => {
      disposed = true
      renditionRef.current?.destroy?.()
      void bookRef.current?.destroy?.()
      renditionRef.current = null
      bookRef.current = null
    }
  }, [filePath, reloadKey, t])

  useEffect(() => {
    if (!project || !sourceIdentity) {
      setHighlights([])
      return
    }
    let disposed = false
    void listHighlights(project.path, sourceIdentity)
      .then((items) => {
        if (!disposed) setHighlights(items)
      })
      .catch(() => {
        if (!disposed) setHighlights([])
      })
    return () => {
      disposed = true
    }
  }, [project, sourceIdentity])

  // Restore the last-read CFI once per document, before the save effect
  // below starts persisting relocations — same ordering guard as PdfPreview.
  useEffect(() => {
    if (!project || !sourceIdentity || loading || !renditionRef.current) return
    if (restoredForRef.current === sourceIdentity) return
    restoredForRef.current = sourceIdentity
    void getReadingState(project.path, sourceIdentity)
      .then((state) => {
        if (state?.location) void renditionRef.current?.display(state.location)
      })
      .catch(() => {})
  }, [project, sourceIdentity, loading])

  useEffect(() => {
    if (!project || !sourceIdentity || !locationCfi) return
    if (restoredForRef.current !== sourceIdentity) return
    const timeout = window.setTimeout(() => {
      void setReadingState(
        { projectPath: project.path, sourceIdentity, title: getFileName(filePath), docType: "epub" },
        { location: locationCfi, percent, status: "reading" },
      ).catch(() => {})
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [project, sourceIdentity, locationCfi, percent, filePath])

  // Keep epub.js's own annotation layer (which does the actual highlight
  // painting inside its iframe) in sync with the saved highlight list,
  // diffing against what we last applied rather than clearing and
  // re-adding everything on every render.
  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    const applied = appliedHighlightsRef.current
    const currentIds = new Set(highlights.map((item) => item.id))
    for (const [id, cfiRange] of applied) {
      if (!currentIds.has(id)) {
        rendition.annotations.remove(cfiRange, "highlight")
        applied.delete(id)
      }
    }
    for (const highlight of highlights) {
      if (applied.has(highlight.id)) continue
      let cfiRange: string | null = null
      try {
        const parsed = JSON.parse(highlight.rectsJson) as { cfi?: string }
        cfiRange = parsed.cfi ?? null
      } catch {
        cfiRange = null
      }
      if (!cfiRange) continue
      const color = HIGHLIGHT_COLORS[highlight.color] ?? HIGHLIGHT_COLORS[DEFAULT_HIGHLIGHT_COLOR]
      rendition.annotations.highlight(
        cfiRange,
        {},
        () => void removeHighlight(highlight.id),
        "epub-highlight",
        { fill: color, "fill-opacity": "1", "mix-blend-mode": "multiply", cursor: "pointer" },
      )
      applied.set(highlight.id, cfiRange)
    }
    // removeHighlight is stable across renders (defined below with no
    // dependency on component state other than refs/setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlights])

  async function confirmPendingHighlight(color: string) {
    if (!pendingHighlight || !project || !sourceIdentity) return
    const saved = await addHighlight(
      { projectPath: project.path, sourceIdentity, title: getFileName(filePath), docType: "epub" },
      {
        rects: { cfi: pendingHighlight.cfiRange } as unknown as NormalizedRect,
        text: pendingHighlight.text,
        color,
      },
    )
    setHighlights((prev) => [...prev, saved])
    setPendingHighlight(null)
    renditionRef.current?.getContents?.()?.forEach?.((contents: { window: Window }) => {
      contents.window.getSelection()?.removeAllRanges()
    })
  }

  async function removeHighlight(id: string) {
    if (!project) return
    setHighlights((prev) => prev.filter((item) => item.id !== id))
    await deleteHighlight(project.path, id).catch(() => {})
  }

  return <div className="flex h-full min-h-0 flex-col p-4">
    <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
      {pageCountLabel(percent, t)}
      <button type="button" onClick={() => void openPath(filePath)} className="rounded p-1 hover:bg-muted" title={t("preview.openWithSystem")} aria-label={t("preview.openWithSystem")}><ExternalLink className="h-3.5 w-3.5" /></button>
      {project && sourceIdentity && (
        <button
          type="button"
          onClick={() => setPanelOpen((value) => !value)}
          className={`rounded p-1 hover:bg-muted ${panelOpen ? "bg-muted" : ""}`}
          title={t("reader.togglePanel")}
          aria-label={t("reader.togglePanel")}
        >
          <StickyNote className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    <div className="flex min-h-0 flex-1 gap-2">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-white">
        {loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <FileQuestion className="h-8 w-8" />
            <p>{t("preview.epubLoadError")}</p>
            <p className="max-w-xl break-words text-xs opacity-70">{loadError}</p>
            <button type="button" className="rounded border px-3 py-1.5 hover:bg-muted" onClick={() => setReloadKey((value) => value + 1)}>{t("preview.reload")}</button>
          </div>
        ) : (
          <>
            {loading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white text-sm text-muted-foreground">
                {t("preview.epubLoading")}
              </div>
            )}
            <div ref={viewerRef} className="h-full w-full" />
            {!loading && (
              <>
                <button
                  type="button"
                  className="absolute left-1 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 shadow hover:bg-muted"
                  onClick={() => void renditionRef.current?.prev?.()}
                  aria-label={t("reader.previousPage")}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 shadow hover:bg-muted"
                  onClick={() => void renditionRef.current?.next?.()}
                  aria-label={t("reader.nextPage")}
                >
                  ›
                </button>
              </>
            )}
            {pendingHighlight && (
              <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border bg-popover p-1 shadow-md">
                {Object.entries(HIGHLIGHT_COLORS).map(([name, color]) => (
                  <button
                    key={name}
                    type="button"
                    className="h-5 w-5 rounded-full border border-black/10"
                    style={{ backgroundColor: color }}
                    title={name}
                    onClick={() => void confirmPendingHighlight(name)}
                  />
                ))}
                <button
                  type="button"
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted"
                  onClick={() => setPendingHighlight(null)}
                  aria-label={t("preview.cancel")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {panelOpen && project && sourceIdentity && (
        <ReaderSidePanel
          projectPath={project.path}
          sourceIdentity={sourceIdentity}
          title={getFileName(filePath)}
          docType="epub"
          currentBookmark={locationCfi ? { location: locationCfi, label: `${t("preview.pdfPage")} · ${percent}%` } : null}
          onJumpToBookmark={(location) => void renditionRef.current?.display(location)}
          currentNoteLocation={locationCfi}
          onJumpToNoteLocation={(location) => void renditionRef.current?.display(location)}
          highlights={highlights}
          prefillHighlightId={prefillHighlightId}
          onConsumePrefill={() => setPrefillHighlightId(null)}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  </div>
}

function pageCountLabel(percent: number, t: (key: string) => string): ReactElement {
  return <span className="whitespace-nowrap">{t("reader.progress")} {percent}%</span>
}

const MAX_INLINE_PDF_BYTES = 128 * 1024 * 1024
const MAX_INLINE_EPUB_BYTES = 64 * 1024 * 1024

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function clampPdfPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, pageCount))
}

export function parseDelimitedContent(content: string, delimiter: string, maxRows = 500): string[][] {
  const rows: string[][] = []
  let cells: string[] = []
  let current = ""
  let quoted = false
  const normalized = content.replace(/\r\n/g, "\n")
  for (let index = 0; index < normalized.length && rows.length < maxRows; index += 1) {
    const char = normalized[index]
    if (char === '"') {
      if (quoted && normalized[index + 1] === '"') { current += '"'; index += 1 } else quoted = !quoted
    } else if (char === delimiter && !quoted) { cells.push(current); current = "" } else current += char
    if (char === "\n" && !quoted) {
      current = current.slice(0, -1)
      cells.push(current); rows.push(cells); cells = []; current = ""
    }
  }
  if ((current || cells.length > 0) && rows.length < maxRows) { cells.push(current); rows.push(cells) }
  return rows
}

function DelimitedTablePreview({ filePath, content, delimiter }: { filePath: string; content: string; delimiter: string }) {
  const rows = useMemo(() => parseDelimitedContent(content, delimiter), [content, delimiter])
  return <div className="h-full overflow-auto p-4"><div className="mb-2 text-xs text-muted-foreground">{filePath}</div><table className="min-w-full border-collapse text-xs"><thead className="sticky top-0 bg-muted">{rows[0] && <tr>{rows[0].map((cell, index) => <th key={index} className="border px-2 py-1 text-left">{cell}</th>)}</tr>}</thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-80 border px-2 py-1 align-top">{cell}</td>)}</tr>)}</tbody></table></div>
}

function HtmlPreview({
  filePath,
  fileName,
  content,
}: {
  filePath: string
  fileName: string
  content: string
}) {
  const { t } = useTranslation()
  const src = convertFileSrc(filePath)
  const [showSource, setShowSource] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  return (
    <div className="flex h-full flex-col p-4" data-preview-kind="html">
      <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">HTML</span>
        <button
          type="button"
          onClick={() => setShowSource((current) => !current)}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title={showSource ? t("preview.showRendered") : t("preview.showSource")}
          aria-label={showSource ? t("preview.showRendered") : t("preview.showSource")}
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
        {!showSource && (
          <button
            type="button"
            onClick={() => setReloadKey((current) => current + 1)}
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            title={t("preview.reload")}
            aria-label={t("preview.reload")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void openPath(filePath)}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title={t("preview.openWithSystem")}
          aria-label={t("preview.openWithSystem")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
        {showSource ? (
          <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs">
            {content}
          </pre>
        ) : (
          <iframe
            key={reloadKey}
            title={fileName}
            src={src}
            className="h-full w-full bg-white"
            // Generated HTML is untrusted Agent output. Scripts are useful for
            // interactive reports, but same-origin access stays disabled so the
            // document cannot reach the parent DOM or authenticated app APIs.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  )
}

function StandaloneMermaidPreview({ filePath, content }: { filePath: string; content: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-6" data-preview-kind="mermaid">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={filePath}>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">Mermaid</span>
      </div>
      <MermaidDiagram code={content} />
    </div>
  )
}

function isAgentWorkspacePath(filePath: string): boolean {
  return normalizePath(filePath).split("/").includes("agent-workspace")
}

function extractedTextLabel(filePath: string): string {
  switch (getFileExtension(filePath)) {
    case "doc":
      return "Word DOC (extracted text)"
    case "docx":
    case "docm":
      return "Word DOCX (extracted text)"
    case "ppt":
    case "pps":
    case "pot":
    case "pptx":
    case "pptm":
    case "ppsx":
    case "ppsm":
      return "PowerPoint (extracted text)"
    case "xls":
    case "xlsx":
    case "xlsm":
    case "xlsb":
      return "Spreadsheet (extracted text)"
    case "odt":
    case "ods":
    case "odp":
      return "OpenDocument (extracted text)"
    case "rtf":
      return "Rich Text Format (extracted text)"
    default:
      return "Extracted text"
  }
}

function ImagePreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(1)
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><span className="min-w-0 flex-1 truncate">{filePath}</span><button type="button" onClick={() => setExpanded(true)} className="rounded p-1 hover:bg-muted"><Maximize2 className="h-4 w-4" /></button></div>
      <div className="flex flex-1 items-center justify-center overflow-auto rounded-lg bg-muted/30">
        <img
          src={src}
          alt={fileName}
          className="max-h-full max-w-full object-contain"
        />
      </div>
      {expanded && <div className="fixed inset-0 z-[100] flex flex-col bg-background/95 p-4 backdrop-blur-sm"><div className="flex justify-end gap-1"><button type="button" className="rounded p-2 hover:bg-muted" onClick={() => setZoom((value) => Math.max(.25, value - .25))}><Minus className="h-4 w-4" /></button><button type="button" className="rounded p-2 hover:bg-muted" onClick={() => setZoom((value) => Math.min(5, value + .25))}><Plus className="h-4 w-4" /></button><button type="button" className="rounded p-2 hover:bg-muted" onClick={() => setExpanded(false)}><X className="h-4 w-4" /></button></div><div className="min-h-0 flex-1 overflow-auto text-center"><img src={src} alt={fileName} className="mx-auto max-w-none object-contain" style={{ width: `${zoom * 100}%` }} /></div></div>}
    </div>
  )
}

function VideoPreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4 text-xs text-muted-foreground">{filePath}</div>
      <div className="flex flex-1 items-center justify-center overflow-auto rounded-lg bg-black">
        <video
          src={src}
          controls
          className="max-h-full max-w-full"
        >
          <track kind="captions" label={fileName} />
        </video>
      </div>
    </div>
  )
}

function AudioPreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  const src = convertFileSrc(filePath)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="text-xs text-muted-foreground">{filePath}</div>
      <Music className="h-16 w-16 text-muted-foreground/50" />
      <p className="text-sm font-medium">{fileName}</p>
      <audio src={src} controls className="w-full max-w-md">
        <track kind="captions" label={fileName} />
      </audio>
    </div>
  )
}

function CodePreview({ filePath, content }: { filePath: string; content: string }) {
  const lang = getCodeLanguage(filePath)
  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{lang}</span>
      </div>
      <pre className="whitespace-pre-wrap rounded-lg bg-muted/30 p-4 font-mono text-sm">
        {content}
      </pre>
    </div>
  )
}

function TextPreview({ filePath, content, label }: { filePath: string; content: string; label: string }) {
  const projectPath = useWikiStore((s) => s.project?.path ?? null)
  const pendingScrollImageSrc = useWikiStore((s) => s.pendingScrollImageSrc)
  const setPendingScrollImageSrc = useWikiStore((s) => s.setPendingScrollImageSrc)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  const { frontmatter, body } = useMemo(() => parseFrontmatter(content), [content])
  // Rewrite Obsidian image embeds (`![[…]]`) into standard markdown
  // so raw-source previews (e.g. skill-exported docs) actually show
  // their images instead of dumping the embed syntax as text.
  const renderBody = useMemo(() => transformImageEmbeds(body), [body])
  // Directory of this file (project-absolute) so relative image
  // references (`../assets/x.png`) resolve against the file's own
  // location, Obsidian-style.
  const currentFileDir = useMemo(() => {
    const norm = normalizePath(filePath)
    const dir = norm.slice(0, norm.lastIndexOf("/"))
    return dir || null
  }, [filePath])
  const renderLanguage = useMemo(() => detectLanguage(body), [body])
  const direction = getTextDirection(renderLanguage)
  const htmlLang = getHtmlLang(renderLanguage)

  // Consume `pendingScrollImageSrc` once the file has rendered.
  // We re-scan the DOM whenever:
  //   - file content changes (different page just loaded), OR
  //   - the pending target changes (user clicked a different image)
  // Image loading is async, so we also subscribe to `load` events
  // and rescroll once the actual layout settles — the first
  // `scrollIntoView` lands on a 0-height placeholder otherwise.
  useEffect(() => {
    if (!pendingScrollImageSrc) return
    const root = scrollRootRef.current
    if (!root) return
    // Match by `data-mdsrc` (literal markdown URL) — the post-
    // resolver `src` is a tauri:// URL we don't want to bake into
    // the search-result data.
    // Inline-escape `"` and `\` for the attribute-VALUE position
    // of a CSS selector (CSS.escape is for IDENTIFIER context and
    // would over-escape here). Image URLs can in principle contain
    // either, so doing this is correctness, not paranoia.
    const escapedSrc = pendingScrollImageSrc
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
    const target = root.querySelector<HTMLImageElement>(
      `img[data-mdsrc="${escapedSrc}"]`,
    )
    if (!target) {
      // Page may not actually contain this image — clear the
      // pending so a future page-open doesn't get an unexpected
      // scroll. Fail silently: the user navigated, we just don't
      // know where to send them.
      setPendingScrollImageSrc(null)
      return
    }
    // Initial scroll. The image may not have loaded its bytes yet
    // (lazy loading + remote PNG decode) so this lands on a
    // 0-height box. After load, recompute.
    target.scrollIntoView({ behavior: "auto", block: "center" })
    if (!target.complete) {
      const onLoad = () => {
        target.scrollIntoView({ behavior: "smooth", block: "center" })
        target.removeEventListener("load", onLoad)
      }
      target.addEventListener("load", onLoad)
    }
    // Briefly highlight the target so the user sees where they
    // landed — the page might be long and the image might be in
    // a section visually similar to its neighbors.
    target.classList.add("ring-2", "ring-primary", "ring-offset-2")
    const tHighlight = setTimeout(() => {
      target.classList.remove("ring-2", "ring-primary", "ring-offset-2")
    }, 1800)
    setPendingScrollImageSrc(null)
    return () => clearTimeout(tHighlight)
  }, [pendingScrollImageSrc, content, setPendingScrollImageSrc])

  return (
    <div ref={scrollRootRef} className="h-full overflow-auto p-6">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{filePath}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{label}</span>
      </div>
      {frontmatter && <FrontmatterPanel data={frontmatter} />}
      <div
        className="prose prose-sm max-w-none dark:prose-invert"
        dir={direction}
        lang={htmlLang}
        style={{ textAlign: "start" }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            // Resolve `![](media/...)` references generated by the
            // ingest image-extraction step. Without this, the
            // browser tries to load `media/...` relative to the
            // webview origin and silently 404s.
            //
            // `data-mdsrc` preserves the ORIGINAL markdown URL
            // (pre-resolver) so the search-result jump-to-image
            // path can find the rendered <img> by its source-of-
            // truth identifier rather than the resolved tauri://
            // URL (which differs per platform).
            img: ({ src, alt, ...props }) => (
              <img
                src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath, currentFileDir) : undefined}
                data-mdsrc={typeof src === "string" ? src : undefined}
                alt={alt ?? ""}
                className="max-w-full rounded border border-border/40 transition-all"
                loading="lazy"
                {...props}
              />
            ),
            table: ({ children, ...props }) => (
              <div className="my-2 overflow-x-auto rounded border border-border">
                <table className="w-full border-collapse text-xs" {...props}>{children}</table>
              </div>
            ),
            thead: ({ children, ...props }) => (
              <thead className="bg-muted" {...props}>{children}</thead>
            ),
            th: ({ children, ...props }) => (
              <th className="border border-border/80 px-3 py-1.5 text-start font-semibold bg-muted" {...props}>{children}</th>
            ),
            td: ({ children, ...props }) => (
              <td className="border border-border/60 px-3 py-1.5" {...props}>{children}</td>
            ),
            pre: ({ children, ...props }) => {
              const mermaid = unwrapMermaidPre(children)
              if (mermaid) return <>{mermaid}</>
              return <pre dir="ltr" style={{ textAlign: "left" }} {...props}>{children}</pre>
            },
            code: ({ className, children, ...props }) => {
              const lang = className?.replace("language-", "")
              const codeText = String(children).replace(/\n$/, "")
              if (lang === "mermaid") return <MermaidDiagram code={codeText} />
              return <code dir="ltr" className={className} {...props}>{children}</code>
            },
          }}
        >
          {renderBody}
        </ReactMarkdown>
      </div>
    </div>
  )
}

function BinaryPlaceholder({
  filePath,
  fileName,
  category,
}: {
  filePath: string
  fileName: string
  category: FileCategory
}) {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const iconMap: Record<string, typeof FileText> = {
    document: FileSpreadsheet,
    unknown: FileQuestion,
    image: ImageIcon,
    video: Film,
  }
  const Icon = iconMap[category] ?? FileQuestion

  if (text !== null) {
    return <CodePreview filePath={filePath} content={text} />
  }

  const viewAsText = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      // read_file is size-bounded on the Rust side. The explicit user action is
      // the opt-in for long-tail text formats; decoding failures remain visible
      // here instead of being mistaken for an empty file.
      const { readFile } = await import("@/commands/fs")
      setText(await readFile(filePath))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Icon className="h-16 w-16 text-muted-foreground/30" />
      <div>
        <p className="text-sm font-medium">{fileName}</p>
        <p className="mt-1 text-xs text-muted-foreground">{filePath}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("preview.notAvailable")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => void viewAsText()}
          disabled={loading}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          {loading ? t("preview.loadingText") : t("preview.viewAsText")}
        </button>
        <button
          type="button"
          onClick={() => void openPath(filePath)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("preview.openWithSystem")}
        </button>
      </div>
      {loadError && <p className="max-w-lg text-xs text-destructive">{loadError}</p>}
    </div>
  )
}
