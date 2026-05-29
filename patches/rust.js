import fs from "@vistta/fs";
import { getInfo } from "../utils";

export async function patchMainRs(targetDir, config) {
  const mainPath = fs.resolve(targetDir, "src", "main.rs");
  if (!fs.existsSync(mainPath)) return;
  const { lib } = await getInfo(config);
  const appId = config?.app?.id || "org.vistta.app";
  await fs.writeFile(
    mainPath,
    String(await fs.readFile(mainPath, "utf8"))
      .replace(/vistta_js_example/g, lib)
      .replace(/vistta_app_id/g, appId),
  );
}

export async function patchLibRs(targetDir) {
  const libPath = fs.resolve(targetDir, "src", "lib.rs");
  if (!fs.existsSync(libPath)) return;

  const content = `#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    env_logger::init();
    log::info!("Starting Vistta.js Runtime");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_haptics::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .setup(|app| {
            use tauri::tray::TrayIconBuilder;
            use tauri::menu::{Menu, MenuItem};

            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`;
  await fs.writeFile(libPath, content);
}

export async function patchCargoToml(targetDir, config) {
  const cargoPath = fs.resolve(targetDir, "Cargo.toml");
  if (!fs.existsSync(cargoPath)) return;
  const { name, version, description, author, lib } = await getInfo(config);
  let content = String(await fs.readFile(cargoPath, "utf8"))
    .replace(/^name\s*=\s*".*"/m, `name = "${name}"`)
    .replace(/^version\s*=\s*".*"/m, `version = "${version}"`)
    .replace(/^description\s*=\s*".*"/m, `description = "${description}"`)
    .replace(/^authors\s*=\s*\[.*\]/m, `authors = ["${author}"]`)
    .replace(/^\[lib\]\s*\nname\s*=\s*".*"/m, `[lib]\nname = "${lib}"`);

  if (config?.app?.background && !content.includes("tray-icon")) {
    content = content.replace(
      /tauri = \{ version = "2", features = \["devtools"\] \}/,
      `tauri = { version = "2", features = ["devtools", "tray-icon"] }`,
    );
  }

  await fs.writeFile(cargoPath, content);
}
