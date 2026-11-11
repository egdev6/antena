// antena de escritorio: arranca el servidor Node (sidecar) y abre el panel, el prompter y el dock.
//
// - El servidor es el mismo de siempre (src/server.mjs): la app solo lo arranca, espera a que responda
//   y carga http://127.0.0.1:<puerto>/ en la ventana. Las fuentes de Meld y el Stream Deck siguen
//   hablando con ese mismo puerto, así que la app tiene que estar abierta (vale minimizada en la bandeja).
// - An existing server is reused only when its data directory identity matches.
// - Al salir se pide un apagado ordenado (POST /api/shutdown) para que guarde todo; si no, se mata.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server_identity;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use server_identity::{connection_failure, decide, expected_id, framed_match, Decision, MAX_RESPONSE_BYTES};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const DEFAULT_PORT: u16 = 4500;
/// El Elgato Prompter se presenta como una pantalla de 1024×600.
const PROMPTER_W: u32 = 1024;
const PROMPTER_H: u32 = 600;

enum ServerChild {
    Sidecar(CommandChild),
    Plain(std::process::Child),
}

struct Server {
    port: u16,
    /// true si el servidor lo ha arrancado esta app (y por tanto lo apaga al salir)
    managed: Mutex<bool>,
    child: Mutex<Option<ServerChild>>,
    startup: Mutex<StartupState>,
    /// carpetas de datos y media que recibe el servidor (ver server_dirs)
    data: PathBuf,
    media: PathBuf,
}

#[derive(Default)]
struct StartupState {
    ready: bool,
    conflict: bool,
    error: Option<String>,
    waiters: Vec<tauri::async_runtime::Sender<Result<(), String>>>,
}

impl StartupState {
    fn wait(&mut self) -> Result<Option<tauri::async_runtime::Receiver<Result<(), String>>>, String> {
        if self.can_open() { return Ok(None); }
        if let Some(error) = &self.error { return Err(error.clone()); }
        let (sender, receiver) = tauri::async_runtime::channel(1);
        self.waiters.push(sender);
        Ok(Some(receiver))
    }
    fn signal(&mut self, result: Result<(), String>) {
        for sender in self.waiters.drain(..) { let _ = sender.try_send(result.clone()); }
    }
    fn signal_ready(&mut self) { self.ready = true; self.signal(Ok(())); }
    fn can_open(&self) -> bool { self.ready && !self.conflict }
    fn conflict(&mut self, port: u16) {
        self.ready = false;
        self.conflict = true;
        let message = conflict_message(port);
        self.error = Some(message.clone());
        self.signal(Err(message));
    }
}

// ---------- bounded HTTP probe against the local server ----------
fn status_probe(port: u16, data: &Path, keep_open: bool) -> (Decision, Option<TcpStream>) {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(stream) => stream,
        Err(err) => return (connection_failure(err.kind()), None),
    };
    let timeout = Duration::from_millis(600);
    if stream.set_write_timeout(Some(timeout)).is_err() { return (Decision::Conflict, None); }
    let connection = if keep_open { "keep-alive" } else { "close" };
    let request = format!("GET /api/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: {connection}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() { return (Decision::Conflict, None); }
    let deadline = Instant::now() + timeout;
    let mut response = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { return (Decision::Conflict, None) };
        if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() { return (Decision::Conflict, None); }
        match stream.read(&mut buf) {
            Ok(0) => return (decide(true, Some(&response), expected_id(data).as_deref()), None),
            Ok(n) => {
                if response.len() + n > MAX_RESPONSE_BYTES { return (Decision::Conflict, None); }
                response.extend_from_slice(&buf[..n]);
                if framed_match(&response, expected_id(data).as_deref()) {
                    return (Decision::Reuse, if keep_open { Some(stream) } else { None });
                }
            }
            Err(_) => return (Decision::Conflict, None),
        }
    }
}

fn retry_verification<T>(mut attempt: impl FnMut() -> Option<T>, mut again: impl FnMut() -> bool) -> Option<T> {
    loop {
        if let Some(value) = attempt() { return Some(value); }
        if !again() { return None; }
    }
}

// Verify and send on the same connection, so a replacement listener cannot receive shutdown.
fn shutdown_if_matching(port: u16, data: &Path) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    let Some(mut stream) = retry_verification(
        || match status_probe(port, data, true) { (Decision::Reuse, Some(stream)) => Some(stream), _ => None },
        || {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { return false };
            if remaining.is_zero() { return false; }
            std::thread::sleep(remaining.min(Duration::from_millis(100)));
            Instant::now() < deadline
        },
    ) else { return false };
    if stream.set_write_timeout(Some(Duration::from_secs(2))).is_err() { return false; }
    let request = format!("POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
    if stream.write_all(request.as_bytes()).is_err() { return false; }
    // Drain the response before closing, as the previous graceful shutdown request did.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut received = 0;
    let mut buf = [0u8; 4096];
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        if remaining.is_zero() || stream.set_read_timeout(Some(remaining)).is_err() { break; }
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => { received += n; if received > MAX_RESPONSE_BYTES { break; } }
        }
    }
    true
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

