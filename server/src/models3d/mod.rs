//! 3D models from suppliers and libraries, for assemblies: the mechanical twin of `parts`.
//!
//! A person types a supplier's part number (McMaster-Carr 91251A431), an LCSC number, the name
//! of a KiCad package, or simply a size ("M5x20 socket head"), sees what matches and places it in
//! an assembly.  Every source is a `Provider`: `search(query)` lists what it has, `fetch(id)`
//! brings one model — a STEP file, or a part studio for the parts Junction draws itself.
//!
//!   standard    — standard hardware drawn from its standard's dimensions (standard.rs).  No
//!                 network, no credentials: screws, nuts, washers, pins, bearings, extrusions.
//!   mcmaster    — McMaster-Carr, through their Product Information API, which needs an approved
//!                 account and a client certificate (mcmaster.rs).  Their website is not read.
//!                 Without credentials a part number of a known hardware family, typed with its
//!                 size, is answered with the generated equivalent and says so.
//!   lcsc        — LCSC / JLCPCB electronic parts: the STEP model EasyEDA publishes for the part,
//!                 through `parts` (the same cache the board editor uses).
//!   kicad       — KiCad's packages3D library, through `kicadlib`.
//!   freecad     — the FreeCAD parts library (github.com/FreeCAD/FreeCAD-library, CC BY 3.0).
//!   traceparts  — TraceParts' CAD-content API.  Needs a tenant id, an API key and an e-mail.
//!   library     — a catalogue of your own: any web folder with an `index.json` (sources.rs).
//!
//! A provider without credentials is listed as not configured, not as an error.  Fetched STEP
//! files are kept in `part_models`, beside the vendor models of electronic parts, so a model is
//! fetched once however many projects place it.  Every base URL can be set from the environment,
//! which is how the tests run against a local stand-in (scripts/fake-vendors.mjs).
//!
//! - `GET /api/models3d/providers` — the providers, and which are configured.
//! - `GET /api/models3d/search?q=WORDS[&provider=ID]` — matching models from every provider.
//! - `GET /api/models3d/model?provider=ID&id=ID` — one model's file (`X-Model-Format`: step or jpart).
//! - `GET /api/models3d/image?provider=ID&id=ID` — a supplier's picture of the part, when it has one.

pub mod mcmaster;
pub mod sources;
pub mod standard;

use std::sync::OnceLock;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::parts::vendors::{ErrKind, VendorErr};
use crate::persist;
use crate::AppState;

pub type MResult<T> = Result<T, VendorErr>;

/// The largest model kept or passed on.
pub const MAX_MODEL_BYTES: usize = 40 * 1024 * 1024;

/// Who is asking: the server's state, and the person (an electronic vendor is asked with their keys).
pub struct Cx<'a> {
    pub state: &'a AppState,
    pub user_id: i64,
}

/// One model a provider offers.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ModelHit {
    pub provider: String,
    /// the supplier as a person names it: "McMaster-Carr"
    pub supplier: String,
    /// what `fetch` takes
    pub id: String,
    pub part_number: String,
    /// the part's name in a bill of materials: the supplier and its part number
    pub title: String,
    pub description: String,
    /// "step", "jpart" (a part studio Junction draws), or "" when there is nothing to place
    pub format: String,
    /// the supplier's page of the part
    pub url: String,
    /// a picture: a path of this server
    #[serde(skip_serializing_if = "String::is_empty")]
    pub image: String,
    /// the part's outline as an SVG path, for parts Junction draws: `{ d, box }`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<Value>,
    /// the part's bounding box in millimetres, when it is known before the model is fetched
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    /// drawn by Junction from a standard's dimensions, not the supplier's own file
    pub generated: bool,
    /// stands in for a supplier's part: the same standard part, not their model
    pub equivalent: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub license: String,
    /// a search to try instead, when this row cannot be placed as it is
    #[serde(skip_serializing_if = "String::is_empty")]
    pub hint: String,
}

/// A fetched model.
pub struct Model {
    /// "step" or "jpart"
    pub format: &'static str,
    pub bytes: Vec<u8>,
    /// a file name without its extension
    pub name: String,
}

pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// One sentence on what it has.
    fn note(&self) -> &'static str;
    /// The environment variables that connect it; empty when it needs none.
    fn needs(&self) -> &'static [&'static str] { &[] }
    /// Where its credentials are asked for.
    fn signup(&self) -> &'static str { "" }
    fn configured(&self) -> bool { true }
    /// Whether `fetch` goes to the network and its answer should be kept here (a provider with a
    /// store of its own says no).
    fn keeps(&self) -> bool { false }
    /// What matches.  A provider that is not configured answers with nothing (or with what it can say without).
    fn search<'a>(&'a self, cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>>;
    fn fetch<'a>(&'a self, cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>>;
    /// A picture of the part: its media type and bytes.
    fn image<'a>(&'a self, _cx: &'a Cx<'a>, _id: &'a str) -> BoxFuture<'a, MResult<(String, Vec<u8>)>> {
        Box::pin(async { Err(VendorErr::new(ErrKind::NotFound, "No picture.")) })
    }
}

