//! The providers that read a catalogue somebody else keeps.
//!
//!   lcsc        LCSC / JLCPCB.  A part number (C8734) is that part; words search the catalogue.
//!               The model is EasyEDA's STEP file for the part, through `parts`, with the keys and
//!               the cache the board editor uses.  No credentials.
//!   kicad       KiCad's packages3D library (CC-BY-SA 4.0 with KiCad's exception), through
//!               `kicadlib`.  No credentials.  The first search reads the library's listing, which
//!               takes about half a minute; until it is read the search says so.
//!   freecad     The FreeCAD parts library, github.com/FreeCAD/FreeCAD-library (CC BY 3.0): its
//!               STEP files, found by the words of their path.  No credentials.
//!               `FREECAD_LIBRARY_API_URL` (default https://api.github.com) lists the repository,
//!               `FREECAD_LIBRARY_RAW_URL` (default https://raw.githubusercontent.com) serves the files.
//!   traceparts  TraceParts' CAD-content API: `TRACEPARTS_TENANT_UID`, `TRACEPARTS_API_KEY` and
//!               `TRACEPARTS_USER_EMAIL` (the address TraceParts records each download under);
//!               `TRACEPARTS_API_URL` (default https://api.traceparts.com),
//!               `TRACEPARTS_STEP_FORMAT_ID` (the id of STEP among their CAD formats, default 7).
//!   library     A catalogue of your own: `MODELS3D_LIBRARY_URL` is a web folder whose `index.json`
//!               is `{ "name": "Acme parts", "license": "…", "models": [{ "id", "part_number",
//!               "supplier", "description", "file", "url", "keywords" }] }`; `file` is a STEP file's
//!               path under the same folder.  `MODELS3D_LIBRARY_TOKEN` is sent as a bearer token.

use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use super::{check_step, download, enc, env_opt, env_url, from_app, http, mcmaster_number, standard, Cx, MResult, Model, ModelHit, Provider};
use crate::kicadlib;
use crate::parts;
use crate::parts::vendors::{self, ErrKind, VendorErr};

/// A listing read from somewhere, and when: one reader at a time.
type Kept<T> = tokio::sync::Mutex<Option<(Instant, Arc<T>)>>;

fn words(q: &str) -> Vec<String> {
    q.to_lowercase().split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).map(str::to_string).collect()
}
fn text(v: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| match v.get(*k) { Some(Value::String(s)) => Some(s.trim().to_string()), Some(Value::Number(n)) => Some(n.to_string()), _ => None }).unwrap_or_default()
}
/// A query that names hardware or a supplier's number is not a search of an electronics catalogue.
fn is_hardware(q: &str) -> bool { mcmaster_number(q).is_some() || !standard::search(q, 1).is_empty() }

// ------------------------------------------------------------------ LCSC

pub struct Lcsc;

