use actix_web::{delete, get, post, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::fs;
use std::path::{Path, PathBuf};
use display_info::DisplayInfo;
use uuid::Uuid;
use actix_files::{Files, NamedFile};
use std::thread;
use futures_util::StreamExt;
use std::io::Write;
use qmetaobject::prelude::*;
use std::net::UdpSocket;

fn get_local_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|addr| addr.ip().to_string())
}

// --- Database & API (Same as before) ---

struct AppState {
    global_db: Mutex<Connection>,
    system_db: Mutex<Connection>,
    project_db: Mutex<Option<Connection>>,
    active_project_id: Mutex<Option<String>>,
}

#[derive(Serialize, Deserialize)]
struct AssetMeta { id: String, name: String, mime_type: String }

#[derive(Serialize, Deserialize)]
struct ProjectMeta { id: String, name: String, created_at: String }

#[derive(Serialize, Deserialize, Default)]
struct AppConfig { dashboard_screen_name: String }

#[derive(Serialize)]
struct MonitorInfo { id: u32, x: i32, y: i32, width: u32, height: u32, is_primary: bool }

#[derive(Deserialize)]
struct IndexQuery { screen: Option<String> }

#[get("/")]
async fn index(data: web::Data<AppState>, query: web::Query<IndexQuery>) -> impl Responder {
    let screen_name = query.screen.clone().unwrap_or_else(|| "Unknown".to_string());
    
    // Try to fetch the monitor config from the SYSTEM DB
    let config_opt: Option<AppConfig> = {
        let conn = data.system_db.lock().unwrap();
        conn.query_row("SELECT value FROM system_data WHERE key = 'monitor_config'", [], |r| {
            let s: String = r.get(0)?;
            Ok(serde_json::from_str(&s).unwrap_or_default())
        }).ok()
    };

    match config_opt {
        Some(config) => {
            if screen_name == config.dashboard_screen_name {
                return NamedFile::open_async("./ui/dist/index.html").await;
            }
            NamedFile::open_async("./ui/dist/projection.html").await
        },
        None => NamedFile::open_async("./ui/dist/setup.html").await
    }
}

#[get("/dashboard")]
async fn dashboard() -> impl Responder { NamedFile::open_async("./ui/dist/dashboard.html").await }

#[get("/projection")]
async fn projection() -> impl Responder { NamedFile::open_async("./ui/dist/projection.html").await }

#[get("/api/monitors")]
async fn get_monitors() -> impl Responder {
    let monitors = DisplayInfo::all().unwrap_or_default();
    let info: Vec<MonitorInfo> = monitors.into_iter().map(|m| MonitorInfo {
        id: m.id, x: m.x, y: m.y, width: m.width, height: m.height, is_primary: m.is_primary,
    }).collect();
    HttpResponse::Ok().json(info)
}