/// Every provider, in the order their results are listed.
pub fn providers() -> &'static [Box<dyn Provider>] {
    static ALL: OnceLock<Vec<Box<dyn Provider>>> = OnceLock::new();
    ALL.get_or_init(|| {
        vec![
            Box::new(mcmaster::McMaster),
            Box::new(Standard),
            Box::new(sources::Lcsc),
            Box::new(sources::Kicad),
            Box::new(sources::FreeCad),
            Box::new(sources::TraceParts),
            Box::new(sources::Library),
        ]
    })
}

fn provider(id: &str) -> AppResult<&'static dyn Provider> {
    providers().iter().map(|p| p.as_ref()).find(|p| p.id() == id).ok_or_else(|| AppError::BadRequest(format!("unknown provider \"{id}\"")))
}

pub(crate) fn env_url(name: &str, default: &str) -> String {
    std::env::var(name).ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default.into())
}
pub(crate) fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub(crate) fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| reqwest::Client::builder().user_agent("junction-models3d/1.0").timeout(Duration::from_secs(40)).connect_timeout(Duration::from_secs(8)).build().expect("http client"))
}

/// A path segment or query value, percent-encoded.
pub(crate) fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"_-.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// A STEP file, or the reason it is not one (a sign-in page, an error page, something too large).
pub(crate) fn check_step(what: &str, bytes: Vec<u8>) -> MResult<Vec<u8>> {
    if bytes.len() > MAX_MODEL_BYTES { return Err(VendorErr::new(ErrKind::Other, format!("{what}'s model is too large to place ({} MB).", bytes.len() / 1024 / 1024))); }
    if !bytes.starts_with(b"ISO-10303-21") { return Err(VendorErr::new(ErrKind::NotFound, format!("{what} did not answer with a STEP file."))); }
    Ok(bytes)
}

/// The bytes at `url`, when the answer is a success.
pub(crate) async fn download(what: &str, req: reqwest::RequestBuilder) -> MResult<Vec<u8>> {
    let resp = req.send().await.map_err(|e| VendorErr::net(what, e))?;
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { return Err(VendorErr::new(ErrKind::Rejected, format!("{what} refused the request ({}).", status.as_u16()))); }
    if !status.is_success() {
        return Err(VendorErr::new(if status.is_server_error() { ErrKind::Unreachable } else { ErrKind::NotFound }, format!("{what} has no such model ({}).", status.as_u16())));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_MODEL_BYTES) { return Err(VendorErr::new(ErrKind::Other, format!("{what}'s model is too large to place."))); }
    Ok(resp.bytes().await.map_err(|e| VendorErr::net(what, e))?.to_vec())
}

/// A provider that goes through `parts` or `kicadlib` gets their errors as its own.
pub(crate) fn from_app(e: AppError) -> VendorErr {
    match e {
        AppError::NotFound => VendorErr::new(ErrKind::NotFound, "There is no such model."),
        AppError::Api(_, code, message) => VendorErr::new(
            match code { "part_not_found" => ErrKind::NotFound, "vendor_not_configured" => ErrKind::NotConfigured, "vendor_rejected_key" => ErrKind::Rejected, "vendor_unreachable" | "kicad_libs_unreachable" => ErrKind::Unreachable, _ => ErrKind::Other },
            message,
        ),
        AppError::BadRequest(message) => VendorErr::new(ErrKind::NotFound, message),
        other => VendorErr::new(ErrKind::Other, other.to_string()),
    }
}

/// A McMaster-Carr part number in a query: four or five digits, a letter, up to four digits ("91251A431").
pub fn mcmaster_number(q: &str) -> Option<String> {
    q.split(|c: char| !c.is_ascii_alphanumeric()).map(|t| t.to_ascii_uppercase()).find(|t| {
        let b = t.as_bytes();
        let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
        (4..=5).contains(&digits) && b.len() > digits + 1 && b.len() <= digits + 5 && b[digits].is_ascii_uppercase() && b[digits + 1..].iter().all(|c| c.is_ascii_digit())
    })
}

// ------------------------------------------------------------------ the standard parts, as a provider

pub struct Standard;

