use actix_web::{delete, get, post, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::{Path, PathBuf};
use display_info::DisplayInfo;

#[get("/")]
async fn index() -> impl Responder {
    let monitors = DisplayInfo::all().unwrap_or_default();
    if monitors.len() > 1 {
        HttpResponse::Ok()
            .content_type("text/html")
            .body(include_str!("../html/setup.html"))
    } else {
        HttpResponse::Ok()
            .content_type("text/html")
            .body(include_str!("../html/Emap.html"))
    }
}

#[get("/dashboard")]
async fn dashboard() -> impl Responder {
    HttpResponse::Ok()
        .content_type("text/html")
        .body(include_str!("../html/dashboard.html"))
}

#[get("/projection")]
async fn projection() -> impl Responder {
    HttpResponse::Ok()
        .content_type("text/html")
        .body(include_str!("../html/projection.html"))
}

#[get("/lib/babel.min.js")]
async fn babel() -> impl Responder {
    HttpResponse::Ok()
        .content_type("application/javascript")
        .body(include_str!("../html/lib/babel.min.js"))
}

#[get("/lib/tailwind.js")]
async fn tailwind() -> impl Responder {
    HttpResponse::Ok()
        .content_type("application/javascript")
        .body(include_str!("../html/lib/tailwind.js"))
}

#[get("/lib/react.min.js")]
async fn react() -> impl Responder {
    HttpResponse::Ok()
        .content_type("application/javascript")
        .body(include_str!("../html/lib/react.min.js"))
}

#[get("/lib/react-dom.min.js")]
async fn react_dom() -> impl Responder {
    HttpResponse::Ok()
        .content_type("application/javascript")
        .body(include_str!("../html/lib/react-dom.min.js"))
}

#[get("/robotic T M.png")]
async fn logo() -> impl Responder {
    HttpResponse::Ok()
        .content_type("image/png")
        .body(include_bytes!("../html/robotic T M.png") as &'static [u8])
}

// --- Database & API ---

struct AppState {
    db: Mutex<Connection>,
}

#[derive(Serialize, Deserialize)]
struct AssetMeta {
    id: String,
    name: String,
    mime_type: String,
}

#[derive(Serialize, Deserialize)]
struct AppConfig {
    control_panel_monitor_id: u32,
}

#[derive(Serialize)]
struct MonitorInfo {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_primary: bool,
}

#[get("/api/monitors")]
async fn get_monitors() -> impl Responder {
    let monitors = DisplayInfo::all().unwrap_or_default();
    let info: Vec<MonitorInfo> = monitors.into_iter().map(|m| MonitorInfo {
        id: m.id,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        is_primary: m.is_primary,
    }).collect();
    HttpResponse::Ok().json(info)
}

#[post("/api/config/monitor")]
async fn save_monitor_config(data: web::Data<AppState>, config: web::Json<AppConfig>) -> impl Responder {
    let conn = data.db.lock().unwrap();
    let config_str = serde_json::to_string(&*config).unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO system_data (key, value) VALUES (?1, ?2)",
        params!["monitor_config", config_str],
    ).unwrap();
    HttpResponse::Ok().finish()
}

#[get("/api/kv/{key}")]
async fn get_kv(data: web::Data<AppState>, key: web::Path<String>) -> impl Responder {
    let conn = data.db.lock().unwrap();
    let res: Result<String, _> = conn.query_row(
        "SELECT value FROM kv_store WHERE key = ?1",
        params![key.as_str()],
        |row| row.get(0),
    );

    match res {
        Ok(val) => HttpResponse::Ok().content_type("application/json").body(val),
        Err(_) => HttpResponse::NotFound().finish(),
    }
}

#[post("/api/kv/{key}")]
async fn save_kv(data: web::Data<AppState>, key: web::Path<String>, body: String) -> impl Responder {
    let conn = data.db.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?1, ?2)",
        params![key.as_str(), body],
    ).unwrap();
    HttpResponse::Ok().finish()
}

#[get("/api/assets")]
async fn list_assets(data: web::Data<AppState>) -> impl Responder {
    let conn = data.db.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, name, mime_type FROM assets").unwrap();
    let assets_iter = stmt.query_map([], |row| {
        Ok(AssetMeta {
            id: row.get(0)?,
            name: row.get(1)?,
            mime_type: row.get(2)?,
        })
    }).unwrap();

    let assets: Vec<AssetMeta> = assets_iter.map(|x| x.unwrap()).collect();
    HttpResponse::Ok().json(assets)
}

// --- File System Explorer API ---

#[derive(Deserialize)]
struct ListParams {
    path: Option<String>,
}

#[derive(Serialize)]
struct FileItem {
    name: String,
    path: String,
    #[serde(rename = "type")]
    type_: String, // "dir", "file", "drive"
    size: String,
}

#[derive(Serialize)]
struct ListResponse {
    path: String,
    items: Vec<FileItem>,
}

