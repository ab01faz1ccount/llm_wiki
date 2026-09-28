import { invoke } from "@tauri-apps/api/core"

/**
 * Reader store: per-document reading progress, highlights, notes and
 * bookmarks, persisted in `.llm-wiki/reader.db` (SQLite) inside the
 * project. Documents are identified by `sourceIdentity` — use
 * `sourceIdentityForPath` from `@/lib/source-identity` to derive it
 * from a project-relative source path, the same identity already used
 * for citations elsewhere in the app.
 */

export type ReaderDocType = "pdf" | "epub" | "markdown"

export interface ReadingState {
  page: number | null
  location: string | null
  percent: number | null
  status: string
  lastReadAt: string
}

export interface Highlight {
  id: string
  page: number | null
  rectsJson: string
  text: string
  prefix: string
  suffix: string
  color: string
  createdAt: string
}

export interface Note {
  id: string
  highlightId: string | null
  page: number | null
  location: string | null
  bodyMd: string
  createdAt: string
  updatedAt: string
}

export interface Bookmark {
  id: string
  location: string | null
  label: string | null
  createdAt: string
}

/** Fields identifying which document a reader-store row belongs to. */
interface DocumentRef {
  projectPath: string
  sourceIdentity: string
  title?: string | null
  docType: ReaderDocType
}

export async function getReadingState(
  projectPath: string,
  sourceIdentity: string,
): Promise<ReadingState | null> {
  return await invoke("reader_get_reading_state", { projectPath, sourceIdentity })
}

export async function setReadingState(
  doc: DocumentRef,
  update: { page?: number | null; location?: string | null; percent?: number | null; status: string },
): Promise<void> {
  await invoke("reader_set_reading_state", {
    projectPath: doc.projectPath,
    sourceIdentity: doc.sourceIdentity,
    title: doc.title ?? null,
    docType: doc.docType,
    page: update.page ?? null,
    location: update.location ?? null,
    percent: update.percent ?? null,
    status: update.status,
  })
}

export async function listHighlights(projectPath: string, sourceIdentity: string): Promise<Highlight[]> {
  return await invoke("reader_list_highlights", { projectPath, sourceIdentity })
}

export async function addHighlight(
  doc: DocumentRef,
  highlight: { page?: number | null; rects: unknown; text: string; prefix?: string; suffix?: string; color?: string },
): Promise<Highlight> {
  return await invoke("reader_add_highlight", {
    projectPath: doc.projectPath,
    sourceIdentity: doc.sourceIdentity,
    title: doc.title ?? null,
    docType: doc.docType,
    page: highlight.page ?? null,
    rectsJson: JSON.stringify(highlight.rects),
    text: highlight.text,
    prefix: highlight.prefix ?? "",
    suffix: highlight.suffix ?? "",
    color: highlight.color ?? "yellow",
  })
}

export async function updateHighlightColor(
  projectPath: string,
  highlightId: string,
  color: string,
): Promise<void> {
  await invoke("reader_update_highlight_color", { projectPath, highlightId, color })
}

export async function deleteHighlight(projectPath: string, highlightId: string): Promise<void> {
  await invoke("reader_delete_highlight", { projectPath, highlightId })
}

export async function listNotes(projectPath: string, sourceIdentity: string): Promise<Note[]> {
  return await invoke("reader_list_notes", { projectPath, sourceIdentity })
}

export async function addNote(
  doc: DocumentRef,
  note: { highlightId?: string | null; page?: number | null; location?: string | null; bodyMd: string },
): Promise<Note> {
  return await invoke("reader_add_note", {
    projectPath: doc.projectPath,
    sourceIdentity: doc.sourceIdentity,
    title: doc.title ?? null,
    docType: doc.docType,
    highlightId: note.highlightId ?? null,
    page: note.page ?? null,
    location: note.location ?? null,
    bodyMd: note.bodyMd,
  })
}

export async function updateNote(projectPath: string, noteId: string, bodyMd: string): Promise<void> {
  await invoke("reader_update_note", { projectPath, noteId, bodyMd })
}

export async function deleteNote(projectPath: string, noteId: string): Promise<void> {
  await invoke("reader_delete_note", { projectPath, noteId })
}

export async function listBookmarks(projectPath: string, sourceIdentity: string): Promise<Bookmark[]> {
  return await invoke("reader_list_bookmarks", { projectPath, sourceIdentity })
}

export async function addBookmark(
  doc: DocumentRef,
  bookmark: { location?: string | null; label?: string | null },
): Promise<Bookmark> {
  return await invoke("reader_add_bookmark", {
    projectPath: doc.projectPath,
    sourceIdentity: doc.sourceIdentity,
    title: doc.title ?? null,
    docType: doc.docType,
    location: bookmark.location ?? null,
    label: bookmark.label ?? null,
  })
}

export async function deleteBookmark(projectPath: string, bookmarkId: string): Promise<void> {
  await invoke("reader_delete_bookmark", { projectPath, bookmarkId })
}
