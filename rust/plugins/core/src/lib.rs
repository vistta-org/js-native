use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Initializes the plugin.
///
/// On Android the plugin registers a Kotlin `VisttaPlugin` class that owns
/// the foreground service (`VisttaService`), the background HTTP client
/// (`VisttaNetwork`), and the `JavascriptInterface` bridges
/// (`VisttaScheduler`, `VisttaFetch`, `VisttaSocket`) injected into the
/// webview. On desktop/iOS the plugin is a no-op — the JS-side scheduler
/// and net plugins fall through to `setInterval` / `window.fetch`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("vistta")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let _handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VisttaPlugin")?;
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "org.vistta.runtime";