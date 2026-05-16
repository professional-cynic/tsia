//! Tiny helpers shared across the Rust modules.

/// Strip the last extension off a filename. `foo.bar.jpg` → `foo.bar`,
/// `noext` → `noext`. Handles dotfiles in the harmless way (`.gitignore`
/// becomes empty string — never hit by our code paths in practice).
pub fn strip_ext(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((stem, _)) => stem.to_string(),
        None => filename.to_string(),
    }
}
