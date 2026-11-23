//! KiCad's own exporters, run on the project as it is now by Junction desktop's kicad-cli (the same files
//! `kicad_check.rs` writes out for Run DRC / Run ERC): what the desktop editors do in-process and a browser cannot.
//!
//! Route (anyone who may open the project): `POST /api/docs/{id}/kicad-job` with `{ job, …options }`:
//! * `downgrade` — File > Export > For Older KiCad Version... (RunExportForOlderVersion): `kicad-cli sch|pcb downgrade`
//!   of the project's root schematic or of the board, always `--force` (consent is taken from the report, as
//!   RunDowngradeJob does).  `{ target, variant?, dropApproximations?, dryRun? }`.  A dry run answers
//!   `{ report: { target, entries: [{ bucket, feature, detail, count }], blocked, lossy, text } }` (the
//!   COMPATIBILITY_REPORT, parsed from its ToText form); otherwise the exported copy: the board file, or a .zip of the
//!   schematic folder (`<stem>/…`, as the desktop writes it into the destination folder).
//! * `specctra` — File > Export > Specctra DSN... (`pcb export specctra`): the .dsn file.
//! * `gencad` — File > Export > GenCAD... (DIALOG_GENCAD_EXPORT_OPTIONS): `{ flipBottomPads, uniquePins,
//!   individualShapes, useDrillOrigin, storeOriginCoords }`; the .cad file.
//! * `idf` — File > Export > IDFv3... (DIALOG_EXPORT_IDF3): `{ units: "mm"|"mils", origin: "center"|"grid"|"drill"|"user",
//!   userOriginX, userOriginY (in the output units), noDnp, noUnspecified, explicitHeight, partNumberField }`;
//!   a .zip of the board (.emn) and library (.emp) files.
//! A failed run answers 422 `job_failed` with kicad-cli's own message; no kicad-cli answers 501 `no_kicad_cli`.

use std::path::{Path as FsPath, PathBuf};
use std::time::Duration;

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
use crate::kicad_check::{cli, path_in, safe_join, WorkDir, CHECKING};
use crate::persist;
use crate::AppState;

/// An export of a big board takes as long as its DRC.
const JOB_TIMEOUT: Duration = Duration::from_secs(300);

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/docs/{id}/kicad-job", post(job))
}

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct JobOpts {
    job: String,
    // downgrade
    #[serde(default)]
    target: String,
    #[serde(default)]
    variant: String,
    #[serde(default)]
    drop_approximations: bool,
    #[serde(default)]
    dry_run: bool,
    // gencad
    #[serde(default)]
    flip_bottom_pads: bool,
    #[serde(default)]
    unique_pins: bool,
    #[serde(default)]
    individual_shapes: bool,
    #[serde(default)]
    use_drill_origin: bool,
    #[serde(default)]
    store_origin_coords: bool,
    // idf
    #[serde(default)]
    units: String,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    user_origin_x: f64,
    #[serde(default)]
    user_origin_y: f64,
    #[serde(default)]
    no_dnp: bool,
    #[serde(default)]
    no_unspecified: bool,
    #[serde(default)]
    explicit_height: bool,
    #[serde(default)]
    part_number_field: String,
}

/// What a job writes: one file named `name`, or a folder (zipped as `name`) that kicad-cli is given as `-o`, or
/// whose file (the second name) it is given, the files it writes beside that one going into the folder too.
#[derive(Debug, PartialEq)]
enum Output {
    File(String),
    Folder(String, Option<String>),
    /// A dry run: only the compatibility report.
    Report,
}

/// A text option kicad-cli takes as one argument: no control characters, not mistaken for a flag.
fn plain(s: &str, what: &str) -> AppResult<String> {
    let t = s.trim();
    if t.len() > 200 || t.starts_with('-') || t.chars().any(char::is_control) {
        return Err(AppError::BadRequest(format!("bad {what}")));
    }
    Ok(t.to_string())
}

