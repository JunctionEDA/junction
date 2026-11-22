//! Stored files, kept once and small (migration 0260).
//!
//! A snapshot points at a blob named by the SHA-256 of the file it stands for, so the same file under many
//! snapshots (a copy, a clone, a branch, every account's Devboard Demo) is stored once.  A blob holds the
//! file zstd-compressed, either whole or as a difference from another blob of the same document (the file
//! a few edits earlier), which for a board that changed a little is a few kilobytes instead of megabytes.
//! A difference is always against a whole blob, never against another difference, so any file is read back
//! from at most two rows.
//!
//! Every blob is decoded and compared with the file before it is written; a file that does not come back
//! byte for byte is stored whole.  Nothing here changes a file's bytes.

use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;
use zstd::zstd_safe::{self, CCtx, CParameter, DCtx, DParameter};

pub const WHOLE: i16 = 1;
pub const DELTA: i16 = 2;

/// A difference is only tried against a base up to this size: both files sit in memory while it is made.
const MAX_DELTA_BASE: usize = 192 << 20;

/// The joins that bring a snapshot's stored bytes along: `s` is the snapshots row.
pub const JOIN: &str = " LEFT JOIN blobs b ON b.hash = s.blob LEFT JOIN blobs bb ON bb.hash = b.base ";
/// The columns `content_of` reads, for a query that uses `JOIN`.
pub const COLS: &str = " s.content, b.enc AS blob_enc, b.size AS blob_size, b.data AS blob_data, bb.data AS blob_base, bb.size AS blob_base_size ";

pub fn hash(content: &[u8]) -> Vec<u8> {
    Sha256::digest(content).to_vec()
}

fn zerr(code: usize) -> String {
    zstd_safe::get_error_name(code).to_string()
}

fn level_for(len: usize) -> i32 {
    // the strongest setting takes about a second per 3 MB; large boards get a quicker one
    if len <= 8 << 20 { 19 } else { 12 }
}

fn window_log(total: usize) -> u32 {
    (usize::BITS - total.max(1).leading_zeros()).clamp(20, 31)
}

fn compress(content: &[u8], prefix: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut cctx = CCtx::create();
    cctx.set_parameter(CParameter::CompressionLevel(level_for(content.len()))).map_err(zerr)?;
    cctx.set_parameter(CParameter::ContentSizeFlag(true)).map_err(zerr)?;
    if let Some(prefix) = prefix {
        // the whole base must stay in reach, so the window covers both files
        cctx.set_parameter(CParameter::WindowLog(window_log(prefix.len() + content.len()))).map_err(zerr)?;
        cctx.set_parameter(CParameter::EnableLongDistanceMatching(true)).map_err(zerr)?;
        cctx.ref_prefix(prefix).map_err(zerr)?;
    }
    let mut out: Vec<u8> = Vec::with_capacity(zstd_safe::compress_bound(content.len()));
    cctx.compress2(&mut out, content).map_err(zerr)?;
    Ok(out)
}

/// The file a blob stands for.  `base` is the whole file of the blob a difference was made against.
pub fn decode(enc: i16, size: usize, data: &[u8], base: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let mut dctx = DCtx::create();
    dctx.set_parameter(DParameter::WindowLogMax(31)).map_err(zerr)?;
    match (enc, base) {
        (WHOLE, _) => {}
        (DELTA, Some(base)) => {
            dctx.ref_prefix(base).map_err(zerr)?;
        }
        (DELTA, None) => return Err("a stored difference has lost its base".into()),
        _ => return Err(format!("unknown blob encoding {enc}")),
    }
    let mut out: Vec<u8> = Vec::with_capacity(size);
    dctx.decompress(&mut out, data).map_err(zerr)?;
    if out.len() != size {
        return Err(format!("a stored file came back {} bytes long, not {size}", out.len()));
    }
    Ok(out)
}

