mod commands;
mod models;

const GROBID_CONTAINER: &str = "pdfreader-grobid";
const GROBID_IMAGE: &str = "grobid/grobid:0.8.1";

fn start_grobid() {
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", GROBID_CONTAINER])
        .output();

    match std::process::Command::new("docker")
        .args([
            "run", "-d",
            "--name", GROBID_CONTAINER,
            "-p", "8070:8070",
            "--restart", "no",
            GROBID_IMAGE,
        ])
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                eprintln!("[grobid] Container started");
            } else {
                eprintln!("[grobid] Failed to start: {}", String::from_utf8_lossy(&output.stderr));
            }
        }
        Err(e) => eprintln!("[grobid] Docker not available: {}", e),
    }
}

fn stop_grobid() {
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", GROBID_CONTAINER])
        .output();
    eprintln!("[grobid] Container stopped");
}

pub fn run() {
    start_grobid();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::filesystem::scan_directory,
            commands::filesystem::read_pdf_bytes,
            commands::filesystem::pick_folder,
            commands::filesystem::copy_file_to_folder,
            commands::filesystem::create_directory,
            commands::chat::send_chat_message,
            commands::storage::save_chat_tree,
            commands::storage::load_chat_tree,
            commands::storage::save_stamps,
            commands::storage::load_stamps,
            commands::storage::save_citations,
            commands::storage::load_citations,
            commands::storage::save_session,
            commands::storage::load_session,
            commands::lookup::open_url,
            commands::lookup::proxy_image,
            commands::lookup::geocode_location,
            commands::lookup::lookup_person,
            commands::lookup::resolve_citation,
            commands::lookup::search_arxiv,
            commands::lookup::download_pdf,
            commands::lookup::parse_references_grobid,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    stop_grobid();
}