/// The kicad-cli arguments (before `-o <out> <input>`) and the output of `opts` for a document of `doc_type`
/// whose file stem is `stem`.
fn plan(opts: &JobOpts, doc_type: &str, stem: &str) -> AppResult<(Vec<String>, Output)> {
    let board = doc_type == "kicad_pcb";
    let need_board = || if board { Ok(()) } else { Err(AppError::BadRequest("this export needs a board".into())) };
    let mut a: Vec<String> = Vec::new();
    let out = match opts.job.as_str() {
        "downgrade" => {
            if !board && doc_type != "kicad_sch" {
                return Err(AppError::BadRequest("only a schematic or a board can be exported for an older version".into()));
            }
            a.extend([if board { "pcb" } else { "sch" }, "downgrade"].map(String::from));
            let target = plain(&opts.target, "target")?;
            if !target.is_empty() { a.extend(["--target".into(), target]); }
            let variant = plain(&opts.variant, "variant")?;
            if !variant.is_empty() { a.extend(["--variant".into(), variant]); }
            if opts.drop_approximations { a.push("--drop-approximations".into()); }
            a.push("--force".into());
            if opts.dry_run {
                a.push("--dry-run".into());
                Output::Report
            } else if board {
                Output::File(format!("{stem}.kicad_pcb"))
            } else {
                Output::Folder(stem.to_string(), None)
            }
        }
        "specctra" => {
            need_board()?;
            a.extend(["pcb", "export", "specctra"].map(String::from));
            Output::File(format!("{stem}.dsn"))
        }
        "gencad" => {
            need_board()?;
            a.extend(["pcb", "export", "gencad"].map(String::from));
            for (on, flag) in [(opts.flip_bottom_pads, "--flip-bottom-pads"), (opts.unique_pins, "--unique-pins"),
                               (opts.individual_shapes, "--unique-footprints"), (opts.use_drill_origin, "--use-drill-origin"),
                               (opts.store_origin_coords, "--store-origin-coord")] {
                if on { a.push(flag.into()); }
            }
            Output::File(format!("{stem}.cad"))
        }
        "idf" => {
            need_board()?;
            a.extend(["pcb", "export", "idf"].map(String::from));
            let units = match opts.units.as_str() { "" | "mm" => "mm", "mils" => "mils", _ => return Err(AppError::BadRequest("bad units".into())) };
            let origin = match opts.origin.as_str() { "" | "center" => "center", o @ ("grid" | "drill" | "user") => o, _ => return Err(AppError::BadRequest("bad origin".into())) };
            a.extend(["--units".into(), units.into(), "--origin".into(), origin.into()]);
            if origin == "user" {
                if !opts.user_origin_x.is_finite() || !opts.user_origin_y.is_finite() { return Err(AppError::BadRequest("bad origin".into())); }
                a.extend(["--user-origin-x".into(), opts.user_origin_x.to_string(), "--user-origin-y".into(), opts.user_origin_y.to_string()]);
            }
            if opts.no_unspecified { a.push("--no-unspecified".into()); }
            if opts.no_dnp { a.push("--no-dnp".into()); }
            if opts.explicit_height { a.push("--explicit-height".into()); }
            let field = plain(&opts.part_number_field, "part number field")?;
            if !field.is_empty() { a.extend(["--part-number-field".into(), field]); }
            // IDF_EXPORTER writes the library (.emp) beside the board file (.emn)
            Output::Folder(format!("{stem}-idf"), Some(format!("{stem}.emn")))
        }
        other => return Err(AppError::BadRequest(format!("unknown job '{other}'"))),
    };
    Ok((a, out))
}

async fn job(State(state): State<AppState>, viewer: Viewer, Path(id): Path<Uuid>, Json(opts): Json<JobOpts>) -> AppResult<Response> {
    let doc = persist::get_document(&state.pool, id).await?.ok_or(AppError::NotFound)?;
    access::resolve(&state.pool, &viewer, doc.project_id).await?.ok_or(AppError::NotFound)?;
    // a schematic export is of the whole hierarchy, from the root sheet
    let docs = persist::project_documents(&state.pool, doc.project_id).await?;
    let target = if doc.doc_type == "kicad_sch" { crate::http::root_schematic(&docs).cloned().unwrap_or(doc) } else { doc };
    let stem = target.path.rsplit('/').next().unwrap_or("").rsplit_once('.').map(|(s, _)| s).unwrap_or("export").to_string();
    let (args, output) = plan(&opts, &target.doc_type, &stem)?;
    let Some(cli) = cli() else {
        return Err(AppError::Api(StatusCode::NOT_IMPLEMENTED, "no_kicad_cli", "This server has no kicad-cli to run KiCad's exporters.".into()));
    };
    let _permit = CHECKING.acquire().await.map_err(|e| anyhow::anyhow!("job queue: {e}"))?;

    crate::compact::fold_project(&state.pool, target.project_id).await;
    let docs = persist::project_documents(&state.pool, target.project_id).await?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for d in &docs {
        if let Some((_, content)) = persist::latest_snapshot(&state.pool, d.id).await? {
            entries.push((d.path.clone(), content));
        }
    }
    entries.extend(crate::projectlibs::rebuild_symbol_libraries(&entries));
    let input = path_in(&entries, &target.path);
    let work = WorkDir(std::env::temp_dir().join(format!("junction-job-{}", Uuid::new_v4())));
    let (bytes, name) = run(&cli, &work.0, &entries, &input, args, &output, &opts.target).await?;
    match output {
        Output::Report => Ok(Json(json!({ "report": serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null) })).into_response()),
        _ => {
            let kind = if name.ends_with(".zip") { "application/zip" } else { "application/octet-stream" };
            let disposition = format!("attachment; filename=\"{}\"", name.replace(['"', '\\', '\r', '\n'], "_"));
            Ok(([(header::CONTENT_TYPE, kind.to_string()), (header::CONTENT_DISPOSITION, disposition)], bytes).into_response())
        }
    }
}

