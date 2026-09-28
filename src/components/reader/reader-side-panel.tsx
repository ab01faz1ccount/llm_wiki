import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bookmark, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react"
import {
  addBookmark,
  addNote,
  deleteBookmark,
  deleteNote,
  listBookmarks,
  listNotes,
  updateNote,
  type Bookmark as BookmarkRecord,
  type Highlight,
  type Note,
  type ReaderDocType,
} from "@/lib/reader-db"

interface ReaderSidePanelProps {
  projectPath: string
  sourceIdentity: string
  title: string
  docType: ReaderDocType
  highlights: Highlight[]
  /** Page to stamp a freestanding (not highlight-linked) note with, and how
   * to jump back to a note's page later. Omit for document types without a
   * meaningful page number (e.g. reflowable EPUB) — freestanding notes are
   * still created, just without page-based jump-back. */
  currentPage?: number | null
  onJumpToPage?: (page: number) => void
  /** Opaque location (CFI, JSON page marker, ...) to stamp a freestanding
   * note with, and how to jump to a note's location later — preferred over
   * currentPage/onJumpToPage when available, since it's precise for doc
   * types without page numbers. Notes saved before this field existed have
   * no location, so the panel falls back to currentPage/onJumpToPage for
   * those. */
  currentNoteLocation?: string | null
  onJumpToNoteLocation?: (location: string) => void
  /** The current position to save if the user bookmarks it right now, plus
   * a human label for it. Location is an opaque string from the caller's
   * point of view (JSON for PDF page numbers, a raw CFI for EPUB) — the
   * panel never parses it, only round-trips it through onJumpToBookmark. */
  currentBookmark: { location: string; label: string } | null
  onJumpToBookmark: (location: string) => void
  /** Set when the caller (e.g. a "note this" button on a highlight) wants
   * the composer to open pre-attached to a specific highlight. Consumed
   * (cleared) once the composer picks it up. */
  prefillHighlightId?: string | null
  onConsumePrefill?: () => void
  onClose: () => void
}

type Tab = "notes" | "bookmarks"

