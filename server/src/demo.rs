//! "Devboard Demo": the project every new account starts with, so there is a real board to tinker with on the
//! first visit.
//!
//! It is a snapshot of the Cyberboard project (github.com/notaroomba/cyberboard, hardware/): schematic, board,
//! project file, library tables and the project's own symbol, footprint and 3D model library.  The files are
//! compiled in as `seed/devboard-demo.zip`, written by `scripts/seed/devboard-demo.py`, so making a copy reads
//! nothing from GitHub.  Each account gets its own private copy, owned by it, shared with nobody.
//!
//! `users.demo_seeded` (migration 0205) makes it happen once: a new account is inserted with false, and the copy
//! is made in the same transaction that sets it to true, so a repeated or concurrent sign-in finds it done.
//! Accounts from before the migration are marked done.

use std::io::Read;

use uuid::Uuid;

use crate::http::doc_type_for;
use crate::AppState;

/// The name the project gets in the person's list.
pub const NAME: &str = "Devboard Demo";

const SEED: &[u8] = include_bytes!("../seed/devboard-demo.zip");

/// The seed's files, project-relative path and content, in archive order.
fn files() -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(SEED)).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = crate::http::safe_zip_name(f.name()).ok_or_else(|| format!("bad path {}", f.name()))?;
        let mut data = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        out.push((name, data));
    }
    Ok(out)
}

/// `fonts/<face>/<file>`: a font the design's text names by `face`, kept as the project's font rather than as a
/// project file (the web editor, its plots and the desktop fetch a face that is not installed from there).
fn font_entry(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("fonts/")?;
    let (face, file) = rest.split_once('/')?;
    (!face.is_empty() && !file.is_empty() && !file.contains('/')).then_some((face, file))
}

