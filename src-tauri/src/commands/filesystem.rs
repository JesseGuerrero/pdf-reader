use base64::{engine::general_purpose, Engine as _};
use std::path::Path;
use walkdir::WalkDir;

use crate::models::FileNode;

#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<FileNode>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Not a directory".to_string());
    }

    let mut pdf_paths: Vec<std::path::PathBuf> = WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .map_or(false, |ext| ext.eq_ignore_ascii_case("pdf"))
        })
        .map(|e| e.path().to_path_buf())
        .collect();

    pdf_paths.sort();

    let mut nodes: Vec<FileNode> = Vec::new();
    for pdf_path in &pdf_paths {
        if let Ok(relative) = pdf_path.strip_prefix(root) {
            let components: Vec<&str> = relative
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect();
            insert_path(&mut nodes, &components, &pdf_path.to_string_lossy());
        }
    }

    sort_tree(&mut nodes);
    Ok(nodes)
}

fn insert_path(nodes: &mut Vec<FileNode>, components: &[&str], full_path: &str) {
    if components.is_empty() {
        return;
    }
    if components.len() == 1 {
        nodes.push(FileNode {
            name: components[0].to_string(),
            path: full_path.to_string(),
            is_dir: false,
            children: vec![],
        });
        return;
    }
    let dir_name = components[0];
    let existing = nodes.iter_mut().find(|n| n.is_dir && n.name == dir_name);
    match existing {
        Some(node) => insert_path(&mut node.children, &components[1..], full_path),
        None => {
            let mut dir = FileNode {
                name: dir_name.to_string(),
                path: String::new(),
                is_dir: true,
                children: vec![],
            };
            insert_path(&mut dir.children, &components[1..], full_path);
            nodes.push(dir);
        }
    }
}

fn sort_tree(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    for node in nodes.iter_mut() {
        if node.is_dir {
            sort_tree(&mut node.children);
        }
    }
}

#[tauri::command]
pub fn read_pdf_bytes(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| format!("Dialog error: {}", e))
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_file_to_folder(source: String, folder: String) -> Result<String, String> {
    let src = Path::new(&source);
    let filename = src.file_name().ok_or("Invalid source filename")?;
    let dest = Path::new(&folder).join(filename);
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}