fn lcsc_hit(info: &vendors::PartInfo, model: Option<&str>, known: bool) -> ModelHit {
    let what = [info.manufacturer.as_str(), info.mpn.as_str(), info.package.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let description = if info.description.is_empty() { what } else if what.is_empty() { info.description.clone() } else { format!("{what}: {}", info.description) };
    ModelHit {
        provider: "lcsc".into(),
        supplier: "LCSC".into(),
        id: info.vendor_id.clone(),
        part_number: info.vendor_id.clone(),
        title: format!("LCSC {}", info.vendor_id),
        description,
        format: if known && model.is_none() { String::new() } else { "step".into() },
        url: info.url.clone(),
        image: format!("/api/parts/image?vendor=lcsc&id={}", enc(&info.vendor_id)),
        note: if known && model.is_none() { "LCSC has no 3D model of this part.".into() } else if known { String::new() } else { "Its 3D model is looked up when it is placed.".into() },
        ..Default::default()
    }
}

impl Provider for Lcsc {
    fn id(&self) -> &'static str { "lcsc" }
    fn name(&self) -> &'static str { "LCSC / JLCPCB" }
    fn note(&self) -> &'static str { "Electronic parts by LCSC number or by words, with the STEP model EasyEDA publishes for them. No key needed." }
    fn search<'a>(&'a self, cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            if vendors::is_lcsc_id(q) {
                return match parts::model_summary(cx.state, cx.user_id, "lcsc", q).await {
                    Ok((info, model)) => Ok(vec![lcsc_hit(&info, model.as_deref(), true)]),
                    Err(e) => { let e = from_app(e); if e.kind == ErrKind::NotFound { Ok(Vec::new()) } else { Err(e) } }
                };
            }
            if q.chars().count() < 3 || is_hardware(q) { return Ok(Vec::new()); }
            let hits = parts::search_vendor(cx.state, cx.user_id, "lcsc", q, limit.min(6)).await.map_err(from_app)?;
            Ok(hits.iter().map(|h| lcsc_hit(h, None, false)).collect())
        })
    }
    fn fetch<'a>(&'a self, cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            let (info, bytes) = parts::model_step(cx.state, cx.user_id, "lcsc", id).await.map_err(|e| {
                let e = from_app(e);
                if e.kind == ErrKind::NotFound { VendorErr::new(ErrKind::NotFound, format!("LCSC has no 3D model of {}.", id.to_ascii_uppercase())) } else { e }
            })?;
            Ok(Model { format: "step", bytes: check_step("LCSC", bytes)?, name: format!("LCSC {}", info.vendor_id) })
        })
    }
}

// ------------------------------------------------------------------ KiCad's 3D library

pub struct Kicad;

/// The library's listing, without making a search wait for the half minute its first reading takes:
/// the reading goes on in the background and the next search has it.
async fn kicad_index() -> MResult<Arc<Vec<String>>> {
    let task = tokio::spawn(kicadlib::model_index());
    match tokio::time::timeout(Duration::from_secs(10), task).await {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(e))) => Err(from_app(e)),
        Ok(Err(_)) => Err(VendorErr::new(ErrKind::Other, "KiCad's 3D library could not be listed.")),
        Err(_) => Err(VendorErr::new(ErrKind::Unreachable, "KiCad's 3D library is being listed for the first time, which takes about half a minute. Search again shortly.")),
    }
}

impl Provider for Kicad {
    fn id(&self) -> &'static str { "kicad" }
    fn name(&self) -> &'static str { "KiCad 3D library" }
    fn note(&self) -> &'static str { "The STEP models of KiCad's packages3D library: connectors, packages, switches, mounting hardware." }
    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            let words = words(q);
            if q.chars().count() < 3 || mcmaster_number(q).is_some() || vendors::is_lcsc_id(q) { return Ok(Vec::new()); }
            let all = kicad_index().await?;
            let mut hits: Vec<&String> = all.iter().filter(|id| { let l = id.to_lowercase(); words.iter().all(|w| l.contains(w.as_str())) }).collect();
            let exact = |id: &str| words.len() == 1 && id.rsplit(':').next().is_some_and(|n| n.eq_ignore_ascii_case(&words[0]));
            hits.sort_by(|a, b| exact(b).cmp(&exact(a)).then(a.len().cmp(&b.len())).then(a.cmp(b)));
            let (base, git_ref) = kicadlib::library_home();
            Ok(hits.into_iter().take(limit).filter_map(|id| {
                let (lib, name) = id.split_once(':')?;
                Some(ModelHit {
                    provider: "kicad".into(),
                    supplier: "KiCad".into(),
                    id: format!("{lib}/{name}"),
                    part_number: name.to_string(),
                    title: format!("KiCad {name}"),
                    description: format!("{} (KiCad 3D library)", lib.replace('_', " ")),
                    format: "step".into(),
                    url: format!("{base}/kicad/libraries/kicad-packages3D/-/blob/{}/{}.3dshapes/{}.step", enc(git_ref), enc(lib), enc(name)),
                    license: "CC-BY-SA 4.0, with KiCad's library exception".into(),
                    ..Default::default()
                })
            }).collect())
        })
    }
    fn fetch<'a>(&'a self, cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            let (lib, name) = id.split_once('/').ok_or_else(|| VendorErr::new(ErrKind::NotFound, "There is no such model."))?;
            let bytes = kicadlib::model_step(cx.state, lib, name).await.map_err(from_app)?.ok_or_else(|| VendorErr::new(ErrKind::NotFound, format!("KiCad's 3D library has no model {name}.")))?;
            Ok(Model { format: "step", bytes: check_step("KiCad's 3D library", bytes)?, name: format!("KiCad {name}") })
        })
    }
}