#[get("/api/fs/list")]
async fn list_files(web::Query(params): web::Query<ListParams>) -> impl Responder {
    let current_path = params.path.unwrap_or_default();
    let mut items = Vec::new();

    if current_path.is_empty() {
        // Root Level: List contents of 'assets' folder directly
        let assets_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("assets");
        if let Ok(entries) = fs::read_dir(assets_dir) {
            for entry in entries.flatten() {
                let meta = entry.metadata().ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let name = entry.file_name().to_string_lossy().to_string();
                
                if !name.starts_with('.') {
                    items.push(FileItem {
                        name,
                        path: entry.path().to_string_lossy().to_string(),
                        type_: if is_dir { "dir".to_string() } else { "file".to_string() },
                        size: if is_dir { "".to_string() } else { format_size(size) },
                    });
                }
            }
        }
    } else {
        // List contents of the requested path
        let path = PathBuf::from(&current_path);
        
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let meta = entry.metadata().ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let name = entry.file_name().to_string_lossy().to_string();
                
                if !name.starts_with('.') {
                    items.push(FileItem {
                        name,
                        path: entry.path().to_string_lossy().to_string(),
                        type_: if is_dir { "dir".to_string() } else { "file".to_string() },
                        size: if is_dir { "".to_string() } else { format_size(size) },
                    });
                }
            }
        }
    }

    // Sort: Directories first, then files
    items.sort_by(|a, b| {
        if a.type_ == "dir" && b.type_ != "dir" {
            std::cmp::Ordering::Less
        } else if a.type_ != "dir" && b.type_ == "dir" {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    HttpResponse::Ok().json(ListResponse { path: current_path, items })
}

#[derive(Deserialize)]
struct ImportRequest {
    path: String,
}

#[post("/api/asset/import")]
async fn import_asset(data: web::Data<AppState>, req: web::Json<ImportRequest>) -> impl Responder {
    let src = PathBuf::from(&req.path);
    if !src.exists() { return HttpResponse::NotFound().body("File not found"); }
    
    let name = src.file_name().unwrap().to_string_lossy().to_string();
    let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let assets_dir = run_dir.join("assets");
    let dest = assets_dir.join(&name);
    
    // Copy if not in assets dir
    if src.parent().map(|p| p != assets_dir).unwrap_or(true) {
        if let Err(e) = fs::copy(&src, &dest) {
            return HttpResponse::InternalServerError().body(e.to_string());
        }
    }

    // Add to DB
    let mime_type = mime_guess::from_path(&dest).first_or_octet_stream().to_string();
    let conn = data.db.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO assets (id, name, mime_type) VALUES (?1, ?2, ?3)",
        params![name, name, mime_type],
    ).unwrap();

    HttpResponse::Ok().body("Imported")
}

fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if bytes >= MB { format!("{:.2} MB", bytes as f64 / MB as f64) }
    else if bytes >= KB { format!("{:.2} KB", bytes as f64 / KB as f64) }
    else { format!("{} B", bytes) }
}

#[post("/api/asset/{id}")]
async fn save_asset(
    data: web::Data<AppState>,
    id: web::Path<String>, 
    req: HttpRequest, 
    body: web::Bytes
) -> impl Responder {
    let filename = req.headers().get("X-Asset-Name")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| id.into_inner());
    
    let safe_filename = Path::new(&filename).file_name().unwrap_or_default().to_string_lossy().to_string();
    if safe_filename.is_empty() { return HttpResponse::BadRequest().finish(); }

    let file_path = format!("assets/{}", safe_filename);
    if let Err(_) = fs::write(&file_path, &body) {
        return HttpResponse::InternalServerError().body("Failed to save file");
    }

    // Add to DB
    let mime_type = mime_guess::from_path(&file_path).first_or_octet_stream().to_string();
    let conn = data.db.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO assets (id, name, mime_type) VALUES (?1, ?2, ?3)",
        params![safe_filename, safe_filename, mime_type],
    ).unwrap();

    HttpResponse::Ok().finish()
}

#[get("/api/asset/{id}")]
async fn get_asset(id: web::Path<String>) -> impl Responder {
    let filename = id.into_inner();
    let safe_filename = Path::new(&filename).file_name().unwrap_or_default().to_string_lossy().to_string();
    let file_path = format!("assets/{}", safe_filename);

    if let Ok(data) = fs::read(&file_path) {
        let mime_type = if safe_filename.ends_with(".png") { "image/png" }
                        else if safe_filename.ends_with(".jpg") || safe_filename.ends_with(".jpeg") { "image/jpeg" }
                        else if safe_filename.ends_with(".mp4") { "video/mp4" }
                        else if safe_filename.ends_with(".webm") { "video/webm" }
                        else { "application/octet-stream" };
        HttpResponse::Ok().content_type(mime_type).body(data)
    } else {
        HttpResponse::NotFound().finish()
    }
}

#[delete("/api/asset/{id}")]
async fn delete_asset(data: web::Data<AppState>, id: web::Path<String>) -> impl Responder {
    let filename = id.into_inner();
    // Only delete from DB, keep file in assets folder
    let conn = data.db.lock().unwrap();
    conn.execute("DELETE FROM assets WHERE id = ?1", params![filename]).unwrap();

    HttpResponse::Ok().finish()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Create assets directory
    fs::create_dir_all("assets")?;

    // Initialize Database
    let conn = Connection::open("emap.db").expect("Failed to open database");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT
        )",
        [],
    ).expect("Failed to create kv_store table");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS system_data (
            key TEXT PRIMARY KEY,
            value TEXT
        )",
        [],
    ).expect("Failed to create system_data table");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            name TEXT,
            mime_type TEXT
        )",
        [],
    ).expect("Failed to create assets table");

    let app_state = web::Data::new(AppState {
        db: Mutex::new(conn),
    });

    println!("Starting server on http://127.0.0.1:8080");
    println!("Open http://127.0.0.1:8080 in your browser.");

    HttpServer::new(move || {
        App::new()
            // Increase upload limit to 1GB
            .app_data(web::PayloadConfig::new(1024 * 1024 * 1024))
            .app_data(app_state.clone())
            .service(index)
            .service(dashboard)
            .service(projection)
            .service(babel)
            .service(tailwind)
            .service(react)
            .service(react_dom)
            .service(logo)
            .service(get_monitors)
            .service(save_monitor_config)
            .service(get_kv)
            .service(save_kv)
            .service(list_assets)
            .service(list_files)
            .service(import_asset)
            .service(save_asset)
            .service(get_asset)
            .service(delete_asset)
    })
    .bind(("127.0.0.1", 8080))?
    .run()
    .await
}