export function ReaderSidePanel({
  projectPath,
  sourceIdentity,
  title,
  docType,
  currentPage,
  onJumpToPage,
  currentNoteLocation,
  onJumpToNoteLocation,
  currentBookmark,
  onJumpToBookmark,
  highlights,
  prefillHighlightId,
  onConsumePrefill,
  onClose,
}: ReaderSidePanelProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>("notes")
  const [notes, setNotes] = useState<Note[]>([])
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([])
  const [composingNote, setComposingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState("")
  const [noteHighlightId, setNoteHighlightId] = useState<string | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")

  const doc = { projectPath, sourceIdentity, title, docType }

  useEffect(() => {
    let disposed = false
    void listNotes(projectPath, sourceIdentity).then((items) => {
      if (!disposed) setNotes(items)
    })
    void listBookmarks(projectPath, sourceIdentity).then((items) => {
      if (!disposed) setBookmarks(items)
    })
    return () => {
      disposed = true
    }
  }, [projectPath, sourceIdentity])

  useEffect(() => {
    if (!prefillHighlightId) return
    setTab("notes")
    setComposingNote(true)
    setNoteHighlightId(prefillHighlightId)
    onConsumePrefill?.()
  }, [prefillHighlightId, onConsumePrefill])

  async function saveNote() {
    const body = noteDraft.trim()
    if (!body) return
    const saved = await addNote(doc, {
      highlightId: noteHighlightId,
      page: currentPage ?? null,
      location: currentNoteLocation ?? null,
      bodyMd: body,
    })
    setNotes((prev) => [...prev, saved])
    setComposingNote(false)
    setNoteDraft("")
    setNoteHighlightId(null)
  }

  async function saveNoteEdit(noteId: string) {
    const body = editDraft.trim()
    if (!body) return
    await updateNote(projectPath, noteId, body)
    setNotes((prev) =>
      prev.map((note) => (note.id === noteId ? { ...note, bodyMd: body } : note)),
    )
    setEditingNoteId(null)
  }

  async function removeNote(noteId: string) {
    setNotes((prev) => prev.filter((note) => note.id !== noteId))
    await deleteNote(projectPath, noteId).catch(() => {})
  }

  async function addCurrentPageBookmark() {
    if (!currentBookmark) return
    const saved = await addBookmark(doc, {
      location: currentBookmark.location,
      label: currentBookmark.label,
    })
    setBookmarks((prev) => [...prev, saved])
  }

  async function removeBookmark(bookmarkId: string) {
    setBookmarks((prev) => prev.filter((bookmark) => bookmark.id !== bookmarkId))
    await deleteBookmark(projectPath, bookmarkId).catch(() => {})
  }

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l bg-background">
      <div className="flex items-center gap-1 border-b p-1.5">
        <button
          type="button"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm ${tab === "notes" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
          onClick={() => setTab("notes")}
        >
          <StickyNote className="h-3.5 w-3.5" /> {t("reader.notes")} ({notes.length})
        </button>
        <button
          type="button"
          className={`flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-sm ${tab === "bookmarks" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
          onClick={() => setTab("bookmarks")}
        >
          <Bookmark className="h-3.5 w-3.5" /> {t("reader.bookmarks")} ({bookmarks.length})
        </button>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={onClose} aria-label={t("preview.cancel")}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {tab === "notes" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-2">
            {notes.length === 0 && !composingNote && (
              <p className="p-2 text-xs text-muted-foreground">{t("reader.notesEmpty")}</p>
            )}
            <ul className="space-y-2">
              {notes.map((note) => {
                const linkedHighlight = note.highlightId
                  ? highlights.find((item) => item.id === note.highlightId)
                  : undefined
                return (
                  <li key={note.id} className="group rounded-md border p-2 text-sm">
                    <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                      <button
                        type="button"
                        className="hover:underline disabled:no-underline disabled:hover:no-underline"
                        disabled={note.location ? !onJumpToNoteLocation : !note.page || !onJumpToPage}
                        onClick={() => {
                          if (note.location && onJumpToNoteLocation) onJumpToNoteLocation(note.location)
                          else if (note.page) onJumpToPage?.(note.page)
                        }}
                      >
                        {note.page ? `${t("preview.pdfPage")} ${note.page}` : note.location ? t("reader.jumpToNote") : t("reader.unpositionedNote")}
                      </button>
                      <div className="hidden items-center gap-1 group-hover:flex">
                        <button
                          type="button"
                          className="rounded p-0.5 hover:bg-muted"
                          onClick={() => {
                            setEditingNoteId(note.id)
                            setEditDraft(note.bodyMd)
                          }}
                          aria-label={t("reader.editNote")}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-0.5 hover:bg-muted hover:text-destructive"
                          onClick={() => void removeNote(note.id)}
                          aria-label={t("reader.deleteNote")}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    {linkedHighlight && (
                      <blockquote className="mb-1 border-l-2 pl-2 text-xs italic text-muted-foreground line-clamp-2">
                        {linkedHighlight.text}
                      </blockquote>
                    )}
                    {editingNoteId === note.id ? (
                      <div className="space-y-1">
                        <textarea
                          className="w-full resize-none rounded border bg-background p-1.5 text-sm"
                          rows={3}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                          autoFocus
                        />
                        <div className="flex justify-end gap-1">
                          <button type="button" className="rounded px-2 py-0.5 text-xs hover:bg-muted" onClick={() => setEditingNoteId(null)}>{t("preview.cancel")}</button>
                          <button type="button" className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground" onClick={() => void saveNoteEdit(note.id)}>{t("reader.save")}</button>
                        </div>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap break-words">{note.bodyMd}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="border-t p-2">
            {composingNote ? (
              <div className="space-y-1.5">
                {noteHighlightId && (
                  <blockquote className="border-l-2 pl-2 text-xs italic text-muted-foreground line-clamp-2">
                    {highlights.find((item) => item.id === noteHighlightId)?.text}
                  </blockquote>
                )}
                <textarea
                  className="w-full resize-none rounded border bg-background p-1.5 text-sm"
                  rows={3}
                  placeholder={t("reader.noteDraftPlaceholder")}
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  autoFocus
                />
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs hover:bg-muted"
                    onClick={() => {
                      setComposingNote(false)
                      setNoteDraft("")
                      setNoteHighlightId(null)
                    }}
                  >
                    {t("preview.cancel")}
                  </button>
                  <button type="button" className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground" onClick={() => void saveNote()}>{t("reader.save")}</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed py-1.5 text-sm text-muted-foreground hover:bg-muted"
                onClick={() => setComposingNote(true)}
              >
                <Plus className="h-3.5 w-3.5" /> {t("reader.addNote")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-2">
            {bookmarks.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">{t("reader.bookmarksEmpty")}</p>
            )}
            <ul className="space-y-1">
              {bookmarks.map((bookmark) => (
                <li key={bookmark.id} className="group flex items-center justify-between rounded-md border p-2 text-sm">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    onClick={() => bookmark.location && onJumpToBookmark(bookmark.location)}
                  >
                    {bookmark.label || bookmark.location || "–"}
                  </button>
                  <button
                    type="button"
                    className="hidden rounded p-0.5 hover:bg-muted hover:text-destructive group-hover:block"
                    onClick={() => void removeBookmark(bookmark.id)}
                    aria-label={t("reader.deleteBookmark")}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t p-2">
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!currentBookmark}
              onClick={() => void addCurrentPageBookmark()}
            >
              <Plus className="h-3.5 w-3.5" /> {t("reader.bookmarkThisPage")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
