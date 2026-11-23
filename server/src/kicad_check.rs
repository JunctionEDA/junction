//! The Design Rules Checker and Electrical Rules Checker run by KiCad itself.
//!
//! The browser's checks (web/domains/pcb/tools/pcb-tools/drc*.ts, sch-tools/erc*.ts) are a TypeScript
//! port: quick enough to run while editing, but not KiCad.  `Run DRC` and `Run ERC` come here instead:
//! the project is written out as the design is now (the journal folded into each file, as an archive
//! download does) and the desktop's own `kicad-cli pcb drc` / `sch erc` checks it, so the result is
//! exactly what Junction desktop reports for the same files.  The dialog shows that list; the browser
//! falls back to its own checks only when this server has no kicad-cli (`501 no_kicad_cli`) or the
//! request fails.
//!
//! Routes (anyone who may open the project):
//! * `POST /api/docs/{id}/drc`  `{ parity?, refill?, allTrackErrors?, units? }` → `{ report, cli }` where `report`
//!   is kicad-cli's JSON report (`--format json --units <units> --severity-all`); `units` is the editor's
//!   (`mm`, `in` or `mil`), as KiCad's dialogs report in the frame's user units.
//! * `POST /api/docs/{id}/erc`  `{ showAllErrors?, units?, progress? }` → the same for the project's root
//!   schematic.  `showAllErrors` is DIALOG_ERC's "Show all errors" (`--show-all-errors`).  With `progress` the
//!   answer is a stream of JSON lines (`application/x-ndjson`): `{ "phase": "Checking conflicts..." }` for each
//!   test phase kicad-cli starts (`--progress`), then `{ report, cli }` or `{ error, message, status }`.
//!   Closing the request (the dialog's Cancel) stops kicad-cli.

use std::path::{Path as FsPath, PathBuf};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::access::{self, Viewer};
use crate::error::{AppError, AppResult};
use crate::persist;
use crate::AppState;

/// A big board (the Jetson demo, 12 layers) takes about 40 s.
const CHECK_TIMEOUT: Duration = Duration::from_secs(300);
/// Checks running at once: each holds a whole design in memory.
pub(crate) static CHECKING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
/// Rules about the global libraries: the server has no footprint or symbol libraries installed, so
/// kicad-cli would report every footprint and symbol as coming from an unknown library.
const LIBRARY_RULES: &[&str] = &["lib_footprint_issues", "lib_footprint_mismatch", "lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues"];

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/docs/{id}/drc", post(drc)).route("/api/docs/{id}/erc", post(erc))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DrcOpts {
    #[serde(default)]
    parity: bool,
    #[serde(default)]
    refill: bool,
    #[serde(default)]
    all_track_errors: bool,
    #[serde(default)]
    units: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ErcOpts {
    #[serde(default)]
    show_all_errors: bool,
    #[serde(default)]
    units: Option<String>,
    #[serde(default)]
    progress: bool,
}

/// kicad-cli's `--units` for the editor's units (EDA_UNITS of the frame the dialog belongs to).
fn cli_units(units: Option<&str>) -> AppResult<&'static str> {
    match units.unwrap_or("") {
        "" | "mm" => Ok("mm"),
        "in" => Ok("in"),
        "mil" | "mils" => Ok("mils"),
        other => Err(AppError::BadRequest(format!("unknown units '{other}'"))),
    }
}

/// The kicad-cli to check with: Junction desktop's own (the Docker image installs it), else `KICAD_CLI`.
pub(crate) fn cli() -> Option<String> {
    crate::nonkicad_import::cli()
}