/// Write the project into `work`, run kicad-cli, and answer the output's bytes and download name (a dry run's
/// bytes are the report as JSON).
async fn run(cli: &str, work: &FsPath, entries: &[(String, Vec<u8>)], input: &str, mut args: Vec<String>, output: &Output, target: &str)
             -> AppResult<(Vec<u8>, String)> {
    let files = work.join("files");
    for (path, content) in entries {
        let Some(to) = safe_join(&files, path_in(entries, path)) else { continue };
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| anyhow::anyhow!("job folder: {e}"))?;
        }
        tokio::fs::write(&to, content).await.map_err(|e| anyhow::anyhow!("write {path}: {e}"))?;
    }
    let input = safe_join(&files, input.to_string()).ok_or_else(|| AppError::BadRequest("bad document path".into()))?;
    let home = work.join("home");
    let out_dir = work.join("out");
    tokio::fs::create_dir_all(&home).await.map_err(|e| anyhow::anyhow!("job home: {e}"))?;
    tokio::fs::create_dir_all(&out_dir).await.map_err(|e| anyhow::anyhow!("job output: {e}"))?;
    let report = work.join("report.txt");
    let downgrade = args.get(1).map(String::as_str) == Some("downgrade");
    if downgrade {
        args.extend(["--report".into(), report.to_string_lossy().into_owned()]);
    }
    // the output must not exist yet for a downgrade (ValidateFreshDowngradeOutput)
    let out_path: Option<PathBuf> = match output {
        Output::Report => None,
        Output::File(name) => Some(out_dir.join(name)),
        Output::Folder(name, None) => Some(out_dir.join(name)),
        Output::Folder(name, Some(file)) => {
            tokio::fs::create_dir_all(out_dir.join(name)).await.map_err(|e| anyhow::anyhow!("job output: {e}"))?;
            Some(out_dir.join(name).join(file))
        }
    };
    if let Some(p) = &out_path {
        args.extend(["-o".into(), p.to_string_lossy().into_owned()]);
    }
    args.push(input.to_string_lossy().into_owned());

    let mut cmd = tokio::process::Command::new(cli);
    cmd.args(args.iter())
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .current_dir(work)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let result = match tokio::time::timeout(JOB_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(AppError::Other(anyhow::anyhow!("could not run kicad-cli: {e}"))),
        Err(_) => return Err(AppError::Api(StatusCode::GATEWAY_TIMEOUT, "job_timeout", "The export took too long and was stopped.".into())),
    };
    let why = || {
        let text = String::from_utf8_lossy(&result.stderr).to_string() + &String::from_utf8_lossy(&result.stdout);
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.contains("Gtk-") && !l.contains("dbus")).collect();
        AppError::Api(StatusCode::UNPROCESSABLE_ENTITY, "job_failed", if lines.is_empty() { "kicad-cli failed".to_string() } else { lines.join("\n") })
    };
    match output {
        Output::Report => {
            let text = tokio::fs::read_to_string(&report).await.map_err(|_| why())?;
            if !result.status.success() && text.trim().is_empty() { return Err(why()); }
            let mut v = parse_report(&text);
            v["target"] = json!(target);
            Ok((v.to_string().into_bytes(), String::new()))
        }
        Output::File(name) => {
            if !result.status.success() { return Err(why()); }
            let p = out_path.as_ref().map(|p| p.to_path_buf()).unwrap_or_default();
            // a command that takes -o as a folder leaves its file inside it
            let bytes = match tokio::fs::read(&p).await {
                Ok(b) if !p.is_dir() => b,
                _ => {
                    let found = list_files(&out_dir);
                    let first = found.into_iter().next().ok_or_else(why)?;
                    tokio::fs::read(out_dir.join(&first)).await.map_err(|_| why())?
                }
            };
            Ok((bytes, name.clone()))
        }
        Output::Folder(name, _) => {
            if !result.status.success() { return Err(why()); }
            let found = list_files(&out_dir);
            if found.is_empty() { return Err(why()); }
            let mut items = Vec::new();
            for rel in found {
                let bytes = tokio::fs::read(out_dir.join(&rel)).await.map_err(|e| anyhow::anyhow!("read {rel}: {e}"))?;
                items.push((rel, bytes));
            }
            let zipped = tokio::task::spawn_blocking(move || zip_files(items)).await.map_err(|e| anyhow::anyhow!("zip task: {e}"))?
                .map_err(|e| AppError::Other(anyhow::anyhow!(e)))?;
            Ok((zipped, format!("{name}.zip")))
        }
    }
}

