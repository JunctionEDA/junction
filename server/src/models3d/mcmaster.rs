//! McMaster-Carr.
//!
//! McMaster publishes CAD models of nearly everything it sells, and its terms of use do not allow
//! reading its website by program.  The lawful way in is its Product Information API
//! (https://www.mcmaster.com/help/api/): an account McMaster has approved for it, with the client
//! certificate they issue.  This provider speaks that API and nothing else; it never reads a page
//! of mcmaster.com.
//!
//!   MCMASTER_USERNAME, MCMASTER_PASSWORD   the approved account
//!   MCMASTER_CLIENT_CERT                   a PEM file holding the client certificate and its key
//!                                          (`openssl pkcs12 -in mcmaster.pfx -out mcmaster.pem -nodes`)
//!   MCMASTER_API_URL                       default https://api.mcmaster.com
//!
//! The calls, as McMaster documents them: `POST /v1/login` (`UserName`, `Password`) answers an
//! `AuthToken` sent as a bearer token from then on; a product is subscribed to once with
//! `PUT /v1/products` (`URL`), then `GET /v1/products/{part number}` describes it, with `Links`
//! to its price, its picture and its CAD files.  The API has no search by words: a part is found
//! by its number.
//!
//! Without credentials the provider still knows what kind of hardware some of McMaster's commonest
//! part number families are (the table below).  A number of such a family typed with its size
//! ("91251A431 1/4-20 x 1") is answered with the same standard part drawn by Junction, named after
//! McMaster's number, linked to McMaster's page and marked as a generated equivalent.  The size is
//! not looked up: McMaster's dash numbers are not a public table, so it has to be typed.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use super::standard::{self, Kind};
use super::{check_step, enc, env_opt, env_url, mcmaster_number, Cx, MResult, Model, ModelHit, Provider};
use crate::parts::vendors::{ErrKind, VendorErr};

const NAME: &str = "McMaster-Carr";

struct Cfg {
    url: String,
    user: Option<String>,
    password: Option<String>,
    cert: Option<String>,
}

fn cfg() -> &'static Cfg {
    static CFG: OnceLock<Cfg> = OnceLock::new();
    CFG.get_or_init(|| Cfg {
        url: env_url("MCMASTER_API_URL", "https://api.mcmaster.com"),
        user: env_opt("MCMASTER_USERNAME"),
        password: env_opt("MCMASTER_PASSWORD"),
        cert: env_opt("MCMASTER_CLIENT_CERT"),
    })
}

/// The client that presents McMaster's certificate, when one is set.
fn client() -> MResult<&'static reqwest::Client> {
    static HTTP: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    HTTP.get_or_init(|| {
        let mut b = reqwest::Client::builder().user_agent("junction-models3d/1.0").timeout(Duration::from_secs(40)).connect_timeout(Duration::from_secs(8));
        if let Some(path) = &cfg().cert {
            let pem = std::fs::read(path).map_err(|e| format!("McMaster's client certificate ({path}) could not be read: {e}."))?;
            b = b.identity(reqwest::Identity::from_pem(&pem).map_err(|e| format!("McMaster's client certificate ({path}) is not a PEM file with a certificate and its key: {e}."))?);
        }
        b.build().map_err(|e| e.to_string())
    })
    .as_ref()
    .map_err(|m| VendorErr::new(ErrKind::Other, m.clone()))
}

fn page(number: &str) -> String { format!("https://www.mcmaster.com/{number}/") }

fn token_slot() -> &'static Mutex<Option<(String, Instant)>> {
    static T: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

