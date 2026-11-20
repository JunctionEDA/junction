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
//! Without credentials nothing is fetched and nothing is drawn in the part's place: a number is
//! answered with one row that links to McMaster's page of the part and asks the person to download
//! the STEP file there themselves ("3-D STEP" among the page's CAD downloads) and hand it over
//! (`upload`).  The browser then keeps that file in the project as the part.  A McMaster-Carr number
//! only ever places McMaster's own model.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

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

/// What a number is answered with when the API is not connected: where McMaster's model is, and
/// that the person can bring it.  Nothing stands in for it.
fn offline_hit(number: &str) -> ModelHit {
    ModelHit {
        provider: "mcmaster".into(),
        supplier: NAME.into(),
        id: number.to_string(),
        part_number: number.to_string(),
        title: format!("{NAME} {number}"),
        description: "McMaster-Carr part".into(),
        url: page(number),
        upload: true,
        note: "Open McMaster-Carr's page of this part, download its CAD model as “3-D STEP”, and drop the file here. It is placed as this part.".into(),
        ..Default::default()
    }
}

pub struct McMaster;

impl Provider for McMaster {
    fn id(&self) -> &'static str { "mcmaster" }
    fn name(&self) -> &'static str { NAME }
    fn note(&self) -> &'static str { "McMaster-Carr's own CAD models by part number, through their Product Information API (an approved account and its client certificate). Without it, a part number links to McMaster's page, and the STEP file you download there is placed as the part." }
    fn needs(&self) -> &'static [&'static str] { &["MCMASTER_USERNAME", "MCMASTER_PASSWORD", "MCMASTER_CLIENT_CERT"] }
    fn signup(&self) -> &'static str { "https://www.mcmaster.com/help/api/" }
    fn configured(&self) -> bool { cfg().user.is_some() && cfg().password.is_some() }
    fn keeps(&self) -> bool { true }

    fn search<'a>(&'a self, _cx: &'a Cx<'a>, q: &'a str, _limit: usize) -> BoxFuture<'a, MResult<Vec<ModelHit>>> {
        Box::pin(async move {
            // the API has no search by words: only a part number finds a part
            let Some(number) = mcmaster_number(q) else { return Ok(Vec::new()) };
            if !self.configured() { return Ok(vec![offline_hit(&number)]); }
            match product(&number).await {
                Ok(p) => Ok(vec![hit_from_product(&number, &p)]),
                Err(e) if e.kind == ErrKind::NotFound => Ok(Vec::new()),
                Err(e) => Err(e),
            }
        })
    }

    fn fetch<'a>(&'a self, _cx: &'a Cx<'a>, id: &'a str) -> BoxFuture<'a, MResult<Model>> {
        Box::pin(async move {
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
    fn without_the_api_a_number_asks_for_mcmasters_own_file() {
        // whatever family the number is of: one row, a link, and nothing drawn in the part's place
        for number in ["91251A431", "90591A250", "92141A029", "6384K365"] {
            let h = offline_hit(number);
            assert_eq!(h.title, format!("McMaster-Carr {number}"));
            assert_eq!((h.id.as_str(), h.part_number.as_str()), (number, number));
            assert_eq!(h.url, format!("https://www.mcmaster.com/{number}/"));
            assert_eq!(h.format, "", "nothing to place by a click");
            assert!(h.upload && !h.generated && h.thumb.is_none() && h.size.is_none() && h.hint.is_empty());
            assert!(h.note.contains("3-D STEP") && h.note.contains("drop the file"), "{}", h.note);
        }
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
        assert!(!h.generated && !h.upload);
        // a product without a STEP file is listed and cannot be placed
        let none = json!({ "PartNumber": "1234K5", "Links": [{ "Key": "Price", "Value": "/v1/products/1234K5/price" }] });
        assert_eq!(hit_from_product("1234K5", &none).format, "");
    }
}