/// Every file under `dir`, as `/`-separated paths relative to it, sorted.
fn list_files(dir: &FsPath) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for e in read.flatten() {
            let p = e.path();
            if p.is_dir() { stack.push(p); continue; }
            if let Ok(rel) = p.strip_prefix(dir) {
                out.push(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            }
        }
    }
    out.sort();
    out
}

fn zip_files(items: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (name, content) in items {
        writer.start_file(name, opts).map_err(|e| e.to_string())?;
        writer.write_all(&content).map_err(|e| e.to_string())?;
    }
    Ok(writer.finish().map_err(|e| e.to_string())?.into_inner())
}

/// COMPATIBILITY_REPORT::ToText back into its entries: each section ("Keep: n", "Approximate: n", "Drop: n",
/// "Cannot export: n") lists "  feature (count)" rows, each optionally followed by a "    detail" line.
fn parse_report(text: &str) -> Value {
    let mut entries: Vec<Value> = Vec::new();
    let mut bucket = "";
    for line in text.lines() {
        if let Some((head, n)) = line.rsplit_once(": ") {
            if !line.starts_with(' ') && n.trim().parse::<u64>().is_ok() {
                bucket = match head { "Keep" => "keep", "Approximate" => "lower", "Drop" => "drop", "Cannot export" => "block", _ => bucket };
                continue;
            }
        }
        if bucket.is_empty() { continue; }
        if let Some(detail) = line.strip_prefix("    ") {
            if let Some(last) = entries.last_mut() { last["detail"] = json!(detail.trim_end()); }
        } else if let Some(row) = line.strip_prefix("  ") {
            let row = row.trim_end();
            let (feature, count) = match row.rsplit_once(" (") {
                Some((f, c)) if c.ends_with(')') && c[..c.len() - 1].parse::<u64>().is_ok() => (f.to_string(), c[..c.len() - 1].parse::<u64>().unwrap_or(1)),
                _ => (row.to_string(), 1),
            };
            entries.push(json!({ "bucket": bucket, "feature": feature, "detail": "", "count": count }));
        }
    }
    let has = |b: &str| entries.iter().any(|e| e["bucket"] == b);
    let (lossy, blocked) = (has("lower") || has("drop"), has("block"));
    json!({ "entries": entries, "lossy": lossy, "blocked": blocked, "text": text })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(v: Value) -> JobOpts { serde_json::from_value(v).unwrap() }

    #[test]
    fn plans_follow_the_desktop_exporters() {
        let (a, o) = plan(&opts(json!({ "job": "downgrade", "target": "KiCad 9.0", "dryRun": true })), "kicad_sch", "top").unwrap();
        assert_eq!(a, ["sch", "downgrade", "--target", "KiCad 9.0", "--force", "--dry-run"]);
        assert_eq!(o, Output::Report);
        let (a, o) = plan(&opts(json!({ "job": "downgrade", "target": "9.0", "variant": "Lite", "dropApproximations": true })), "kicad_pcb", "b").unwrap();
        assert_eq!(a, ["pcb", "downgrade", "--target", "9.0", "--variant", "Lite", "--drop-approximations", "--force"]);
        assert_eq!(o, Output::File("b.kicad_pcb".into()));
        assert_eq!(plan(&opts(json!({ "job": "downgrade" })), "kicad_sch", "top").unwrap().1, Output::Folder("top".into(), None));
        let (a, o) = plan(&opts(json!({ "job": "gencad", "flipBottomPads": true, "individualShapes": true, "storeOriginCoords": true })), "kicad_pcb", "b").unwrap();
        assert_eq!(a, ["pcb", "export", "gencad", "--flip-bottom-pads", "--unique-footprints", "--store-origin-coord"]);
        assert_eq!(o, Output::File("b.cad".into()));
        let (a, _) = plan(&opts(json!({ "job": "idf", "units": "mils", "origin": "user", "userOriginX": 1.5, "userOriginY": -2, "noDnp": true, "partNumberField": "MPN" })), "kicad_pcb", "b").unwrap();
        assert_eq!(a, ["pcb", "export", "idf", "--units", "mils", "--origin", "user", "--user-origin-x", "1.5", "--user-origin-y", "-2", "--no-dnp", "--part-number-field", "MPN"]);
        assert_eq!(plan(&opts(json!({ "job": "specctra" })), "kicad_pcb", "b").unwrap().0, ["pcb", "export", "specctra"]);
        // refused: a board export of a schematic, a flag smuggled in as a value, an unknown job
        assert!(plan(&opts(json!({ "job": "specctra" })), "kicad_sch", "t").is_err());
        assert!(plan(&opts(json!({ "job": "downgrade", "target": "--libraries=/etc" })), "kicad_pcb", "b").is_err());
        assert!(plan(&opts(json!({ "job": "idf", "origin": "moon" })), "kicad_pcb", "b").is_err());
        assert!(plan(&opts(json!({ "job": "rm" })), "kicad_pcb", "b").is_err());
    }

    #[test]
    fn the_compatibility_report_is_read_back() {
        // COMPATIBILITY_REPORT::ToText
        let text = "KiCad Compatibility Report\nTarget: KiCad 9.0\n\nCompatibility preview. This report describes planned changes.\nExport requires approval for the changes below.\n\nCounts cover reported items only.\n\nKeep: 12\n  Wires (12)\n\nApproximate: 2\n  Rounded rectangles (2)\n    Written as polygons\n\nDrop: 1\n  Net chains (1)\n\nCannot export: 0\n";
        let r = parse_report(text);
        let e = r["entries"].as_array().unwrap();
        assert_eq!(e.len(), 3);
        assert_eq!(e[1], json!({ "bucket": "lower", "feature": "Rounded rectangles", "detail": "Written as polygons", "count": 2 }));
        assert_eq!(e[2]["bucket"], "drop");
        assert_eq!(r["lossy"], true);
        assert_eq!(r["blocked"], false);
    }

    /// The files a job leaves come back zipped under their own paths; a single-file job's file comes back as it is.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_job_runs_and_answers_its_output() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("junction-job-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("kicad-cli");
        // writes the file at -o and, for idf, the library beside it
        std::fs::write(&fake, "#!/bin/sh\nout=\"\"; job=\"$3\"\nwhile [ $# -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then out=\"$2\"; fi; shift; done\nif [ \"$job\" = idf ]; then echo board > \"$out\"; echo lib > \"${out%.emn}.emp\"; else echo '(pcb dsn)' > \"$out\"; fi\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let entries = vec![("b.kicad_pcb".to_string(), b"(kicad_pcb)".to_vec())];
        let (args, out) = plan(&opts(json!({ "job": "specctra" })), "kicad_pcb", "b").unwrap();
        let work = WorkDir(dir.join("w1"));
        let (bytes, name) = run(fake.to_str().unwrap(), &work.0, &entries, "project/b.kicad_pcb", args, &out, "").await.unwrap();
        assert_eq!((String::from_utf8(bytes).unwrap().trim(), name.as_str()), ("(pcb dsn)", "b.dsn"));
        let (args, out) = plan(&opts(json!({ "job": "idf" })), "kicad_pcb", "b").unwrap();
        let work2 = WorkDir(dir.join("w2"));
        let (bytes, name) = run(fake.to_str().unwrap(), &work2.0, &entries, "project/b.kicad_pcb", args, &out, "").await.unwrap();
        assert_eq!(name, "b-idf.zip");
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        assert_eq!(names, ["b-idf/b.emn", "b-idf/b.emp"]);
        drop((work, work2));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