pub(crate) fn standard_hit(spec: &standard::Spec) -> ModelHit {
    ModelHit {
        provider: "standard".into(),
        supplier: "Standard part".into(),
        id: spec.id(),
        part_number: spec.part_number(),
        title: spec.part_number(),
        description: spec.description(),
        format: "jpart".into(),
        thumb: Some(standard::thumbnail(spec)),
        size: Some(standard::extent(spec)),
        generated: true,
        note: spec.note().into(),
        ..Default::default()
    }
}

impl Provider for Standard {
    fn id(&self) -> &'static str { "standard" }
    fn name(&self) -> &'static str { "Standard parts" }
    fn note(&self) -> &'static str { "Screws, nuts, washers, pins, bearings and T-slot extrusions drawn from their ISO, DIN and ASME dimensions. No network needed." }
    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            // a supplier's number with a size is that supplier's row, not a second one here
            if mcmaster_number(q).is_some() { return Ok(Vec::new()); }
            Ok(standard::search(q, limit).iter().map(standard_hit).collect())
        })
    }
    fn fetch<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            let spec = standard::Spec::from_id(id).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "There is no such standard part."))?;
            Ok(Model { format: "jpart", bytes: standard::part_studio(&spec, "", "").into_bytes(), name: spec.part_number() })
        })
    }
}

// ------------------------------------------------------------------ routes

async fn need_cad(state: &AppState, user_id: i64) -> AppResult<()> {
    // assemblies are part of Mechanical CAD, which each person turns on (persist::cad_enabled)
    if persist::cad_enabled(&state.pool, user_id).await? { Ok(()) } else { Err(AppError::Api(StatusCode::FORBIDDEN, "cad_off", "Turn on Mechanical CAD in your settings to search for 3D models.".into())) }
}

fn provider_json(p: &dyn Provider) -> Value {
    json!({ "id": p.id(), "name": p.name(), "note": p.note(), "configured": p.configured(), "needs": p.needs(), "signup": p.signup() })
}