// ------------------------------------------------------------------ the FreeCAD parts library

pub struct FreeCad;

const FREECAD_REPO: &str = "FreeCAD/FreeCAD-library";
const FREECAD_REF: &str = "master";

/// Every STEP file of the library, by its path.  One request, kept for a day.
async fn freecad_index() -> MResult<Arc<Vec<String>>> {
    static SLOT: OnceLock<Kept<Vec<String>>> = OnceLock::new();
    let mut guard = SLOT.get_or_init(|| tokio::sync::Mutex::new(None)).lock().await;
    if let Some((at, v)) = guard.as_ref() { if at.elapsed() < Duration::from_secs(24 * 3600) { return Ok(v.clone()); } }
    let what = "The FreeCAD parts library";
    let url = format!("{}/repos/{FREECAD_REPO}/git/trees/{FREECAD_REF}?recursive=1", env_url("FREECAD_LIBRARY_API_URL", "https://api.github.com"));
    let resp = http().get(&url).header("Accept", "application/vnd.github+json").send().await.map_err(|e| VendorErr::net(what, e))?;
    if !resp.status().is_success() { return Err(VendorErr::new(ErrKind::Unreachable, format!("{what} could not be listed ({}).", resp.status().as_u16()))); }
    let v: Value = resp.json().await.map_err(|e| VendorErr::net(what, e))?;
    let mut paths: Vec<String> = v.get("tree").and_then(Value::as_array).map(|a| a.iter().filter_map(|e| {
        let path = e.get("path")?.as_str()?;
        let lower = path.to_ascii_lowercase();
        let small = e.get("size").and_then(Value::as_u64).is_none_or(|n| (n as usize) < super::MAX_MODEL_BYTES);
        (e.get("type").and_then(Value::as_str) == Some("blob") && (lower.ends_with(".step") || lower.ends_with(".stp")) && small && !path.contains("..")).then(|| path.to_string())
    }).collect()).unwrap_or_default();
    if paths.is_empty() { return Err(VendorErr::new(ErrKind::Unreachable, format!("{what} could not be listed."))); }
    paths.sort();
    let v = Arc::new(paths);
    *guard = Some((Instant::now(), v.clone()));
    Ok(v)
}

fn stem(path: &str) -> &str { let f = path.rsplit('/').next().unwrap_or(path); f.rsplit_once('.').map(|(s, _)| s).unwrap_or(f) }

impl Provider for FreeCad {
    fn id(&self) -> &'static str { "freecad" }
    fn name(&self) -> &'static str { "FreeCAD library" }
    fn note(&self) -> &'static str { "The STEP files of the FreeCAD parts library: fasteners, bearings, motors, profiles, electronics, shared under CC BY 3.0." }
    fn keeps(&self) -> bool { true }
    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            let words = words(q);
            if q.chars().count() < 3 || mcmaster_number(q).is_some() || vendors::is_lcsc_id(q) { return Ok(Vec::new()); }
            let all = freecad_index().await?;
            let mut hits: Vec<&String> = all.iter().filter(|p| { let l = p.to_lowercase(); words.iter().all(|w| l.contains(w.as_str())) }).collect();
            hits.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
            Ok(hits.into_iter().take(limit).map(|path| {
                let folder = path.rsplit_once('/').map(|(d, _)| d.replace('/', " › ")).unwrap_or_default();
                ModelHit {
                    provider: "freecad".into(),
                    supplier: "FreeCAD library".into(),
                    id: path.clone(),
                    part_number: stem(path).to_string(),
                    title: stem(path).to_string(),
                    description: if folder.is_empty() { "FreeCAD parts library".into() } else { folder },
                    format: "step".into(),
                    url: format!("https://github.com/{FREECAD_REPO}/blob/{FREECAD_REF}/{}", path.split('/').map(enc).collect::<Vec<_>>().join("/")),
                    license: "CC BY 3.0, the FreeCAD-library contributors".into(),
                    ..Default::default()
                }
            }).collect())
        })
    }
    fn fetch<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            // only a file the listing has: the id is a path, and nothing else of the host is read through here
            if !freecad_index().await?.iter().any(|p| p == id) { return Err(VendorErr::new(ErrKind::NotFound, "The FreeCAD parts library has no such file.")); }
            let url = format!("{}/{FREECAD_REPO}/{FREECAD_REF}/{}", env_url("FREECAD_LIBRARY_RAW_URL", "https://raw.githubusercontent.com"), id.split('/').map(enc).collect::<Vec<_>>().join("/"));
            let bytes = download("The FreeCAD parts library", http().get(&url)).await?;
            Ok(Model { format: "step", bytes: check_step("The FreeCAD parts library", bytes)?, name: stem(id).to_string() })
        })
    }
}

