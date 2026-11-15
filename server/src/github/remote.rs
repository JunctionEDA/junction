//! The GitHub side of a linked project, read as one set of files.
//!
//! A project is a folder of a repository, but its files are not always all in that
//! folder of that repository:
//!
//!   * a folder inside it that has a project file of its own is another project, and
//!     its files belong to that one;
//!   * a library table, a sheet or a 3D model may name a file outside the folder
//!     (`${KIPRJMOD}/../lib/parts.kicad_sym`, a library two projects share).  Those
//!     files come along, under the same `../lib/…` path the project uses for them;
//!   * any folder on the way may be a git submodule: another repository, pinned at a
//!     commit.  It is read through, and each file remembers which repository it is in.
//!
//! Nothing here writes to GitHub.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;

use serde_json::{json, Value};
use sqlx::Row;

use super::{Gh, GhErr, RepoRef};
use crate::error::AppResult;
use crate::http::{allowed_file, is_local_state_path, MAX_FILES, MAX_FILE_BYTES};

/// Submodules inside submodules are read this deep.
const MAX_DEPTH: usize = 3;

/// One repository at one commit: the linked repository itself (index 0), or a submodule.
#[derive(Debug, Clone)]
pub(super) struct Source {
    pub repo: RepoRef,
    pub commit: String,
    pub tree: String,
    /// Where it sits, as a path from the root of the linked repository ("" for that repository).
    pub mount: String,
    /// The source that holds its gitlink, and the gitlink's path there.
    pub parent: Option<(usize, String)>,
    /// The branch `.gitmodules` says it follows.
    pub branch: Option<String>,
    pub depth: usize,
}

#[derive(Debug, Clone)]
pub(super) struct RemoteFile {
    pub sha: String,
    pub size: u64,
    /// Index into `Remote::sources`.
    pub src: usize,
    /// Path inside that source's repository.
    pub path: String,
}

#[derive(Default)]
pub(super) struct Remote {
    pub head: Option<String>,
    pub tree: Option<String>,
    /// Project path -> file.  A path outside the project folder starts with `../`.
    pub files: BTreeMap<String, RemoteFile>,
    pub truncated: bool,
    pub sources: Vec<Source>,
    /// Things the person should know: a submodule that cannot be read, a library that is not there.
    pub notes: Vec<Value>,
    /// Folders inside the project folder that are projects of their own.
    pub nested: Vec<String>,
    /// Whether the linked folder is there at all.
    pub folder_exists: bool,
}

impl Remote {
    pub fn sha(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(|f| f.sha.as_str())
    }

    /// The repository a file is in.
    pub fn repo_of(&self, f: &RemoteFile) -> &RepoRef {
        &self.sources[f.src].repo
    }

    pub async fn blob(&self, gh: &Gh, path: &str) -> Result<Option<Vec<u8>>, GhErr> {
        match self.files.get(path) {
            Some(f) => Ok(Some(gh.blob(self.repo_of(f), &f.sha).await?)),
            None => Ok(None),
        }
    }

    /// Where a project path lives (or would be written): the source and the path inside it.
    /// None for a path that climbs out of the repository.
    pub fn place(&self, subdir: &str, doc_path: &str) -> Option<(usize, String)> {
        if let Some(f) = self.files.get(doc_path) {
            return Some((f.src, f.path.clone()));
        }
        let full = repo_path(subdir, doc_path)?;
        // The deepest submodule the path is inside.
        let mut best = (0usize, full.clone());
        let mut best_len = 0;
        for (i, s) in self.sources.iter().enumerate().skip(1) {
            if let Some(rest) = full.strip_prefix(&format!("{}/", s.mount)) {
                if s.mount.len() >= best_len {
                    best = (i, rest.to_string());
                    best_len = s.mount.len();
                }
            }
        }
        Some(best)
    }
}

// ------------------------------------------------------------------ paths

