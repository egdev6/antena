// antena de escritorio: arranca el servidor Node (sidecar) y abre el panel, el prompter y el dock.
//
// - El servidor es el mismo de siempre (src/server.mjs): la app solo lo arranca, espera a que responda
//   y carga http://127.0.0.1:<puerto>/ en la ventana. Las fuentes de Meld y el Stream Deck siguen
//   hablando con ese mismo puerto, así que la app tiene que estar abierta (vale minimizada en la bandeja).
// - Si ya hay un antena escuchando en el puerto (por ejemplo `pnpm start`), se usa ese y no se arranca otro.
// - Al salir se pide un apagado ordenado (POST /api/shutdown) para que guarde todo; si no, se mata.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, PhysicalPosition, Position, RunEvent, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
    /// carpetas de datos y media que recibe el servidor (ver server_dirs)
    data: PathBuf,
    media: PathBuf,
}

// ---------- HTTP mínimo contra el servidor local ----------
fn http(port: u16, method: &str, path: &str, timeout: Duration) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let body = if method == "POST" { "{}" } else { "" };
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    Some(out)
}
fn server_alive(port: u16) -> bool {
    http(port, "GET", "/api/status", Duration::from_millis(600)).is_some_and(|r| r.starts_with("HTTP/1.1 200"))
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
        return true;
    }
    // el servidor solo se publica por http en 127.0.0.1: mismo puerto y solo las tres rutas
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
        && matches!(url.path(), "/" | "/prompter" | "/dock" | "/widget/teleprompter")
}

fn splash_error(app: &AppHandle, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!("window.egdevError && window.egdevError({})", serde_json::to_string(msg).unwrap_or_default());
        let _ = w.eval(&js);
        let _ = w.show();
    }
}

// ---------- arranque del servidor ----------
fn start_server(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<Server>();
    let port = st.port;
    if server_alive(port) {
        println!("[antena] ya hay un servidor en el puerto {port}: se usa ese");
        return Ok(());
    }
    if port_open(port) {
        return Err(format!("El puerto {port} está ocupado por otro programa. Ciérralo o cambia el puerto (ANTENA_PORT)."));
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
                .map_err(|e| format!("No se pudo arrancar node: {e}. Instala Node 22 o ejecuta pnpm desktop:node."))?;
            ServerChild::Plain(child)
        }
        Err(e) => return Err(format!("Falta el Node empaquetado: {e}")),
    };
    *st.child.lock().unwrap() = Some(child);
    *st.managed.lock().unwrap() = true;
    Ok(())
}