/// Windows devuelve rutas \\?\C:\… que algunos programas no entienden.
fn plain(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

/// Puerto: ANTENA_PORT, o el "port" del config.json de los datos, o 4500.
fn read_port(data_dir: &Path) -> u16 {
    if let Some(p) = std::env::var("ANTENA_PORT").ok().and_then(|v| v.parse().ok()) {
        return p;
    }
    std::fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_PORT)
}

/// En desarrollo, la raíz del repositorio: se usa su código (src/server.mjs) y sus datos (data/, media/).
fn dev_root() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    // La ruta se muestra en el panel (desktop_info): se canonicaliza para no mostrar "src-tauri\\..".
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let clean = std::fs::canonicalize(&root).unwrap_or(root);
    clean.join("src/server.mjs").exists().then_some(clean)
}

/// Carpetas de datos y media del servidor: ANTENA_DATA / ANTENA_MEDIA mandan; si no,
/// en desarrollo las del proyecto (como `pnpm start`) y en la app instalada las de %APPDATA%.
fn server_dirs(app_data: &Path, dev_root: Option<&Path>, env_data: Option<PathBuf>, env_media: Option<PathBuf>) -> (PathBuf, PathBuf) {
    let base = dev_root.unwrap_or(app_data);
    (env_data.unwrap_or_else(|| base.join("data")), env_media.unwrap_or_else(|| base.join("media")))
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Guardia de navegación: en las ventanas de la app solo se carga la pantalla de inicio local
/// (tauri://) y el panel, el prompter, el dock o el teleprompter servidos por el propio servidor
/// (mismo puerto y rutas "/", "/prompter", "/dock" y "/widget/teleprompter"). Una página servida
/// en otro puerto local no llega a cargarse y, con ello, no puede invocar comandos ni tocar
/// `window.__TAURI__`.
fn allowed_navigation(port: u16, url: &Url) -> bool {
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]") if matches!(url.scheme(), "http" | "https"));
    if !local {
        // El origen interno de Tauri aloja la pantalla de inicio, también en Windows.
        return !matches!(url.scheme(), "http" | "https") || url.host_str() == Some("tauri.localhost");
    }
    // el servidor solo se publica por http en 127.0.0.1: mismo puerto y solo las tres rutas
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
        && matches!(url.path(), "/" | "/prompter" | "/dock" | "/widget/teleprompter")
}

#[derive(Debug, PartialEq, Eq)]
enum NavigationDecision {
    Allow,
    Deny,
    Browser,
}

fn navigation_decision(port: u16, url: &Url) -> NavigationDecision {
    if allowed_navigation(port, url) {
        NavigationDecision::Allow
    } else if is_loopback_host(url) {
        // Loopback que la guardia no autoriza (otras rutas, puertos o hosts): sigue bloqueado
        // y nunca se reenvía al sistema, para no abrir servicios locales ajenos (#37).
        NavigationDecision::Deny
    } else {
        NavigationDecision::Browser
    }
}

/// Any loopback or unspecified address (all of 127.0.0.0/8, ::1, IPv4-mapped forms) and any
/// *.localhost name, with or without a trailing dot.
fn is_loopback_host(url: &Url) -> bool {
    use std::net::IpAddr;
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_unspecified(),
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified()
                || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified()),
        };
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    name == "localhost" || name.ends_with(".localhost")
}

fn new_window_opens_in_browser(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn open_in_browser(app: &AppHandle, url: &Url) {
    #[allow(deprecated)]
    if let Err(err) = app.shell().open(url.as_str(), None) {
        eprintln!("[antena] no se pudo abrir el navegador: {err}");
    }
}

fn conflict_message(port: u16) -> String {
    format!("Otro servidor ocupa el puerto {port} y no usa tus datos de antena. Ciérralo y vuelve a abrir antena.")
}

fn splash_error(app: &AppHandle, msg: &str) {
    let st = app.state::<Server>();
    let message = {
        let mut startup = st.startup.lock().unwrap();
        let message = if startup.conflict { conflict_message(st.port) } else { msg.to_owned() };
        startup.error = Some(message.clone());
        startup.signal(Err(message.clone()));
        message
    };
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.egdevError && window.egdevError({})", serde_json::to_string(&message).unwrap_or_default());
        let _ = w.eval(&js);
        let _ = w.show();
    }
}

fn show_conflict(app: &AppHandle) {
    let st = app.state::<Server>();
    {
        st.startup.lock().unwrap().conflict(st.port);
    }
    splash_error(app, &conflict_message(st.port));
}

// Port-opening actions are unavailable until the identity check has succeeded.
fn server_ready(app: &AppHandle) -> bool {
    let st = app.state::<Server>();
    let (can_open, conflict) = {
        let startup = st.startup.lock().unwrap();
        (startup.can_open(), startup.conflict)
    };
    if can_open { return true; }
    if conflict { splash_error(app, &conflict_message(st.port)); }
    show_main(app);
    false
}

// Shows the splash while the start is pending and, on a conflict, shows it again with the
// warning (it may have been hidden), so a tray action never fails silently.
fn wait_and_surface<S: FnMut(), W: FnMut(&str)>(
    startup: &Mutex<StartupState>,
    mut show: S,
    mut warn: W,
) -> Result<Option<tauri::async_runtime::Receiver<Result<(), String>>>, String> {
    let waited = startup.lock().unwrap().wait();
    match waited {
        Ok(receiver) => {
            if receiver.is_some() { show(); }
            Ok(receiver)
        }
        Err(error) => {
            warn(&error);
            show();
            Err(error)
        }
    }
}

