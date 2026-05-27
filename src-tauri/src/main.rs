#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    pdf_reader_lib::run();
}