async fn login(fresh: bool) -> MResult<String> {
    let c = cfg();
    let (Some(user), Some(password)) = (&c.user, &c.password) else { return Err(VendorErr::new(ErrKind::NotConfigured, "McMaster-Carr's API is not connected on this server.")) };
    if !fresh {
        if let Some((t, at)) = token_slot().lock().unwrap_or_else(|e| e.into_inner()).as_ref() { if at.elapsed() < Duration::from_secs(12 * 3600) { return Ok(t.clone()); } }
    }
    let resp = client()?.post(format!("{}/v1/login", c.url)).json(&json!({ "UserName": user, "Password": password })).send().await.map_err(|e| VendorErr::net("McMaster-Carr's API", e))?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    let token = v.get("AuthToken").or(v.get("authToken")).and_then(Value::as_str).unwrap_or("");
    if status >= 500 { return Err(VendorErr::new(ErrKind::Unreachable, format!("McMaster-Carr's API is having trouble (it answered {status})."))); }
    if status >= 400 || token.is_empty() { return Err(VendorErr::new(ErrKind::Rejected, "McMaster-Carr's API refused the account. Check MCMASTER_USERNAME, MCMASTER_PASSWORD and the client certificate.")); }
    *token_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some((token.to_string(), Instant::now()));
    Ok(token.to_string())
}

/// One call with the bearer token; a token McMaster no longer takes is replaced once.
async fn call(build: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder) -> MResult<reqwest::Response> {
    let http = client()?;
    let mut token = login(false).await?;
    for attempt in 0..2 {
        let resp = build(http, &cfg().url).bearer_auth(&token).send().await.map_err(|e| VendorErr::net("McMaster-Carr's API", e))?;
        if resp.status().as_u16() == 401 && attempt == 0 { token = login(true).await?; continue; }
        return Ok(resp);
    }
    Err(VendorErr::new(ErrKind::Rejected, "McMaster-Carr's API refused the account."))
}

/// What the API says about one part number.  A part the account has not subscribed to yet is subscribed to first.
async fn product(number: &str) -> MResult<Value> {
    let path = format!("/v1/products/{}", enc(number));
    for attempt in 0..2 {
        let resp = call(|h, base| h.get(format!("{base}{path}"))).await?;
        let status = resp.status().as_u16();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if status < 300 && v.is_object() { return Ok(v); }
        if status >= 500 { return Err(VendorErr::new(ErrKind::Unreachable, format!("McMaster-Carr's API is having trouble (it answered {status})."))); }
        if attempt == 0 && (status == 403 || status == 404) {
            // not subscribed yet: ask for it, then read it
            let sub = call(|h, base| h.put(format!("{base}/v1/products")).json(&json!({ "URL": format!("https://mcmaster.com/{number}") }))).await?;
            if sub.status().is_success() { continue; }
        }
        return Err(VendorErr::new(ErrKind::NotFound, format!("McMaster-Carr has no part {number}.")));
    }
    Err(VendorErr::new(ErrKind::NotFound, format!("McMaster-Carr has no part {number}.")))
}

/// The `Links` of a product as (key, path) pairs: McMaster lists them as `{Key, Value}` objects.
fn links(p: &Value) -> Vec<(String, String)> {
    let text = |v: &Value, keys: &[&str]| keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str)).unwrap_or("").to_string();
    match p.get("Links").or(p.get("links")) {
        Some(Value::Array(a)) => a.iter().map(|l| (text(l, &["Key", "key"]), text(l, &["Value", "value"]))).filter(|(_, v)| !v.is_empty()).collect(),
        Some(Value::Object(m)) => m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
        _ => Vec::new(),
    }
}

/// The STEP file among a product's CAD links.
fn step_link(p: &Value) -> Option<String> {
    let all = links(p);
    let is_step = |s: &str| { let l = s.to_ascii_lowercase(); l.contains("step") || l.ends_with(".stp") };
    all.iter().find(|(k, v)| is_step(k) || is_step(v)).map(|(_, v)| v.clone())
}
fn image_link(p: &Value) -> Option<String> {
    links(p).into_iter().find(|(k, _)| k.to_ascii_lowercase().contains("image")).map(|(_, v)| v)
}

fn text(p: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| p.get(*k).and_then(Value::as_str)).unwrap_or("").trim().to_string()
}

