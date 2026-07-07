use std::collections::HashMap;
use std::path::PathBuf;

// Candidate .env locations: project root (dev: cwd is src-tauri), cwd, and
// next to the executable (production). First one that exists wins.
fn env_file_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../.env")));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(".env"));
        candidates.push(cwd.join("../.env"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(".env"));
        }
    }
    candidates
}

fn parse_env_file(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim().trim_matches('"').trim_matches('\'');
            map.insert(k.trim().to_string(), v.to_string());
        }
    }
    map
}

#[tauri::command]
pub fn get_env_config() -> HashMap<String, String> {
    let mut config = HashMap::new();
    for path in env_file_candidates() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            config = parse_env_file(&content);
            break;
        }
    }
    // Process environment overrides the file
    for key in ["LLM_API_URL", "LLM_API_KEY", "LLM_MODEL", "S2_API_KEY"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                config.insert(key.to_string(), v);
            }
        }
    }
    config
}