/// Compress `content`, as a difference from `base` when that is clearly the smaller, and prove the result
/// reads back as `content`.  Returns the encoding and the bytes to store.
pub fn encode(content: &[u8], base: Option<&[u8]>) -> Result<(i16, Vec<u8>), String> {
    let mut picked: Option<(i16, Vec<u8>)> = None;
    if let Some(base) = base.filter(|b| !b.is_empty() && b.len() <= MAX_DELTA_BASE && content.len() <= MAX_DELTA_BASE) {
        if let Ok(delta) = compress(content, Some(base)) {
            // A hundredth of the file is far below what compression alone reaches.  Past that the file has
            // drifted from its base: once a difference is over an eighth of the compressed file, the file
            // is stored whole and becomes the base of the ones after it.
            let small = delta.len() <= content.len() / 100;
            let whole = if small { None } else { Some(compress(content, None)?) };
            let wins = whole.as_ref().map_or(true, |w| delta.len() <= w.len() / 8);
            if wins && decode(DELTA, content.len(), &delta, Some(base)).ok().as_deref() == Some(content) {
                picked = Some((DELTA, delta));
            } else if let Some(whole) = whole {
                picked = Some((WHOLE, whole));
            }
        }
    }
    let (enc, data) = match picked {
        Some(p) => p,
        None => (WHOLE, compress(content, None)?),
    };
    if enc == WHOLE && decode(WHOLE, content.len(), &data, None)?.as_slice() != content {
        return Err("a compressed file did not read back the same".into());
    }
    Ok((enc, data))
}

const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// A picture or other text the server alone reads back (a board preview), compressed when that helps.
/// Never used for something that itself could start with zstd's four magic bytes.
pub fn pack(bytes: &[u8]) -> Vec<u8> {
    if bytes.starts_with(&ZSTD_MAGIC) {
        return bytes.to_vec();
    }
    match compress(bytes, None) {
        Ok(z) if z.len() < bytes.len() && decode(WHOLE, bytes.len(), &z, None).ok().as_deref() == Some(bytes) => z,
        _ => bytes.to_vec(),
    }
}

/// What `pack` was given; bytes stored before packing existed come back as they are.
pub fn unpack(stored: Vec<u8>) -> Vec<u8> {
    if !stored.starts_with(&ZSTD_MAGIC) {
        return stored;
    }
    let size = zstd_safe::get_frame_content_size(&stored).ok().flatten();
    match size.map(|n| decode(WHOLE, n as usize, &stored, None)) {
        Some(Ok(bytes)) => bytes,
        _ => stored,
    }
}

fn db_err(e: String) -> sqlx::Error {
    sqlx::Error::Protocol(e)
}

/// The stored bytes of a row selected with `COLS`: the old whole-file column, or the blob.
pub fn content_of(row: &sqlx::postgres::PgRow) -> sqlx::Result<Vec<u8>> {
    if let Some(content) = row.try_get::<Option<Vec<u8>>, _>("content")? {
        return Ok(content);
    }
    let enc: Option<i16> = row.try_get("blob_enc")?;
    let Some(enc) = enc else { return Err(db_err("a snapshot has neither a file nor a blob".into())) };
    let size: i64 = row.try_get("blob_size")?;
    let data: Vec<u8> = row.try_get("blob_data")?;
    let base: Option<Vec<u8>> = row.try_get("blob_base")?;
    let base = match base {
        Some(b) => Some(decode(WHOLE, row.try_get::<i64, _>("blob_base_size")? as usize, &b, None).map_err(db_err)?),
        None => None,
    };
    decode(enc, size as usize, &data, base.as_deref()).map_err(db_err)
}

/// The file behind a blob.
pub async fn get(conn: &mut PgConnection, hash: &[u8]) -> sqlx::Result<Option<Vec<u8>>> {
    let row = sqlx::query(
        "SELECT NULL::bytea AS content, b.enc AS blob_enc, b.size AS blob_size, b.data AS blob_data, bb.data AS blob_base,
                bb.size AS blob_base_size
         FROM blobs b LEFT JOIN blobs bb ON bb.hash = b.base WHERE b.hash = $1",
    )
    .bind(hash)
    .fetch_optional(&mut *conn)
    .await?;
    row.map(|r| content_of(&r)).transpose()
}