// ------------------------------------------------------------------ TraceParts

pub struct TraceParts;

struct TpCfg { url: String, tenant: Option<String>, key: Option<String>, email: Option<String>, step_format: String }

fn tp() -> &'static TpCfg {
    static CFG: OnceLock<TpCfg> = OnceLock::new();
    CFG.get_or_init(|| TpCfg {
        url: env_url("TRACEPARTS_API_URL", "https://api.traceparts.com"),
        tenant: env_opt("TRACEPARTS_TENANT_UID"),
        key: env_opt("TRACEPARTS_API_KEY"),
        email: env_opt("TRACEPARTS_USER_EMAIL"),
        step_format: env_opt("TRACEPARTS_STEP_FORMAT_ID").unwrap_or_else(|| "7".into()),
    })
}

const TP: &str = "TraceParts";

async fn tp_token() -> MResult<String> {
    static SLOT: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
    let slot = SLOT.get_or_init(|| Mutex::new(None));
    if let Some((t, at)) = slot.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { if at.elapsed() < Duration::from_secs(20 * 60) { return Ok(t.clone()); } }
    let c = tp();
    let (Some(tenant), Some(key)) = (&c.tenant, &c.key) else { return Err(VendorErr::new(ErrKind::NotConfigured, "TraceParts is not connected on this server.")) };
    let resp = http().post(format!("{}/v2/RequestToken", c.url)).json(&json!({ "tenantUid": tenant, "apiKey": key })).send().await.map_err(|e| VendorErr::net(TP, e))?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    let token = text(&v, &["token", "Token", "access_token"]);
    if status >= 500 { return Err(VendorErr::new(ErrKind::Unreachable, format!("TraceParts is having trouble (it answered {status})."))); }
    if status >= 400 || token.is_empty() { return Err(VendorErr::new(ErrKind::Rejected, "TraceParts refused the tenant id or the API key.")); }
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some((token.clone(), Instant::now()));
    Ok(token)
}

async fn tp_json(req: reqwest::RequestBuilder) -> MResult<(u16, Value)> {
    let resp = req.bearer_auth(tp_token().await?).send().await.map_err(|e| VendorErr::net(TP, e))?;
    let status = resp.status().as_u16();
    if status >= 500 { return Err(VendorErr::new(ErrKind::Unreachable, format!("TraceParts is having trouble (it answered {status})."))); }
    if status == 401 || status == 403 { return Err(VendorErr::new(ErrKind::Rejected, "TraceParts refused the request.")); }
    Ok((status, resp.json().await.unwrap_or(Value::Null)))
}