async fn drc(State(state): State<AppState>, viewer: Viewer, Path(id): Path<Uuid>, body: Option<Json<DrcOpts>>) -> AppResult<Response> {
    let opts = body.map(|b| b.0).unwrap_or_default();
    let doc = persist::get_document(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if doc.doc_type != "kicad_pcb" {
        return Err(AppError::BadRequest("the Design Rules Checker needs a board".into()));
    }
    let mut args: Vec<String> = vec!["pcb".into(), "drc".into()];
    if opts.parity { args.push("--schematic-parity".into()); }
    if opts.refill { args.push("--refill-zones".into()); }
    if opts.all_track_errors { args.push("--all-track-errors".into()); }
    let units = cli_units(opts.units.as_deref())?;
    run(&state, &viewer, &doc, args, units, false).await
}

async fn erc(State(state): State<AppState>, viewer: Viewer, Path(id): Path<Uuid>, body: Option<Json<ErcOpts>>) -> AppResult<Response> {
    let opts = body.map(|b| b.0).unwrap_or_default();
    let units = cli_units(opts.units.as_deref())?;
    let doc = persist::get_document(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    if doc.doc_type != "kicad_sch" {
        return Err(AppError::BadRequest("the Electrical Rules Checker needs a schematic".into()));
    }
    // ERC is a check of the whole hierarchy, from the root sheet
    let docs = persist::project_documents(&state.pool, doc.project_id).await?;
    let root = crate::http::root_schematic(&docs).cloned().unwrap_or(doc);
    let mut args: Vec<String> = vec!["sch".into(), "erc".into()];
    if let Some(cli) = cli() {
        if opts.show_all_errors {
            if !cli_has(&cli, &["sch", "erc"], "--show-all-errors").await {
                return Err(AppError::Api(StatusCode::NOT_IMPLEMENTED, "no_kicad_cli_option",
                    "This server's kicad-cli cannot show all errors; the checks run in the browser.".into()));
            }
            args.push("--show-all-errors".into());
        }
        // an older kicad-cli runs without the phase lines
        if opts.progress && cli_has(&cli, &["sch", "erc"], "--progress").await { args.push("--progress".into()); }
    }
    run(&state, &viewer, &root, args, units, opts.progress).await
}

/// Whether this server's kicad-cli knows `flag` for the command `sub` ("sch erc"): a release built before the flag
/// was added refuses an unknown argument, so a flag is passed only when the command's help lists it.
pub(crate) async fn cli_has(cli: &str, sub: &[&str], flag: &str) -> bool {
    static HELP: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> = std::sync::OnceLock::new();
    let key = format!("{cli} {}", sub.join(" "));
    let cache = HELP.get_or_init(Default::default);
    let known = cache.lock().ok().and_then(|m| m.get(&key).cloned());
    let help = match known {
        Some(h) => h,
        None => {
            let mut cmd = tokio::process::Command::new(cli);
            cmd.args(sub).arg("--help").stdin(std::process::Stdio::null()).kill_on_drop(true);
            let text = match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
                Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr),
                _ => return false,
            };
            if let Ok(mut m) = cache.lock() { m.insert(key, text.clone()); }
            text
        }
    };
    help.split(|c: char| c.is_whitespace() || c == ',' || c == '[' || c == ']').any(|w| w == flag)
}

/// The work folder of one check, removed however the check ends (also when the request is dropped).
pub(crate) struct WorkDir(pub(crate) PathBuf);

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One line of a progress stream.
fn line(v: Value) -> Result<Bytes, std::io::Error> {
    let mut s = v.to_string();
    s.push('\n');
    Ok(Bytes::from(s))
}

