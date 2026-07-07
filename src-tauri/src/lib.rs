mod commands;
mod models;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::filesystem::scan_directory,
            commands::filesystem::read_pdf_bytes,
            commands::filesystem::extract_pdf_text,
            commands::filesystem::pick_folder,
            commands::filesystem::copy_file_to_folder,
            commands::filesystem::create_directory,
            commands::filesystem::ocr_pdf,
            commands::filesystem::list_ocr_originals,
            commands::chat::send_chat_message,
            commands::config::get_env_config,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