/// The STEP file inside what TraceParts hands out: the file itself, or a zip archive holding it.
fn step_of(bytes: Vec<u8>) -> MResult<Vec<u8>> {
    if !bytes.starts_with(b"PK") { return check_step(TP, bytes); }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| VendorErr::new(ErrKind::Other, "TraceParts' archive could not be opened."))?;
    for i in 0..zip.len() {
        let Ok(mut f) = zip.by_index(i) else { continue };
        let lower = f.name().to_ascii_lowercase();
        if !(lower.ends_with(".stp") || lower.ends_with(".step")) || f.size() as usize > super::MAX_MODEL_BYTES { continue; }
        let mut out = Vec::with_capacity(f.size() as usize);
        if f.read_to_end(&mut out).is_ok() { return check_step(TP, out); }
    }
    Err(VendorErr::new(ErrKind::NotFound, "TraceParts' archive holds no STEP file."))
}

impl Provider for TraceParts {
    fn id(&self) -> &'static str { "traceparts" }
    fn name(&self) -> &'static str { TP }
    fn note(&self) -> &'static str { "Manufacturers' catalogues of mechanical and electrical parts, through TraceParts' CAD-content API." }
    fn needs(&self) -> &'static [&'static str] { &["TRACEPARTS_TENANT_UID", "TRACEPARTS_API_KEY", "TRACEPARTS_USER_EMAIL"] }
    fn signup(&self) -> &'static str { "https://developers.traceparts.com/" }
    fn configured(&self) -> bool { tp().tenant.is_some() && tp().key.is_some() && tp().email.is_some() }
    fn keeps(&self) -> bool { true }
    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            if !self.configured() { return Err(VendorErr::new(ErrKind::NotConfigured, "TraceParts is not connected on this server.")); }
            if q.chars().count() < 3 { return Ok(Vec::new()); }
            let size = limit.to_string();
            let (status, v) = tp_json(http().get(format!("{}/v3/Search/ProductList", tp().url)).query(&[("cultureInfo", "en"), ("keyword", q), ("size", size.as_str()), ("page", "1")])).await?;
            if status >= 400 { return Err(VendorErr::new(ErrKind::Other, format!("TraceParts answered {status}."))); }
            let list = v.get("products").or(v.get("Products")).or(v.get("results")).and_then(Value::as_array).cloned().unwrap_or_default();
            Ok(list.iter().take(limit).filter_map(|p| {
                let family = text(p, &["partFamilyCode", "PartFamilyCode"]);
                if family.is_empty() { return None; }
                let number = text(p, &["partNumber", "PartNumber"]);
                let maker = text(p, &["manufacturerName", "ManufacturerName", "catalogLabel"]);
                let label = text(p, &["label", "title", "partDescription", "partFamilyLabel"]);
                let path = text(p, &["selectionPath", "SelectionPath"]);
                let shown = if number.is_empty() { family.clone() } else { number.clone() };
                Some(ModelHit {
                    provider: "traceparts".into(),
                    supplier: if maker.is_empty() { TP.into() } else { maker.clone() },
                    id: format!("{family}|{number}|{path}"),
                    part_number: shown.clone(),
                    title: format!("{} {shown}", if maker.is_empty() { TP } else { maker.as_str() }),
                    description: if label.is_empty() { "TraceParts catalogue part".into() } else { label },
                    format: "step".into(),
                    url: text(p, &["productUrl", "partUrl", "url"]),
                    note: "From TraceParts: the download is recorded under this server's TraceParts account.".into(),
                    ..Default::default()
                })
            }).collect())
        })
    }
    fn fetch<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            let c = tp();
            let Some(email) = &c.email else { return Err(VendorErr::new(ErrKind::NotConfigured, "TraceParts is not connected on this server.")) };
            let mut parts = id.splitn(3, '|');
            let (family, number, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            if family.is_empty() { return Err(VendorErr::new(ErrKind::NotFound, "There is no such model.")); }
            let mut body = json!({ "userEmail": email, "cultureInfo": "en", "partFamilyCode": family, "cadFormatId": c.step_format.parse::<i64>().unwrap_or(7) });
            if !number.is_empty() { body["partNumber"] = json!(number); }
            if !path.is_empty() { body["selectionPath"] = json!(path); }
            let (status, v) = tp_json(http().post(format!("{}/v3/Product/cadRequest", c.url)).json(&body)).await?;
            let request = text(&v, &["cadRequestId", "CadRequestId", "id"]);
            if status >= 400 || request.is_empty() { return Err(VendorErr::new(ErrKind::NotFound, format!("TraceParts has no STEP model of this part ({status})."))); }
            // the file is prepared on their side: ask until it is there
            let mut link = String::new();
            for _ in 0..20 {
                let (status, v) = tp_json(http().get(format!("{}/v2/Product/cadFileUrl", c.url)).query(&[("cadRequestId", request.as_str())])).await?;
                link = text(&v, &["url", "cadFileUrl", "Url"]);
                if status == 200 && !link.is_empty() { break; }
                if status >= 400 && status != 404 { return Err(VendorErr::new(ErrKind::Other, format!("TraceParts answered {status} for the model."))); }
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            if link.is_empty() { return Err(VendorErr::new(ErrKind::Unreachable, "TraceParts is still preparing the model. Try again in a moment.")); }
            let bytes = download(TP, http().get(&link)).await?;
            Ok(Model { format: "step", bytes: step_of(bytes)?, name: if number.is_empty() { family.to_string() } else { number.to_string() } })
        })
    }
}