async fn run(state: &AppState, viewer: &Viewer, doc: &persist::Document, mut args: Vec<String>, units: &'static str, progress: bool) -> AppResult<Response> {
    access::resolve(&state.pool, viewer, doc.project_id).await?.ok_or(AppError::NotFound)?;
    let Some(cli) = cli() else {
        return Err(AppError::Api(StatusCode::NOT_IMPLEMENTED, "no_kicad_cli", "This server has no kicad-cli; the checks run in the browser.".into()));
    };
    let permit = CHECKING.acquire().await.map_err(|e| anyhow::anyhow!("check queue: {e}"))?;

    // the files as the design is now, not as the last upload left them
    crate::compact::fold_project(&state.pool, doc.project_id).await;
    let docs = persist::project_documents(&state.pool, doc.project_id).await?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for d in &docs {
        if let Some((_, content)) = persist::latest_snapshot(&state.pool, d.id).await? {
            entries.push((d.path.clone(), content));
        }
    }
    entries.extend(crate::projectlibs::rebuild_symbol_libraries(&entries));
    let target = path_in(&entries, &doc.path);
    let work = WorkDir(std::env::temp_dir().join(format!("junction-check-{}", Uuid::new_v4())));
    args.extend(["--format", "json", "--units", units, "--severity-all"].map(String::from));
    if !progress {
        // a dropped request drops this future, and kill_on_drop stops kicad-cli
        let result = check(&cli, &work.0, &entries, &target, &mut args, None).await;
        drop(permit);
        return result.map(|v| Json(v).into_response());
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    tokio::spawn(async move {
        let _permit = permit;
        let work = work;
        let phases = tx.clone();
        let result = tokio::select! {
            r = check(&cli, &work.0, &entries, &target, &mut args, Some(phases)) => r,
            // the dialog's Cancel closed the request: dropping the check kills kicad-cli
            _ = tx.closed() => return,
        };
        let last = match result {
            Ok(v) => v,
            Err(e) => {
                let resp = e.into_response();
                let status = resp.status().as_u16();
                let body = axum::body::to_bytes(resp.into_body(), 64 * 1024).await.unwrap_or_default();
                let mut v: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({ "error": "check_failed" }));
                v["status"] = json!(status);
                v
            }
        };
        let _ = tx.send(line(last)).await;
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-cache, no-transform"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

/// Whether a line kicad-cli printed is one of ERC_TESTER::RunTests's phase messages ("Checking conflicts...").
fn is_phase(line: &str) -> bool {
    line.starts_with("Checking ") && line.ends_with("...")
}

async fn check(cli: &str, work: &FsPath, entries: &[(String, Vec<u8>)], target: &str, args: &mut Vec<String>,
               phases: Option<tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>>) -> AppResult<Value> {
    let files = work.join("files");
    for (path, content) in entries {
        let Some(to) = safe_join(&files, path_in(entries, path)) else { continue };
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| anyhow::anyhow!("check folder: {e}"))?;
        }
        tokio::fs::write(&to, content).await.map_err(|e| anyhow::anyhow!("write {path}: {e}"))?;
    }
    let input = safe_join(&files, target.to_string()).ok_or_else(|| AppError::BadRequest("bad document path".into()))?;
    let out = work.join("report.json");
    let home = work.join("home");
    tokio::fs::create_dir_all(&home).await.map_err(|e| anyhow::anyhow!("check home: {e}"))?;
    args.push("-o".into());
    args.push(out.to_string_lossy().into_owned());
    args.push(input.to_string_lossy().into_owned());

    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(args.iter())
        // settings and caches stay in the work folder
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .current_dir(work)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let run = async {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt};
        let mut child = cmd.spawn()?;
        let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err(std::io::Error::other("no output pipes"));
        };
        // stdout line by line (the phases go out as they come), stderr whole
        let read_out = async {
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            let mut text = String::new();
            while let Ok(Some(l)) = lines.next_line().await {
                let t = l.trim();
                if let Some(tx) = &phases {
                    if is_phase(t) { let _ = tx.send(line(json!({ "phase": t }))).await; }
                }
                text.push_str(&l);
                text.push('\n');
            }
            text
        };
        let read_err = async {
            let mut v = Vec::new();
            let _ = stderr.read_to_end(&mut v).await;
            String::from_utf8_lossy(&v).to_string()
        };
        let (out_text, err_text) = tokio::join!(read_out, read_err);
        child.wait().await?;
        Ok::<_, std::io::Error>(err_text + &out_text)
    };
    let output = match tokio::time::timeout(CHECK_TIMEOUT, run).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(AppError::Other(anyhow::anyhow!("could not run kicad-cli: {e}"))),
        Err(_) => return Err(AppError::Api(StatusCode::GATEWAY_TIMEOUT, "check_timeout", "The check took too long and was stopped.".into())),
    };
    let report = tokio::fs::read(&out).await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let Some(mut report) = report else {
        let text = output;
        let why = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains("Gtk-") && !l.contains("dbus")).last().unwrap_or("kicad-cli failed").to_string();
        return Err(AppError::Api(StatusCode::UNPROCESSABLE_ENTITY, "check_failed", why));
    };
    strip_library_rules(&mut report);
    Ok(json!({ "report": report, "cli": "kicad-cli" }))
}

/// Where a document's path lands under the work folder: shared `../` files one level up as in a download.
pub(crate) fn path_in(entries: &[(String, Vec<u8>)], path: &str) -> String {
    let up = entries.iter().map(|(p, _)| p.split('/').take_while(|s| *s == "..").count()).max().unwrap_or(0);
    crate::http::archive_place(&crate::http::archive_home("", "project", up), path)
}

/// `base/rel` when `rel` stays inside `base` (no absolute paths, no `..` left after placing).
pub(crate) fn safe_join(base: &FsPath, rel: String) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => return None,
            s if s.contains('\\') || s.contains('\0') => return None,
            s => out.push(s),
        }
    }
    (out != base).then_some(out)
}