fn wait_for_server(app: &AppHandle) -> Result<Option<tauri::async_runtime::Receiver<Result<(), String>>>, String> {
    let st = app.state::<Server>();
    wait_and_surface(&st.startup, || show_main(app), |error| splash_error(app, error))
}

async fn run_when_ready<F: std::future::Future<Output = Result<(), String>>>(receiver: Option<tauri::async_runtime::Receiver<Result<(), String>>>, action: F) -> Result<(), String> {
    if let Some(mut receiver) = receiver { receiver.recv().await.unwrap_or_else(|| Err("No se pudo abrir la ventana.".into()))?; }
    action.await
}

// ---------- arranque del servidor ----------
fn start_server(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<Server>();
    let port = st.port;
    match status_probe(port, &st.data, false).0 {
        Decision::Reuse => {
            println!("[antena] ya hay un servidor con los mismos datos en el puerto {port}: se usa ese");
            return Ok(());
        }
        Decision::Conflict => {
            show_conflict(app);
            return Err(conflict_message(port));
        }
        Decision::Launch => {}
    }
    let (data, media) = (&st.data, &st.media);
    let _ = std::fs::create_dir_all(data);
    let _ = std::fs::create_dir_all(media);
    let envs = [
        ("ANTENA_DATA".to_string(), plain(data)),
        ("ANTENA_MEDIA".to_string(), plain(media)),
        ("PORT".to_string(), port.to_string()),
        ("ANTENA_DESKTOP".to_string(), "1".to_string()),
    ];

    // en desarrollo se usa el código del repositorio (src/server.mjs) para ver los cambios al momento
    let root = match dev_root() {
        Some(root) => root,
        None => app.path().resource_dir().map_err(|e| e.to_string())?.join("server"),
    };
    let entry = root.join("src").join("server.mjs");
    if !entry.exists() {
        return Err(format!("No encuentro el servidor en {}", plain(&entry)));
    }

    let child = match app.shell().sidecar("node") {
        Ok(cmd) => {
            let (mut rx, child) = cmd
                .args([plain(&entry)])
                .current_dir(&root)
                .envs(envs.clone())
                .spawn()
                .map_err(|e| format!("No se pudo arrancar Node: {e}"))?;
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(l) => print!("[server] {}", String::from_utf8_lossy(&l)),
                        CommandEvent::Stderr(l) => eprint!("[server] {}", String::from_utf8_lossy(&l)),
                        CommandEvent::Terminated(t) => {
                            let managed = *handle.state::<Server>().managed.lock().unwrap();
                            if managed {
                                eprintln!("[antena] el servidor se ha cerrado (código {:?})", t.code);
                                splash_error(&handle, &format!("El servidor se ha cerrado (código {:?}). Mira el registro y vuelve a abrir la app.", t.code));
                            }
                        }
                        _ => {}
                    }
                }
            });
            ServerChild::Sidecar(child)
        }
        // sin el Node empaquetado (pnpm desktop:node), en desarrollo vale el del sistema
        Err(e) if cfg!(debug_assertions) => {
            println!("[antena] sin sidecar ({e}); uso el node del sistema");
            let child = std::process::Command::new("node")
                .arg(plain(&entry))
                .current_dir(&root)
                .envs(envs)
                // entrada en tubería: el servidor vigila su fin para apagarse si la app muere (#88)
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|e| format!("No se pudo arrancar node: {e}. Instala Node 24 o ejecuta pnpm desktop:node."))?;
            ServerChild::Plain(child)
        }
        Err(e) => return Err(format!("Falta el Node empaquetado: {e}")),
    };
    *st.child.lock().unwrap() = Some(child);
    *st.managed.lock().unwrap() = true;
    Ok(())
}

fn wait_and_open(app: AppHandle) {
    let st = app.state::<Server>();
    let port = st.port;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(30) {
        match status_probe(port, &st.data, false).0 {
            Decision::Reuse => {
                {
                    let mut startup = st.startup.lock().unwrap();
                    if startup.conflict { return; }
                    startup.signal_ready();
                }
                if let (Some(w), Ok(url)) = (app.get_webview_window("main"), Url::parse(&format!("{}/", base_url(port)))) {
                    let _ = w.navigate(url);
                }
                return;
            }
            Decision::Conflict => { show_conflict(&app); return; }
            Decision::Launch => {}
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    splash_error(&app, &format!("El servidor no responde en {} tras 30 s.", base_url(port)));
}

fn stop_server(app: &AppHandle) {
    let st = app.state::<Server>();
    if !*st.managed.lock().unwrap() {
        return;
    }
    *st.managed.lock().unwrap() = false;
    let port = st.port;
    // Only the same verified connection may receive the graceful shutdown request.
    if shutdown_if_matching(port, &st.data) {
        let t0 = Instant::now();
        while port_open(port) && t0.elapsed() < Duration::from_secs(6) {
            std::thread::sleep(Duration::from_millis(150));
        }
    }
    match st.child.lock().unwrap().take() {
        Some(ServerChild::Sidecar(c)) => {
            if port_open(port) {
                let _ = c.kill();
            }
        }
        Some(ServerChild::Plain(mut c)) => {
            if c.try_wait().ok().flatten().is_none() {
                let _ = c.kill();
            }
        }
        None => {}
    };
}

// ---------- ventanas ----------
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[derive(Serialize)]
struct MonitorInfo {
    name: String,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale: f64,
    primary: bool,
    #[serde(rename = "prompterLike")]
    prompter_like: bool,
}

fn monitor_list(app: &AppHandle) -> Vec<(MonitorInfo, tauri::Monitor)> {
    let Some(w) = app.get_webview_window("main") else { return vec![] };
    let primary = w.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    w.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let size = *m.size();
            let pos = *m.position();
            let scale = m.scale_factor();
            let name = m.name().cloned().unwrap_or_else(|| format!("Pantalla {}", i + 1));
            let (lw, lh) = ((size.width as f64 / scale).round() as u32, (size.height as f64 / scale).round() as u32);
            let like = |w: u32, h: u32| (w, h) == (PROMPTER_W, PROMPTER_H) || (w, h) == (PROMPTER_H, PROMPTER_W);
            let info = MonitorInfo {
                primary: primary.as_deref() == Some(name.as_str()),
                prompter_like: like(size.width, size.height) || like(lw, lh),
                name,
                width: size.width,
                height: size.height,
                x: pos.x,
                y: pos.y,
                scale,
            };
            (info, m)
        })
        .collect()
}

