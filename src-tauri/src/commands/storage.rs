use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri::Manager;

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn hash_path(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:016x}", h.finish())
}

#[tauri::command]
pub fn save_chat_tree(app: tauri::AppHandle, pdf_path: String, data: String) -> Result<(), String> {
    let dir = data_dir(&app)?.join("chats");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", hash_path(&pdf_path))), data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_chat_tree(app: tauri::AppHandle, pdf_path: String) -> Result<Option<String>, String> {
    let file = data_dir(&app)?
        .join("chats")
        .join(format!("{}.json", hash_path(&pdf_path)));
    if file.exists() {
        std::fs::read_to_string(file)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_stamps(app: tauri::AppHandle, pdf_path: String, data: String) -> Result<(), String> {
    let dir = data_dir(&app)?.join("stamps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", hash_path(&pdf_path))), data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_stamps(app: tauri::AppHandle, pdf_path: String) -> Result<Option<String>, String> {
    let file = data_dir(&app)?
        .join("stamps")
        .join(format!("{}.json", hash_path(&pdf_path)));
    if file.exists() {
        std::fs::read_to_string(file)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_citations(app: tauri::AppHandle, pdf_path: String, data: String) -> Result<(), String> {
    let dir = data_dir(&app)?.join("citations");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", hash_path(&pdf_path))), data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_citations(app: tauri::AppHandle, pdf_path: String) -> Result<Option<String>, String> {
    let file = data_dir(&app)?
        .join("citations")
        .join(format!("{}.json", hash_path(&pdf_path)));
    if file.exists() {
        std::fs::read_to_string(file)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_session(app: tauri::AppHandle, data: String) -> Result<(), String> {
    std::fs::write(data_dir(&app)?.join("session.json"), data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_session(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = data_dir(&app)?.join("session.json");
    if file.exists() {
        std::fs::read_to_string(file)
            .map(Some)
            .map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}
