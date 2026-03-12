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
use qmetaobject::{QmlComponent, ComponentStatus};
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
    discovered_monitors: Mutex<Vec<MonitorInfo>>,
    monitor_config: Mutex<Option<AppConfig>>,
}

#[derive(Serialize, Deserialize)]
struct AssetMeta { id: String, name: String, path: String, mime_type: String, #[serde(default)] tags: Vec<String> }

#[derive(Serialize, Deserialize)]
struct ProjectMeta { id: String, name: String, created_at: String }

#[derive(Serialize, Deserialize, Default, Clone)]
struct AppConfig { 
    #[serde(default)]
    dashboard_screen_name: String 
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct MonitorInfo { id: u32, name: String, x: i32, y: i32, width: u32, height: u32, is_primary: bool }

#[derive(Deserialize)]
struct IndexQuery { screen: Option<String> }

#[get("/")]
async fn index(_req: HttpRequest, data: web::Data<AppState>, query: web::Query<IndexQuery>) -> impl Responder {
    let screen_name = query.screen.clone().unwrap_or_else(|| "Unknown".to_string());
    
    let config_opt = {
        let config = data.monitor_config.lock().unwrap();
        config.clone()
    };

    println!("[BACKEND] [INDEX] Request from screen: '{}'", screen_name);

    let response_file = match config_opt {
        Some(config) if !config.dashboard_screen_name.is_empty() => {
            let is_dashboard = screen_name.trim() == config.dashboard_screen_name.trim();
            println!("[BACKEND] [INDEX] Comparing screen_name: '{}' (len:{}) with dashboard: '{}' (len:{}). Match: {}", 
                screen_name, screen_name.len(), config.dashboard_screen_name, config.dashboard_screen_name.len(), is_dashboard);
            
            if is_dashboard {
                println!("[BACKEND] [INDEX] Serving DASHBOARD to '{}'", screen_name);
                "./ui/dist/index.html"
            } else {
                println!("[BACKEND] [INDEX] Serving PROJECTION to '{}'", screen_name);
                "./ui/dist/projection.html"
            }
        },
        _ => {
            println!("[BACKEND] [INDEX] No monitor configuration found. Serving SETUP to '{}'", screen_name);
            "./ui/dist/setup.html"
        }
    };

    NamedFile::open_async(response_file).await.unwrap()
        .customize()
        .insert_header(("Cache-Control", "no-store, must-revalidate, max-age=0"))
        .insert_header(("Pragma", "no-cache"))
        .insert_header(("Expires", "0"))
}

#[derive(Serialize)]
struct SyncResponse {
    project_data: Option<serde_json::Value>,
    active_selection: Option<serde_json::Value>,
    ui_sync: Option<serde_json::Value>,
    monitor_config: Option<AppConfig>,
}

#[get("/api/sync")]
async fn sync_all(data: web::Data<AppState>) -> impl Responder {
    let data_clone = data.clone();
    let res = web::block(move || {
        let db_guard = data_clone.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return (None, None, None) };
        
        let project_data: Option<serde_json::Value> = conn.query_row("SELECT value FROM kv_store WHERE key = 'project_data_v22'", [], |r| {
            let s: String = r.get(0)?;
            Ok(serde_json::from_str(&s).unwrap_or_default())
        }).ok();

        let active_selection: Option<serde_json::Value> = conn.query_row("SELECT value FROM kv_store WHERE key = 'active_cue_selection'", [], |r| {
            let s: String = r.get(0)?;
            Ok(serde_json::from_str(&s).unwrap_or_default())
        }).ok();

        let ui_sync: Option<serde_json::Value> = conn.query_row("SELECT value FROM kv_store WHERE key = 'ui_sync_state'", [], |r| {
            let s: String = r.get(0)?;
            Ok(serde_json::from_str(&s).unwrap_or_default())
        }).ok();

        (project_data, active_selection, ui_sync)
    }).await;

    let (project_data, active_selection, ui_sync) = match res {
        Ok(v) => v,
        Err(_) => (None, None, None),
    };

    let monitor_config = {
        let config = data.monitor_config.lock().unwrap();
        config.clone()
    };