#[tauri::command]
fn monitors(app: AppHandle) -> Vec<MonitorInfo> {
    monitor_list(&app).into_iter().map(|(i, _)| i).collect()
}

fn page_url(app: &AppHandle, path: &str) -> Result<Url, String> {
    Url::parse(&format!("{}{}", base_url(app.state::<Server>().port), path)).map_err(|e| e.to_string())
}

/// Único punto donde se crean ventanas: así ninguna puede quedarse sin la guardia de navegación
/// (mismo puerto del servidor y solo las rutas del panel, el prompter y el dock).
fn window_builder<'a, M: tauri::Manager<tauri::Wry>>(app: &'a M, label: &str, url: WebviewUrl) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    let port = app.state::<Server>().port;
    let navigation_app = app.app_handle().clone();
    let new_window_app = navigation_app.clone();
    WebviewWindowBuilder::new(app, label, url)
        .on_navigation(move |url| match navigation_decision(port, url) {
            NavigationDecision::Allow => true,
            NavigationDecision::Deny => false,
            NavigationDecision::Browser => {
                open_in_browser(&navigation_app, url);
                false
            }
        })
        .on_new_window(move |url, _features| {
            if new_window_opens_in_browser(url.as_str()) {
                open_in_browser(&new_window_app, &url);
            }
            NewWindowResponse::Deny
        })
}

fn focus(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

const PANEL_WINDOWS_EVENT: &str = "antena://panel-windows";

fn notify_panel_windows(app: &AppHandle) {
    let _ = app.emit_to("main", PANEL_WINDOWS_EVENT, ());
}

fn valid_panel_close_label(label: &str) -> bool {
    matches!(label, "prompter" | "teleprompter")
}

fn teleprompter_mode(fullscreen: Option<bool>) -> &'static str {
    match fullscreen { None => "closed", Some(false) => "floating", Some(true) => "screen" }
}

fn should_replace_screen(opening_fullscreen: bool, other_fullscreen: bool) -> bool {
    opening_fullscreen && other_fullscreen
}

