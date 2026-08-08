use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("privileged-clipboard")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let _handle = api.register_android_plugin(
                    "org.vistta.privilegedclipboard",
                    "PrivilegedClipboardPlugin",
                )?;
            }
            Ok(())
        })
        .build()
}