/// Store `content` and return the hash a snapshot row points at.  `near` is the document the file belongs
/// to: its newest stored file is what a difference is made against.  Call inside the transaction that
/// writes the snapshot row, so the blob cannot be swept away in between.
pub async fn put(conn: &mut PgConnection, content: &[u8], near: Option<Uuid>) -> sqlx::Result<Vec<u8>> {
    let hash = hash(content);
    // already stored: keep it (and hold it against the sweep until this transaction ends)
    let kept = sqlx::query("UPDATE blobs SET created_at = now() WHERE hash = $1")
        .bind(&hash)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if kept > 0 {
        return Ok(hash);
    }
    // the whole blob the document's newest file is, or is a difference from
    let mut base: Option<(Vec<u8>, Vec<u8>)> = None;
    if let Some(doc) = near {
        let base_hash: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT COALESCE(b.base, b.hash) FROM snapshots s JOIN blobs b ON b.hash = s.blob
             WHERE s.doc_id = $1 ORDER BY s.seq DESC LIMIT 1",
        )
        .bind(doc)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some(h) = base_hash {
            let row = sqlx::query("SELECT size, data FROM blobs WHERE hash = $1 AND enc = 1 AND size <= $2")
                .bind(&h)
                .bind(MAX_DELTA_BASE as i64)
                .fetch_optional(&mut *conn)
                .await?;
            if let Some(row) = row {
                let (size, data): (i64, Vec<u8>) = (row.get("size"), row.get("data"));
                if let Ok(bytes) = decode(WHOLE, size as usize, &data, None) {
                    base = Some((h, bytes));
                }
            }
        }
    }
    let owned = content.to_vec();
    let (enc, data, base_hash) = tokio::task::spawn_blocking(move || {
        let (enc, data) = encode(&owned, base.as_ref().map(|(_, b)| b.as_slice()))?;
        Ok::<_, String>((enc, data, base.map(|(h, _)| h).filter(|_| enc == DELTA)))
    })
    .await
    .map_err(|e| db_err(e.to_string()))?
    .map_err(db_err)?;
    sqlx::query(
        "INSERT INTO blobs (hash, size, enc, base, data) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (hash) DO UPDATE SET created_at = now()",
    )
    .bind(&hash)
    .bind(content.len() as i64)
    .bind(enc)
    .bind(base_hash)
    .bind(&data)
    .execute(&mut *conn)
    .await?;
    Ok(hash)
}

/// Blobs no snapshot points at any more (pruned history, deleted projects), once they are a day old and
/// nothing is stored as a difference from them.
pub async fn sweep(pool: &PgPool) -> sqlx::Result<u64> {
    let mut gone = 0;
    // a difference goes first, then the base it alone was holding
    for _ in 0..2 {
        gone += sqlx::query(
            "DELETE FROM blobs b WHERE b.created_at < now() - interval '1 day'
               AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.blob = b.hash)
               AND NOT EXISTS (SELECT 1 FROM blobs d WHERE d.base = b.hash)",
        )
        .execute(pool)
        .await?
        .rows_affected();
    }
    Ok(gone)
}

/// How far the move of old whole-file rows has come.
pub async fn status(pool: &PgPool) -> sqlx::Result<serde_json::Value> {
    let row = sqlx::query(
        "SELECT (SELECT count(*) FROM snapshots WHERE content IS NOT NULL)
                 + (SELECT count(*) FROM doc_previews WHERE substring(svg from 1 for 4) <> '\\x28b52ffd'::bytea) AS waiting,
                (SELECT count(*) FROM snapshots WHERE blob IS NOT NULL) AS moved,
                (SELECT count(*) FROM blobs) AS blobs,
                (SELECT count(*) FROM blobs WHERE enc = 2) AS deltas,
                (SELECT COALESCE(sum(octet_length(data)), 0)::bigint FROM blobs) AS stored,
                (SELECT COALESCE(sum(size), 0)::bigint FROM snapshots WHERE blob IS NOT NULL) AS stands_for",
    )
    .fetch_one(pool)
    .await?;
    Ok(serde_json::json!({
        "waiting": row.get::<i64, _>("waiting"), "moved": row.get::<i64, _>("moved"),
        "blobs": row.get::<i64, _>("blobs"), "deltas": row.get::<i64, _>("deltas"),
        "storedBytes": row.get::<i64, _>("stored"), "fileBytes": row.get::<i64, _>("stands_for"),
        "running": RUNNING.load(std::sync::atomic::Ordering::Relaxed),
    }))
}