#[post("/api/config/monitor")]
async fn save_monitor_config(data: web::Data<AppState>, config: web::Json<AppConfig>) -> impl Responder {
    let config_val = config.into_inner();
    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        let config_str = serde_json::to_string(&config_val).unwrap();
        conn.execute("INSERT OR REPLACE INTO system_data (key, value) VALUES (?1, ?2)", params!["monitor_config", config_str])
    }).await;
    match res { Ok(_) => HttpResponse::Ok().finish(), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[get("/api/config/monitor")]
async fn get_monitor_config(data: web::Data<AppState>) -> impl Responder {
    let config_opt: Option<AppConfig> = {
        let conn = data.system_db.lock().unwrap();
        conn.query_row("SELECT value FROM system_data WHERE key = 'monitor_config'", [], |r| {
            let s: String = r.get(0)?;
            Ok(serde_json::from_str(&s).unwrap_or_default())
        }).ok()
    };
    match config_opt { Some(c) => HttpResponse::Ok().json(c), None => HttpResponse::NotFound().finish() }
}

#[post("/api/config/reset")]
async fn reset_monitor_config(data: web::Data<AppState>) -> impl Responder {
    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        conn.execute("DELETE FROM system_data WHERE key = 'monitor_config'", [])
    }).await;
    match res { Ok(_) => HttpResponse::Ok().finish(), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[get("/api/projects")]
async fn list_projects(data: web::Data<AppState>) -> impl Responder {
    let res = web::block(move || {
        let conn = data.global_db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, created_at FROM projects ORDER BY created_at DESC").unwrap();
        let projects_iter = stmt.query_map([], |row| Ok(ProjectMeta { id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)? })).unwrap();
        projects_iter.map(|x| x.unwrap()).collect::<Vec<ProjectMeta>>()
    }).await;
    match res { Ok(projects) => HttpResponse::Ok().json(projects), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct CreateProjectReq { name: String }

#[post("/api/projects")]
async fn create_project(data: web::Data<AppState>, req: web::Json<CreateProjectReq>) -> impl Responder {
    let req_name = req.name.clone();
    let res = web::block(move || {
        let id = Uuid::new_v4().to_string();
        let created_at = chrono::Local::now().to_rfc3339();
        {
            let conn = data.global_db.lock().unwrap();
            conn.execute("INSERT INTO projects (id, name, created_at) VALUES (?1, ?2, ?3)", params![id, req_name, created_at]).unwrap();
        }
        let _ = init_project_db(&id);
        load_project_internal(&data, &id);
        id
    }).await;
    match res { Ok(id) => HttpResponse::Ok().json(serde_json::json!({ "id": id })), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[delete("/api/projects/{id}")]
async fn delete_project(data: web::Data<AppState>, id: web::Path<String>) -> impl Responder {
    let project_id = id.into_inner();
    println!("[BACKEND] Request to delete project: {}", project_id);
    
    let res = web::block(move || {
        // 1. Check if it's the active project and clear it if so
        {
            let mut active_id_guard = data.active_project_id.lock().unwrap();
            if active_id_guard.as_ref() == Some(&project_id) {
                println!("[BACKEND] Deleting active project, clearing session...");
                *active_id_guard = None;
                let mut db_guard = data.project_db.lock().unwrap();
                *db_guard = None; // Drop the connection
                
                // Clear from system_db last_id as well
                let system = data.system_db.lock().unwrap();
                let _ = system.execute("DELETE FROM system_data WHERE key = 'last_project_id'", []);
            }
        }

        // 2. Delete from projects.db
        {
            let conn = data.global_db.lock().unwrap();
            conn.execute("DELETE FROM projects WHERE id = ?1", params![&project_id]).unwrap();
        }

        let project_dir = PathBuf::from("projects").join(&project_id);
        if project_dir.exists() {
            println!("[BACKEND] Removing project directory: {:?}", project_dir);
            let _ = fs::remove_dir_all(project_dir);
        }
        true
    }).await;
    match res { Ok(_) => HttpResponse::Ok().finish(), Err(_) => HttpResponse::InternalServerError().finish() }
}

fn purge_orphaned_projects(global_db: &Connection) {
    println!("[BACKEND] Checking for orphaned project files/folders...");
    let mut stmt = global_db.prepare("SELECT id FROM projects").unwrap();
    let valid_ids: std::collections::HashSet<String> = stmt.query_map([], |row| row.get(0)).unwrap()
        .map(|x| x.unwrap()).collect();

    if let Ok(entries) = fs::read_dir("projects") {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(dir_name) = path.file_name().and_then(|s| s.to_str()) {
                    if !valid_ids.contains(dir_name) {
                        println!("[BACKEND] Purging orphaned project folder: {:?}", path);
                        let _ = fs::remove_dir_all(&path);
                    }
                }
            } else if path.extension().and_then(|s| s.to_str()) == Some("db") {
                if let Some(file_name) = path.file_stem().and_then(|s| s.to_str()) {
                    if !valid_ids.contains(file_name) {
                        println!("[BACKEND] Purging legacy database file: {:?}", path);
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
    }
}

#[post("/api/projects/{id}/load")]
async fn load_project(data: web::Data<AppState>, id: web::Path<String>) -> impl Responder {
    let project_id = id.into_inner();
    let res = web::block(move || load_project_internal(&data, &project_id)).await;
    match res { Ok(true) => HttpResponse::Ok().body("Loaded"), Ok(false) => HttpResponse::NotFound().body("Project not found"), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[get("/api/project/active")]
async fn get_active_project(data: web::Data<AppState>) -> impl Responder {
    let res = web::block(move || {
        let id_guard = data.active_project_id.lock().unwrap();
        match &*id_guard {
            Some(id) => {
                let conn = data.global_db.lock().unwrap();
                let name: String = conn.query_row("SELECT name FROM projects WHERE id = ?1", params![id], |r| r.get(0)).unwrap_or("Unknown".to_string());
                Some(serde_json::json!({ "id": id, "name": name }))
            },
            None => None
        }
    }).await;
    match res { Ok(Some(json)) => HttpResponse::Ok().json(json), Ok(None) => HttpResponse::NotFound().finish(), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[get("/api/kv/{key}")]
async fn get_kv(data: web::Data<AppState>, key: web::Path<String>) -> impl Responder {
    let key_str = key.into_inner();
    let res = web::block(move || {
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return None };
        let res: Result<String, _> = conn.query_row("SELECT value FROM kv_store WHERE key = ?1", params![key_str], |row| row.get(0));
        res.ok()
    }).await;
    match res { 
        Ok(Some(val)) => HttpResponse::Ok().content_type("application/json").body(val), 
        Ok(None) => HttpResponse::NotFound().finish(), 
        Err(e) => {
            println!("[BACKEND ERROR] get_kv block error: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[post("/api/kv/{key}")]
async fn save_kv(data: web::Data<AppState>, key: web::Path<String>, body: String) -> impl Responder {
    let key_str = key.into_inner();
    let content_len = body.len();
    let res = web::block(move || {
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { 
            Some(c) => c, 
            None => {
                // Silent return when no project is loaded
                return false; 
            }
        };
        match conn.execute("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?1, ?2)", params![key_str, body]) {
            Ok(_) => true,
            Err(e) => {
                println!("[BACKEND ERROR] DB Execute failed in save_kv (key: {}, len: {}): {}", key_str, content_len, e);
                false
            }
        }
    }).await;
    match res { 
        Ok(true) => HttpResponse::Ok().finish(), 
        Ok(false) => HttpResponse::BadRequest().body("No active project"), // This is handled silently by frontend
        Err(e) => {
            println!("[BACKEND ERROR] save_kv block error: {}", e);
            HttpResponse::InternalServerError().finish() 
        }
    }
}

#[get("/api/assets")]
async fn list_assets(data: web::Data<AppState>) -> impl Responder {
    let res = web::block(move || {
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return Vec::new() };
        let mut stmt = conn.prepare("SELECT id, name, mime_type FROM assets").unwrap();
        let assets_iter = stmt.query_map([], |row| Ok(AssetMeta { id: row.get(0)?, name: row.get(1)?, mime_type: row.get(2)? })).unwrap();
        assets_iter.map(|x| x.unwrap()).collect::<Vec<AssetMeta>>()
    }).await;
    match res { Ok(assets) => HttpResponse::Ok().json(assets), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct ListParams { path: Option<String> }
#[derive(Serialize)]
struct FileItem { name: String, path: String, #[serde(rename = "type")] type_: String, size: String }
#[derive(Serialize)]
struct ListResponse { path: String, items: Vec<FileItem> }

#[get("/api/fs/list")]
async fn list_files(web::Query(params): web::Query<ListParams>) -> impl Responder {
    let current_path = params.path.unwrap_or_default();
    let current_path_clone = current_path.clone();
    let res = web::block(move || {
        let mut items = Vec::new();
        let path = if current_path_clone.is_empty() { std::env::current_dir().unwrap_or_default().join("assets") } else { PathBuf::from(&current_path_clone) };
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let meta = entry.metadata().ok();
                let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    items.push(FileItem {
                        name, path: entry.path().to_string_lossy().to_string(),
                        type_: if is_dir { "dir".to_string() } else { "file".to_string() },
                        size: if is_dir { "".to_string() } else { format!("{:.2} MB", meta.as_ref().map(|m| m.len()).unwrap_or(0) as f64 / 1024.0 / 1024.0) },
                    });
                }
            }
        }
        items.sort_by(|a, b| if a.type_ == "dir" && b.type_ != "dir" { std::cmp::Ordering::Less } else if a.type_ != "dir" && b.type_ == "dir" { std::cmp::Ordering::Greater } else { a.name.cmp(&b.name) });
        ListResponse { path: current_path_clone, items }
    }).await;
    match res { Ok(response) => HttpResponse::Ok().json(response), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct ImportRequest { path: String, overwrite: Option<bool> }

#[derive(Deserialize)]
struct DeleteFileRequest { path: String }

#[post("/api/fs/delete")]
async fn delete_fs_file(req: web::Json<DeleteFileRequest>) -> impl Responder {
    let path = PathBuf::from(&req.path);
    println!("[BACKEND] Request to delete file: {:?}", path);
    
    // Safety: Only allow deleting files in known asset areas or USB drives
    // For now, we trust the path but could add more guards.
    let res = web::block(move || {
        if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
    }).await;

    match res {
        Ok(Ok(_)) => HttpResponse::Ok().finish(),
        _ => HttpResponse::InternalServerError().finish()
    }
}

#[get("/api/drives")]
async fn get_drives() -> impl Responder {
    let res = web::block(move || {
        let mut drives = Vec::new();
        #[cfg(target_os = "linux")]
        let mount_points = vec![
            format!("/media/{}", std::env::var("USER").unwrap_or_default()),
            format!("/run/media/{}", std::env::var("USER").unwrap_or_default()),
            "/media".to_string(),
            "/mnt".to_string(),
        ];
        #[cfg(target_os = "freebsd")]
        let mount_points = vec!["/media".to_string(), "/mnt".to_string()];
        #[cfg(not(any(target_os = "linux", target_os = "freebsd")))]
        let mount_points: Vec<String> = vec![];

        for mp in mount_points {
            if let Ok(entries) = fs::read_dir(mp) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_dir() {
                            drives.push(FileItem {
                                name: entry.file_name().to_string_lossy().to_string(),
                                path: entry.path().to_string_lossy().to_string(),
                                type_: "drive".to_string(),
                                size: "".to_string(),
                            });
                        }
                    }
                }
            }
        }
        drives
    }).await;
    match res { Ok(drives) => HttpResponse::Ok().json(drives), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[post("/api/asset/import")]
async fn import_asset(data: web::Data<AppState>, req: web::Json<ImportRequest>) -> impl Responder {
    let req_path = req.path.clone();
    let overwrite = req.overwrite.unwrap_or(false);
    println!("[BACKEND] Import request: {} (overwrite: {})", req_path, overwrite);
    let res = web::block(move || {
        let src = PathBuf::from(&req_path);
        if !src.exists() { return Err("File not found".to_string()); }
        let name = src.file_name().unwrap().to_string_lossy().to_string();
        let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let assets_dir = run_dir.join("assets");
        let dest = assets_dir.join(&name);
        
        if dest.exists() && !overwrite {
            return Err("Conflict".to_string());
        }

        if src.parent().map(|p| p != assets_dir).unwrap_or(true) { fs::copy(&src, &dest).map_err(|e| e.to_string())?; }
        let mime_type = mime_guess::from_path(&dest).first_or_octet_stream().to_string();
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return Err("No project".to_string()) };
        conn.execute("INSERT OR REPLACE INTO assets (id, name, mime_type) VALUES (?1, ?2, ?3)", params![name, name, mime_type]).unwrap();
        Ok(name)
    }).await;
    match res { 
        Ok(Ok(name)) => HttpResponse::Ok().json(serde_json::json!({ "status": "imported", "id": name })),
        Ok(Err(e)) if e == "Conflict" => HttpResponse::Conflict().body("File already exists"),
        _ => HttpResponse::InternalServerError().finish() 
    }
}

#[post("/api/asset/{id}")]
async fn save_asset(data: web::Data<AppState>, id: web::Path<String>, req: HttpRequest, mut payload: web::Payload) -> impl Responder {
    let filename = req.headers().get("X-Asset-Name").and_then(|h| h.to_str().ok()).map(|s| s.to_string()).unwrap_or_else(|| id.into_inner());
    let safe_filename = Path::new(&filename).file_name().unwrap_or_default().to_string_lossy().to_string();
    let file_path = format!("assets/{}", safe_filename);
    let mut f = fs::File::create(&file_path).unwrap();
    while let Some(chunk) = payload.next().await { f.write_all(&chunk.unwrap()).unwrap(); }
    let safe_filename_clone = safe_filename.clone();
    let res = web::block(move || {
        let mime_type = mime_guess::from_path(&file_path).first_or_octet_stream().to_string();
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return false };
        conn.execute("INSERT OR REPLACE INTO assets (id, name, mime_type) VALUES (?1, ?2, ?3)", params![safe_filename_clone, safe_filename_clone, mime_type]).is_ok()
    }).await;
    if res.unwrap() { HttpResponse::Ok().finish() } else { HttpResponse::InternalServerError().finish() }
}

#[get("/api/asset/{id}")]
async fn get_asset(req: HttpRequest, id: web::Path<String>) -> impl Responder {
    let file_path = format!("assets/{}", id.into_inner());
    match NamedFile::open_async(file_path).await { Ok(file) => file.into_response(&req), Err(_) => HttpResponse::NotFound().finish() }
}

#[delete("/api/asset/{id}")]
async fn delete_asset(data: web::Data<AppState>, id: web::Path<String>) -> impl Responder {
    let filename = id.into_inner();
    let res = web::block(move || {
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return false };
        conn.execute("DELETE FROM assets WHERE id = ?1", params![filename]).is_ok()
    }).await;
    if res.unwrap() { HttpResponse::Ok().finish() } else { HttpResponse::InternalServerError().finish() }
}

fn init_project_db(id: &str) -> Result<Connection, rusqlite::Error> {
    let dir_path = PathBuf::from("projects").join(id);
    let _ = fs::create_dir_all(&dir_path);
    let path = dir_path.join("project.db");
    
    println!("[DB] Opening project database at: {:?}", path);
    
    let conn = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | 
        rusqlite::OpenFlags::SQLITE_OPEN_CREATE | 
        rusqlite::OpenFlags::SQLITE_OPEN_FULL_MUTEX
    )?;

    conn.busy_timeout(std::time::Duration::from_millis(5000))?;
    
    // Attempt to enable WAL mode, but don't fail if it returns an error (e.g. if already open)
    match conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0)) {
        Ok(mode) => println!("[DB] Project {} journal mode: {}", id, mode),
        Err(e) => println!("[DB WARNING] Could not set WAL mode for {}: {}", id, e),
    }

    conn.execute("CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)", [])?;
    conn.execute("CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT, mime_type TEXT)", [])?;
    
    Ok(conn)
}

fn load_project_internal(data: &AppState, id: &str) -> bool {
    println!("[BACKEND] Attempting to load project: {}", id);
    if let Ok(conn) = init_project_db(id) {
        let mut db_guard = data.project_db.lock().unwrap();
        *db_guard = Some(conn);
        let mut id_guard = data.active_project_id.lock().unwrap();
        *id_guard = Some(id.to_string());
        let system = data.system_db.lock().unwrap();
        let _ = system.execute("INSERT OR REPLACE INTO system_data (key, value) VALUES ('last_project_id', ?1)", params![id]);
        println!("[BACKEND] Project {} loaded successfully", id);
        true
    } else { 
        println!("[BACKEND ERROR] Failed to initialize project DB for {}", id);
        false 
    }
}

// --- MAIN RUNTIME ---

fn main() {
    let (server_tx, server_rx) = std::sync::mpsc::channel();

    thread::spawn(move || {
        let sys = actix_web::rt::System::new();
        sys.block_on(async {
            let _ = fs::create_dir_all("assets");
            let _ = fs::create_dir_all("projects");
            let _ = fs::create_dir_all("system_data");
            
            // System DB for global configuration (monitors, etc)
            let system_conn = Connection::open_with_flags(
                "system_data/system.db",
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | 
                rusqlite::OpenFlags::SQLITE_OPEN_CREATE | 
                rusqlite::OpenFlags::SQLITE_OPEN_FULL_MUTEX
            ).expect("System DB error");
            system_conn.busy_timeout(std::time::Duration::from_millis(5000)).unwrap();
            let _ = system_conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()));
            system_conn.execute("CREATE TABLE IF NOT EXISTS system_data (key TEXT PRIMARY KEY, value TEXT)", []).unwrap();
            
            // Global DB for project management
            let global_conn = Connection::open_with_flags(
                "system_data/projects.db",
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | 
                rusqlite::OpenFlags::SQLITE_OPEN_CREATE | 
                rusqlite::OpenFlags::SQLITE_OPEN_FULL_MUTEX
            ).expect("Projects DB error");
            global_conn.busy_timeout(std::time::Duration::from_millis(5000)).unwrap();
            let _ = global_conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()));
            global_conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, created_at TEXT)", []).unwrap();
            
            // Clean up old files
            purge_orphaned_projects(&global_conn);
            
            let app_state = web::Data::new(AppState {
                global_db: Mutex::new(global_conn), 
                system_db: Mutex::new(system_conn),
                project_db: Mutex::new(None), 
                active_project_id: Mutex::new(None),
            });

            // Removed automatic loading of last_id to force user to pick a project every time.

            let server = HttpServer::new(move || {
                App::new()
                    .app_data(web::PayloadConfig::new(10 * 1024 * 1024 * 1024))
                    .app_data(app_state.clone())
                    .service(index).service(dashboard).service(projection)
                    .service(get_monitors).service(save_monitor_config).service(get_monitor_config).service(reset_monitor_config).service(list_projects).service(delete_project).service(create_project)
                    .service(load_project).service(get_active_project).service(get_kv).service(save_kv).service(list_assets)
                    .service(list_files).service(import_asset).service(save_asset).service(get_asset).service(delete_asset)
                    .service(get_drives).service(delete_fs_file)
                    .service(Files::new("/", "./ui/dist").index_file("index.html"))
            })
            .bind(("0.0.0.0", 8080)).unwrap();

            let local_ip = get_local_ip();
            
            let _ = server_tx.send(());
            println!("\n==========================================");
            println!("Emap Server is running!");
            println!("Local access:   http://127.0.0.1:8080");
            
            match local_ip {
                Some(ip) if ip != "127.0.0.1" => {
                    println!("Network access: http://{}:8080", ip);
                },
                _ => {
                    println!("Network access: [OFFLINE] No network connection detected.");
                }
            }
            println!("==========================================\n");
            server.run().await.unwrap();
        });
    });

    let _ = server_rx.recv();
    println!("Server started, launching Qt window...");

    // Print detected monitors from Rust perspective too
    if let Ok(monitors) = DisplayInfo::all() {
        println!("Rust detected {} monitors:", monitors.len());
        for (i, m) in monitors.iter().enumerate() {
            println!("  {}: {}x{} at ({},{}) primary={}", i, m.width, m.height, m.x, m.y, m.is_primary);
        }
    }

    let mut engine = QmlEngine::new();
    
    // Initialize WebEngine
    engine.load_data(r#"
        import QtQuick
        import QtQuick.Window
        import QtWebEngine
        import QtQml

        Item {
            id: root
            
            Component.onCompleted: {
                console.log("QML: Starting Emap Projection System");
                console.log("QML: Detected " + Qt.application.screens.length + " screens");
                for (var i = 0; i < Qt.application.screens.length; i++) {
                    console.log("QML: Screen " + i + ": " + Qt.application.screens[i].name + 
                                " (" + Qt.application.screens[i].width + "x" + Qt.application.screens[i].height + ")");
                }
            }

            Instantiator {
                model: Qt.application.screens
                delegate: Window {
                    id: win
                    visible: true
                    
                    // Explicitly set coordinates to help the compositor (especially on Wayland/Hyprland)
                    x: modelData.virtualX
                    y: modelData.virtualY
                    width: modelData.width
                    height: modelData.height
                    
                    visibility: Window.FullScreen
                    screen: modelData
                    title: "Emap - " + modelData.name
                    color: "black"

                    Component.onCompleted: {
                        console.log("QML: Created window for " + modelData.name + 
                                    " at " + x + "," + y + " (" + width + "x" + height + ")");
                    }

                    WebEngineView {
                        anchors.fill: parent
                        // Pass the screen name to the backend so it can decide what to serve
                        url: "http://127.0.0.1:8080/?screen=" + encodeURIComponent(modelData.name)
                        
                        settings.pluginsEnabled: true
                        settings.playbackRequiresUserGesture: false
                        settings.javascriptCanAccessClipboard: true
                        settings.accelerated2dCanvasEnabled: true
                        settings.webGLEnabled: true
                        
                        onLoadingChanged: function(loadRequest) {
                            if (loadRequest.status === WebEngineView.LoadFailedStatus) {
                                console.error("QML: Load failed for " + loadRequest.url + " : " + loadRequest.errorString);
                            } else if (loadRequest.status === WebEngineView.LoadSucceededStatus) {
                                console.log("QML: Load succeeded for " + loadRequest.url);
                            }
                        }

                        onFullScreenRequested: function(request) {
                            request.accept()
                        }
                        onContextMenuRequested: function(request) {
                            request.accepted = true // This disables the menu
                        }
                    }
                }
            }
        }
    "#.into());

    engine.exec();
}