fn hit_from_product(number: &str, p: &Value) -> ModelHit {
    let family = text(p, &["FamilyDescription", "familyDescription"]);
    let detail = text(p, &["DetailDescription", "detailDescription"]);
    let description = [family, detail].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ");
    let has_step = step_link(p).is_some();
    ModelHit {
        provider: "mcmaster".into(),
        supplier: NAME.into(),
        id: number.to_string(),
        part_number: number.to_string(),
        title: format!("{NAME} {number}"),
        description: if description.is_empty() { "McMaster-Carr part".into() } else { description },
        format: if has_step { "step".into() } else { String::new() },
        url: page(number),
        image: if image_link(p).is_some() { format!("/api/models3d/image?provider=mcmaster&id={}", enc(number)) } else { String::new() },
        note: if has_step { String::new() } else { "McMaster-Carr lists no STEP model for this part.".into() },
        ..Default::default()
    }
}

// ------------------------------------------------------------------ equivalents, without the API

/// A family of McMaster part numbers (the number up to its letter) that is one kind of standard hardware.
struct Family {
    prefix: &'static str,
    kind: Kind,
    inch: bool,
    what: &'static str,
}

static FAMILIES: &[Family] = &[
    Family { prefix: "91251A", kind: Kind::Shcs, inch: true, what: "Black-oxide alloy steel socket head screw" },
    Family { prefix: "92196A", kind: Kind::Shcs, inch: true, what: "18-8 stainless steel socket head screw" },
    Family { prefix: "91290A", kind: Kind::Shcs, inch: false, what: "Black-oxide alloy steel socket head screw" },
    Family { prefix: "91292A", kind: Kind::Shcs, inch: false, what: "18-8 stainless steel socket head screw" },
    Family { prefix: "91255A", kind: Kind::Button, inch: true, what: "Black-oxide alloy steel button head hex drive screw" },
    Family { prefix: "92949A", kind: Kind::Button, inch: true, what: "18-8 stainless steel button head hex drive screw" },
    Family { prefix: "91239A", kind: Kind::Button, inch: false, what: "Black-oxide alloy steel button head hex drive screw" },
    Family { prefix: "92095A", kind: Kind::Button, inch: false, what: "18-8 stainless steel button head hex drive screw" },
    Family { prefix: "91253A", kind: Kind::Flat, inch: true, what: "Black-oxide alloy steel hex drive flat head screw" },
    Family { prefix: "92210A", kind: Kind::Flat, inch: true, what: "18-8 stainless steel hex drive flat head screw" },
    Family { prefix: "91294A", kind: Kind::Flat, inch: false, what: "Black-oxide alloy steel hex drive flat head screw" },
    Family { prefix: "92125A", kind: Kind::Flat, inch: false, what: "18-8 stainless steel hex drive flat head screw" },
    Family { prefix: "92240A", kind: Kind::Hex, inch: true, what: "18-8 stainless steel hex head screw" },
    Family { prefix: "90480A", kind: Kind::Nut, inch: true, what: "Zinc-plated steel hex nut" },
    Family { prefix: "91841A", kind: Kind::Nut, inch: true, what: "18-8 stainless steel hex nut" },
    Family { prefix: "90591A", kind: Kind::Nut, inch: false, what: "Zinc-plated steel hex nut" },
    Family { prefix: "91828A", kind: Kind::Nut, inch: false, what: "18-8 stainless steel hex nut" },
    Family { prefix: "90126A", kind: Kind::Washer, inch: true, what: "Zinc-plated steel washer" },
    Family { prefix: "92141A", kind: Kind::Washer, inch: true, what: "18-8 stainless steel washer" },
    Family { prefix: "91166A", kind: Kind::Washer, inch: false, what: "Zinc-plated steel washer" },
    Family { prefix: "93475A", kind: Kind::Washer, inch: false, what: "18-8 stainless steel washer" },
];

fn family(number: &str) -> Option<&'static Family> { FAMILIES.iter().find(|f| number.starts_with(f.prefix)) }

/// The size to type after a number of this family, as an example.
fn example(f: &Family) -> &'static str {
    match (f.kind, f.inch) {
        (Kind::Nut | Kind::Washer, true) => "1/4-20",
        (Kind::Nut | Kind::Washer, false) => "M5",
        (Kind::Flat, false) => "M5 x 16",
        (_, true) => "1/4-20 x 1",
        (_, false) => "M5 x 20",
    }
}