static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Move every snapshot that still carries its whole file over to a blob, oldest first within a document
/// so later files become differences.  Each row is its own transaction: the blob is written, read back
/// from the database and compared with the old column byte for byte, and only then is the old column
/// cleared.  A row that fails is left exactly as it was.  Safe to stop and start again.
pub async fn compact(pool: &PgPool) -> sqlx::Result<(u64, u64)> {
    use std::sync::atomic::Ordering;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok((0, 0));
    }
    let result = compact_rows(pool).await;
    RUNNING.store(false, Ordering::SeqCst);
    let (moved, failed) = result?;
    // hand the freed pages back to the system; these tables are small once their bulk is gone
    for table in ["snapshots", "doc_previews", "mcp_changes"] {
        if let Err(e) = sqlx::query(&format!("VACUUM FULL {table}")).execute(pool).await {
            tracing::warn!("{table} could not be vacuumed after the move: {e}");
        }
    }
    tracing::info!(moved, failed, "stored files moved to blobs");
    Ok((moved, failed))
}

async fn compact_rows(pool: &PgPool) -> sqlx::Result<(u64, u64)> {
    let rows: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT doc_id, seq FROM snapshots WHERE content IS NOT NULL ORDER BY doc_id, seq")
            .fetch_all(pool)
            .await?;
    let (mut moved, mut failed) = (0u64, 0u64);
    for (doc, seq) in rows {
        match compact_row(pool, doc, seq).await {
            Ok(true) => moved += 1,
            Ok(false) => {}
            Err(e) => {
                failed += 1;
                tracing::warn!("snapshot {doc} seq {seq} stays as a whole file: {e}");
            }
        }
    }
    // previews stored before they were packed
    let previews: Vec<(Uuid, bool)> =
        sqlx::query_as("SELECT doc_id, fit FROM doc_previews WHERE substring(svg from 1 for 4) <> $1")
            .bind(&ZSTD_MAGIC[..])
            .fetch_all(pool)
            .await?;
    for (doc, fit) in previews {
        let mut tx = pool.begin().await?;
        let svg: Option<Vec<u8>> = sqlx::query_scalar("SELECT svg FROM doc_previews WHERE doc_id = $1 AND fit = $2 FOR UPDATE")
            .bind(doc)
            .bind(fit)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(svg) = svg else { continue };
        let packed = tokio::task::spawn_blocking(move || {
            let packed = pack(&svg);
            (unpack(packed.clone()) == svg && packed.len() < svg.len()).then_some(packed)
        })
        .await
        .ok()
        .flatten();
        if let Some(packed) = packed {
            sqlx::query("UPDATE doc_previews SET svg = $3 WHERE doc_id = $1 AND fit = $2")
                .bind(doc)
                .bind(fit)
                .bind(&packed)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
        }
    }
    crate::mcp::trim_undo(pool).await?;
    Ok((moved, failed))
}

async fn compact_row(pool: &PgPool, doc: Uuid, seq: i64) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;
    let content: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT content FROM snapshots WHERE doc_id = $1 AND seq = $2 FOR UPDATE")
            .bind(doc)
            .bind(seq)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
    let Some(content) = content else { return Ok(false) };
    // rows go oldest first, so the document's newest blob is the row just before this one
    let hash = put(&mut tx, &content, Some(doc)).await?;
    let back = get(&mut tx, &hash).await?;
    if back.as_deref() != Some(content.as_slice()) {
        return Err(db_err("the blob did not read back as the stored file".into()));
    }
    sqlx::query("UPDATE snapshots SET blob = $3, size = $4, content = NULL WHERE doc_id = $1 AND seq = $2")
        .bind(doc)
        .bind(seq)
        .bind(&hash)
        .bind(content.len() as i64)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// The way back: every snapshot gets its whole file in the old column again (blobs stay).  For a rollback
