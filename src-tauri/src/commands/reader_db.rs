//! Reader store: highlights, notes, bookmarks and reading progress.
//!
//! One SQLite file per project at `.llm-wiki/reader.db`, separate from
//! the LanceDB vector store (embeddings) and the project's markdown
//! files (wiki content). This is small, relational, per-user data that
//! doesn't belong in either of those.
//!
//! Documents are identified by `source_identity` (the project-relative
//! path under `raw/sources/`, same identity already used elsewhere for
//! citations — see `src/lib/source-identity.ts`) rather than by an
//! opaque id the frontend would have to track. Every command therefore
//! takes `project_path` + `source_identity` and looks up (or lazily
//! creates) the `documents` row itself.
//!
//! Connections are opened per call. rusqlite's `bundled` feature makes
//! this cheap enough (no separate connection pool) and avoids holding
//! a long-lived lock across the async Tauri command boundary; SQLite's
//! own file locking handles concurrent access from multiple windows.

use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::panic_guard::run_guarded;

fn db_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".llm-wiki").join("reader.db")
}

fn open_conn(project_path: &str) -> Result<Connection, String> {
    let path = db_path(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .llm-wiki directory: {e}"))?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| format!("Failed to open reader.db at {}: {e}", path.display()))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS documents (            id TEXT PRIMARY KEY,
            source_identity TEXT NOT NULL UNIQUE,
            title TEXT,
            doc_type TEXT NOT NULL,
            content_hash TEXT,
            added_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reading_state (
            doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            page INTEGER,
            location TEXT,
            percent REAL,
            status TEXT NOT NULL DEFAULT 'unread',
            last_read_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS highlights (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            page INTEGER,
            rects_json TEXT NOT NULL,
            text TEXT NOT NULL,
            prefix TEXT NOT NULL DEFAULT '',
            suffix TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT 'yellow',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_highlights_doc ON highlights(doc_id);

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            highlight_id TEXT REFERENCES highlights(id) ON DELETE SET NULL,
            page INTEGER,
            body_md TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_doc ON notes(doc_id);

        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            location TEXT,
            label TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_doc ON bookmarks(doc_id);
        "#,
    )
    .map_err(|e| format!("reader.db migration failed: {e}"))?;

    // Additive migration: `notes` originally shipped without a `location`
    // column (freestanding notes could only carry a `page` number, which
    // doesn't work for reflowable EPUB or Markdown). SQLite has no
    // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so run it unconditionally
    // and swallow the "duplicate column name" error on every connection
    // after the first — any other error still propagates.
    match conn.execute("ALTER TABLE notes ADD COLUMN location TEXT", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(ref msg))) if msg.contains("duplicate column name") => {}
        Err(e) => return Err(format!("reader.db migration failed (notes.location): {e}")),
    }

    Ok(())
}