fn hex_sha256(data: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// Give `user_id` its Devboard Demo if it is still owed one.  Returns the new project's id, or None when the
/// account already had it (or never was owed it).  All or nothing: on any error nothing is kept and the
/// account stays owed, so the next sign-in or project list tries again.
pub async fn ensure(state: &AppState, user_id: i64) -> anyhow::Result<Option<Uuid>> {
    // Cheap check first: this runs on every project list.
    let owed: Option<bool> = sqlx::query_scalar("SELECT NOT demo_seeded FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    if owed != Some(true) {
        return Ok(None);
    }

    let files = tokio::task::spawn_blocking(files).await?.map_err(|e| anyhow::anyhow!("demo seed: {e}"))?;
    let mut tx = state.pool.begin().await?;
    // Claiming the flag locks the account's row: a second sign-in racing this one waits here, then finds
    // nothing to claim.
    let claimed = sqlx::query("UPDATE users SET demo_seeded = true WHERE id = $1 AND NOT demo_seeded")
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if claimed == 0 {
        return Ok(None);
    }
    let project = copy_into(&mut tx, user_id, &files).await?;
    tx.commit().await?;
    tracing::info!(user_id, %project, files = files.len(), "gave a new account its Devboard Demo");
    Ok(Some(project))
}

/// Make a copy of the seed owned by `user_id` inside `tx`; returns the new project's id.
async fn copy_into(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i64,
    files: &[(String, Vec<u8>)],
) -> anyhow::Result<Uuid> {
    let project: Uuid =
        sqlx::query_scalar("INSERT INTO projects (owner_id, name, public) VALUES ($1, $2, false) RETURNING id")
            .bind(user_id)
            .bind(NAME)
            .fetch_one(&mut **tx)
            .await?;
    for (path, content) in files {
        if let Some((face, file_name)) = font_entry(path) {
            let font = crate::fonts::inspect(content, 0).map_err(|e| anyhow::anyhow!("demo font {path}: {e:?}"))?;
            sqlx::query(
                "INSERT INTO project_font_files (project_id, family_key, family, bold, italic, file_name, fs_type, license, sha256, bytes, data, uploaded_by)
                 VALUES ($1, $2, $3, false, false, $4, $5, $6, $7, $8, $9, $10)",
            )
            .bind(project)
            .bind(face.to_lowercase())
            .bind(face)
            .bind(file_name)
            .bind(font.fs_type.unwrap_or(0) as i32)
            .bind(&font.license)
            .bind(hex_sha256(&font.data))
            .bind(font.data.len() as i64)
            .bind(&font.data)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
            continue;
        }
        let doc: Uuid = sqlx::query_scalar(
            "INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(project)
        .bind(path)
        .bind(doc_type_for(path))
        .fetch_one(&mut **tx)
        .await?;
        crate::persist::insert_snapshot_in(&mut **tx, doc, 0, content.as_slice(), Some(user_id)).await?;
    }
    Ok(project)
}

/// The caller's Devboard Demo: their newest project of that name, made for them first when they have none
/// (an account from before the demo, or one that deleted its copy).  The home page's "Keep going in a real
/// project" opens it.
async fn find_or_make(state: &AppState, user_id: i64) -> anyhow::Result<Uuid> {
    ensure(state, user_id).await?;
    let find = "SELECT id FROM projects WHERE owner_id = $1 AND name = $2 AND deleted_at IS NULL AND parent_id IS NULL
                ORDER BY created_at DESC LIMIT 1";
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(find).bind(user_id).bind(NAME).fetch_optional(&state.pool).await? {
        return Ok(id);
    }
    let files = tokio::task::spawn_blocking(files).await?.map_err(|e| anyhow::anyhow!("demo seed: {e}"))?;
    let mut tx = state.pool.begin().await?;
    // the account's row is the lock: two clicks at once make one copy
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(user_id).execute(&mut *tx).await?;
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(find).bind(user_id).bind(NAME).fetch_optional(&mut *tx).await? {
        return Ok(id);
    }
    let project = copy_into(&mut tx, user_id, &files).await?;
    tx.commit().await?;
    tracing::info!(user_id, %project, "made a Devboard Demo on request");
    Ok(project)
}

/// POST /api/projects/demo: `{ projectId }` of the caller's Devboard Demo (see `find_or_make`).
pub async fn open(
    axum::extract::State(state): axum::extract::State<AppState>,
    crate::auth::AuthUser(user): crate::auth::AuthUser,
) -> crate::error::AppResult<axum::Json<serde_json::Value>> {
    let id = find_or_make(&state, user.id).await?;
    Ok(axum::Json(serde_json::json!({ "projectId": id, "name": NAME })))
}

/// Reconnect affected demo copies on the server. Existing snapshots and history stay available.
pub async fn repair_split_ground(state: &AppState) -> anyhow::Result<()> {
    // A board whose newest stored file names the split net, or whose later edits do.  A file kept as a
    // blob cannot be searched in SQL, so it is read here, once per distinct file (most copies share one).
    let rows: Vec<(Uuid, Uuid, i64, Option<Vec<u8>>, bool)> = sqlx::query_as(
        "SELECT d.id, p.id, p.owner_id, s.blob,
                (COALESCE(position(convert_to($2, 'UTF8') in s.content) > 0, false) OR EXISTS (
                    SELECT 1 FROM ops o WHERE o.doc_id = d.id AND o.seq > s.seq AND o.changes::text LIKE '%/GND%'
                ))
         FROM projects p JOIN documents d ON d.project_id = p.id
         JOIN LATERAL (SELECT seq, content, blob FROM snapshots WHERE doc_id = d.id ORDER BY seq DESC LIMIT 1) s ON true
         WHERE p.name = $1 AND p.deleted_at IS NULL AND d.path = 'Devboard_Demo.kicad_pcb'
           AND d.doc_type = 'kicad_pcb'",
    )
    .bind(NAME)
    .bind("\"/GND\"")
    .fetch_all(&state.pool)
    .await?;
    let mut named: std::collections::HashMap<Vec<u8>, bool> = std::collections::HashMap::new();
    let mut candidates: Vec<(Uuid, Uuid, i64)> = Vec::new();
    for (board, project, owner, blob, mut hit) in rows {
        if let (false, Some(hash)) = (hit, blob) {
            hit = match named.get(&hash) {
                Some(known) => *known,
                None => {
                    const NEEDLE: &[u8] = b"\"/GND\"";
                    let file = crate::persist::snapshot_bytes(&state.pool, board, crate::persist::Which::Newest).await?;
                    let found = file.is_some_and(|(_, bytes)| bytes.windows(NEEDLE.len()).any(|w| w == NEEDLE));
                    named.insert(hash, found);
                    found
                }
            };
        }
        if hit {
            candidates.push((board, project, owner));
        }
    }

    let count = candidates.len();
    let mut repaired = 0;
    let mut failed = 0;
    for (board, project, owner) in candidates {
        match repair_board(state, board, project, owner).await {
            Ok(true) => repaired += 1,
            Ok(false) => {}
            Err(error) => {
                failed += 1;
                tracing::warn!("Devboard Demo ground repair skipped a board: {error}");
            }
        }
    }
    tracing::info!(count, repaired, failed, "Devboard Demo ground scan complete");
    Ok(())
}

async fn repair_board(state: &AppState, board: Uuid, project: Uuid, owner: i64) -> anyhow::Result<bool> {
    use crate::{compact, persist, versions};
    let pool = &state.pool;
    let docs = persist::project_documents(pool, project).await?;
    let Some(pcb) = docs.iter().find(|doc| doc.id == board) else { return Ok(false) };
    let mut sheets = docs.iter().filter(|doc| doc.doc_type == "kicad_sch");
    let Some(sch) = sheets.next().filter(|doc| doc.path == "Devboard_Demo.kicad_sch") else { return Ok(false) };
    if sheets.next().is_some() { return Ok(false) }
    for doc in [pcb, sch] {
        compact::fold(pool, doc).await.map_err(anyhow::Error::msg)?;
    }
    let Some((board_seq, board_bytes)) = persist::latest_snapshot(pool, board).await? else { return Ok(false) };
    let Some((sch_seq, sch_bytes)) = persist::latest_snapshot(pool, sch.id).await? else { return Ok(false) };
    if persist::head_seq(pool, sch.id).await? != sch_seq || persist::head_seq(pool, board).await? != board_seq {
        anyhow::bail!("A document changed during the scan");
    }
    let project_file = if let Some(pro) = docs.iter().find(|doc| doc.path == "Devboard_Demo.kicad_pro") {
        persist::latest_snapshot(pool, pro.id).await?.map(|(_, bytes)| String::from_utf8(bytes)).transpose()?.unwrap_or_default()
    } else { String::new() };
    let req = serde_json::json!({
        "base": "", "token": "", "agent": "", "canWrite": false,
        "user": { "id": 0, "login": "", "name": "" }, "project": null, "tool": "repair_demo_ground",
        "args": { "board": String::from_utf8(board_bytes)?, "schematic": String::from_utf8(sch_bytes)?, "projectFile": project_file },
    });
    let reply = crate::mcp::hosts().call(i64::MIN + 1, req, std::time::Duration::from_secs(60)).await
        .map_err(anyhow::Error::msg)?;
    if reply["ok"] != true { anyhow::bail!("Could not verify the corrected copper") }
    let Some(content) = reply["result"]["text"].as_str() else { return Ok(false) };
    if persist::head_seq(pool, sch.id).await? != sch_seq { anyhow::bail!("The schematic changed during the repair") }
    if !versions::reset_to_content_if_unchanged(state, owner, board, content.as_bytes(), board_seq).await
        .map_err(|_| anyhow::anyhow!("Could not save the approved board repair"))? {
        anyhow::bail!("The board changed during the repair");
    }
    Ok(true)
}

/// `ensure`, with a failure logged instead of returned: a missing demo must never stop a sign-in or a list.
pub async fn ensure_quietly(state: &AppState, user_id: i64) {
    if let Err(e) = ensure(state, user_id).await {
        tracing::warn!(user_id, "Devboard Demo not made: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seed_is_a_whole_kicad_project_with_its_libraries_and_models() {
        let files = files().expect("seed unpacks");
        let names: std::collections::HashSet<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        for need in ["Devboard_Demo.kicad_pro", "Devboard_Demo.kicad_sch", "Devboard_Demo.kicad_pcb",
                     "sym-lib-table", "fp-lib-table", "lib/lcsc.kicad_sym"] {
            assert!(names.contains(need), "{need} missing");
        }
        assert!(files.iter().any(|(n, _)| n.starts_with("lib/lcsc.pretty/") && n.ends_with(".kicad_mod")));
        let text = |n: &str| String::from_utf8(files.iter().find(|(p, _)| p == n).unwrap().1.clone()).unwrap();
        let pcb = text("Devboard_Demo.kicad_pcb");
        // every model the board names inside the project is in the seed
        let mut models = 0;
        for line in pcb.lines() {
            if let Some(rest) = line.trim().strip_prefix("(model \"${KIPRJMOD}/") {
                let path = rest.split('"').next().unwrap();
                assert!(names.contains(path), "board names {path}, which the seed lacks");
                let step = path.rsplit_once('.').unwrap().0.to_string() + ".step";
                assert!(names.contains(step.as_str()), "{step} missing (the web 3D view reads STEP)");
                models += 1;
            }
            assert!(!line.contains("(model \"/"), "an absolute model path is left: {line}");
        }
        assert!(models >= 14, "only {models} project models on the board");
        assert!(!pcb.contains("(sheetfile \"Cyberboard"));
        assert!(!text("Devboard_Demo.kicad_sch").contains("(project \"Cyberboard\""));
        assert!(text("Devboard_Demo.kicad_pro").contains("\"filename\": \"Devboard_Demo.kicad_pro\""));
        // the two faces the text uses travel with the project, and their licences let them
        let pcb_sch = pcb.clone() + &text("Devboard_Demo.kicad_sch");
        let fonts: Vec<_> = files.iter().filter_map(|(n, d)| font_entry(n).map(|(face, _)| (face, d))).collect();
        assert_eq!(fonts.len(), 2);
        for (face, data) in fonts {
            assert!(pcb_sch.contains(&format!("(face \"{face}\")")), "{face} is not used");
            let f = crate::fonts::inspect(data, 0).expect("a font");
            assert!(crate::fonts::may_embed(f.fs_type), "{face} may not be embedded: fsType {:?}", f.fs_type);
        }
        for (n, _) in files.iter().filter(|(n, _)| font_entry(n).is_none()) {
            assert_ne!(doc_type_for(n), "other", "{n} would not be stored as a project file");
        }
    }
}
