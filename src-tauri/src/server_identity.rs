use std::io::Read;
use std::path::Path;

pub const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Launch,
    Reuse,
    Conflict,
}

pub fn connection_failure(kind: std::io::ErrorKind) -> Decision {
    if kind == std::io::ErrorKind::ConnectionRefused { Decision::Launch } else { Decision::Conflict }
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn expected_id(data_dir: &Path) -> Option<String> {
    let file = std::fs::File::open(data_dir.join("instance.json")).ok()?;
    let mut text = String::new();
    file.take(4097).read_to_string(&mut text).ok()?;
    if text.len() > 4096 { return None; }
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let directory = value.get("directory")?.as_str()?;
    if std::fs::canonicalize(directory).ok()? != std::fs::canonicalize(data_dir).ok()? { return None; }
    let id = value.get("id")?.as_str()?;
    valid_id(id).then(|| id.to_owned())
}

fn line_end(bytes: &[u8], from: usize) -> Option<usize> {
    bytes.get(from..)?.windows(2).position(|w| w == b"\r\n").map(|n| from + n)
}

fn chunks(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 0;
    let mut out = Vec::new();
    loop {
        let end = line_end(bytes, pos)?;
        let line = std::str::from_utf8(&bytes[pos..end]).ok()?;
        let size = line.split(';').next()?;
        if size.is_empty() || !size.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
        let size = usize::from_str_radix(size, 16).ok()?;
        pos = end + 2;
        if size == 0 {
            loop {
                let end = line_end(bytes, pos)?;
                if end == pos { return (end + 2 == bytes.len()).then_some(out); }
                let trailer = std::str::from_utf8(&bytes[pos..end]).ok()?;
                if !trailer.contains(':') { return None; }
                pos = end + 2;
            }
        }
        let end = pos.checked_add(size)?;
        if end.checked_add(2)? > bytes.len() || out.len().checked_add(size)? > MAX_RESPONSE_BYTES
            || &bytes[end..end + 2] != b"\r\n" { return None; }
        out.extend_from_slice(&bytes[pos..end]);
        pos = end + 2;
    }
}

fn response_id(response: &[u8]) -> Option<(String, bool)> {
    if response.len() > MAX_RESPONSE_BYTES { return None; }
    let header_end = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    let header = std::str::from_utf8(&response[..header_end]).ok()?;
    let mut lines = header.split("\r\n");
    let mut status = lines.next()?.split_whitespace();
    if !matches!(status.next(), Some("HTTP/1.0" | "HTTP/1.1")) || status.next()? != "200" { return None; }
    let mut length = None;
    let mut transfer = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return None; }
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) { return None; }
            length = Some(value.parse::<usize>().ok()?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if transfer.is_some() { return None; }
            transfer = Some(value.trim());
        }
    }
    let raw = &response[header_end + 4..];
    let decoded;
    let (body, framed): (&[u8], bool) = match (length, transfer) {
        (Some(n), None) if n == raw.len() => (raw, true),
        (None, Some(value)) if value.eq_ignore_ascii_case("chunked") => {
            decoded = chunks(raw)?;
            (&decoded, true)
        }
        (None, None) => (raw, false),
        _ => return None,
    };
    let json: serde_json::Value = serde_json::from_slice(body).ok()?;
    let instance = json.get("instance")?;
    if instance.get("app")?.as_str()? != "antena" { return None; }
    Some((instance.get("id")?.as_str()?.to_owned(), framed))
}

pub fn decide(taken: bool, response: Option<&[u8]>, expected: Option<&str>) -> Decision {
    if !taken { return Decision::Launch; }
    match (expected.filter(|id| valid_id(id)), response.and_then(response_id)) {
        (Some(expected), Some((actual, _))) if expected == actual => Decision::Reuse,
        _ => Decision::Conflict,
    }
}