/// What can be said of a number without asking McMaster.
fn offline_hit(number: &str, q: &str) -> ModelHit {
    let base = ModelHit { provider: "mcmaster".into(), supplier: NAME.into(), part_number: number.to_string(), title: format!("{NAME} {number}"), url: page(number), ..Default::default() };
    let Some(f) = family(number) else {
        return ModelHit {
            id: number.to_string(),
            description: "McMaster-Carr part".into(),
            note: "McMaster's own model of this part comes through their API, which this server is not connected to.".into(),
            ..base
        };
    };
    // the size, typed beside the number: the same thread system as the family, or it is not this part
    let spec = standard::exact(f.kind, q).filter(|s| s.is_inch() == f.inch);
    match spec {
        Some(s) => ModelHit {
            id: format!("eq|{number}|{}", s.id()),
            description: format!("{}, {}", f.what, s.description()),
            format: "jpart".into(),
            thumb: Some(standard::thumbnail(&s)),
            size: Some(standard::extent(&s)),
            generated: true,
            equivalent: true,
            note: format!("A generated equivalent ({}): not McMaster-Carr's own model, and the size is the one you typed, not looked up. {}", s.part_number(), s.note()),
            ..base
        },
        None => ModelHit {
            id: number.to_string(),
            description: format!("{} ({} sizes)", f.what, if f.inch { "inch" } else { "metric" }),
            note: format!("Type its size after the number to place a generated equivalent, for example “{number} {}”. McMaster's own model comes through their API, which this server is not connected to.", example(f)),
            hint: format!("{number} {}", example(f)),
            ..base
        },
    }
}

pub struct McMaster;

impl Provider for McMaster {
    fn id(&self) -> &'static str { "mcmaster" }
    fn name(&self) -> &'static str { NAME }
    fn note(&self) -> &'static str { "McMaster-Carr's own CAD models by part number, through their Product Information API (an approved account and its client certificate). Without it, common hardware numbers typed with their size get a generated equivalent." }
    fn needs(&self) -> &'static [&'static str] { &["MCMASTER_USERNAME", "MCMASTER_PASSWORD", "MCMASTER_CLIENT_CERT"] }
    fn signup(&self) -> &'static str { "https://www.mcmaster.com/help/api/" }
    fn configured(&self) -> bool { cfg().user.is_some() && cfg().password.is_some() }
    fn keeps(&self) -> bool { true }

    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, _limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            // the API has no search by words: only a part number finds a part
            let Some(number) = mcmaster_number(q) else { return Ok(Vec::new()) };
            if !self.configured() { return Ok(vec![offline_hit(&number, q)]); }
            match product(&number).await {
                Ok(p) => Ok(vec![hit_from_product(&number, &p)]),
                Err(e) if e.kind == ErrKind::NotFound => Ok(Vec::new()),
                Err(e) => Err(e),
            }
        })
    }

    fn fetch<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
            if let Some(rest) = id.strip_prefix("eq|") {
                let (number, spec) = rest.split_once('|').ok_or_else(|| VendorErr::new(ErrKind::NotFound, "There is no such model."))?;
                let number = mcmaster_number(number).filter(|n| n == number).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "That is not a McMaster-Carr part number."))?;
                let spec = standard::Spec::from_id(spec).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "There is no such standard part."))?;
                let title = format!("{NAME} {number}");
                return Ok(Model { format: "jpart", bytes: standard::part_studio(&spec, &title, &page(&number)).into_bytes(), name: title });
            }
            let number = mcmaster_number(id).filter(|n| n == id).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "That is not a McMaster-Carr part number."))?;
            let p = product(&number).await?;
            let link = step_link(&p).ok_or_else(|| VendorErr::new(ErrKind::NotFound, format!("McMaster-Carr lists no STEP model for {number}.")))?;
            let resp = call(|h, base| h.get(if link.starts_with("http") { link.clone() } else { format!("{base}{link}") })).await?;
            let bytes = read(resp).await?;
            Ok(Model { format: "step", bytes: check_step(NAME, bytes)?, name: format!("{NAME} {number}") })
        })
    }

    fn image<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<(String, Vec<u8>)>> {
        Box::pin(async move {
            let number = mcmaster_number(id).filter(|n| n == id).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "No picture."))?;
            let link = image_link(&product(&number).await?).ok_or_else(|| VendorErr::new(ErrKind::NotFound, "No picture."))?;
            let resp = call(|h, base| h.get(if link.starts_with("http") { link.clone() } else { format!("{base}{link}") })).await?;
            let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("image/png").to_string();
            Ok((ctype, read(resp).await?))
        })
    }
}