/// `base` joined with `rel`, `.` and `..` resolved.  Climbing above `base`'s root keeps
/// leading `..` segments ("a" + "../../x" -> "../x").
pub(super) fn norm_join(base: &str, rel: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in base.split('/').chain(rel.split(['/', '\\'])) {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    out.join("/")
}

/// The repository path of a project file; None when it climbs out of the repository.
pub(super) fn repo_path(subdir: &str, doc_path: &str) -> Option<String> {
    let p = norm_join(subdir, doc_path);
    (!p.is_empty() && !p.starts_with("..")).then_some(p)
}

/// A project path as sync uses it: an ordinary project-relative path, or one that
/// starts with `../` segments for a shared file outside the project folder.
pub(super) fn sync_path(s: &str) -> Option<String> {
    let s = s.trim().replace('\\', "/");
    let mut ups = 0;
    let mut rest = s.as_str();
    while let Some(r) = rest.strip_prefix("../") {
        ups += 1;
        rest = r;
    }
    let rest = crate::http::safe_zip_name(rest)?;
    Some(format!("{}{rest}", "../".repeat(ups)))
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_lib_table(path: &str) -> bool {
    matches!(base_name(path), "sym-lib-table" | "fp-lib-table" | "design-block-lib-table")
}

fn ext(path: &str) -> String {
    base_name(path).rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

/// Whether a file can name other files worth following.
fn names_files(path: &str) -> bool {
    is_lib_table(path) || matches!(ext(path).as_str(), "kicad_sch" | "kicad_pcb" | "kicad_mod")
}

// ------------------------------------------------------------------ what a file names

/// Every `"…"` string that directly follows `(<head> ` in an s-expression text.
fn quoted_after<'a>(text: &'a str, head: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = text[from..].find(head) {
        let start = from + i + head.len();
        from = start;
        let rest = text[start..].trim_start();
        if let Some(body) = rest.strip_prefix('"') {
            if let Some(end) = body.find('"') {
                out.push(&body[..end]);
            }
        } else {
            // an unquoted atom: up to whitespace or the closing parenthesis
            // (a `$(VAR)` inside it has parentheses of its own)
            let mut depth = 0;
            let end = rest
                .find(|c: char| match c {
                    '(' => { depth += 1; false }
                    ')' if depth > 0 => { depth -= 1; false }
                    c => c == ')' || c.is_whitespace(),
                })
                .unwrap_or(rest.len());
            if end > 0 {
                out.push(&rest[..end]);
            }
        }
    }
    out
}

fn strip_kiprjmod(s: &str) -> Option<&str> {
    s.strip_prefix("${KIPRJMOD}/")
        .or_else(|| s.strip_prefix("$(KIPRJMOD)/"))
        .or_else(|| s.strip_prefix("${KIPRJMOD}\\"))
}

/// The files `text` (the content of `path`) names: project-relative for a library
/// table row and a 3D model (`${KIPRJMOD}/…`), relative to the sheet's own folder for
/// a sub-sheet.  Anything under another path variable or absolute is not the project's.
pub(super) fn refs_of(path: &str, text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if is_lib_table(path) {
        out.extend(quoted_after(text, "(uri").into_iter().filter_map(strip_kiprjmod).map(str::to_string));
    } else {
        match ext(path).as_str() {
            "kicad_sch" => {
                for s in quoted_after(text, "(property \"Sheetfile\"") {
                    // A sheet file is named relative to the sheet that holds it; only a
                    // relative name that leaves the folder needs following.
                    if !s.starts_with('/') && !s.contains(':') && !s.starts_with('$') {
                        out.push(s.to_string());
                    } else if let Some(r) = strip_kiprjmod(s) {
                        out.push(format!("//{r}")); // marked project-relative
                    }
                }
            }
            "kicad_pcb" | "kicad_mod" => {
                out.extend(quoted_after(text, "(model").into_iter().filter_map(strip_kiprjmod).map(str::to_string));
            }
            _ => {}
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Turn what `refs_of` returned for the file at project path `path` into project paths.
pub(super) fn resolve_refs(path: &str, refs: &[String]) -> Vec<String> {
    let sheet = ext(path) == "kicad_sch";
    refs.iter()
        .map(|r| match r.strip_prefix("//") {
            Some(abs) => norm_join("", abs),
            None if sheet => norm_join(dir_of(path), r),
            None => norm_join("", r),
        })
        .filter(|p| !p.is_empty())
        .collect()
}

// ------------------------------------------------------------------ .gitmodules

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Module {
    pub url: String,
    pub branch: Option<String>,
}

/// `.gitmodules`: submodule path -> where it comes from.
pub(super) fn parse_gitmodules(text: &str) -> HashMap<String, Module> {
    let mut out = HashMap::new();
    let (mut path, mut url, mut branch) = (None::<String>, None::<String>, None::<String>);
    let mut flush = |path: &mut Option<String>, url: &mut Option<String>, branch: &mut Option<String>| {
        if let (Some(p), Some(u)) = (path.take(), url.take()) {
            out.insert(p.trim_matches('/').to_string(), Module { url: u, branch: branch.take().filter(|b| b != ".") });
        }
        *branch = None;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            flush(&mut path, &mut url, &mut branch);
            continue;
        }
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('"').to_string();
        match k.trim().to_ascii_lowercase().as_str() {
            "path" => path = Some(v),
            "url" => url = Some(v),
            "branch" => branch = Some(v),
            _ => {}
        }
    }
    flush(&mut path, &mut url, &mut branch);
    out
}

/// The GitHub repository a submodule URL names; None for another host.  A relative
/// URL (`../lib.git`) is relative to the repository that holds the submodule.
pub(super) fn submodule_repo(url: &str, parent: &RepoRef, web_host: &str) -> Option<RepoRef> {
    let url = url.trim();
    let path: String = if url.starts_with("./") || url.starts_with("../") {
        let joined = norm_join(&format!("{}/{}", parent.owner, parent.name), url);
        if joined.starts_with("..") {
            return None;
        }
        joined
    } else if let Some(rest) = url.strip_prefix("git@") {
        // git@github.com:owner/name.git
        let (host, path) = rest.split_once(':')?;
        if !is_github(host, web_host) {
            return None;
        }
        path.to_string()
    } else {
        let rest = url.split_once("://").map(|(_, r)| r)?;
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        if !is_github(host, web_host) {
            return None;
        }
        path.to_string()
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    RepoRef::parse(&format!("{owner}/{name}")).ok()
}

fn is_github(host: &str, web_host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "github.com" || h == "www.github.com" || h == web_host.to_ascii_lowercase()
}

// ------------------------------------------------------------------ walking repositories

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Blob,
    Tree,
    /// A gitlink: a submodule pinned at a commit.
    Commit,
}

#[derive(Debug, Clone)]
struct TreeEntry {
    path: String,
    kind: Kind,
    sha: String,
    size: u64,
}

pub(super) enum Loc {
    Missing,
    File(RemoteFile),
    Dir { src: usize, tree: String, path: String },
}

pub(super) struct Walker<'a> {
    gh: &'a Gh,
    pub sources: Vec<Source>,
    pub notes: Vec<Value>,
    pub truncated: bool,
    listings: HashMap<(String, String, bool), (Vec<TreeEntry>, bool)>,
    modules: HashMap<usize, HashMap<String, Module>>,
    mounts: HashMap<(usize, String), Option<usize>>,
}

type Fut<'f, T> = Pin<Box<dyn Future<Output = Result<T, GhErr>> + Send + 'f>>;

impl<'a> Walker<'a> {
    pub fn new(gh: &'a Gh, repo: &RepoRef, commit: &str, tree: &str) -> Self {
        Walker {
            gh,
            sources: vec![Source {
                repo: repo.clone(),
                commit: commit.to_string(),
                tree: tree.to_string(),
                mount: String::new(),
                parent: None,
                branch: None,
                depth: 0,
            }],
            notes: Vec::new(),
            truncated: false,
            listings: HashMap::new(),
            modules: HashMap::new(),
            mounts: HashMap::new(),
        }
    }

    fn note(&mut self, kind: &str, path: &str, repo: Option<&RepoRef>, message: String) {
        if self.notes.iter().any(|n| n["kind"] == kind && n["path"] == path) {
            return;
        }
        self.notes.push(json!({ "kind": kind, "path": path, "repo": repo.map(RepoRef::slug), "message": message }));
    }

    /// The entries of a tree: its direct children, or everything below it.
    async fn entries(&mut self, src: usize, tree: &str, recursive: bool) -> Result<Vec<TreeEntry>, GhErr> {
        let repo = self.sources[src].repo.clone();
        let key = (repo.slug(), tree.to_string(), recursive);
        if let Some((e, t)) = self.listings.get(&key) {
            self.truncated |= *t;
            return Ok(e.clone());
        }
        let v = self
            .gh
            .get(&format!("/repos/{}/git/trees/{tree}{}", repo.slug(), if recursive { "?recursive=1" } else { "" }))
            .await?;
        let mut out = Vec::new();
        for e in v["tree"].as_array().into_iter().flatten() {
            let kind = match e["type"].as_str() {
                Some("blob") => Kind::Blob,
                Some("tree") => Kind::Tree,
                Some("commit") => Kind::Commit,
                _ => continue,
            };
            if let (Some(p), Some(s)) = (e["path"].as_str(), e["sha"].as_str()) {
                out.push(TreeEntry { path: p.to_string(), kind, sha: s.to_string(), size: e["size"].as_u64().unwrap_or(0) });
            }
        }
        let truncated = v["truncated"].as_bool().unwrap_or(false);
        self.truncated |= truncated;
        self.listings.insert(key, (out.clone(), truncated));
        Ok(out)
    }

    async fn modules_of(&mut self, src: usize) -> Result<HashMap<String, Module>, GhErr> {
        if let Some(m) = self.modules.get(&src) {
            return Ok(m.clone());
        }
        let root = self.sources[src].tree.clone();
        let top = self.entries(src, &root, false).await?;
        let parsed = match top.iter().find(|e| e.kind == Kind::Blob && e.path == ".gitmodules") {
            Some(e) => {
                let bytes = self.gh.blob(&self.sources[src].repo, &e.sha).await?;
                parse_gitmodules(&String::from_utf8_lossy(&bytes))
            }
            None => HashMap::new(),
        };
        self.modules.insert(src, parsed.clone());
        Ok(parsed)
    }

    /// Open the submodule whose gitlink is at `path` of `parent`.  None (with a note) when
    /// it cannot be read: not on GitHub, not visible to this connection, nested too deep.
    async fn mount(&mut self, parent: usize, path: &str, commit: &str) -> Result<Option<usize>, GhErr> {
        let key = (parent, path.to_string());
        if let Some(m) = self.mounts.get(&key) {
            return Ok(*m);
        }
        let full = norm_join(&self.sources[parent].mount, path);
        let depth = self.sources[parent].depth + 1;
        let modules = self.modules_of(parent).await?;
        let parent_repo = self.sources[parent].repo.clone();
        let found = match modules.get(path) {
            None => {
                self.note("submodule_unknown", &full, None, format!(
                    "{full} is a submodule, but the repository's .gitmodules file does not say where it comes from."));
                None
            }
            Some(_) if depth > MAX_DEPTH => {
                self.note("submodule_deep", &full, None, format!("{full} is a submodule nested too deep to read."));
                None
            }
            Some(m) => match submodule_repo(&m.url, &parent_repo, &self.gh.web_host) {
                None => {
                    self.note("submodule_not_github", &full, None, format!(
                        "{full} is a submodule kept at {}, which is not on GitHub, so its files can't be read.", m.url));
                    None
                }
                Some(repo) => match self.gh.commit_tree(&repo, commit).await {
                    Ok(tree) => {
                        self.sources.push(Source {
                            repo,
                            commit: commit.to_string(),
                            tree,
                            mount: full,
                            parent: Some((parent, path.to_string())),
                            branch: m.branch.clone(),
                            depth,
                        });
                        Some(self.sources.len() - 1)
                    }
                    Err(e) if matches!(e.status, 403 | 404 | 409 | 422) => {
                        // Tell "cannot see the repository" from "the pinned commit is not in it".
                        let visible = self.gh.get(&format!("/repos/{}", repo.slug())).await.is_ok();
                        let message = if visible {
                            format!("{full} is a submodule pinned to a commit that {} does not have (was it pushed?).", repo.slug())
                        } else if self.gh.kind == "app" {
                            format!("{full} is a submodule ({}). Junction sees only the repositories you chose: add {} to them to read it.",
                                repo.slug(), repo.slug())
                        } else {
                            format!("{full} is a submodule ({}) that your GitHub connection cannot read.", repo.slug())
                        };
                        self.note(if visible { "submodule_commit_missing" } else { "submodule_no_access" }, &full, Some(&repo), message);
                        None
                    }
                    Err(e) => return Err(e),
                },
            },
        };
        self.mounts.insert(key, found);
        Ok(found)
    }

    /// What is at `path` of a source, going through submodules on the way.
    pub fn locate<'f>(&'f mut self, src: usize, path: &'f str) -> Fut<'f, Loc> {
        Box::pin(async move {
            let (mut cur_src, mut cur_tree) = (src, self.sources[src].tree.clone());
            let mut inside: Vec<&str> = Vec::new(); // path within cur_src
            let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
            for (i, seg) in segs.iter().enumerate() {
                let last = i + 1 == segs.len();
                let children = self.entries(cur_src, &cur_tree, false).await?;
                let Some(e) = children.iter().find(|e| e.path == *seg) else { return Ok(Loc::Missing) };
                inside.push(seg);
                match e.kind {
                    Kind::Tree => cur_tree = e.sha.clone(),
                    Kind::Blob => {
                        return Ok(if last {
                            Loc::File(RemoteFile { sha: e.sha.clone(), size: e.size, src: cur_src, path: inside.join("/") })
                        } else {
                            Loc::Missing
                        });
                    }
                    Kind::Commit => {
                        let at = inside.join("/");
                        match self.mount(cur_src, &at, &e.sha).await? {
                            Some(s) => {
                                cur_src = s;
                                cur_tree = self.sources[s].tree.clone();
                                inside.clear();
                            }
                            None => return Ok(Loc::Missing),
                        }
                    }
                }
            }
            Ok(Loc::Dir { src: cur_src, tree: cur_tree, path: inside.join("/") })
        })
    }

    /// Every file below a folder, submodules included, as (path relative to the folder, file).
    pub fn list<'f>(&'f mut self, src: usize, tree: &'f str, dir: &'f str, prefix: &'f str, out: &'f mut Vec<(String, RemoteFile)>) -> Fut<'f, ()> {
        Box::pin(async move {
            let all = self.entries(src, tree, true).await?;
            for e in all {
                let inside = if dir.is_empty() { e.path.clone() } else { format!("{dir}/{}", e.path) };
                match e.kind {
                    Kind::Tree => {}
                    Kind::Blob => out.push((format!("{prefix}{}", e.path), RemoteFile { sha: e.sha, size: e.size, src, path: inside })),
                    Kind::Commit => {
                        if let Some(s) = self.mount(src, &inside, &e.sha).await? {
                            let sub_tree = self.sources[s].tree.clone();
                            let sub_prefix = format!("{prefix}{}/", e.path);
                            self.list(s, &sub_tree, "", &sub_prefix, out).await?;
                        }
                    }
                }
            }
            Ok(())
        })
    }
}

fn usable(rel: &str) -> bool {
    allowed_file(rel) && !is_local_state_path(rel) && sync_path(rel).is_some()
}

/// Folders (relative, never "") that directly hold a project file.
fn project_dirs<'p>(paths: impl Iterator<Item = &'p String>) -> BTreeSet<String> {
    paths
        .filter(|p| p.ends_with(".kicad_pro"))
        .map(|p| dir_of(p).to_string())
        .filter(|d| !d.is_empty())
        .collect()
}