/// to a server from before blobs.
pub async fn expand(pool: &PgPool) -> sqlx::Result<u64> {
    use std::sync::atomic::Ordering;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(0);
    }
    let result = expand_rows(pool).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn expand_rows(pool: &PgPool) -> sqlx::Result<u64> {
    let rows: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT doc_id, seq FROM snapshots WHERE content IS NULL ORDER BY doc_id, seq")
            .fetch_all(pool)
            .await?;
    let mut done = 0;
    for (doc, seq) in rows {
        let mut tx = pool.begin().await?;
        let hash: Option<Vec<u8>> = sqlx::query_scalar("SELECT blob FROM snapshots WHERE doc_id = $1 AND seq = $2 FOR UPDATE")
            .bind(doc)
            .bind(seq)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
        let Some(hash) = hash else { continue };
        let Some(content) = get(&mut tx, &hash).await? else { continue };
        if self::hash(&content) != hash {
            tracing::error!("blob of snapshot {doc} seq {seq} does not match its hash; left alone");
            continue;
        }
        sqlx::query("UPDATE snapshots SET content = $3 WHERE doc_id = $1 AND seq = $2")
            .bind(doc)
            .bind(seq)
            .bind(&content)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        done += 1;
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(n: usize, moved: usize) -> Vec<u8> {
        let mut s = String::from("(kicad_pcb (version 20241229) (generator \"pcbnew\")\n");
        for i in 0..n {
            let x = if i == moved { 999.5 } else { i as f64 * 1.27 };
            s.push_str(&format!("  (footprint \"R_0402\" (layer \"F.Cu\") (uuid \"{:08x}-0000-4000-8000-{:012x}\") (at {x} {}))\n", i * 7919, i * 104729, i % 50));
        }
        s.push_str(")\n");
        s.into_bytes()
    }

    #[test]
    fn a_whole_file_reads_back() {
        let a = board(4000, usize::MAX);
        let (enc, data) = encode(&a, None).unwrap();
        assert_eq!(enc, WHOLE);
        assert!(data.len() < a.len() / 3);
        assert_eq!(decode(enc, a.len(), &data, None).unwrap(), a);
    }

    #[test]
    fn a_small_edit_is_stored_as_a_small_difference() {
        let a = board(4000, usize::MAX);
        let b = board(4000, 1234);
        let (enc, data) = encode(&b, Some(&a)).unwrap();
        assert_eq!(enc, DELTA);
        assert!(data.len() < 400, "difference is {} bytes", data.len());
        assert_eq!(decode(enc, b.len(), &data, Some(&a)).unwrap(), b);
        assert!(decode(enc, b.len(), &data, None).is_err());
    }

    #[test]
    fn an_unrelated_file_is_stored_whole() {
        let a = board(4000, usize::MAX);
        let other: Vec<u8> = (0..200_000u32).flat_map(|i| i.wrapping_mul(2654435761).to_le_bytes()).collect();
        let (enc, data) = encode(&other, Some(&a)).unwrap();
        assert_eq!(enc, WHOLE);
        assert_eq!(decode(enc, other.len(), &data, None).unwrap(), other);
    }

    #[test]
    fn a_packed_picture_unpacks_and_old_bytes_pass_through() {
        let svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{}</svg>", "<path d=\"M0 0L10 10\"/>".repeat(500)).into_bytes();
        let packed = pack(&svg);
        assert!(packed.len() < svg.len() / 10);
        assert_eq!(unpack(packed), svg);
        assert_eq!(unpack(svg.clone()), svg);
        assert_eq!(unpack(pack(b"")), b"");
    }

    #[test]
    fn empty_and_tiny_files() {
        for f in [&b""[..], b"x", b"{}"] {
            let (enc, data) = encode(f, Some(b"")).unwrap();
            assert_eq!(decode(enc, f.len(), &data, None).unwrap(), f);
        }
    }

    #[test]
    fn a_wrong_size_or_broken_blob_is_an_error_not_a_file() {
        let a = board(100, usize::MAX);
        let (enc, mut data) = encode(&a, None).unwrap();
        assert!(decode(enc, a.len() + 1, &data, None).is_err());
        let mid = data.len() / 2;
        data[mid] ^= 0xff;
        assert_ne!(decode(enc, a.len(), &data, None).ok(), Some(a));
    }
}