// A persistent connection can only be used after an explicitly framed response is complete.
pub fn framed_match(response: &[u8], expected: Option<&str>) -> bool {
    matches!((expected.filter(|id| valid_id(id)), response_id(response)),
        (Some(expected), Some((actual, true))) if expected == actual)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";

    fn response(status: &str, body: &str) -> Vec<u8> {
        format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes()
    }
    fn body(id: &str) -> String {
        format!(r#"{{"instance":{{"app":"antena","id":"{id}"}},"overlays":0}}"#)
    }

    #[test]
    fn only_connection_refused_means_the_port_is_free() {
        use std::io::ErrorKind;
        assert_eq!(connection_failure(ErrorKind::ConnectionRefused), Decision::Launch);
        assert_eq!(connection_failure(ErrorKind::TimedOut), Decision::Conflict);
        assert_eq!(connection_failure(ErrorKind::Other), Decision::Conflict);
    }

    #[test]
    fn copied_identity_is_not_the_expected_id_of_another_directory() {
        use std::time::{SystemTime, UNIX_EPOCH};
        struct Temp(std::path::PathBuf);
        impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = Temp(std::env::temp_dir().join(format!("antena-identity-path-{}-{suffix}", std::process::id())));
        let a = root.0.join("a"); let b = root.0.join("b");
        std::fs::create_dir_all(&a).unwrap(); std::fs::create_dir_all(&b).unwrap();
        let record = serde_json::json!({ "id": ID, "createdAt": "2026-01-02T03:04:05.000Z", "directory": std::fs::canonicalize(&a).unwrap() });
        let text = serde_json::to_string(&record).unwrap();
        std::fs::write(a.join("instance.json"), &text).unwrap();
        std::fs::write(b.join("instance.json"), &text).unwrap();
        assert_eq!(expected_id(&a).as_deref(), Some(ID));
        assert_eq!(expected_id(&b), None);
    }

    #[test]
    fn port_decisions_require_the_matching_antena_identity() {
        let matching = response("200 OK", &body(ID));
        assert_eq!(decide(false, None, None), Decision::Launch);
        assert_eq!(decide(true, Some(&matching), Some(ID)), Decision::Reuse);
        let wrong = response("200 OK", &body(OTHER));
        let old = response("200 OK", r#"{"overlays":0}"#);
        let missing = response("200 OK", r#"{"instance":{"app":"antena"}}"#);
        let foreign = response("200 OK", &format!(r#"{{"instance":{{"app":"other","id":"{ID}"}}}}"#));
        let text = response("200 OK", "hello");
        let bad_status = response("503 Unavailable", &body(ID));
        for input in [&wrong[..], &old, &missing, &foreign, &text, &bad_status, b"not http"] {
            assert_eq!(decide(true, Some(input), Some(ID)), Decision::Conflict);
        }
        assert_eq!(decide(true, None, Some(ID)), Decision::Conflict);
        assert_eq!(decide(true, Some(&matching), None), Decision::Conflict);
    }

    #[test]
    fn parses_complete_content_length_and_chunked_responses() {
        let json = body(ID);
        let length = response("200 OK", &json);
        assert_eq!(decide(true, Some(&length), Some(ID)), Decision::Reuse);
        assert!(framed_match(&length, Some(ID)));
        assert!(!framed_match(&length[..length.len() - 1], Some(ID)));
        let close_delimited = format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{json}");
        assert_eq!(decide(true, Some(close_delimited.as_bytes()), Some(ID)), Decision::Reuse);
        assert!(!framed_match(close_delimited.as_bytes(), Some(ID)));
        let split = json.len() / 2;
        let chunked = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n{:x};x=y\r\n{}\r\n0\r\n\r\n", split, &json[..split], json.len() - split, &json[split..]);
        assert_eq!(decide(true, Some(chunked.as_bytes()), Some(ID)), Decision::Reuse);
        assert!(framed_match(chunked.as_bytes(), Some(ID)));
    }

    #[test]
    fn rejects_truncated_oversized_or_garbled_responses() {
        let good = response("200 OK", &body(ID));
        for length in [0, 1, good.len() - 1] {
            assert_eq!(decide(true, Some(&good[..length]), Some(ID)), Decision::Conflict);
        }
        for input in [
            b"HTTP/1.1 2000 OK\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n{}\r\n0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{",
        ] {
            assert_eq!(decide(true, Some(input), Some(ID)), Decision::Conflict);
        }
        let huge = vec![b'x'; 65_537];
        assert_eq!(decide(true, Some(&huge), Some(ID)), Decision::Conflict);
    }
}