fn under<'d>(dirs: &'d BTreeSet<String>, path: &str) -> Option<&'d String> {
    dirs.iter().find(|d| path.starts_with(&format!("{d}/")))
}

// ------------------------------------------------------------------ reading a project

/// What a blob names, remembered by blob id.
async fn blob_refs(pool: &sqlx::PgPool, gh: &Gh, repo: &RepoRef, doc_path: &str, f: &RemoteFile) -> AppResult<Vec<String>> {
    if let Some(row) = sqlx::query("SELECT refs FROM github_blob_refs WHERE blob_sha = $1").bind(&f.sha).fetch_optional(pool).await? {
        let v: Value = row.get("refs");
        return Ok(v.as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_string)).collect());
    }
    if f.size > MAX_FILE_BYTES {
        return Ok(Vec::new());
    }
    let bytes = gh.blob(repo, &f.sha).await?;
    let refs = refs_of(doc_path, &String::from_utf8_lossy(&bytes));
    sqlx::query("INSERT INTO github_blob_refs (blob_sha, refs) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(&f.sha)
        .bind(json!(refs))
        .execute(pool)
        .await?;
    Ok(refs)
}

/// The project's files on GitHub: the linked folder of the branch head (less the
/// projects nested in it), plus what those files name outside it.  `known` are the
/// outside files the project already has: one that is still in the repository stays
/// part of the project even when nothing names it any more (a library table row
/// removed is not the library deleted).
pub(super) async fn read(pool: &sqlx::PgPool, gh: &Gh, repo: &RepoRef, branch: &str, subdir: &str, known: &[String]) -> AppResult<Remote> {
    let Some(head) = gh.branch_head(repo, branch).await? else {
        return Ok(Remote::default());
    };
    let tree = gh.commit_tree(repo, &head).await?;
    let mut w = Walker::new(gh, repo, &head, &tree);
    let mut remote = Remote { head: Some(head), tree: Some(tree), ..Default::default() };

    let folder = w.locate(0, subdir).await?;
    let Loc::Dir { src, tree: folder_tree, path: folder_path } = folder else {
        remote.sources = w.sources;
        remote.notes = w.notes;
        return Ok(remote);
    };
    remote.folder_exists = true;
    let mut listed = Vec::new();
    w.list(src, &folder_tree, &folder_path, "", &mut listed).await?;
    let mut files: BTreeMap<String, RemoteFile> = listed.into_iter().filter(|(rel, _)| usable(rel)).collect();

    // A folder below with a project file of its own is another project — when this
    // folder is a project itself.  (A link to a folder that merely contains projects
    // keeps everything, as it always did.)
    let own_project = files.keys().any(|p| p.ends_with(".kicad_pro") && !p.contains('/'));
    let nested = if own_project { project_dirs(files.keys()) } else { BTreeSet::new() };
    let mut set_aside: BTreeMap<String, RemoteFile> = BTreeMap::new();
    if !nested.is_empty() {
        let (keep, aside): (BTreeMap<_, _>, BTreeMap<_, _>) = files.into_iter().partition(|(p, _)| under(&nested, p).is_none());
        files = keep;
        set_aside = aside;
    }
    // Only the outermost of nested projects is named.
    remote.nested = nested.iter().filter(|d| !nested.iter().any(|o| o != *d && d.starts_with(&format!("{o}/")))).cloned().collect();

    // Follow what the files name outside the project: a shared library, a sheet kept
    // in another folder, a model.  What they bring in may name more.
    let mut scanned: BTreeSet<String> = BTreeSet::new();
    let mut tried: BTreeSet<String> = BTreeSet::new();
    loop {
        let todo: Vec<String> = files.keys().filter(|p| names_files(p) && !scanned.contains(*p)).cloned().collect();
        if todo.is_empty() {
            break;
        }
        // Read what is not remembered yet a few at a time.
        let mut named: Vec<String> = Vec::new();
        for group in todo.chunks(6) {
            let jobs = group.iter().map(|p| {
                let f = &files[p];
                blob_refs(pool, gh, &w.sources[f.src].repo, p, f)
            });
            for (p, refs) in group.iter().zip(futures_util::future::try_join_all(jobs).await?) {
                named.extend(resolve_refs(p, &refs));
            }
        }
        scanned.extend(todo);
        named.sort();
        named.dedup();
        for target in named {
            let outside = target.starts_with("../");
            if !(outside || under(&nested, &target).is_some()) || files.contains_key(&target) || !tried.insert(target.clone()) {
                continue;
            }
            if files.keys().any(|p| p.starts_with(&format!("{target}/"))) {
                continue;
            }
            // Something the project folder holds but another project owns.
            if !outside {
                let prefix = format!("{target}/");
                let hits: Vec<String> = set_aside.keys().filter(|p| **p == target || p.starts_with(&prefix)).cloned().collect();
                for p in hits {
                    if let Some(f) = set_aside.remove(&p) {
                        files.insert(p, f);
                    }
                }
                continue;
            }
            let Some(at) = repo_path(subdir, &target) else {
                w.note("outside_repo", &target, None, format!(
                    "{target} is outside the repository, so it can't come along. Libraries a project shares need to be in the repository."));
                continue;
            };
            let notes_before = w.notes.len();
            match w.locate(0, &at).await? {
                Loc::File(f) => {
                    if usable(&target) {
                        files.insert(target, f);
                    }
                }
                Loc::Dir { src, tree, path } => {
                    let mut found = Vec::new();
                    let prefix = format!("{target}/");
                    w.list(src, &tree, &path, &prefix, &mut found).await?;
                    files.extend(found.into_iter().filter(|(rel, _)| usable(rel)));
                }
                Loc::Missing => {
                    // A submodule that could not be opened has said so already.
                    if w.notes.len() == notes_before && !w.notes.iter().any(|n| {
                        n["kind"].as_str().is_some_and(|k| k.starts_with("submodule"))
                            && n["path"].as_str().is_some_and(|m| at == m || at.starts_with(&format!("{m}/")))
                    }) {
                        w.note("missing_ref", &target, None, format!("The project names {target} ({at} in the repository), which is not there."));
                    }
                }
            }
            if files.len() > MAX_FILES * 4 {
                break;
            }
        }
    }

    for path in known {
        if !path.starts_with("../") || files.contains_key(path) || !usable(path) {
            continue;
        }
        let Some(at) = repo_path(subdir, path) else { continue };
        let notes = w.notes.len();
        if let Loc::File(f) = w.locate(0, &at).await? {
            files.insert(path.clone(), f);
        }
        w.notes.truncate(notes);
    }

    remote.files = files;
    remote.truncated = w.truncated;
    remote.sources = w.sources;
    remote.notes = w.notes;
    Ok(remote)
}