    HttpResponse::Ok().json(SyncResponse {
        project_data,
        active_selection,
        ui_sync,
        monitor_config,
    })
}

#[get("/dashboard")]
async fn dashboard() -> impl Responder { NamedFile::open_async("./ui/dist/dashboard.html").await }

#[get("/projection")]
async fn projection() -> impl Responder { NamedFile::open_async("./ui/dist/projection.html").await }

#[get("/api/monitors")]
async fn get_monitors(data: web::Data<AppState>) -> impl Responder {
    let monitors = data.discovered_monitors.lock().unwrap();
    // println!("[BACKEND] [MONITOR] Returning {} discovered monitors", monitors.len());
    HttpResponse::Ok().json(monitors.clone())
}

#[post("/api/monitors/register")]
async fn register_monitor(data: web::Data<AppState>, monitor: web::Json<MonitorInfo>) -> impl Responder {
    let mut monitors = data.discovered_monitors.lock().unwrap();
    let m = monitor.into_inner();
    
    if let Some(existing) = monitors.iter_mut().find(|x| x.name == m.name) {
        if existing.x != m.x || existing.y != m.y || existing.width != m.width || existing.height != m.height {
            println!("[BACKEND] [MONITOR] Updated: '{}' -> ({}x{} at {},{})", m.name, m.width, m.height, m.x, m.y);
            *existing = m;
        }
    } else {
        println!("[BACKEND] [MONITOR] Registered: '{}' ({}x{} at {},{})", m.name, m.width, m.height, m.x, m.y);
        monitors.push(m);
    }
    HttpResponse::Ok().finish()
}

#[post("/api/config/monitor")]
async fn save_monitor_config(data: web::Data<AppState>, config: web::Json<AppConfig>) -> impl Responder {
    let config_val = config.into_inner();
    println!("[BACKEND] [CONFIG] Saving monitor configuration: Dashboard = '{}'", config_val.dashboard_screen_name);
    
    let config_clone = config_val.clone();
    {
        let mut cache = data.monitor_config.lock().unwrap();
        *cache = Some(config_clone);
    }

    let res = web::block(move || {
        let conn = data.system_db.lock().map_err(|_| "Failed to lock system DB")?;
        let config_str = serde_json::to_string(&config_val).map_err(|_| "Failed to serialize config")?;
        conn.execute("INSERT OR REPLACE INTO system_data (key, value) VALUES (?1, ?2)", params!["monitor_config", config_str])
            .map_err(|e| {
                println!("[BACKEND ERROR] [CONFIG] Database error in save_monitor_config: {}", e);
                "Database error"
            })
    }).await;

    match res { 
        Ok(_) => {
            println!("[BACKEND] [CONFIG] Successfully saved to database.");
            HttpResponse::Ok().finish()
        }, 
        Err(e) => {
            println!("[BACKEND ERROR] [CONFIG] Failed to save monitor config: {}", e);
            HttpResponse::InternalServerError().body(e.to_string())
        }
    }
}

#[get("/api/config/monitor")]
async fn get_monitor_config(data: web::Data<AppState>) -> impl Responder {
    let config_opt = {
        let config = data.monitor_config.lock().unwrap();
        config.clone()
    };
    match config_opt { 
        Some(c) if !c.dashboard_screen_name.is_empty() => {
            HttpResponse::Ok()
                .insert_header(("Cache-Control", "no-store"))
                .json(c)
        },
        _ => {
            // println!("[BACKEND] [CONFIG] No dashboard configuration found (Returning 404)");
            HttpResponse::NotFound()
                .insert_header(("Cache-Control", "no-store"))
                .finish()
        }
    }
}

#[post("/api/config/reset")]
async fn reset_monitor_config(data: web::Data<AppState>) -> impl Responder {
    println!("[BACKEND] Monitor configuration RESET requested - Clearing all screens");
    {
        let mut cache = data.monitor_config.lock().unwrap();
        *cache = None;
    }

    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        conn.execute("DELETE FROM system_data WHERE key = 'monitor_config'", [])
    }).await;
    match res { Ok(_) => HttpResponse::Ok().finish(), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct TagRequest { path: String, tag: String }

#[get("/api/tags/all")]
async fn get_all_tags(data: web::Data<AppState>) -> impl Responder {
    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT DISTINCT tag FROM image_tags ORDER BY tag ASC").unwrap();
        let tags_iter = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        tags_iter.map(|x| x.unwrap()).collect::<Vec<String>>()
    }).await;
    match res { Ok(tags) => HttpResponse::Ok().json(tags), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[get("/api/tags")]
async fn get_tags(data: web::Data<AppState>, query: web::Query<PreviewQuery>) -> impl Responder {
    let path_str = query.path.clone();
    if !std::path::Path::new(&path_str).exists() {
        return HttpResponse::Ok().json(Vec::<String>::new());
    }
    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT tag FROM image_tags WHERE path = ?1").unwrap();
        let tags_iter = stmt.query_map(params![path_str], |row| row.get::<_, String>(0)).unwrap();
        tags_iter.map(|x| x.unwrap()).collect::<Vec<String>>()
    }).await;
    match res { Ok(tags) => HttpResponse::Ok().json(tags), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[post("/api/tags/add")]
async fn add_tag(data: web::Data<AppState>, req: web::Json<TagRequest>) -> impl Responder {
    let r = req.into_inner();
    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        conn.execute("INSERT OR IGNORE INTO image_tags (path, tag) VALUES (?1, ?2)", params![r.path, r.tag])
    }).await;
    match res { Ok(_) => HttpResponse::Ok().finish(), Err(_) => HttpResponse::InternalServerError().finish() }
}