/// Look up the document row for `source_identity`, creating it on first
/// reference. `title`/`doc_type` only take effect on creation — later
/// calls with a different title do not rename an existing document,
/// since the frontend passes its current in-memory title on every open
/// and we don't want that clobbering a title the user edited elsewhere.
fn get_or_create_document(
    conn: &Connection,
    source_identity: &str,
    title: Option<&str>,
    doc_type: &str,
) -> Result<String, String> {
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM documents WHERE source_identity = ?1",
            [source_identity],
            |row| row.get::<_, String>(0),
        )
        .ok()
    {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO documents (id, source_identity, title, doc_type, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, source_identity, title, doc_type, Utc::now().to_rfc3339()],
    )
    .map_err(|e| format!("Failed to register document: {e}"))?;
    Ok(id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStateDto {
    pub page: Option<i64>,
    pub location: Option<String>,
    pub percent: Option<f64>,
    pub status: String,
    pub last_read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightDto {
    pub id: String,
    pub page: Option<i64>,
    pub rects_json: String,
    pub text: String,
    pub prefix: String,
    pub suffix: String,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub id: String,
    pub highlight_id: Option<String>,
    pub page: Option<i64>,
    pub location: Option<String>,
    pub body_md: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDto {
    pub id: String,
    pub location: Option<String>,
    pub label: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------

#[tauri::command]
pub fn reader_get_reading_state(
    project_path: String,
    source_identity: String,
) -> Result<Option<ReadingStateDto>, String> {
    run_guarded("reader_get_reading_state", || {
        let conn = open_conn(&project_path)?;
        // Reading state is only meaningful for a document that has
        // already been opened at least once; don't create a row here.
        let doc_id: Option<String> = conn
            .query_row(
                "SELECT id FROM documents WHERE source_identity = ?1",
                [&source_identity],
                |row| row.get(0),
            )
            .ok();
        let Some(doc_id) = doc_id else { return Ok(None) };
        conn.query_row(
            "SELECT page, location, percent, status, last_read_at FROM reading_state WHERE doc_id = ?1",
            [&doc_id],
            |row| {
                Ok(ReadingStateDto {
                    page: row.get(0)?,
                    location: row.get(1)?,
                    percent: row.get(2)?,
                    status: row.get(3)?,
                    last_read_at: row.get(4)?,
                })
            },
        )
        .ok()
        .map_or(Ok(None), |s| Ok(Some(s)))
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reader_set_reading_state(
    project_path: String,
    source_identity: String,
    title: Option<String>,
    doc_type: String,
    page: Option<i64>,
    location: Option<String>,
    percent: Option<f64>,
    status: String,
) -> Result<(), String> {
    run_guarded("reader_set_reading_state", || {
        let conn = open_conn(&project_path)?;
        let doc_id = get_or_create_document(&conn, &source_identity, title.as_deref(), &doc_type)?;
        conn.execute(
            "INSERT INTO reading_state (doc_id, page, location, percent, status, last_read_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(doc_id) DO UPDATE SET
                page = excluded.page,
                location = excluded.location,
                percent = excluded.percent,
                status = excluded.status,
                last_read_at = excluded.last_read_at",
            rusqlite::params![doc_id, page, location, percent, status, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Failed to save reading state: {e}"))?;
        Ok(())
    })
}

// ---------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------

#[tauri::command]
pub fn reader_list_highlights(
    project_path: String,
    source_identity: String,
) -> Result<Vec<HighlightDto>, String> {
    run_guarded("reader_list_highlights", || {
        let conn = open_conn(&project_path)?;
        let doc_id: Option<String> = conn
            .query_row(
                "SELECT id FROM documents WHERE source_identity = ?1",
                [&source_identity],
                |row| row.get(0),
            )
            .ok();
        let Some(doc_id) = doc_id else { return Ok(Vec::new()) };
        let mut stmt = conn
            .prepare(
                "SELECT id, page, rects_json, text, prefix, suffix, color, created_at
                 FROM highlights WHERE doc_id = ?1 ORDER BY page, created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&doc_id], |row| {
                Ok(HighlightDto {
                    id: row.get(0)?,
                    page: row.get(1)?,
                    rects_json: row.get(2)?,
                    text: row.get(3)?,
                    prefix: row.get(4)?,
                    suffix: row.get(5)?,
                    color: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reader_add_highlight(
    project_path: String,
    source_identity: String,
    title: Option<String>,
    doc_type: String,
    page: Option<i64>,
    rects_json: String,
    text: String,
    prefix: String,
    suffix: String,
    color: String,
) -> Result<HighlightDto, String> {
    run_guarded("reader_add_highlight", || {
        let conn = open_conn(&project_path)?;
        let doc_id = get_or_create_document(&conn, &source_identity, title.as_deref(), &doc_type)?;
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO highlights (id, doc_id, page, rects_json, text, prefix, suffix, color, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![id, doc_id, page, rects_json, text, prefix, suffix, color, created_at],
        )
        .map_err(|e| format!("Failed to save highlight: {e}"))?;
        Ok(HighlightDto { id, page, rects_json, text, prefix, suffix, color, created_at })
    })
}

#[tauri::command]
pub fn reader_update_highlight_color(
    project_path: String,
    highlight_id: String,
    color: String,
) -> Result<(), String> {
    run_guarded("reader_update_highlight_color", || {
        let conn = open_conn(&project_path)?;
        conn.execute(
            "UPDATE highlights SET color = ?1 WHERE id = ?2",
            rusqlite::params![color, highlight_id],
        )
        .map_err(|e| format!("Failed to update highlight: {e}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn reader_delete_highlight(project_path: String, highlight_id: String) -> Result<(), String> {
    run_guarded("reader_delete_highlight", || {
        let conn = open_conn(&project_path)?;
        conn.execute("DELETE FROM highlights WHERE id = ?1", [&highlight_id])
            .map_err(|e| format!("Failed to delete highlight: {e}"))?;
        Ok(())
    })
}

// ---------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------

#[tauri::command]
pub fn reader_list_notes(
    project_path: String,
    source_identity: String,
) -> Result<Vec<NoteDto>, String> {
    run_guarded("reader_list_notes", || {
        let conn = open_conn(&project_path)?;
        let doc_id: Option<String> = conn
            .query_row(
                "SELECT id FROM documents WHERE source_identity = ?1",
                [&source_identity],
                |row| row.get(0),
            )
            .ok();
        let Some(doc_id) = doc_id else { return Ok(Vec::new()) };
        let mut stmt = conn
            .prepare(
                "SELECT id, highlight_id, page, location, body_md, created_at, updated_at
                 FROM notes WHERE doc_id = ?1 ORDER BY page, created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&doc_id], |row| {
                Ok(NoteDto {
                    id: row.get(0)?,
                    highlight_id: row.get(1)?,
                    page: row.get(2)?,
                    location: row.get(3)?,
                    body_md: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn reader_add_note(
    project_path: String,
    source_identity: String,
    title: Option<String>,
    doc_type: String,
    highlight_id: Option<String>,
    page: Option<i64>,
    location: Option<String>,
    body_md: String,
) -> Result<NoteDto, String> {
    run_guarded("reader_add_note", || {
        let conn = open_conn(&project_path)?;
        let doc_id = get_or_create_document(&conn, &source_identity, title.as_deref(), &doc_type)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO notes (id, doc_id, highlight_id, page, location, body_md, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            rusqlite::params![id, doc_id, highlight_id, page, location, body_md, now],
        )
        .map_err(|e| format!("Failed to save note: {e}"))?;
        Ok(NoteDto { id, highlight_id, page, location, body_md, created_at: now.clone(), updated_at: now })
    })
}

#[tauri::command]
pub fn reader_update_note(
    project_path: String,
    note_id: String,
    body_md: String,
) -> Result<(), String> {
    run_guarded("reader_update_note", || {
        let conn = open_conn(&project_path)?;
        conn.execute(
            "UPDATE notes SET body_md = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![body_md, Utc::now().to_rfc3339(), note_id],
        )
        .map_err(|e| format!("Failed to update note: {e}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn reader_delete_note(project_path: String, note_id: String) -> Result<(), String> {
    run_guarded("reader_delete_note", || {
        let conn = open_conn(&project_path)?;
        conn.execute("DELETE FROM notes WHERE id = ?1", [&note_id])
            .map_err(|e| format!("Failed to delete note: {e}"))?;
        Ok(())
    })
}

// ---------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------

#[tauri::command]
pub fn reader_list_bookmarks(
    project_path: String,
    source_identity: String,
) -> Result<Vec<BookmarkDto>, String> {
    run_guarded("reader_list_bookmarks", || {
        let conn = open_conn(&project_path)?;
        let doc_id: Option<String> = conn
            .query_row(
                "SELECT id FROM documents WHERE source_identity = ?1",
                [&source_identity],
                |row| row.get(0),
            )
            .ok();
        let Some(doc_id) = doc_id else { return Ok(Vec::new()) };
        let mut stmt = conn
            .prepare(
                "SELECT id, location, label, created_at FROM bookmarks
                 WHERE doc_id = ?1 ORDER BY created_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&doc_id], |row| {
                Ok(BookmarkDto {
                    id: row.get(0)?,
                    location: row.get(1)?,
                    label: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn reader_add_bookmark(
    project_path: String,
    source_identity: String,
    title: Option<String>,
    doc_type: String,
    location: Option<String>,
    label: Option<String>,
) -> Result<BookmarkDto, String> {
    run_guarded("reader_add_bookmark", || {
        let conn = open_conn(&project_path)?;
        let doc_id = get_or_create_document(&conn, &source_identity, title.as_deref(), &doc_type)?;
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO bookmarks (id, doc_id, location, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, doc_id, location, label, created_at],
        )
        .map_err(|e| format!("Failed to save bookmark: {e}"))?;
        Ok(BookmarkDto { id, location, label, created_at })
    })
}

#[tauri::command]
pub fn reader_delete_bookmark(project_path: String, bookmark_id: String) -> Result<(), String> {
    run_guarded("reader_delete_bookmark", || {
        let conn = open_conn(&project_path)?;
        conn.execute("DELETE FROM bookmarks WHERE id = ?1", [&bookmark_id])
            .map_err(|e| format!("Failed to delete bookmark: {e}"))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_project() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn highlight_roundtrip_and_reading_state() {
        let dir = tmp_project();
        let project_path = dir.path().to_string_lossy().to_string();

        reader_set_reading_state(
            project_path.clone(),
            "book.pdf".into(),
            Some("Book".into()),
            "pdf".into(),
            Some(3),
            None,
            Some(12.5),
            "reading".into(),
        )
        .expect("set reading state");

        let state = reader_get_reading_state(project_path.clone(), "book.pdf".into())
            .expect("get reading state")
            .expect("state exists");
        assert_eq!(state.page, Some(3));
        assert_eq!(state.status, "reading");

        let h = reader_add_highlight(
            project_path.clone(),
            "book.pdf".into(),
            Some("Book".into()),
            "pdf".into(),
            Some(3),
            "[[10,20,100,40]]".into(),
            "some text".into(),
            "before ".into(),
            " after".into(),
            "yellow".into(),
        )
        .expect("add highlight");

        let highlights = reader_list_highlights(project_path.clone(), "book.pdf".into())
            .expect("list highlights");
        assert_eq!(highlights.len(), 1);
        assert_eq!(highlights[0].id, h.id);

        reader_update_highlight_color(project_path.clone(), h.id.clone(), "green".into())
            .expect("update color");
        let highlights = reader_list_highlights(project_path.clone(), "book.pdf".into()).unwrap();
        assert_eq!(highlights[0].color, "green");

        let note = reader_add_note(
            project_path.clone(),
            "book.pdf".into(),
            Some("Book".into()),
            "pdf".into(),
            Some(h.id.clone()),
            Some(3),
            None,
            "why this matters".into(),
        )
        .expect("add note");
        assert_eq!(note.location, None);

        let cfi_note = reader_add_note(
            project_path.clone(),
            "book.pdf".into(),
            Some("Book".into()),
            "pdf".into(),
            None,
            None,
            Some("epubcfi(/6/4!/4/2)".into()),
            "a freestanding note with a location".into(),
        )
        .expect("add note with location");
        assert_eq!(cfi_note.location.as_deref(), Some("epubcfi(/6/4!/4/2)"));
        // migrate() runs its additive "notes.location" ALTER TABLE again on
        // every open_conn() call above — this line only passes if the
        // "duplicate column name" swallow logic actually works.
        assert_eq!(
            reader_list_notes(project_path.clone(), "book.pdf".into()).unwrap().len(),
            2
        );

        reader_delete_highlight(project_path.clone(), h.id).expect("delete highlight");
        assert!(reader_list_highlights(project_path.clone(), "book.pdf".into())
            .unwrap()
            .is_empty());
        // Deleting the highlight should not cascade-delete its notes (ON DELETE SET NULL).
        assert_eq!(
            reader_list_notes(project_path.clone(), "book.pdf".into()).unwrap().len(),
            2
        );

        reader_delete_note(project_path.clone(), note.id).expect("delete note");
        assert_eq!(
            reader_list_notes(project_path.clone(), "book.pdf".into()).unwrap().len(),
            1
        );
        reader_delete_note(project_path.clone(), cfi_note.id).expect("delete note with location");
        assert!(reader_list_notes(project_path.clone(), "book.pdf".into())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn bookmarks_roundtrip() {
        let dir = tmp_project();
        let project_path = dir.path().to_string_lossy().to_string();

        let b = reader_add_bookmark(
            project_path.clone(),
            "notes.epub".into(),
            None,
            "epub".into(),
            Some("epubcfi(/6/4!/4/2)".into()),
            Some("Chapter 1".into()),
        )
        .expect("add bookmark");

        let list = reader_list_bookmarks(project_path.clone(), "notes.epub".into()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label.as_deref(), Some("Chapter 1"));

        reader_delete_bookmark(project_path.clone(), b.id).expect("delete bookmark");
        assert!(reader_list_bookmarks(project_path, "notes.epub".into())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn unopened_document_has_no_reading_state() {
        let dir = tmp_project();
        let project_path = dir.path().to_string_lossy().to_string();
        let state = reader_get_reading_state(project_path, "never-opened.pdf".into()).unwrap();
        assert!(state.is_none());
    }
}