// ------------------------------------------------------------------ scanning a repository

pub(super) struct Found {
    pub path: String,
    pub name: String,
    /// Every project file in the folder (KiCad allows several; they travel as one online project).
    pub project_files: Vec<String>,
    pub files: usize,
    /// The project folder this one is inside, if any.
    pub inside: Option<String>,
    /// The submodule repository the folder is in.
    pub submodule: Option<String>,
    /// Libraries the project's tables name outside its folder: (path as written, repository path, there?).
    pub shared: Vec<(String, Option<String>, bool)>,
}

/// Every folder of a branch that holds a KiCad project, submodules included.
pub(super) async fn scan(gh: &Gh, repo: &RepoRef, branch: &str) -> AppResult<(Remote, Vec<Found>)> {
    let Some(head) = gh.branch_head(repo, branch).await? else {
        return Ok((Remote::default(), Vec::new()));
    };
    let tree = gh.commit_tree(repo, &head).await?;
    let mut w = Walker::new(gh, repo, &head, &tree);
    let mut listed = Vec::new();
    w.list(0, &tree, "", "", &mut listed).await?;
    let all: BTreeMap<String, RemoteFile> = listed.into_iter().filter(|(rel, _)| usable(rel)).collect();

    // folder -> its project files
    let mut folders: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for p in all.keys() {
        if let Some(stem) = base_name(p).strip_suffix(".kicad_pro") {
            folders.entry(dir_of(p).to_string()).or_default().push(stem.to_string());
        }
    }
    // KiCad files but no project file anywhere: offer the root as it is.
    if folders.is_empty() && !all.is_empty() {
        folders.insert(String::new(), vec![repo.name.clone()]);
    }
    let dirs: Vec<String> = folders.keys().cloned().collect();
    let prefix = |d: &str| if d.is_empty() { String::new() } else { format!("{d}/") };
    let mut found = Vec::new();
    for (dir, stems) in &folders {
        let pre = prefix(dir);
        // projects nested in this one take their files with them
        let inner: Vec<String> = dirs.iter().filter(|d| *d != dir && d.starts_with(&pre) && (!dir.is_empty() || !d.is_empty())).map(|d| prefix(d)).collect();
        let own = |p: &str| p.starts_with(&pre) && !inner.iter().any(|i| p.starts_with(i.as_str()));
        let files = all.keys().filter(|p| own(p)).count();
        let folder_name = base_name(dir);
        let name = stems.iter().find(|s| s.as_str() == folder_name).or(stems.first()).cloned().unwrap_or_default();
        let inside = dirs
            .iter()
            .filter(|d| *d != dir && dir.starts_with(&prefix(d)) && !(d.is_empty() && !folders.contains_key("")))
            .max_by_key(|d| d.len())
            .cloned();
        let submodule = all
            .iter()
            .find(|(p, f)| f.src != 0 && p.starts_with(&pre) && dir_of(p) == dir)
            .map(|(_, f)| w.sources[f.src].repo.slug());

        // Libraries its tables name outside the folder.
        let mut shared = Vec::new();
        for table in ["sym-lib-table", "fp-lib-table", "design-block-lib-table"] {
            let Some(f) = all.get(&format!("{pre}{table}")) else { continue };
            if f.size > 1024 * 1024 {
                continue;
            }
            let text = String::from_utf8_lossy(&gh.blob(&w.sources[f.src].repo, &f.sha).await?).into_owned();
            for target in resolve_refs(table, &refs_of(table, &text)) {
                if !target.starts_with("../") {
                    continue;
                }
                let at = repo_path(dir, &target);
                let there = match &at {
                    Some(at) => all.contains_key(at) || all.keys().any(|p| p.starts_with(&format!("{at}/"))),
                    None => false,
                };
                if !shared.iter().any(|(t, _, _)| *t == target) {
                    shared.push((target, at, there));
                }
            }
        }
        found.push(Found { path: dir.clone(), name, project_files: stems.clone(), files, inside, submodule, shared });
    }
    let remote = Remote {
        head: Some(head),
        tree: Some(tree),
        files: all,
        truncated: w.truncated,
        sources: w.sources,
        notes: w.notes,
        nested: Vec::new(),
        folder_exists: true,
    };
    Ok((remote, found))
}