#[post("/api/tags/remove")]
async fn remove_tag(data: web::Data<AppState>, req: web::Json<TagRequest>) -> impl Responder {
    let r = req.into_inner();
    let res = web::block(move || {
        let conn = data.system_db.lock().unwrap();
        conn.execute("DELETE FROM image_tags WHERE path = ?1 AND tag = ?2", params![r.path, r.tag])
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
    let data_clone = data.clone();
    let res = web::block(move || {
        let db_guard = data_clone.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return Ok(Vec::new()) };
        let mut stmt = conn.prepare("SELECT id, name, path, mime_type FROM assets").unwrap();
        let assets_iter = stmt.query_map([], |row| {
            Ok(AssetMeta { 
                id: row.get(0)?, 
                name: row.get(1)?, 
                path: row.get(2)?, 
                mime_type: row.get(3)?,
                tags: Vec::new()
            })
        }).unwrap();
        
        let mut assets: Vec<AssetMeta> = assets_iter.map(|x| x.unwrap()).collect();
        
        // Fetch tags from system_db
        let sys_conn = data_clone.system_db.lock().unwrap();
        for asset in &mut assets {
            let mut tag_stmt = sys_conn.prepare("SELECT tag FROM image_tags WHERE path = ?1").unwrap();
            let tags = tag_stmt.query_map(params![asset.path], |r| r.get::<_, String>(0)).unwrap()
                .map(|x| x.unwrap()).collect();
            asset.tags = tags;
        }
        
        Ok::<Vec<AssetMeta>, rusqlite::Error>(assets)
    }).await;
    match res { Ok(Ok(assets)) => HttpResponse::Ok().json(assets), _ => HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct ListParams { path: Option<String> }
#[derive(Serialize)]
struct FileItem { name: String, path: String, #[serde(rename = "type")] type_: String, size: String, #[serde(default)] tags: Vec<String> }
#[derive(Serialize)]
struct ListResponse { path: String, items: Vec<FileItem> }

#[get("/api/fs/list")]
async fn list_files(data: web::Data<AppState>, web::Query(params): web::Query<ListParams>) -> impl Responder {
    let current_path = params.path.unwrap_or_default();
    let current_path_clone = current_path.clone();
    let data_clone = data.clone();
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
                        tags: Vec::new(),
                    });
                }
            }
        }
        
        // Fetch tags for files - ONLY if the path is within the current working directory
        let sys_conn = data_clone.system_db.lock().unwrap();
        let cwd = std::env::current_dir().unwrap_or_default();
        
        for item in &mut items {
            if item.type_ == "file" {
                let item_path = PathBuf::from(&item.path);
                // Only provide tags if the file is local (within CWD)
                if item_path.starts_with(&cwd) {
                    let mut tag_stmt = sys_conn.prepare("SELECT tag FROM image_tags WHERE path = ?1").unwrap();
                    let tags = tag_stmt.query_map(params![item.path], |r| r.get::<_, String>(0)).unwrap()
                        .map(|x| x.unwrap()).collect();
                    item.tags = tags;
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
async fn delete_fs_file(data: web::Data<AppState>, req: web::Json<DeleteFileRequest>) -> impl Responder {
    let path_str = req.path.clone();
    let path = PathBuf::from(&path_str);
    println!("[BACKEND] Request to delete file from disk: {:?}", path);
    
    let res = web::block(move || {
        // Delete previews first if they exist
        let base_name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
        let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let previews_dir = run_dir.join("assets").join(".previews");
        
        let p1080 = previews_dir.join(format!("{}_1080p.{}", base_name, ext));
        let p720 = previews_dir.join(format!("{}_720p.{}", base_name, ext));
        
        if p1080.exists() { let _ = fs::remove_file(p1080); }
        if p720.exists() { let _ = fs::remove_file(p720); }

        // 1. Delete from Disk
        let disk_res = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };

        if disk_res.is_ok() {
            // 2. Remove from active project library if it was linked
            let db_guard = data.project_db.lock().unwrap();
            if let Some(conn) = &*db_guard {
                let _ = conn.execute("DELETE FROM assets WHERE path = ?1", params![path_str]);
            }
        }
        disk_res
    }).await;

    match res {
        Ok(Ok(_)) => HttpResponse::Ok().finish(),
        _ => HttpResponse::InternalServerError().finish()
    }
}

#[derive(Deserialize)]
struct ProcessQuery { name: String }

#[post("/api/fs/process")]
async fn process_image_asset(query: web::Query<ProcessQuery>) -> impl Responder {
    let name = query.name.clone();
    let res = web::block(move || {
        let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let assets_dir = run_dir.join("assets");
        let previews_dir = assets_dir.join(".previews");
        let _ = fs::create_dir_all(&previews_dir);
        
        let src = assets_dir.join(&name);
        if !src.exists() { return Err("Not found"); }
        
        let mime_type = mime_guess::from_path(&src).first_or_octet_stream().to_string();
        if mime_type.starts_with("image/") && !mime_type.contains("svg") {
            let base_name = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let ext = src.extension().unwrap_or_default().to_string_lossy().to_string();
            let p1080 = previews_dir.join(format!("{}_1080p.{}", base_name, ext));
            let p720 = previews_dir.join(format!("{}_720p.{}", base_name, ext));
            
            let _ = std::process::Command::new("magick").arg(&src).arg("-resize").arg("1920x1080>").arg(&p1080).output();
            let _ = std::process::Command::new("magick").arg(&src).arg("-resize").arg("1280x720>").arg(&p720).output();
        }
        Ok(())
    }).await;
    match res { Ok(Ok(_)) => HttpResponse::Ok().finish(), _ => HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct PreviewQuery { path: String }

#[get("/api/fs/preview")]
async fn get_fs_preview(req: HttpRequest, query: web::Query<PreviewQuery>) -> impl Responder {
    let path = PathBuf::from(&query.path);
    if !path.exists() { return HttpResponse::NotFound().finish().customize(); }
    
    let base_name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
    let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let assets_dir = run_dir.join("assets");
    
    // Check if it's a server asset (in the assets folder)
    let _is_server_asset = path.starts_with(&assets_dir);
    
    let p1080 = assets_dir.join(".previews").join(format!("{}_1080p.{}", base_name, ext));
    let p720 = assets_dir.join(".previews").join(format!("{}_720p.{}", base_name, ext));
    
    let is_low_res = req.query_string().contains("res=720");
    let target_preview = if is_low_res { p720 } else { p1080 };

    if target_preview.exists() {
        return match NamedFile::open_async(target_preview).await {
            Ok(f) => f.into_response(&req).customize().insert_header(("X-Is-Optimized", "true")),
            Err(_) => HttpResponse::NotFound().finish().customize()
        };
    }

    // Strictly DO NOT serve original high-res images as previews for server assets OR USB drives
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    if mime.type_() == "image" {
        return HttpResponse::NotFound().finish().customize(); // Trigger "Processing" or "No Preview" in UI
    }

    // For non-images (videos etc), we can serve the file icon or original if it's small, but safe bet is 404
    HttpResponse::NotFound().finish().customize()
}

#[post("/api/fs/copy_to_assets")]
async fn copy_to_assets(req: web::Json<ImportRequest>) -> impl Responder {
    let src = PathBuf::from(&req.path);
    println!("[BACKEND] Copy to assets request: {:?}", src);
    
    if !src.exists() { return HttpResponse::NotFound().finish(); }
    
    let res = web::block(move || {
        let name = src.file_name().ok_or("Invalid filename")?;
        let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let assets_dir = run_dir.join("assets");
        let _ = fs::create_dir_all(&assets_dir);
        let dest = assets_dir.join(name);
        
        if dest.exists() && !req.overwrite.unwrap_or(false) {
            return Err("Conflict");
        }
        
        fs::copy(&src, &dest).map_err(|_| "Copy failed")?;
        Ok(())
    }).await;

    match res {
        Ok(Ok(_)) => HttpResponse::Ok().finish(),
        Ok(Err("Conflict")) => HttpResponse::Conflict().finish(),
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
                                tags: Vec::new(),
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
    println!("[BACKEND] Import request (link existing): {} (overwrite: {})", req_path, overwrite);
    
    let res = web::block(move || {
        let src = PathBuf::from(&req_path);
        if !src.exists() { return Err("File not found".to_string()); }
        
        let name = src.file_name().unwrap().to_string_lossy().to_string();
        let mime_type = mime_guess::from_path(&src).first_or_octet_stream().to_string();
        
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return Err("No project".to_string()) };
        
        // Check for existing link
        let existing_id: Option<String> = conn.query_row(
            "SELECT id FROM assets WHERE path = ?1", 
            params![req_path], 
            |r| r.get(0)
        ).ok();

        if existing_id.is_some() && !overwrite {
            return Err("Conflict".to_string());
        }

        let asset_id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        
        conn.execute(
            "INSERT OR REPLACE INTO assets (id, name, path, mime_type) VALUES (?1, ?2, ?3, ?4)", 
            params![asset_id, name, req_path, mime_type]
        ).map_err(|e| e.to_string())?;
        
        if mime_type.starts_with("image/") && !mime_type.contains("svg") {
            let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let previews_dir = run_dir.join("assets").join(".previews");
            let _ = fs::create_dir_all(&previews_dir);
            let base_name = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let ext = src.extension().unwrap_or_default().to_string_lossy().to_string();
            let p1080 = previews_dir.join(format!("{}_1080p.{}", base_name, ext));
            let p720 = previews_dir.join(format!("{}_720p.{}", base_name, ext));
            
            if !p1080.exists() || overwrite {
                let _ = std::process::Command::new("magick").arg(&src).arg("-resize").arg("1920x1080>").arg(&p1080).output();
            }
            if !p720.exists() || overwrite {
                let _ = std::process::Command::new("magick").arg(&src).arg("-resize").arg("1280x720>").arg(&p720).output();
            }
        }
        
        Ok(asset_id)
    }).await;

    match res { 
        Ok(Ok(id)) => HttpResponse::Ok().json(serde_json::json!({ "status": "imported", "id": id })),
        Ok(Err(e)) if e == "Conflict" => HttpResponse::Conflict().body("File already linked"),
        _ => HttpResponse::InternalServerError().finish() 
    }
}

#[post("/api/asset/{id}")]
async fn save_asset(data: web::Data<AppState>, id: web::Path<String>, req: HttpRequest, mut payload: web::Payload) -> impl Responder {
    // For direct uploads, we still save to the assets folder and link it
    let filename = req.headers().get("X-Asset-Name").and_then(|h| h.to_str().ok()).map(|s| s.to_string()).unwrap_or_else(|| id.into_inner());
    let safe_filename = Path::new(&filename).file_name().unwrap_or_default().to_string_lossy().to_string();
    
    let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let assets_dir = run_dir.join("assets");
    let _ = fs::create_dir_all(&assets_dir);
    let file_path = assets_dir.join(&safe_filename);
    let path_str = file_path.to_string_lossy().to_string();

    let mut f = match fs::File::create(&file_path) {
        Ok(f) => f,
        Err(e) => {
            println!("[BACKEND ERROR] Failed to create file: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    while let Some(chunk) = payload.next().await { 
        if let Ok(data) = chunk {
            f.write_all(&data).unwrap(); 
        }
    }

    let res = web::block(move || {
        let mime_type = mime_guess::from_path(&file_path).first_or_octet_stream().to_string();
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return false };
        let asset_id = Uuid::new_v4().to_string();
        conn.execute("INSERT OR REPLACE INTO assets (id, name, path, mime_type) VALUES (?1, ?2, ?3, ?4)", params![asset_id, safe_filename, path_str, mime_type]).is_ok()
    }).await;

    if res.unwrap_or(false) { HttpResponse::Ok().finish() } else { HttpResponse::InternalServerError().finish() }
}

#[derive(Deserialize)]
struct GetAssetQuery { res: Option<u32> }

#[get("/api/asset/{id}")]
async fn get_asset(data: web::Data<AppState>, req: HttpRequest, id: web::Path<String>, query: web::Query<GetAssetQuery>) -> impl Responder {
    let asset_id = id.into_inner();
    
    let path_res = web::block(move || {
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return None };
        conn.query_row("SELECT path FROM assets WHERE id = ?1", params![asset_id], |r| r.get::<_, String>(0)).ok()
    }).await;

    let mut file_path = match path_res {
        Ok(Some(p)) => PathBuf::from(p),
        _ => return HttpResponse::NotFound().finish()
    };

    if let Some(res) = query.res {
        let base_name = file_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = file_path.extension().unwrap_or_default().to_string_lossy().to_string();
        let run_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let preview_path = run_dir.join("assets").join(".previews").join(format!("{}_{}p.{}", base_name, res, ext));
        if preview_path.exists() {
            file_path = preview_path;
        }
    }

    match NamedFile::open_async(file_path).await { 
        Ok(file) => file.into_response(&req), 
        Err(_) => HttpResponse::NotFound().finish() 
    }
}

#[delete("/api/asset/{id}")]
async fn delete_asset(data: web::Data<AppState>, id: web::Path<String>) -> impl Responder {
    let asset_id = id.into_inner();
    println!("[BACKEND] Request to remove asset from library (NOT disk): {}", asset_id);
    
    let res = web::block(move || {
        let db_guard = data.project_db.lock().unwrap();
        let conn = match &*db_guard { Some(c) => c, None => return false };
        conn.execute("DELETE FROM assets WHERE id = ?1", params![asset_id]).is_ok()
    }).await;

    if res.unwrap_or(false) { HttpResponse::Ok().finish() } else { HttpResponse::InternalServerError().finish() }
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
    conn.execute("CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT, path TEXT, mime_type TEXT)", [])?;
    
    // Migration: Add path column if it doesn't exist (for existing projects)
    let has_path_col: bool = conn.query_row(
        "SELECT count(*) FROM pragma_table_info('assets') WHERE name='path'",
        [],
        |r| r.get::<_, i64>(0)
    ).unwrap_or(0) > 0;

    if !has_path_col {
        println!("[DB] Migrating project {} assets table: adding path column", id);
        let _ = conn.execute("ALTER TABLE assets ADD COLUMN path TEXT", []);
        // For existing local assets, we can try to infer the path if it was in the assets folder
        let _ = conn.execute("UPDATE assets SET path = 'assets/' || name WHERE path IS NULL", []);
    }
    
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
    // Force Wayland/X11 preference
    std::env::set_var("QT_QPA_PLATFORM", "wayland;xcb");
    
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
            system_conn.execute("CREATE TABLE IF NOT EXISTS image_tags (path TEXT, tag TEXT, PRIMARY KEY (path, tag))", []).unwrap();
            
            // Cleanup orphaned tags: Remove tags for files that no longer exist
            if let Ok(mut stmt) = system_conn.prepare("SELECT DISTINCT path FROM image_tags") {
                let paths: Vec<String> = stmt.query_map([], |row| row.get(0)).unwrap().map(|x| x.unwrap()).collect();
                for path_str in paths {
                    if !std::path::Path::new(&path_str).exists() {
                        let _ = system_conn.execute("DELETE FROM image_tags WHERE path = ?1", params![path_str]);
                    }
                }
            }

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

            // Load initial monitor config
            let initial_config: Option<AppConfig> = system_conn.query_row("SELECT value FROM system_data WHERE key = 'monitor_config'", [], |r| {
                let s: String = r.get(0)?;
                Ok(serde_json::from_str(&s).unwrap_or_default())
            }).ok();
            
            let app_state = web::Data::new(AppState {
                global_db: Mutex::new(global_conn), 
                system_db: Mutex::new(system_conn),
                project_db: Mutex::new(None), 
                active_project_id: Mutex::new(None),
                discovered_monitors: Mutex::new(Vec::new()),
                monitor_config: Mutex::new(initial_config),
            });

            // Removed automatic loading of last_id to force user to pick a project every time.

            let server = HttpServer::new(move || {
                App::new()
                    .app_data(web::PayloadConfig::new(10 * 1024 * 1024 * 1024))
                    .app_data(app_state.clone())
                    .service(index).service(dashboard).service(projection)
                    .service(get_monitors).service(register_monitor).service(save_monitor_config).service(get_monitor_config).service(reset_monitor_config)
                    .service(get_all_tags).service(get_tags).service(add_tag).service(remove_tag)
                    .service(list_projects).service(delete_project).service(create_project)
                    .service(load_project).service(get_active_project).service(get_kv).service(save_kv).service(list_assets)
                    .service(sync_all)
                    .service(list_files).service(import_asset).service(save_asset).service(get_asset).service(delete_asset)
                    .service(get_drives).service(delete_fs_file).service(copy_to_assets).service(process_image_asset).service(get_fs_preview)
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

    // Initialize QtWebEngine before creating the engine
    qmetaobject::webengine::initialize();

    let mut engine = QmlEngine::new();

    // Detect Qt version at runtime to use correct imports
    let (qml_imports, webengine_import) = {
        let mut component = QmlComponent::new(&engine);
        // Try versionless import (Qt 6)
        component.set_data("import QtQuick; Item {}".into());
        if component.status() == ComponentStatus::Ready {
            ("import QtQuick\nimport QtQuick.Window\nimport QtQml", "import QtWebEngine")
        } else {
            ("import QtQuick 2.15\nimport QtQuick.Window 2.15\nimport QtQml 2.15", "import QtWebEngine 1.10")
        }
    };
    
    // Initialize WebEngine
    let qml_code = r#"
        QML_IMPORTS
        WEBENGINE_IMPORT

        Item {
            id: root
            
            property var screens: []

            function updateScreens() {
                console.log("QML: Updating screens. Current count: " + Qt.application.screens.length);
                var newScreens = [];
                for (var i = 0; i < Qt.application.screens.length; i++) {
                    var s = Qt.application.screens[i];
                    newScreens.push({
                        name: s.name || "Unknown-" + i,
                        virtualX: s.virtualX,
                        virtualY: s.virtualY,
                        width: s.width,
                        height: s.height,
                        screen: s
                    });
                }
                screens = newScreens;
                
                // Register with backend
                for (var j = 0; j < screens.length; j++) {
                    var sc = screens[j];
                    var xhr = new XMLHttpRequest();
                    xhr.open("POST", "http://127.0.0.1:8080/api/monitors/register", true);
                    xhr.setRequestHeader("Content-Type", "application/json");
                    xhr.send(JSON.stringify({
                        id: j,
                        name: sc.name,
                        x: sc.virtualX,
                        y: sc.virtualY,
                        width: sc.width,
                        height: sc.height,
                        is_primary: (j === 0)
                    }));
                }
            }

            Component.onCompleted: {
                console.log("QML: Starting Emap Projection System");
                updateScreens();
            }

            // Monitor for screen changes
            Connections {
                target: Qt.application
                function onScreensChanged() { 
                    console.log("QML: Screens changed signal received");
                    updateScreens(); 
                }
            }

            Instantiator {
                model: root.screens
                delegate: Window {
                    id: win
                    
                    // Set screen BEFORE visibility
                    screen: modelData.screen
                    x: modelData.virtualX
                    y: modelData.virtualY
                    width: modelData.width
                    height: modelData.height
                    
                    title: "Emap - " + modelData.name
                    color: "black"

                    Component.onCompleted: {
                        console.log("QML: Window created for screen: " + modelData.name + 
                                    " at " + x + "," + y + " (" + width + "x" + height + ")");
                        showTimer.start();
                    }
                    
                    Timer {
                        id: showTimer
                        interval: 500
                        onTriggered: {
                            win.visibility = Window.FullScreen;
                            win.visible = true;
                        }
                    }

                    WebEngineView {
                        anchors.fill: parent
                        url: "http://127.0.0.1:8080/?screen=" + encodeURIComponent(modelData.name)
                        
                        settings.pluginsEnabled: true
                        settings.playbackRequiresUserGesture: false
                        settings.javascriptCanAccessClipboard: true
                        settings.accelerated2dCanvasEnabled: true
                        settings.webGLEnabled: true
                        
                        onJavaScriptConsoleMessage: function(level, message, lineNumber, sourceID) {
                            var lvl = ["DEBUG", "INFO", "WARN", "ERROR"][level] || "LOG";
                            console.log("[WEB " + lvl + "] (" + modelData.name + ") " + message);
                        }

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
                            request.accepted = true 
                        }
                    }
                }
            }
        }
    "#.replace("QML_IMPORTS", qml_imports)
      .replace("WEBENGINE_IMPORT", webengine_import);

    engine.load_data(qml_code.into());

    engine.exec();
}