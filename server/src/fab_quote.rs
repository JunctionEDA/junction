use axum::{
    body::Bytes,
    extract::Query,
    http::{header, HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

use crate::{
    auth::AuthUser,
    error::{AppError, AppResult},
};

pub(crate) const MAX_ARCHIVE_BYTES: usize = 16 * 1024 * 1024;
const PCBWAY_UPLOAD: &str = "https://www.pcbway.com/Common/KiCadUpFile/";

#[derive(Deserialize)]
pub(crate) struct BoardSize {
    width: f64,
    height: f64,
    layers: u8,
}

fn quote_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && matches!(url.host_str(), Some("www.pcbway.com" | "pcbway.com"))
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn unavailable() -> AppError {
    AppError::Api(
        StatusCode::BAD_GATEWAY,
        "pcbway_upload_failed",
        "PCBWay did not return a quote link. Try again or upload the Gerber ZIP on PCBWay.".into(),
    )
}

/// Forward the same ZIP and quote fields as PCBWay's published KiCad plugin.
pub(crate) async fn pcbway(
    AuthUser(user): AuthUser,
    Query(board): Query<BoardSize>,
    headers: HeaderMap,
    archive: Bytes,
) -> AppResult<Json<Value>> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/zip")
        || !(board.width.is_finite()
            && board.height.is_finite()
            && board.width > 0.0
            && board.height > 0.0
            && (1..=32).contains(&board.layers))
        || !archive.starts_with(b"PK\x03\x04")
    {
        return Err(AppError::BadRequest(
            "A Gerber ZIP and valid board dimensions are required.".into(),
        ));
    }
    if !crate::pcm::within_rate(&format!("fab-pcbway:{}", user.id), 5) {
        return Err(AppError::Api(
            StatusCode::TOO_MANY_REQUESTS,
            "pcbway_busy",
            "Try the PCBWay upload again in a minute.".into(),
        ));
    }
    // Pass only the fixed vendor fields. A random boundary keeps the ZIP bytes opaque.
    let boundary = Uuid::new_v4().simple().to_string();
    let mut body = Vec::with_capacity(archive.len() + 512);
    for (name, value) in [
        ("boardWidth", board.width.to_string()),
        ("boardHeight", board.height.to_string()),
        ("boardLayer", board.layers.to_string()),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"upload[file]\"; filename=\"fabrication.zip\"\r\nContent-Type: application/zip\r\n\r\n").as_bytes());
    body.extend_from_slice(&archive);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|_| unavailable())?;
    let mut response = client
        .post(PCBWAY_UPLOAD)
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > 16 * 1024 {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    let url = reply["redirect"]
        .as_str()
        .and_then(quote_url)
        .ok_or_else(unavailable)?;
    Ok(Json(json!({ "url": url.as_str() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_links_stay_on_pcbway() {
        assert!(quote_url("https://www.pcbway.com/QuickOrderOnline.aspx?kicad=abc").is_some());
        for url in [
            "http://www.pcbway.com/",
            "https://pcbway.com.example.org/",
            "https://www.pcbway.com@other.com/",
            "https://other@www.pcbway.com/",
            "https://www.pcbway.com:444/",
        ] {
            assert!(quote_url(url).is_none(), "{url}");
        }
    }
}