// ------------------------------------------------------------------ a folder that moved

/// Where the project went when its folder is no longer where the link says: folders of
/// the branch (other than `not`, where it was) that hold the files the project had at
/// the last sync, best match first, and whether the first is clearly the one.
/// `base` is project path -> blob id as of that sync.
pub(super) async fn find_moved(gh: &Gh, repo: &RepoRef, tree: &str, base: &HashMap<String, String>, not: &str) -> Result<(Vec<String>, bool), GhErr> {
    let (all, _) = gh.tree(repo, tree).await?;
    let wanted: Vec<(&String, &String)> = base.iter().filter(|(p, _)| !p.starts_with("../")).collect();
    let pro_shas: BTreeSet<&String> = wanted.iter().filter(|(p, _)| p.ends_with(".kicad_pro")).map(|(_, s)| *s).collect();
    if wanted.is_empty() {
        return Ok((Vec::new(), false));
    }
    // Candidate folders: wherever a project file is.
    let dirs: BTreeSet<&str> = all.keys().filter(|p| p.ends_with(".kicad_pro")).map(|p| dir_of(p)).filter(|d| *d != not).collect();
    let mut scored: Vec<(usize, bool, String)> = Vec::new();
    for dir in dirs {
        let pre = if dir.is_empty() { String::new() } else { format!("{dir}/") };
        let same = wanted.iter().filter(|(p, s)| all.get(&format!("{pre}{p}")).is_some_and(|(r, _)| r == *s)).count();
        // The project file itself, under any name (the project may have been renamed too).
        let pro = all.iter().any(|(p, (s, _))| p.ends_with(".kicad_pro") && dir_of(p) == dir && pro_shas.contains(s));
        if pro || same * 2 >= wanted.len() {
            scored.push((same, pro, dir.to_string()));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    // One folder that holds clearly more of the project than any other (and at least
    // half of it) is where it went; a copy of a few of its files elsewhere is not.
    let clear = match scored.as_slice() {
        [only] => only.0 * 2 >= wanted.len() || only.1,
        [first, second, ..] => first.0 > second.0 && first.0 * 2 >= wanted.len(),
        [] => false,
    };
    Ok((scored.into_iter().map(|(_, _, d)| d).collect(), clear))
}

// ------------------------------------------------------------------ the same file under a new name

/// Whether two versions look like one file that was renamed and perhaps edited: the
/// same root uuid (a schematic keeps it for life), or mostly the same lines.
pub(super) fn similar(a: &[u8], b: &[u8]) -> bool {
    if a == b {
        return true;
    }
    let (Ok(a), Ok(b)) = (std::str::from_utf8(a), std::str::from_utf8(b)) else { return false };
    let root_uuid = |t: &str| -> Option<String> {
        let head = &t[..t.len().min(600)];
        // the file's own uuid sits at depth 1, before any item
        let i = head.find("\n\t(uuid ").or_else(|| head.find("\n  (uuid "))?;
        quoted_after(&head[i..], "(uuid").first().map(|s| s.to_string())
    };
    if let (Some(x), Some(y)) = (root_uuid(a), root_uuid(b)) {
        return x == y;
    }
    let mut lines: HashMap<&str, i64> = HashMap::new();
    let mut total_a = 0i64;
    for l in a.lines().map(str::trim).filter(|l| !l.is_empty()) {
        *lines.entry(l).or_default() += 1;
        total_a += 1;
    }
    let (mut common, mut total_b) = (0i64, 0i64);
    for l in b.lines().map(str::trim).filter(|l| !l.is_empty()) {
        total_b += 1;
        if let Some(n) = lines.get_mut(l) {
            if *n > 0 {
                *n -= 1;
                common += 1;
            }
        }
    }
    let most = total_a.max(total_b);
    most >= 4 && common * 10 >= most * 6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(norm_join("hw/keybit", "../lib/lcsc.pretty"), "hw/lib/lcsc.pretty");
        assert_eq!(norm_join("", "../lib/x"), "../lib/x");
        assert_eq!(norm_join("a", "../../x/./y"), "../x/y");
        assert_eq!(norm_join("a/b", "c\\d"), "a/b/c/d");
        assert_eq!(repo_path("hardware/keybit", "../lib/lcsc.kicad_sym").as_deref(), Some("hardware/lib/lcsc.kicad_sym"));
        assert_eq!(repo_path("hardware/keybit", "keybit.kicad_pcb").as_deref(), Some("hardware/keybit/keybit.kicad_pcb"));
        assert_eq!(repo_path("", "../lib/x.kicad_sym"), None, "above the repository root");
        assert_eq!(repo_path("hw", "../../x"), None);
        assert_eq!(sync_path("../lib/a.kicad_sym").as_deref(), Some("../lib/a.kicad_sym"));
        assert_eq!(sync_path("../../lib/a.pretty/R.kicad_mod").as_deref(), Some("../../lib/a.pretty/R.kicad_mod"));
        assert_eq!(sync_path("a/b.kicad_sch").as_deref(), Some("a/b.kicad_sch"));
        assert_eq!(sync_path("a/../b.kicad_sch"), None, "only leading parent segments");
        assert_eq!(sync_path("/etc/x.kicad_sch"), None);
        assert_eq!(sync_path("../"), None);
    }

    #[test]
    fn what_files_name() {
        let table = "(fp_lib_table\n  (version 7)\n  (lib (name \"lcsc\")(type \"KiCad\")(uri \"${KIPRJMOD}/../lib/lcsc.pretty\")(options \"\")(descr \"\"))\n  (lib (name std)(type KiCad)(uri ${KICAD9_FOOTPRINT_DIR}/R.pretty))\n  (lib (name mine)(type KiCad)(uri $(KIPRJMOD)/mine.pretty))\n)";
        assert_eq!(resolve_refs("fp-lib-table", &refs_of("fp-lib-table", table)), vec!["../lib/lcsc.pretty", "mine.pretty"]);
        let sch = "(kicad_sch\n\t(sheet\n\t\t(property \"Sheetname\" \"psu\")\n\t\t(property \"Sheetfile\" \"../common/psu.kicad_sch\"\n\t\t\t(at 0 0 0))\n\t)\n\t(sheet (property \"Sheetfile\" \"io.kicad_sch\"))\n)";
        assert_eq!(resolve_refs("sub/top.kicad_sch", &refs_of("sub/top.kicad_sch", sch)), vec!["common/psu.kicad_sch", "sub/io.kicad_sch"]);
        assert_eq!(resolve_refs("top.kicad_sch", &refs_of("top.kicad_sch", sch)), vec!["../common/psu.kicad_sch", "io.kicad_sch"]);
        let pcb = "(kicad_pcb (footprint \"a:b\" (model \"${KIPRJMOD}/../lib/lcsc.3dshapes/X.wrl\" (offset (xyz 0 0 0))) (model \"${KICAD10_3DMODEL_DIR}/R.3dshapes/R.step\")))";
        assert_eq!(resolve_refs("b.kicad_pcb", &refs_of("b.kicad_pcb", pcb)), vec!["../lib/lcsc.3dshapes/X.wrl"]);
        assert!(refs_of("x.kicad_pro", "{\"uri\": \"${KIPRJMOD}/../x\"}").is_empty());
    }

    #[test]
    fn gitmodules() {
        let m = parse_gitmodules("[submodule \"hardware/lib\"]\n\tpath = hardware/lib\n\turl = https://github.com/o/parts.git\n\tbranch = main\n# note\n[submodule \"x\"]\n  path=fw/rtos\n  url = git@gitlab.com:a/b.git\n");
        assert_eq!(m["hardware/lib"], Module { url: "https://github.com/o/parts.git".into(), branch: Some("main".into()) });
        assert_eq!(m["fw/rtos"].branch, None);
        let parent = RepoRef::parse("me/board").unwrap();
        let r = |u: &str| submodule_repo(u, &parent, "127.0.0.1:8098").map(|r| r.slug());
        assert_eq!(r("https://github.com/o/parts.git").as_deref(), Some("o/parts"));
        assert_eq!(r("https://github.com/o/parts/").as_deref(), Some("o/parts"));
        assert_eq!(r("git@github.com:o/parts.git").as_deref(), Some("o/parts"));
        assert_eq!(r("ssh://git@github.com/o/parts").as_deref(), Some("o/parts"));
        assert_eq!(r("../parts.git").as_deref(), Some("me/parts"));
        assert_eq!(r("../../other/parts").as_deref(), Some("other/parts"));
        assert_eq!(r("http://127.0.0.1:8098/o/parts.git").as_deref(), Some("o/parts"));
        assert_eq!(r("git@gitlab.com:a/b.git"), None);
        assert_eq!(r("https://example.com/o/parts.git"), None);
        assert_eq!(r("../../../x"), None);
    }

    #[test]
    fn renamed_files_are_recognised() {
        let sch = |uuid: &str, extra: &str| format!("(kicad_sch\n\t(version 20250114)\n\t(generator \"eeschema\")\n\t(uuid \"{uuid}\")\n\t(paper \"A4\")\n{extra})\n");
        assert!(similar(sch("aaaa", "").as_bytes(), sch("aaaa", "\t(wire)\n\t(wire)\n\t(label)\n\t(junction)\n\t(text)\n").as_bytes()), "same root uuid");
        assert!(!similar(sch("aaaa", "").as_bytes(), sch("bbbb", "").as_bytes()), "another schematic");
        let lines = |n: usize, tag: &str| (0..n).map(|i| format!("(fp {tag}{i})\n")).collect::<String>();
        let a = format!("(kicad_pcb\n{}", lines(20, "x"));
        let b = format!("(kicad_pcb\n{}{}", lines(20, "x"), lines(3, "y"));
        assert!(similar(a.as_bytes(), b.as_bytes()), "a board with a few more items");
        assert!(!similar(a.as_bytes(), format!("(kicad_pcb\n{}", lines(20, "z")).as_bytes()));
        assert!(!similar(b"\x00\x01", b"\x00\x02"));
    }
}
