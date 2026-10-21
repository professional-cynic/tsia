//! Small helpers shared across the Rust modules.

use serde::Serialize;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Strip the last extension off a filename. `foo.bar.jpg` → `foo.bar`,
/// `noext` → `noext`. Handles dotfiles in the harmless way (`.gitignore`
/// becomes empty string — never hit by our code paths in practice).
pub fn strip_ext(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _)) => stem.to_string(),
        None => filename.to_string(),
    }
}

/// Last path segment of a `/`- or `\`-separated relative path.
pub fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// Filesystem-safe slug of an arbitrary string. Keeps ASCII alphanumerics,
/// dashes, and underscores. Spaces become underscores; everything else
/// becomes a dash. Leading/trailing dashes and underscores are trimmed.
/// Mirrored by `slug()` in src/lib/io/merge.ts for the folder-name preview.
pub fn slug(s: &str) -> String {
    let out: String = s.chars().map(|c| {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c }
        else if c.is_whitespace() { '_' }
        else { '-' }
    }).collect();
    let out = out.trim_matches(|c| c == '-' || c == '_');
    if out.is_empty() { "project".to_string() } else { out.to_string() }
}

/// Validate an image path that is meant to stay inside a folder (the
/// `filename` of a project image). Rejects empty paths, absolute paths, drive
/// or UNC prefixes and `..` components, so joining the result onto a folder
/// can never escape it. Image filenames come from project files, which travel
/// with datasets and may come from someone else: **this is the security
/// boundary** for every command that joins them onto a directory.
pub fn safe_relative(p: &str) -> Result<&Path, String> {
    let path = Path::new(p);
    if p.is_empty() {
        return Err("empty image path".to_string());
    }
    for c in path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("unsafe image path: {p}")),
        }
    }
    Ok(path)
}

/// Validate a folder path received from the frontend: absolute and free of
/// `..` components (a relative path would resolve against the app's cwd).
pub fn safe_absolute_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err("path is not absolute".to_string());
    }
    if dir.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("path contains a parent-directory traversal".to_string());
    }
    Ok(())
}

/// Create `parent/name`, or `parent/name-2`, `name-3`… if it already exists.
/// Never reuses an existing folder: export and merge delete their output
/// folder on cancel or failure, which must not touch anything pre-existing.
pub async fn create_unique_dir(parent: &Path, name: &str) -> std::io::Result<PathBuf> {
    for n in 1..=1000 {
        let candidate = if n == 1 { parent.join(name) } else { parent.join(format!("{name}-{n}")) };
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, "no free folder name"))
}

/// Write a file so that it is either fully replaced or left untouched: write
/// a sibling temp file, flush it to disk, then rename it over the target.
/// A crash mid-write can no longer leave a truncated file behind.
pub async fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    let mut f = tokio::fs::File::create(&tmp).await?;
    f.write_all(contents).await?;
    f.sync_all().await?;
    drop(f);
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

pub fn io_err(label: &'static str) -> impl Fn(std::io::Error) -> String {
    move |e| format!("{label}: {e}")
}

// ── Long-running jobs (export, merge) ────────────────────

/// Progress events streamed to the frontend over an IPC channel.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind", content = "data")]
pub enum Progress {
    /// Sent once at the start with the total number of items and the
    /// resolved output folder.
    Start { total: usize, out_path: String },
    /// Sent after each item finishes (or is skipped).
    Item { current: usize, filename: String },
    /// Sent when a single item was skipped due to a non-fatal error.
    Warning { filename: String, message: String },
    /// Sent on successful completion.
    Done { out_path: String },
    /// Sent if cancelled before completion.
    Cancelled,
    /// Sent if a fatal error halts the job.
    Failed { message: String },
}

/// Cancellation flag shared between a running job and its cancel command.
#[derive(Default, Clone)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn reset(&self) { self.0.store(false, Ordering::Relaxed); }
    pub fn cancel(&self) { self.0.store(true, Ordering::Relaxed); }
    pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::Relaxed) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rules() {
        assert_eq!(slug("Pipe A defects"), "Pipe_A_defects");
        assert_eq!(slug("  ünï/cødé  "), "n--c-d");
        assert_eq!(slug("--__--"), "project");
        assert_eq!(slug(""), "project");
    }

    #[test]
    fn basename_and_strip_ext() {
        assert_eq!(basename("a/b/c.jpg"), "c.jpg");
        assert_eq!(basename(r"a\b\c.jpg"), "c.jpg");
        assert_eq!(basename("c.jpg"), "c.jpg");
        assert_eq!(strip_ext("sub/a.b.jpg"), "sub/a.b");
        assert_eq!(strip_ext("noext"), "noext");
    }

    #[test]
    fn safe_relative_accepts_nested_names() {
        assert!(safe_relative("a.jpg").is_ok());
        assert!(safe_relative("sub/dir/a.jpg").is_ok());
        assert!(safe_relative("a..b.jpg").is_ok());
        assert!(safe_relative("./a.jpg").is_ok());
    }

    #[test]
    fn safe_relative_rejects_escapes() {
        assert!(safe_relative("").is_err());
        assert!(safe_relative("../a.jpg").is_err());
        assert!(safe_relative("sub/../../a.jpg").is_err());
        assert!(safe_relative("/etc/passwd").is_err());
        #[cfg(windows)]
        {
            assert!(safe_relative(r"C:\Windows\x.dll").is_err());
            assert!(safe_relative("C:x.jpg").is_err());
            assert!(safe_relative(r"\\server\share\x.jpg").is_err());
            assert!(safe_relative(r"\x.jpg").is_err());
        }
    }

    #[test]
    fn safe_absolute_dir_rules() {
        #[cfg(unix)]
        {
            assert!(safe_absolute_dir(Path::new("/data/images")).is_ok());
            assert!(safe_absolute_dir(Path::new("/data/../etc")).is_err());
        }
        assert!(safe_absolute_dir(Path::new("relative/dir")).is_err());
    }

    #[test]
    fn progress_serialises_camel_case() {
        let v = serde_json::to_value(Progress::Start { total: 3, out_path: "/x".into() }).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "start", "data": { "total": 3, "outPath": "/x" } }));
        let v = serde_json::to_value(Progress::Cancelled).unwrap();
        assert_eq!(v, serde_json::json!({ "kind": "cancelled" }));
    }

    #[tokio::test]
    async fn unique_dir_never_reuses() {
        let base = std::env::temp_dir().join(format!("tsia-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let a = create_unique_dir(&base, "out").await.unwrap();
        let b = create_unique_dir(&base, "out").await.unwrap();
        assert_eq!(a, base.join("out"));
        assert_eq!(b, base.join("out-2"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[tokio::test]
    async fn atomic_write_replaces_and_cleans_up() {
        let base = std::env::temp_dir().join(format!("tsia-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let f = base.join("p.json");
        write_atomic(&f, b"one").await.unwrap();
        write_atomic(&f, b"two").await.unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