// ------------------------------------------------------------------ a catalogue of one's own

pub struct Library;

fn library_url() -> Option<&'static str> {
    static V: OnceLock<Option<String>> = OnceLock::new();
    V.get_or_init(|| env_opt("MODELS3D_LIBRARY_URL").map(|s| s.trim_end_matches('/').to_string())).as_deref()
}
fn library_get(url: String) -> reqwest::RequestBuilder {
    let req = http().get(url);
    match env_opt("MODELS3D_LIBRARY_TOKEN") { Some(t) => req.bearer_auth(t), None => req }
}

/// The catalogue's `index.json`, kept for ten minutes.
async fn library_index() -> MResult<Arc<Value>> {
    static SLOT: OnceLock<Kept<Value>> = OnceLock::new();
    let Some(base) = library_url() else { return Err(VendorErr::new(ErrKind::NotConfigured, "No model library is connected on this server.")) };
    let mut guard = SLOT.get_or_init(|| tokio::sync::Mutex::new(None)).lock().await;
    if let Some((at, v)) = guard.as_ref() { if at.elapsed() < Duration::from_secs(600) { return Ok(v.clone()); } }
    let resp = library_get(format!("{base}/index.json")).send().await.map_err(|e| VendorErr::net("The model library", e))?;
    if !resp.status().is_success() { return Err(VendorErr::new(ErrKind::Unreachable, format!("The model library's index could not be read ({}).", resp.status().as_u16()))); }
    let v: Value = resp.json().await.map_err(|_| VendorErr::new(ErrKind::Other, "The model library's index.json is not JSON."))?;
    if !v.get("models").is_some_and(Value::is_array) { return Err(VendorErr::new(ErrKind::Other, "The model library's index.json has no \"models\" list.")); }
    let v = Arc::new(v);
    *guard = Some((Instant::now(), v.clone()));
    Ok(v)
}

/// A file path of the catalogue: relative, and never climbing out of its folder.
fn library_file(m: &Value) -> Option<String> {
    let f = text(m, &["file"]);
    let lower = f.to_ascii_lowercase();
    (!f.is_empty() && !f.starts_with('/') && !f.contains("..") && !f.contains("://") && !f.contains('\\') && (lower.ends_with(".step") || lower.ends_with(".stp"))).then_some(f)
}