/// GET /api/models3d/providers
pub async fn list_providers(State(state): State<AppState>, AuthUser(user): AuthUser) -> AppResult<Json<Value>> {
    need_cad(&state, user.id).await?;
    Ok(Json(json!({ "providers": providers().iter().map(|p| provider_json(p.as_ref())).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

/// How long one provider may take over a search before the others' results are shown without it.
const SEARCH_PATIENCE: Duration = Duration::from_secs(15);

/// GET /api/models3d/search?q=&provider=ID|all
pub async fn search(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<SearchQuery>) -> AppResult<Json<Value>> {
    need_cad(&state, user.id).await?;
    let text = q.q.trim().to_string();
    if text.chars().count() < 2 { return Err(AppError::BadRequest("Type at least two characters to search.".into())); }
    if text.len() > 200 { return Err(AppError::BadRequest("That search is too long.".into())); }
    let limit = q.limit.unwrap_or(8).clamp(1, 30);
    let which = q.provider.as_deref().unwrap_or("all");
    let wanted: Vec<&dyn Provider> = if which == "all" { providers().iter().map(|p| p.as_ref()).collect() } else { vec![provider(which)?] };
    let cx = Cx { state: &state, user_id: user.id };
    let calls = wanted.iter().map(|p| {
        let (cx, text) = (&cx, &text);
        async move {
            let res = match tokio::time::timeout(SEARCH_PATIENCE, p.search(cx, text, limit)).await {
                Ok(r) => r,
                Err(_) => Err(VendorErr::new(ErrKind::Unreachable, format!("{} took too long to answer.", p.name()))),
            };
            (*p, res)
        }
    });
    let mut results: Vec<ModelHit> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    for (p, res) in futures_util::future::join_all(calls).await {
        match res {
            Ok(hits) => results.extend(hits),
            // "not configured" is a state, said by the provider list, not a failure of this search
            Err(e) if e.kind == ErrKind::NotConfigured => {}
            Err(e) => {
                if let AppError::Api(_, code, message) = AppError::from(e) { errors.push(json!({ "provider": p.id(), "name": p.name(), "code": code, "message": message })); }
            }
        }
    }
    Ok(Json(json!({ "query": text, "results": results, "errors": errors, "providers": providers().iter().map(|p| provider_json(p.as_ref())).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
pub struct ModelQuery {
    provider: String,
    id: String,
}

fn clean_id(id: &str) -> AppResult<&str> {
    let id = id.trim();
    if id.is_empty() || id.len() > 400 || id.chars().any(|c| c.is_control()) { return Err(AppError::BadRequest("missing or malformed model id".into())); }
    Ok(id)
}

/// A name that is safe in a Content-Disposition header and as a file name.
fn file_name(name: &str) -> String {
    let n: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || " ._-()".contains(c) { c } else { '_' }).collect();
    let n = n.trim().trim_matches('.').to_string();
    if n.is_empty() { "model".into() } else { n.chars().take(120).collect() }
}

/// GET /api/models3d/model?provider=&id= — the model's file.
pub async fn get_model(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<ModelQuery>) -> AppResult<Response> {
    need_cad(&state, user.id).await?;
    let p = provider(&q.provider)?;
    let id = clean_id(&q.id)?;
    let key = format!("m3d:{}:{id}", p.id());
    let kept = if p.keeps() { sqlx::query_scalar::<_, Vec<u8>>("SELECT step FROM part_models WHERE uuid = $1").bind(&key).fetch_optional(&state.pool).await? } else { None };
    let model = match kept {
        Some(bytes) => Model { format: "step", bytes, name: id.rsplit(['/', '|']).next().unwrap_or(id).to_string() },
        None => {
            let m = p.fetch(&Cx { state: &state, user_id: user.id }, id).await?;
            if p.keeps() && m.format == "step" {
                sqlx::query("INSERT INTO part_models (uuid, step) VALUES ($1, $2) ON CONFLICT (uuid) DO NOTHING").bind(&key).bind(&m.bytes).execute(&state.pool).await?;
            }
            m
        }
    };
    let (ctype, ext) = if model.format == "jpart" { ("application/json", "jpart") } else { ("model/step", "step") };
    Ok((
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}.{ext}\"", file_name(&model.name))),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
            (header::HeaderName::from_static("x-model-format"), model.format.to_string()),
        ],
        model.bytes,
    )
        .into_response())
}

/// GET /api/models3d/image?provider=&id= — the supplier's picture of the part.
pub async fn get_image(State(state): State<AppState>, AuthUser(user): AuthUser, Query(q): Query<ModelQuery>) -> AppResult<Response> {
    need_cad(&state, user.id).await?;
    let p = provider(&q.provider)?;
    let id = clean_id(&q.id)?;
    let (ctype, bytes) = p.image(&Cx { state: &state, user_id: user.id }, id).await.map_err(|_| AppError::NotFound)?;
    // only raster pictures are passed on: an SVG could carry script
    let ok = bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || bytes.starts_with(b"\x89PNG") || bytes.starts_with(b"GIF8") || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP");
    if !ok || bytes.len() > 4 * 1024 * 1024 { return Err(AppError::NotFound); }
    let ctype = if bytes.starts_with(b"\x89PNG") { "image/png".to_string() } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { "image/jpeg".to_string() } else { ctype };
    Ok(([(header::CONTENT_TYPE, ctype), (header::CACHE_CONTROL, "private, max-age=604800".to_string())], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_mcmaster_number() {
        assert_eq!(mcmaster_number("91251A431").as_deref(), Some("91251A431"));
        assert_eq!(mcmaster_number("mcmaster 91251a431 1/4-20 x 1").as_deref(), Some("91251A431"));
        assert_eq!(mcmaster_number("https://www.mcmaster.com/92196A537/").as_deref(), Some("92196A537"));
        assert_eq!(mcmaster_number("6384K365").as_deref(), Some("6384K365"));
        for no in ["M5x20 socket head", "C8734", "608 bearing", "2020 extrusion 300", "STM32F103C8T6", "1234", "123A45", "91251A", "912515A431"] {
            assert_eq!(mcmaster_number(no), None, "{no}");
        }
    }

    #[test]
    fn providers_have_distinct_ids_and_say_what_they_need() {
        let all = providers();
        let mut ids: Vec<&str> = all.iter().map(|p| p.id()).collect();
        assert!(ids.contains(&"standard") && ids.contains(&"mcmaster") && ids.contains(&"lcsc") && ids.contains(&"kicad") && ids.contains(&"freecad"));
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
        for p in all {
            assert!(!p.name().is_empty() && !p.note().is_empty(), "{}", p.id());
            // a provider that needs nothing is always configured
            if p.needs().is_empty() { assert!(p.configured(), "{}", p.id()); }
        }
        assert_eq!(file_name("ASME B18.3 SHCS 1/4-20 x 1\""), "ASME B18.3 SHCS 1_4-20 x 1_");
        assert_eq!(enc("Package_SO/SOIC-8 a"), "Package_SO%2FSOIC-8%20a");
        assert!(check_step("X", b"ISO-10303-21;\nHEADER;".to_vec()).is_ok());
        assert_eq!(check_step("X", b"<html>".to_vec()).unwrap_err().kind, ErrKind::NotFound);
    }
}
