use super::*;
use std::net::TcpListener;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn quit_status_probe_reads_persistence_only_from_the_matching_server() {
    struct Temp(PathBuf);
    impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = Temp(std::env::temp_dir().join(format!("antena-nexo-status-{}-{suffix}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let id = "0123456789abcdef0123456789abcdef";
    let record = serde_json::json!({ "id": id, "directory": std::fs::canonicalize(&dir.0).unwrap() });
    std::fs::write(dir.0.join("instance.json"), serde_json::to_string(&record).unwrap()).unwrap();
    let dirty = serde_json::json!({"dirty":{"config":true,"secrets":false},"pending":{"config":0,"secrets":0}});

    for (remote_id, status, expected) in [
        (id, "200 OK", Some(dirty.clone())),
        ("fedcba9876543210fedcba9876543210", "200 OK", None),
        (id, "503 Unavailable", None),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let persistence = dirty.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(request.starts_with(b"GET /api/status HTTP/1.1\r\n"));
            let body = serde_json::json!({"instance":{"app":"antena","id":remote_id},"persistence":persistence}).to_string();
            let response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).unwrap();
        });
        assert_eq!(persistence_at_server(port, &dir.0), expected);
        server.join().unwrap();
    }
}