fn close_other_screen(app: &AppHandle, label: &str, opening_fullscreen: bool) -> Result<(), String> {
    if let Some(other) = app.get_webview_window(label) {
        if should_replace_screen(opening_fullscreen, other.is_fullscreen().map_err(|e| e.to_string())?) {
            other.close().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct PanelWindows {
    dock: bool,
    prompter: bool,
    teleprompter: &'static str,
}

#[tauri::command]
fn panel_windows(app: AppHandle) -> Result<PanelWindows, String> {
    let teleprompter = app.get_webview_window("teleprompter")
        .map(|w| w.is_fullscreen().map_err(|e| e.to_string())).transpose()?;
    Ok(PanelWindows {
        dock: app.get_webview_window("dock").is_some(),
        prompter: app.get_webview_window("prompter").is_some(),
        teleprompter: teleprompter_mode(teleprompter),
    })
}

#[tauri::command]
fn close_panel_window(app: AppHandle, label: String) -> Result<(), String> {
    if !valid_panel_close_label(&label) { return Err("Ventana no permitida".into()); }
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
    }
    notify_panel_windows(&app);
    Ok(())
}

/// Abre el prompter. Si hay una pantalla de 1024×600 (el Elgato) o se elige una, va a pantalla completa en ella.
#[tauri::command]
async fn open_prompter(app: AppHandle, monitor: Option<String>, fullscreen: Option<bool>) -> Result<(), String> {
    run_when_ready(wait_for_server(&app)?, async {
    let list = monitor_list(&app);
    let target = match monitor.as_deref().filter(|m| !m.is_empty()) {
        Some(name) => list.iter().find(|(i, _)| i.name == name),
        None => list.iter().find(|(i, _)| i.prompter_like),
    };
    close_other_screen(&app, "teleprompter", fullscreen.unwrap_or(true) && target.is_some())?;
    let w = match app.get_webview_window("prompter") {
        Some(w) => w,
        None => window_builder(&app, "prompter", WebviewUrl::External(page_url(&app, "/prompter")?))
            .title("antena · prompter")
            .inner_size(PROMPTER_W as f64, PROMPTER_H as f64)
            .min_inner_size(640.0, 400.0)
            .build()
            .map_err(|e| e.to_string())?,
    };
    if !fullscreen.unwrap_or(true) || target.is_some() {
        w.set_fullscreen(false).map_err(|e| e.to_string())?;
    }
    if let Some((_, m)) = target {
        let _ = w.set_position(Position::Physical(PhysicalPosition { x: m.position().x + 20, y: m.position().y + 20 }));
        if fullscreen.unwrap_or(true) {
            w.set_fullscreen(true).map_err(|e| e.to_string())?;
        }
    }
    focus(&w);
    notify_panel_windows(&app);
    Ok(())
    }).await
}

/// Teleprompter: el guion a pantalla completa en el monitor de la cámara. Sin pantalla
/// elegida (o «La principal») va al monitor primario del sistema, no al último usado.
/// La página no usa IPC: su ventana no está en la capability `default`.
#[tauri::command]
async fn open_teleprompter(app: AppHandle, monitor: Option<String>, fullscreen: Option<bool>) -> Result<(), String> {
    run_when_ready(wait_for_server(&app)?, async {
    let list = monitor_list(&app);
    let target = match monitor.as_deref().filter(|m| !m.is_empty()) {
        Some(name) => list.iter().find(|(i, _)| i.name == name),
        None => list.iter().find(|(i, _)| i.primary),   // «La principal» = monitor primario
    };
    close_other_screen(&app, "prompter", fullscreen.unwrap_or(true))?;
    let w = match app.get_webview_window("teleprompter") {
        Some(w) => w,
        None => window_builder(&app, "teleprompter", WebviewUrl::External(page_url(&app, "/widget/teleprompter")?))
            .title("antena · teleprompter")
            .inner_size(1280.0, 720.0)
            .min_inner_size(480.0, 270.0)
            .build()
            .map_err(|e| e.to_string())?,
    };
    if !fullscreen.unwrap_or(true) || target.is_some() {
        w.set_fullscreen(false).map_err(|e| e.to_string())?;
    }
    if let Some((_, m)) = target {
        let _ = w.set_position(Position::Physical(PhysicalPosition { x: m.position().x + 20, y: m.position().y + 20 }));
    }
    if fullscreen.unwrap_or(true) {
        w.set_fullscreen(true).map_err(|e| e.to_string())?;
    }
    focus(&w);
    notify_panel_windows(&app);
    Ok(())
    }).await
}

/// Dock flotante: la misma vista que el panel de chat de Meld, en una ventana pequeña siempre encima.
#[tauri::command]
async fn open_dock(app: AppHandle, always_on_top: Option<bool>) -> Result<(), String> {
    run_when_ready(wait_for_server(&app)?, async {
    let w = match app.get_webview_window("dock") {
        Some(w) => w,
        None => window_builder(&app, "dock", WebviewUrl::External(page_url(&app, "/dock")?))
            .title("antena · dock")
            .inner_size(380.0, 720.0)
            .min_inner_size(280.0, 360.0)
            .build()
            .map_err(|e| e.to_string())?,
    };
    let _ = w.set_always_on_top(always_on_top.unwrap_or(true));
    focus(&w);
    notify_panel_windows(&app);
    Ok(())
    }).await
}

#[derive(Serialize)]
struct DesktopInfo {
    port: u16,
    managed: bool,
    #[serde(rename = "dataDir")]
    data_dir: String,
    version: String,
}

#[tauri::command]
fn desktop_info(app: AppHandle, state: State<'_, Server>) -> DesktopInfo {
    let managed = *state.managed.lock().unwrap();
    DesktopInfo {
        port: state.port,
        managed,
        data_dir: plain(&state.data),
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn startup_state(state: State<'_, Server>) -> Option<String> {
    state.startup.lock().unwrap().error.clone()
}

// ---------- actualizaciones ----------
// Las busca e instala Rust, no el JS del plugin: así el servidor Node se apaga (stop_server) antes
// de que el instalador NSIS sobrescriba sus archivos. En Windows el plugin sale con
// process::exit sin pasar por RunEvent::Exit; on_before_exit es el único punto previo.

/// La actualización ofrecida por update_check, que update_install instala sin volver a buscar.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize, Clone, Debug, PartialEq)]
struct UpdateInfo {
    version: String,
    notes: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
struct UpdateProgress {
    /// fracción descargada (0..1) o null si el servidor no da el tamaño
    progress: Option<f64>,
}

const UPDATE_PROGRESS_EVENT: &str = "antena://update-progress";

fn download_fraction(done: u64, total: Option<u64>) -> Option<f64> {
    match total {
        Some(t) if t > 0 => Some((done as f64 / t as f64).min(1.0)),
        _ => None,
    }
}

/// Lo que se hace justo antes de que el instalador tome el relevo: primero el apagado ordenado del
/// servidor (guarda config, sesión y alertas retenidas y suelta node.exe), luego la limpieza de Tauri.
fn before_update_exit(app: &AppHandle) {
    stop_server(app);
    app.cleanup_before_exit();
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    // el hook de salida va en el updater con el que se busca: la Update guardada lo hereda
    let handle = app.clone();
    let updater = app.updater_builder().on_before_exit(move || before_update_exit(&handle)).build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone().unwrap_or_default() });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No hay ninguna actualización pendiente: busca de nuevo.")?;
    let mut done = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit(UPDATE_PROGRESS_EVENT, UpdateProgress { progress: download_fraction(done, total) });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // Windows no llega aquí (el instalador ya ha cerrado la app). En el resto se apaga y reinicia.
    before_update_exit(&app);
    app.restart();
}

// ---------- bandeja ----------
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Abrir el panel", true, None::<&str>)?;
    let prompter = MenuItem::with_id(app, "prompter", "Abrir el prompter", true, None::<&str>)?;
    let dock = MenuItem::with_id(app, "dock", "Abrir el dock", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Abrir en el navegador", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Salir (apaga las alertas)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &prompter, &dock, &browser, &sep, &quit])?;
    let mut tray = TrayIconBuilder::with_id("antena").tooltip("antena").menu(&menu).menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, ev| match ev.id.as_ref() {
        "open" => show_main(app),
        "prompter" => {
            let a = app.clone();
            tauri::async_runtime::spawn(async move { let _ = open_prompter(a, None, Some(true)).await; });
        }
        "dock" => {
            let a = app.clone();
            tauri::async_runtime::spawn(async move { let _ = open_dock(a, Some(true)).await; });
        }
        "browser" => {
            if !server_ready(app) { return; }
            let url = format!("{}/", base_url(app.state::<Server>().port));
            #[allow(deprecated)]
            let _ = app.shell().open(url, None);
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|tray, ev| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // una sola instancia: abrir la app otra vez trae el panel al frente
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_shell::init())
        // actualizaciones firmadas desde GitHub Releases (Ajustes › Acerca de): las usan los comandos
        // update_check y update_install, solo desde la ventana principal (capability `updater`)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let env_dir = |name| std::env::var(name).ok().map(PathBuf::from);
            let (data, media) = server_dirs(&app_data, dev_root().as_deref(), env_dir("ANTENA_DATA"), env_dir("ANTENA_MEDIA"));
            // el puerto se lee del config.json de la carpeta que va a usar el servidor
            let port = read_port(&data);
            app.manage(Server { port, managed: Mutex::new(false), child: Mutex::new(None), startup: Mutex::new(StartupState::default()), data, media });
            // la ventana principal se crea aquí (y no en tauri.conf.json) para poder limitar
            // su navegación al servidor local: window_builder pone la guardia a las tres ventanas
            window_builder(app.handle(), "main", WebviewUrl::App("index.html".into()))
                .title("antena")
                .inner_size(1360.0, 860.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .background_color(Color(0x12, 0x12, 0x14, 0xff))
                .build()?;
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            match start_server(&handle) {
                Ok(()) => {
                    std::thread::spawn(move || wait_and_open(handle));
                }
                Err(e) => {
                    eprintln!("[antena] {e}");
                    // The splash also polls stored state if its handler is not loaded yet.
                    splash_error(&handle, &e);
                }
            }
            Ok(())
        })
        .on_window_event(|window, ev| {
            if matches!(ev, WindowEvent::Destroyed) && matches!(window.label(), "dock" | "prompter" | "teleprompter") {
                notify_panel_windows(window.app_handle());
            }
            // cerrar el panel lo deja en la bandeja: las fuentes de Meld y el Stream Deck siguen funcionando
            if let WindowEvent::CloseRequested { api, .. } = ev {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![monitors, open_prompter, open_teleprompter, open_dock, panel_windows, close_panel_window, desktop_info, startup_state, update_check, update_install])
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar antena");

    app.run(|handle, ev| {
        if let RunEvent::Exit = ev {
            stop_server(handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn deferred_open_requests_execute_with_original_args_or_fail_on_conflict() {
        tauri::async_runtime::block_on(async {
            for request in [("prompter", Some("camera"), Some(false)), ("teleprompter", Some("screen"), Some(true)), ("dock", None, Some(false))] {
                let mut state = StartupState::default();
                let mut receiver = state.wait().unwrap().expect("pending commands must wait");
                assert!(receiver.try_recv().is_err());
                let mut executed = None;
                let action = async { executed = Some(request); Ok(()) };
                state.signal_ready();
                run_when_ready(Some(receiver), action).await.unwrap();
                assert_eq!(executed, Some(request));
                assert!(state.wait().unwrap().is_none());
            }
            let mut conflict = StartupState::default();
            let receiver = conflict.wait().unwrap().expect("pending command must wait");
            let mut executed = false;
            let action = async { executed = true; Ok(()) };
            conflict.conflict(4500);
            assert_eq!(run_when_ready(Some(receiver), action).await, Err(conflict_message(4500)));
            assert!(!executed);
        });
    }

    #[test]
    fn shutdown_verification_retries_before_sending() {
        let mut attempts = [None, None, Some("shutdown")].into_iter();
        let mut count = 0;
        assert_eq!(retry_verification(|| { count += 1; attempts.next().unwrap() }, || true), Some("shutdown"));
        assert_eq!(count, 3);
    }

    #[test]
    fn port_actions_wait_for_readiness_and_remain_blocked_in_conflict() {
        let mut state = StartupState::default();
        assert!(!state.can_open());
        state.ready = true;
        assert!(state.can_open());
        state.conflict(4500);
        assert!(!state.can_open());
        assert_eq!(state.error.as_deref(), Some("Otro servidor ocupa el puerto 4500 y no usa tus datos de antena. Ciérralo y vuelve a abrir antena."));
        state.ready = true;
        assert!(!state.can_open());
    }

    #[test]
    fn tray_actions_resurface_the_conflict_warning() {
        let state = std::sync::Mutex::new(StartupState::default());
        state.lock().unwrap().conflict(4500);
        let (mut shown, mut warned) = (0, Vec::new());
        let result = wait_and_surface(&state, || shown += 1, |error: &str| warned.push(error.to_string()));
        assert!(result.is_err());
        assert_eq!(shown, 1, "a hidden splash must be shown again");
        assert_eq!(warned, vec!["Otro servidor ocupa el puerto 4500 y no usa tus datos de antena. Ciérralo y vuelve a abrir antena.".to_string()]);

        let pending = std::sync::Mutex::new(StartupState::default());
        let (mut shown, mut warned) = (0, 0);
        assert!(wait_and_surface(&pending, || shown += 1, |_: &str| warned += 1).unwrap().is_some());
        assert_eq!((shown, warned), (1, 0), "a pending start shows the splash without a warning");
    }

    #[test]
    fn desktop_info_preserves_its_existing_fields() {
        let info = DesktopInfo { port: 4500, managed: true, data_dir: "data".into(), version: "1.2.3".into() };
        let value = serde_json::to_value(info).unwrap();
        assert_eq!(value["port"], 4500);
        assert_eq!(value["managed"], true);
        assert_eq!(value["dataDir"], "data");
        assert_eq!(value["version"], "1.2.3");
        assert_eq!(value.as_object().unwrap().len(), 4);
    }

    #[test]
    fn shutdown_is_sent_only_on_the_verified_connection() {
        use std::net::TcpListener;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct Temp(PathBuf);
        impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = Temp(std::env::temp_dir().join(format!("antena-identity-{}-{suffix}", std::process::id())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let id = "0123456789abcdef0123456789abcdef";
        let record = serde_json::json!({ "id": id, "createdAt": "2026-01-02T03:04:05.000Z", "directory": std::fs::canonicalize(&dir.0).unwrap() });
        std::fs::write(dir.0.join("instance.json"), serde_json::to_string(&record).unwrap()).unwrap();

        for (remote_id, expected) in [(id, true), ("fedcba9876543210fedcba9876543210", false)] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
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
                let body = format!(r#"{{"instance":{{"app":"antena","id":"{remote_id}"}}}}"#);
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                socket.write_all(reply.as_bytes()).unwrap();
                let mut followup = Vec::new();
                while !followup.windows(4).any(|part| part == b"\r\n\r\n") {
                    match socket.read(&mut byte) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => followup.push(byte[0]),
                    }
                }
                String::from_utf8_lossy(&followup).into_owned()
            });
            assert_eq!(shutdown_if_matching(port, &dir.0), expected);
            let followup = server.join().unwrap();
            if expected { assert!(followup.starts_with("POST /api/shutdown HTTP/1.1\r\n")); }
            else { assert_eq!(followup, ""); }
        }
    }

    #[test]
    fn panel_close_label_is_strictly_allowlisted() {
        assert!(valid_panel_close_label("prompter"));
        assert!(valid_panel_close_label("teleprompter"));
        for label in ["main", "dock", "", "Prompter", "prompter "] {
            assert!(!valid_panel_close_label(label), "{label}");
        }
    }

    #[test]
    fn teleprompter_window_state_and_screen_replacement() {
        assert_eq!(teleprompter_mode(None), "closed");
        assert_eq!(teleprompter_mode(Some(false)), "floating");
        assert_eq!(teleprompter_mode(Some(true)), "screen");
        assert!(should_replace_screen(true, true));
        for (opening, other) in [(false, false), (false, true), (true, false)] {
            assert!(!should_replace_screen(opening, other));
        }
    }

    #[test]
    fn navigation_allows_the_local_server_pages() {
        for path in ["/", "/prompter", "/dock", "/widget/teleprompter"] {
            let url = Url::parse(&format!("http://127.0.0.1:4500{path}")).unwrap();
            assert!(allowed_navigation(4500, &url), "{path}");
        }
        let sin_puerto = Url::parse("http://127.0.0.1:4500").unwrap();
        assert!(allowed_navigation(4500, &sin_puerto));
    }

    #[test]
    fn navigation_blocks_other_ports_hosts_and_paths() {
        let otro_puerto = Url::parse("http://127.0.0.1:8999/").unwrap();
        assert!(!allowed_navigation(4500, &otro_puerto));
        let otra_ruta = Url::parse("http://127.0.0.1:4500/legacy").unwrap();
        assert!(!allowed_navigation(4500, &otra_ruta));
        let otro_widget = Url::parse("http://127.0.0.1:4500/widget/chat").unwrap();
        assert!(!allowed_navigation(4500, &otro_widget));
        let localhost = Url::parse("http://localhost:4500/").unwrap();
        assert!(!allowed_navigation(4500, &localhost));
        let externa = Url::parse("https://ejemplo.com/").unwrap();
        assert!(!allowed_navigation(4500, &externa), "las navegaciones externas no deben cargar en la app");
    }

    #[test]
    fn other_loopback_addresses_are_never_forwarded() {
        for raw in ["http://127.0.0.2:8999/", "https://127.0.0.2/", "http://localhost.:8999/", "http://app.localhost/", "http://0.0.0.0:4500/", "http://[::ffff:127.0.0.1]:4500/"] {
            assert_eq!(navigation_decision(4500, &Url::parse(raw).unwrap()), NavigationDecision::Deny, "{raw}");
        }
    }

    #[test]
    fn new_windows_only_open_http_and_https_in_browser() {
        for raw in ["http://example.com/", "https://example.com/", "http://127.0.0.1:4500/x"] {
            assert!(new_window_opens_in_browser(raw), "{raw}");
        }
        for raw in ["file:///tmp/x", "javascript:alert(1)", "data:text/html,hello", "tauri://localhost", "garbage", "http://"] {
            assert!(!new_window_opens_in_browser(raw), "{raw}");
        }
    }

    #[test]
    fn navigation_routes_external_http_to_browser_and_preserves_internal_origins() {
        for raw in ["http://example.com/", "https://example.com/"] {
            assert_eq!(navigation_decision(4500, &Url::parse(raw).unwrap()), NavigationDecision::Browser, "{raw}");
        }
        for raw in ["http://tauri.localhost/index.html", "https://tauri.localhost/index.html", "tauri://localhost/index.html", "file:///index.html"] {
            assert_eq!(navigation_decision(4500, &Url::parse(raw).unwrap()), NavigationDecision::Allow, "{raw}");
        }
        // loopback: other ports, hosts and unlisted routes stay blocked, never forwarded to the OS
        for raw in ["http://127.0.0.1:4500/legacy", "http://127.0.0.1:4500/widget/chat", "http://127.0.0.1:8999/", "http://localhost:4500/", "http://[::1]:4500/", "https://127.0.0.1:4500/"] {
            assert_eq!(navigation_decision(4500, &Url::parse(raw).unwrap()), NavigationDecision::Deny, "{raw}");
        }
        for path in ["/", "/prompter", "/dock", "/widget/teleprompter"] {
            let url = Url::parse(&format!("http://127.0.0.1:4500{path}")).unwrap();
            assert_eq!(navigation_decision(4500, &url), NavigationDecision::Allow, "{path}");
        }
    }

    #[test]
    fn download_fraction_is_bounded_and_unknown_without_size() {
        assert_eq!(download_fraction(50, Some(200)), Some(0.25));
        assert_eq!(download_fraction(300, Some(200)), Some(1.0));
        assert_eq!(download_fraction(10, Some(0)), None);
        assert_eq!(download_fraction(10, None), None);
    }

    #[test]
    fn update_exit_stops_the_server_before_tauri_cleanup() {
        // el orden importa: el instalador sobrescribe node.exe en cuanto la app sale
        let src = include_str!("main.rs");
        let body = &src[src.find("fn before_update_exit").unwrap()..];
        let body = &body[..body.find("\n}").unwrap()];
        let stop = body.find("stop_server(app)").expect("before_update_exit apaga el servidor");
        let clean = body.find("cleanup_before_exit()").expect("y limpia Tauri");
        assert!(stop < clean);
        assert!(src.contains(".on_before_exit(move || before_update_exit(&handle))"));
    }

    #[test]
    fn installed_app_uses_app_data() {
        assert_eq!(server_dirs(&p("/app"), None, None, None), (p("/app/data"), p("/app/media")));
    }

    #[test]
    fn dev_uses_project_data_and_media() {
        assert_eq!(server_dirs(&p("/app"), Some(&p("/repo")), None, None), (p("/repo/data"), p("/repo/media")));
    }

    #[test]
    fn dev_root_is_a_clean_path_without_parent_components() {
        // La ruta se muestra en el panel (desktop_info): no debe llevar "src-tauri\\..".
        if let Some(root) = dev_root() {
            assert!(!root.components().any(|c| matches!(c, std::path::Component::ParentDir)), "{root:?}");
        }
    }

    #[test]
    fn env_overrides_win_in_dev_and_installed() {
        let (d, m) = (Some(p("/d")), Some(p("/m")));
        assert_eq!(server_dirs(&p("/app"), Some(&p("/repo")), d.clone(), m.clone()), (p("/d"), p("/m")));
        assert_eq!(server_dirs(&p("/app"), None, d, None), (p("/d"), p("/app/media")));
    }

    #[test]
    fn port_comes_from_the_data_dir_the_server_uses() {
        // El test no depende del entorno: aparta ANTENA_PORT y lo restaura al salir.
        let previa = std::env::var("ANTENA_PORT").ok();
        std::env::remove_var("ANTENA_PORT");
        let dir = std::env::temp_dir().join(format!("antena-port-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), r#"{"port":4567}"#).unwrap();
        let (data, _) = server_dirs(&p("/app"), None, Some(dir.clone()), None);
        let port = read_port(&data);
        let _ = std::fs::remove_dir_all(&dir);
        match previa {
            Some(v) => std::env::set_var("ANTENA_PORT", v),
            None => std::env::remove_var("ANTENA_PORT"),
        }
        assert_eq!(port, 4567);
    }
}