impl Provider for Library {
    fn id(&self) -> &'static str { "library" }
    fn name(&self) -> &'static str { "Your model library" }
    fn note(&self) -> &'static str { "A catalogue of STEP files of your own: a web folder with an index.json listing part numbers and files." }
    fn needs(&self) -> &'static [&'static str] { &["MODELS3D_LIBRARY_URL"] }
    fn configured(&self) -> bool { library_url().is_some() }
    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            let index = library_index().await?;
            let words = words(q);
            let name = text(&index, &["name"]);
            let license = text(&index, &["license"]);
            Ok(index["models"].as_array().into_iter().flatten().filter_map(|m| {
                let (id, number, file) = (text(m, &["id"]), text(m, &["part_number"]), library_file(m)?);
                if id.is_empty() || number.is_empty() { return None; }
                let supplier = text(m, &["supplier"]);
                let description = text(m, &["description"]);
                let hay = format!("{id} {number} {supplier} {description} {} {file}", text(m, &["keywords"])).to_lowercase();
                if !words.iter().all(|w| hay.contains(w.as_str())) { return None; }
                let supplier = if supplier.is_empty() { if name.is_empty() { "Library".to_string() } else { name.clone() } } else { supplier };
                Some(ModelHit {
                    provider: "library".into(),
                    title: format!("{supplier} {number}"),
                    supplier,
                    id,
                    part_number: number,
                    description,
                    format: "step".into(),
                    url: text(m, &["url"]),
                    license: license.clone(),
                    ..Default::default()
                })
            }).take(limit).collect())
        })
    }
    fn fetch<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            let index = library_index().await?;
            let m = index["models"].as_array().into_iter().flatten().find(|m| text(m, &["id"]) == id).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "The model library has no such part."))?;
            let file = library_file(m).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "The model library names no STEP file for this part."))?;
            let url = format!("{}/{}", library_url().unwrap_or(""), file.split('/').map(enc).collect::<Vec<_>>().join("/"));
            let bytes = download("The model library", library_get(url)).await?;
            Ok(Model { format: "step", bytes: check_step("The model library", bytes)?, name: text(m, &["part_number"]) })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lcsc_rows() {
        let info = vendors::PartInfo { vendor: "lcsc".into(), vendor_id: "C8734".into(), mpn: "STM32F103C8T6".into(), manufacturer: "STMicroelectronics".into(), package: "LQFP-48".into(), description: "ARM MCU".into(), url: "https://www.lcsc.com/product-detail/C8734.html".into(), ..Default::default() };
        let h = lcsc_hit(&info, Some("LQFP-48_L7.0-W7.0-P0.50-LS9.0-BL"), true);
        assert_eq!((h.title.as_str(), h.format.as_str(), h.part_number.as_str()), ("LCSC C8734", "step", "C8734"));
        assert_eq!(h.description, "STMicroelectronics STM32F103C8T6 LQFP-48: ARM MCU");
        assert_eq!(h.image, "/api/parts/image?vendor=lcsc&id=C8734");
        // a part known to have no model is listed and cannot be placed; one not looked up yet can be tried
        assert_eq!(lcsc_hit(&info, None, true).format, "");
        assert_eq!(lcsc_hit(&info, None, false).format, "step");
    }

    #[test]
    fn hardware_is_not_searched_for_among_electronics() {
        assert!(is_hardware("M5x20 socket head") && is_hardware("91251A431") && is_hardware("608 bearing"));
        assert!(!is_hardware("STM32F103C8T6") && !is_hardware("usb c receptacle") && !is_hardware("10k 0603"));
    }

    #[test]
    fn library_files_stay_in_the_library() {
        assert_eq!(library_file(&json!({ "file": "screws/m5.step" })).as_deref(), Some("screws/m5.step"));
        for bad in ["../secret.step", "/etc/passwd.step", "http://elsewhere/x.step", "a\\b.step", "readme.txt", ""] {
            assert_eq!(library_file(&json!({ "file": bad })), None, "{bad}");
        }
        assert_eq!(stem("Mechanical Parts/Fasteners/M5x20.step"), "M5x20");
    }

    #[test]
    fn traceparts_archives() {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"hello").unwrap();
        zip.start_file("part.stp", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"ISO-10303-21;\nHEADER;\nENDSEC;\n").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        assert!(step_of(bytes).unwrap().starts_with(b"ISO-10303-21"));
        assert!(step_of(b"ISO-10303-21;".to_vec()).is_ok());
        assert_eq!(step_of(b"<html>".to_vec()).unwrap_err().kind, ErrKind::NotFound);
    }
}