async fn read(resp: reqwest::Response) -> MResult<Vec<u8>> {
    let status = resp.status();
    if !status.is_success() {
        return Err(VendorErr::new(if status.is_server_error() { ErrKind::Unreachable } else { ErrKind::NotFound }, format!("McMaster-Carr's API answered {}.", status.as_u16())));
    }
    Ok(resp.bytes().await.map_err(|e| VendorErr::net("McMaster-Carr's API", e))?.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equivalents_without_the_api() {
        // the user's example: a socket head screw family, the size typed beside it
        let h = offline_hit("91251A431", "91251A431 1/4-20 x 1");
        assert_eq!(h.title, "McMaster-Carr 91251A431");
        assert_eq!(h.id, "eq|91251A431|shcs:1/4:1in");
        assert_eq!(h.format, "jpart");
        assert!(h.generated && h.equivalent);
        assert_eq!(h.url, "https://www.mcmaster.com/91251A431/");
        assert!(h.description.starts_with("Black-oxide alloy steel socket head screw, Socket head cap screw 1/4\"-20 × 1\""), "{}", h.description);
        assert!(h.note.contains("generated equivalent") && h.note.contains("not McMaster-Carr's own model"));
        // the number alone: what it is, and what to type; nothing to place
        let h = offline_hit("91251A431", "91251A431");
        assert_eq!(h.format, "");
        assert_eq!(h.hint, "91251A431 1/4-20 x 1");
        assert!(h.description.contains("socket head screw") && h.note.contains("Type its size"));
        // a metric size for an inch family is not this part
        assert_eq!(offline_hit("91251A431", "91251A431 M5x20").format, "");
        assert_eq!(offline_hit("91290A115", "91290A115 M3x10").id, "eq|91290A115|shcs:M3:10");
        assert_eq!(offline_hit("90591A250", "90591A250 M5").id, "eq|90591A250|nut:M5");
        assert_eq!(offline_hit("92141A029", "92141A029 1/4-20").id, "eq|92141A029|washer:1/4");
        // a family that is not in the table: the link, and why there is no model
        let h = offline_hit("6384K365", "6384K365");
        assert_eq!((h.format.as_str(), h.url.as_str()), ("", "https://www.mcmaster.com/6384K365/"));
        assert!(h.note.contains("API"));
    }

    #[test]
    fn reads_a_product() {
        let p = json!({
            "PartNumber": "91251A431", "FamilyDescription": "Black-Oxide Alloy Steel Socket Head Screw", "DetailDescription": "1/4\"-20 Thread Size, 1\" Long",
            "Links": [
                { "Key": "Price", "Value": "/v1/products/91251A431/price" }, { "Key": "Image", "Value": "/v1/images/91251A431.png" },
                { "Key": "2-D DWG", "Value": "/v1/cad/91251A431.DWG" }, { "Key": "3-D STEP", "Value": "/v1/cad/91251A431.STEP" },
            ],
        });
        assert_eq!(step_link(&p).as_deref(), Some("/v1/cad/91251A431.STEP"));
        assert_eq!(image_link(&p).as_deref(), Some("/v1/images/91251A431.png"));
        let h = hit_from_product("91251A431", &p);
        assert_eq!((h.format.as_str(), h.title.as_str()), ("step", "McMaster-Carr 91251A431"));
        assert_eq!(h.description, "Black-Oxide Alloy Steel Socket Head Screw, 1/4\"-20 Thread Size, 1\" Long");
        assert!(!h.generated && !h.equivalent);
        // a product without a STEP file is listed and cannot be placed
        let none = json!({ "PartNumber": "1234K5", "Links": [{ "Key": "Price", "Value": "/v1/products/1234K5/price" }] });
        assert_eq!(hit_from_product("1234K5", &none).format, "");
    }
}
