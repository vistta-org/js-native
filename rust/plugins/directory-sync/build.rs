const COMMANDS: &[&str] = &[
    "select_root",
    "probe_root",
    "start_scan",
    "next_scan_page",
    "cancel_operation",
    "begin_lease",
    "end_lease",
    "hash_file",
    "read_file_chunk",
    "begin_write",
    "write_chunk",
    "commit_write",
    "abort_write",
    "recover_root",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