/// Drop the library rules (see LIBRARY_RULES) from a DRC or ERC report.
fn strip_library_rules(report: &mut Value) {
    let keep = |v: &Value| !LIBRARY_RULES.contains(&v["type"].as_str().unwrap_or(""));
    if let Some(list) = report.get_mut("violations").and_then(Value::as_array_mut) {
        list.retain(keep);
    }
    if let Some(sheets) = report.get_mut("sheets").and_then(Value::as_array_mut) {
        for s in sheets {
            if let Some(list) = s.get_mut("violations").and_then(Value::as_array_mut) {
                list.retain(keep);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_in_the_work_folder() {
        let base = FsPath::new("/w");
        assert_eq!(safe_join(base, "project/a.kicad_pcb".into()), Some(PathBuf::from("/w/project/a.kicad_pcb")));
        assert_eq!(safe_join(base, "../x".into()), None);
        assert_eq!(safe_join(base, "".into()), None);
        let entries = vec![("a.kicad_pcb".to_string(), vec![]), ("../lib/x.pretty/y.kicad_mod".to_string(), vec![])];
        assert_eq!(path_in(&entries, "a.kicad_pcb"), "project/a.kicad_pcb");
        assert_eq!(path_in(&entries, "../lib/x.pretty/y.kicad_mod"), "lib/x.pretty/y.kicad_mod");
    }

    #[test]
    fn units_and_phases() {
        assert_eq!(cli_units(None).unwrap(), "mm");
        assert_eq!(cli_units(Some("in")).unwrap(), "in");
        assert_eq!(cli_units(Some("mil")).unwrap(), "mils");
        assert!(cli_units(Some("furlong")).is_err());
        assert!(is_phase("Checking conflicts..."));
        assert!(!is_phase("Found 3 violations"));
        assert!(!is_phase("Saved ERC Report to /w/report.json"));
        let o: ErcOpts = serde_json::from_value(json!({ "showAllErrors": true, "units": "mil", "progress": true })).unwrap();
        assert!(o.show_all_errors && o.progress && o.units.as_deref() == Some("mil"));
    }

    /// A check's work folder goes when its guard does, so a cancelled run leaves nothing behind.
    #[test]
    fn work_folder_is_removed() {
        let dir = std::env::temp_dir().join(format!("junction-check-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("files")).unwrap();
        drop(WorkDir(dir.clone()));
        assert!(!dir.exists());
    }

    /// The stream ends with the report; a kicad-cli that prints phases has them forwarded first.
    #[cfg(unix)]
    #[tokio::test]
    async fn phases_are_streamed_before_the_report() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("junction-check-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("kicad-cli");
        // writes the file after -o and prints two phases and a report line
        std::fs::write(&fake, "#!/bin/sh\nout=\"\"\nwhile [ $# -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then out=\"$2\"; fi; shift; done\necho 'Checking sheet names...'\necho 'Checking conflicts...'\necho 'Found 0 violations'\necho '{\"sheets\":[{\"violations\":[{\"type\":\"lib_symbol_issues\"},{\"type\":\"pin_not_connected\",\"pos\":{\"x\":1,\"y\":2}}]}],\"coordinate_units\":\"mm\"}' > \"$out\"\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let work = WorkDir(dir.join("work"));
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let entries = vec![("a.kicad_sch".to_string(), b"(kicad_sch)".to_vec())];
        let mut args: Vec<String> = vec!["sch".into(), "erc".into(), "--progress".into()];
        let report = check(fake.to_str().unwrap(), &work.0, &entries, "project/a.kicad_sch", &mut args, Some(tx)).await.unwrap();
        let mut got = Vec::new();
        while let Ok(Ok(b)) = rx.try_recv() { got.push(String::from_utf8(b.to_vec()).unwrap()); }
        assert_eq!(got, ["{\"phase\":\"Checking sheet names...\"}\n", "{\"phase\":\"Checking conflicts...\"}\n"]);
        let list = report["report"]["sheets"][0]["violations"].as_array().unwrap();
        assert_eq!(list.len(), 1, "library rules dropped");
        assert_eq!(list[0]["pos"]["x"], 1);
        drop(work);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn library_rules_are_dropped() {
        let mut r = json!({ "violations": [{ "type": "clearance" }, { "type": "lib_footprint_issues" }],
                            "sheets": [{ "violations": [{ "type": "lib_symbol_issues" }, { "type": "pin_not_connected" }] }] });
        strip_library_rules(&mut r);
        assert_eq!(r["violations"].as_array().unwrap().len(), 1);
        assert_eq!(r["sheets"][0]["violations"][0]["type"], "pin_not_connected");
    }
}