fn wait_and_open(app: AppHandle) {
    let port = app.state::<Server>().port;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(30) {
        if server_alive(port) {
            if let (Some(w), Ok(url)) = (app.get_webview_window("main"), Url::parse(&format!("{}/", base_url(port)))) {
                let _ = w.navigate(url);
            }
            return;
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
    // apagado ordenado: guarda configuración, sesión y alertas retenidas
    let _ = http(port, "POST", "/api/shutdown", Duration::from_secs(2));
    let t0 = Instant::now();
    while port_open(port) && t0.elapsed() < Duration::from_secs(6) {
        std::thread::sleep(Duration::from_millis(150));
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
    WebviewWindowBuilder::new(app, label, url).on_navigation(move |u| allowed_navigation(port, u))
}

fn focus(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Abre el prompter. Si hay una pantalla de 1024×600 (el Elgato) o se elige una, va a pantalla completa en ella.
#[tauri::command]
async fn open_prompter(app: AppHandle, monitor: Option<String>, fullscreen: Option<bool>) -> Result<(), String> {
    let list = monitor_list(&app);
    let target = match monitor.as_deref().filter(|m| !m.is_empty()) {
        Some(name) => list.iter().find(|(i, _)| i.name == name),
        None => list.iter().find(|(i, _)| i.prompter_like),
    };
    let w = match app.get_webview_window("prompter") {
        Some(w) => w,
        None => window_builder(&app, "prompter", WebviewUrl::External(page_url(&app, "/prompter")?))
            .title("antena · prompter")
            .inner_size(PROMPTER_W as f64, PROMPTER_H as f64)
            .min_inner_size(640.0, 400.0)
            .build()
            .map_err(|e| e.to_string())?,
    };
    if let Some((_, m)) = target {
        let _ = w.set_fullscreen(false);
        let _ = w.set_position(Position::Physical(PhysicalPosition { x: m.position().x + 20, y: m.position().y + 20 }));
        if fullscreen.unwrap_or(true) {
            let _ = w.set_fullscreen(true);
        }
    }
    focus(&w);
    Ok(())
}

/// Teleprompter: el guion a pantalla completa en el monitor de la cámara. Sin pantalla
/// elegida (o «La principal») va al monitor primario del sistema, no al último usado.
/// La página no usa IPC: su ventana no está en la capability `default`.
#[tauri::command]
async fn open_teleprompter(app: AppHandle, monitor: Option<String>, fullscreen: Option<bool>) -> Result<(), String> {
    let list = monitor_list(&app);
    let target = match monitor.as_deref().filter(|m| !m.is_empty()) {
        Some(name) => list.iter().find(|(i, _)| i.name == name),
        None => list.iter().find(|(i, _)| i.primary),   // «La principal» = monitor primario
    };
    let w = match app.get_webview_window("teleprompter") {
        Some(w) => w,
        None => window_builder(&app, "teleprompter", WebviewUrl::External(page_url(&app, "/widget/teleprompter")?))
            .title("antena · teleprompter")
            .inner_size(1280.0, 720.0)
            .min_inner_size(480.0, 270.0)
            .build()
            .map_err(|e| e.to_string())?,
    };
    if let Some((_, m)) = target {
        let _ = w.set_fullscreen(false);
        let _ = w.set_position(Position::Physical(PhysicalPosition { x: m.position().x + 20, y: m.position().y + 20 }));
        if fullscreen.unwrap_or(true) {
            let _ = w.set_fullscreen(true);
        }
    } else if fullscreen.unwrap_or(true) {
        let _ = w.set_fullscreen(true);
    }
    focus(&w);
    Ok(())
}

/// Dock flotante: la misma vista que el panel de chat de Meld, en una ventana pequeña siempre encima.
#[tauri::command]
async fn open_dock(app: AppHandle, always_on_top: Option<bool>) -> Result<(), String> {
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
    Ok(())
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
    DesktopInfo {
        port: state.port,
        managed: *state.managed.lock().unwrap(),
        data_dir: plain(&state.data),
        version: app.package_info().version.to_string(),
    }
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
        // actualizaciones firmadas desde GitHub Releases (Ajustes › Acerca de); solo la ventana
        // principal puede usarlas (capability `updater`). Al instalar, la app sale y el servidor
        // se apaga solo al cerrarse su stdin (ANTENA_DESKTOP=1).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let env_dir = |name| std::env::var(name).ok().map(PathBuf::from);
            let (data, media) = server_dirs(&app_data, dev_root().as_deref(), env_dir("ANTENA_DATA"), env_dir("ANTENA_MEDIA"));
            // el puerto se lee del config.json de la carpeta que va a usar el servidor
            let port = read_port(&data);
            app.manage(Server { port, managed: Mutex::new(false), child: Mutex::new(None), data, media });
            // la ventana principal se crea aquí (y no en tauri.conf.json) para poder limitar
            // su navegación al servidor local: window_builder pone la guardia a las tres ventanas
            window_builder(app.handle(), "main", WebviewUrl::App("index.html".into()))
                .title("antena")
                .inner_size(1360.0, 860.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .background_color(Color(0x12, 0x12, 0x14, 0xff))
                .on_navigation(move |url| allowed_navigation(port, url))
                .build()?;
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            match start_server(&handle) {
                Ok(()) => {
                    std::thread::spawn(move || wait_and_open(handle));
                }
                Err(e) => {
                    eprintln!("[antena] {e}");
                    // la ventana aún está cargando la pantalla de inicio: se avisa en cuanto pueda
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(800));
                        splash_error(&handle, &e);
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, ev| {
            // cerrar el panel lo deja en la bandeja: las fuentes de Meld y el Stream Deck siguen funcionando
            if let WindowEvent::CloseRequested { api, .. } = ev {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![monitors, open_prompter, open_teleprompter, open_dock, desktop_info])
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
        assert!(allowed_navigation(4500, &externa), "las navegaciones externas no pasan por la guardia");
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
