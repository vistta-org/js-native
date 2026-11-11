# @vistta/js-native

Native runtime for building Android and desktop applications using **Tauri v2**.

> **Production readiness:** This package has not yet been tested in production. Validate it for your use case before deploying.

## Features

- **Single codebase** for Android, macOS, Windows, and Linux. iOS build support is experimental and `run()` does not support iOS. Browser plugin fallbacks are not a Web build target.
- **JS-only for app developers** — no Rust required; the runtime owns `src-tauri/`
- **Built-in integrations**: Clipboard, Dialog, Filesystem, Haptics, Notification, Shell, plus `System` (app metadata + path resolution from the Tauri core API)
- **Smaller bundle than Electron** (Tauri ships a webview, not a full browser)

## Installation

```bash
npm install @vistta/js-native
```

## Quick Start

Put your bundled frontend in `build/www/`, including `index.html`, then build and launch it:

```javascript
import { Tauri } from "@vistta/js-native";

const config = {
  platform: "desktop", // "desktop" | "android" | "linux" | "windows" | "macos"
  buildDir: "./build", // src-tauri root for this app
  app: {
    id: "com.example.myapp",
    name: "My App",
  },
  title: "My App",
  backgroundColor: "#ffffff",
};
await Tauri.build(config);
const app = await Tauri.run(config);
await app.end();
```

`run` and `build` are also available as named exports:

```javascript
import { run, build } from "@vistta/js-native";
```

## API

### `Tauri.run(config)`

Launches an already-built application. Call `build(config)` first, using the same
configuration and `NODE_ENV`:

- `platform: "desktop"` (or `"linux"`/`"windows"`/`"macos"`) launches the native binary from `target/release`, or `target/debug` with `NODE_ENV=development`. A configured cross-compile target adds its target-triple directory; a foreign binary cannot run on an incompatible host.
- `platform: "android"` installs the matching release/debug universal APK and starts its activity using ADB. Build with `target: "apk"` when you intend to run it. Missing artifacts and device/install failures are reported directly.
- `platform: "ios"` → not yet supported

`run()` does not generate configuration, start a dev server, or invoke `tauri dev` / `tauri android dev`. Set `NODE_ENV` before starting the Node process; build mode is selected when the runtime is imported.

```javascript
await Tauri.run({
  platform: "desktop",
  buildDir: "./build",
  app: {
    id: "com.example.app",
    name: "My App",
    publisher: "Example", // installer/Apps list publisher; default "Vistta"
    width: 1280,
    height: 800,
    minWidth: 320,
    minHeight: 480,
    center: true,
    resizable: true,
    fullscreen: false,
    devTools: false,
  },
  title: "My App",
  icon: "icon.png", // relative to buildDir/www
  backgroundColor: "#ffffff",
});
```

> **Inspector / DevTools.** The Tauri `devtools` Cargo feature (which gates
> whether the webview inspector can be opened at all) is only enabled in
> development builds (`NODE_ENV=development`). Release builds compile without
> it, so the inspector cannot be activated in a shipped desktop binary.

### `Tauri.build(config)`

Builds the Tauri app for distribution (Android APK, Windows installer, etc.).
Same config shape as `run`. The `platform` field is required.

`icon` accepts a path relative to `buildDir/www`, a web-root asset URL such as
`/assets/icon.png`, or an absolute filesystem path. Existing bundled assets take
precedence over absolute paths. A configured icon that cannot be found fails the
build rather than silently keeping old generated icons.
When `icon` is omitted, the runtime generates a neutral default icon and all
platform-referenced icon assets, so a minimal config is buildable.

```javascript
await Tauri.build({
  platform: "android",
  buildDir: "./build",
  app: { id: "com.example.app", name: "My App" },
});
```

### Extension points

Power-user escape hatches so you can extend the generated `src-tauri/` without
forking the runtime. All are optional and deep-merged into the defaults.

```javascript
await Tauri.build({
  platform: "desktop",
  buildDir: "./build",
  app: { id: "com.example.app" },

  // Deep-merged into the generated tauri.conf.json.
  extraTauriConfig: {
    app: { windows: [{ decorations: false }] },
    plugins: { shell: { open: false } },
  },

  // Extra Cargo crates appended to [dependencies] (string or object spec).
  extraCargoDependencies: {
    rusqlite: { version: "0.31", features: ["bundled"] },
    chrono: "0.4",
  },

  // Extra permission entries merged into capabilities/default.json.
  extraCapabilities: [
    "core:webview:allow-print",
    { identifier: "shell:allow-execute", allow: [{ name: "git", cmd: "git", args: ["--version"] }] },
  ],

  // Override the default CSP (defaults to null = disabled).
  security: { csp: "default-src 'self'" },

  // Platform code-signing. Windows + macOS settings are forwarded to
  // tauri.conf.json bundle config. Android: provide a pre-existing keystore
  // path + password.
  keystore: { file: "./release.keystore", password: "..." },
});
```

> `extraTauriConfig` is deep-merged into the generated `tauri.conf.json`. Object
> properties merge recursively; **arrays from `extraTauriConfig` replace** the
> defaults rather than concatenating, so callers can fully control list-valued
> fields like `app.windows`.

Default capabilities do not allow command execution or spawning. `extraCapabilities`
is an explicit trust boundary: entries must be permission strings or objects with
an `identifier` and optional array-valued `allow` / `deny` scopes. Broad grants
produce security warnings. Avoid shells, wildcard filesystem scopes, and
`args: true`; grant only named executables and fixed arguments that the app needs.
`extraTauriConfig` can override security settings too; review it as trusted native
application configuration. A CSP is disabled by default; configure one appropriate
to your frontend, especially if it renders external content.

#### Return value

`run` and `build` return different shapes:

- `run` returns a handle of `{ close, on, end }`. Keep it and call `handle.close()` to stop the launched app; `await handle.end()` waits for exit. Android monitors the app process, not only its foreground activity.
- `build` returns `{ type, paths }` where `type` is the build variant that was produced (`"release"` or `"debug"`) and `paths` is a list of absolute paths to the produced artifacts (APK/AAB for android, `.app`/`.ipa` for ios, installers + native binary for desktop). The runtime parses Tauri output for `Finished ... at:` markers, including singular `Finished 1 bundle at:` headers, and handles lines split across output chunks. Desktop paths are deduplicated; fallback discovery only includes requested bundle formats (`exe` means NSIS) and skips installers when bundling is disabled. The promise rejects with an `Error` on non-zero exit.

The CLI consumer (`@vistta/js`) takes the `paths` and copies each artifact to the build output directory using a versioned name derived from `artifactName()`:

```javascript
import { build, artifactName } from "@vistta/js-native";

const { type, paths } = await build({ platform: "android", buildDir: "./build", app: { name: "My App", version: "1.0.0" } });
for (const sourcePath of paths) {
  const name = artifactName({ appName: "My App", version: "1.0.0", type, sourcePath });
  // → "my-app-1.0.0.apk" / "my-app-1.0.0.aab" (android release)
  // → "my-app-1.0.0.msi" / "my-app-1.0.0-setup.exe" (desktop installers)
  // → "my-app-1.0.0.exe" (Windows release binary)
  // → "my-app-1.0.0.app" / ".ipa" (ios)
}
```

#### `artifactName({ appName, name, version, type, sourcePath })`

Derives a versioned destination filename for an artifact produced by `build()`. The naming convention is:

- Android APK: `<App-Name>-<version>.apk` for release builds, `<App-Name>-<version>-debug.apk` for debug builds
- Android AAB: `<App-Name>-<version>.aab`
- NSIS installer: `<App-Name>-<version>-setup.exe`, distinct from the raw application executable
- Other desktop installers (msi/deb/rpm/AppImage/dmg): `<App-Name>-<version><.ext>`
- Windows raw binary: `<App-Name>-<version>.exe` for release builds, `<App-Name>-<version>-debug.exe` for debug builds
- Other desktop raw binaries: `<App-Name>-<version>`
- iOS `.app`/`.ipa`: `<App-Name>-<version><.ext>`

Whitespace and reserved filesystem characters (`/ \ : * ? " < > |`) in `appName` and `version` are collapsed to a single `-` so the filename is safe on Windows, macOS, and Linux.

Derived names are lowercased. An explicit `name` (the CLI's `--name`) replaces the app-name/version prefix and preserves its casing. For example, `--name=vistta-connect --target=exe` produces `vistta-connect-setup.exe` and `vistta-connect.exe`, not two files competing for the same destination. Existing output files are not removed automatically, so older `-release.exe` or `-release.apk` files can remain after rebuilding.

## Cross-compilation

The runtime accepts `linux`, `windows`, and `macos` as platform values — they
map to the internal `desktop` platform, with `windows` auto-setting
`crossCompile` to `x86_64-pc-windows-gnu` and `macos` to `x86_64-apple-darwin`.
`linux` and `desktop` build natively. Cross-compilation is automatic — no extra
flags needed.

```javascript
await Tauri.build({
  platform: "windows",
  buildDir: "./build",
  app: { id: "com.example.app", name: "My App" },
});
```

When `crossCompile` is set:

- `--target <triple>` is passed to `tauri build` so Cargo compiles for the
  specified Rust target.
- Artifact paths are resolved under `target/<triple>/release/` instead of
  `target/release/`.
- The `.exe` extension is used when the target triple contains `-windows-`.

The Rust target triple must be installed beforehand (`rustup target add
x86_64-pc-windows-gnu`) and the cross-linker / bundler tools must be available
(MinGW-w64 for linking, NSIS for `.exe` setup installers, WiX under Wine for
`.msi`). See the `Dockerfile.build` in the Connect app for a working example of
a Linux container that builds Linux + Android + Windows artifacts.

## Bundle targets

The `target` config field controls which bundle format(s) are produced for the
current platform. It accepts a single value, a list, or a per-platform object.
When omitted, the platform defaults are used (Android: APK + AAB, iOS: IPA,
desktop: all installers).

```javascript
await Tauri.build({
  platform: "android",
  buildDir: "./build",
  target: "apk", // only APK (skip AAB)
  app: { id: "com.example.app", name: "My App" },
});
```

Per-platform object (useful in `app` mode where multiple platforms are built in
one invocation):

```javascript
await Tauri.build({
  platform: "android",
  buildDir: "./build",
  target: { android: "apk", desktop: ["msi", "nsis"] },
  app: { id: "com.example.app", name: "My App" },
});
```

Available values per platform:

| Platform | Values                                                                      | Default       |
| -------- | --------------------------------------------------------------------------- | ------------- |
| Android  | `apk`, `aab`                                                                | `apk` + `aab` |
| iOS      | `ipa`, `app`                                                                | `ipa`         |
| Desktop  | `msi`, `nsis` (alias: `exe`), `deb`, `rpm`, `appimage`, `app`, `dmg`, `all` | `all`         |

The CLI exposes this via `--target`:

```bash
# Flat — applies to the current platform
vistta build [folder] android --target apk
vistta build [folder] windows --target nsis

# Comma-separated list
vistta build [folder] android --target apk,aab

# Per-platform assignments (for `app` mode)
vistta build [folder] app --target android=apk,windows=nsis
```

## Run on startup (Windows/Linux) — plan

**Status: partially implemented.** The desktop runtime registers the official
autostart plugin and exposes `System.enableAutostart()`,
`System.disableAutostart()` and `System.isAutostartEnabled()`. Code Hub offers
the opt-in setting on Windows/Linux and reads its state from the OS.
Registration is off by default; enabling it launches the app normally at login.
The outline below remains the follow-up plan for Connect integration,
Windows/Linux-only native registration, and hidden `--autostart` launches.

### Decisions

- **Windows + Linux only.** The upstream plugin supports macOS too, but per-OS
  registration strategies (Launch Agent vs `Run` key vs XDG entry) make the v1
  semantics non-uniform, so macOS is not offered. Android, iOS, and browser
  builds never expose the option.
- **Lives under `System`, not `Shell`.** Registering an autostart entry is OS
  configuration, not process spawning. The intended API is
  `System.enableAutostart()`, `System.disableAutostart()`,
  `System.isAutostartEnabled()`.
- **The OS is the source of truth.** Enabled state is read live from the
  registration on every render and toggle; it is never persisted as a synced
  user preference, so two devices of the same account can legitimately differ.
- **Off by default.** The user opts in via an explicit toggle.
- **Autostarted launches start hidden.** The runtime launches with a
  `--autostart` marker argument and keeps the main window hidden when that
  argument is present, so a login launch lands in the tray instead of stealing
  focus. This pairs with background mode (`app.background: true`) — without it,
  a hidden autostarted app would be unreachable. Apps should only surface the
  toggle when background mode is available.

### Runtime changes

1. **Registry entry** — `autostart` in `plugins.config.js`:
   `id: "autostart"`, `crate: "tauri-plugin-autostart"`, version `2`, and a
   custom `initFn` registering the plugin with the `--autostart` argument
   (fully qualified:
   `tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"]))`,
   so no generated `use` lines are needed). The plugin's `default` permission
   already covers `enable` / `disable` / `is_enabled`, so no `permissions`
   array is required.
2. **Per-OS desktop gating** — the registry currently distinguishes only
   desktop vs mobile, and `platforms: ["desktop"]` includes macOS. The registry
   gains desktop sub-target tags (`"windows"`, `"linux"`, `"macos"`) honored by
   `pluginsFor()` (which must also see the CLI platform, not only the resolved
   `desktop` target), by `patchLibRs` / `patchCargoToml` (cfg
   `not(any(target_os = "android", target_os = "ios", target_os = "macos"))` for
   the crate dependency and plugin registration), and by `patchCapabilities`.
   Existing desktop-only plugins keep their current behaviour.
3. **Hidden-start logic** — `patchLibRs` emits a check of `std::env::args()`
   for `--autostart` and keeps the window hidden at startup when it is present.
   `tauri.conf.json` declares windows statically, so avoiding a first-frame
   flash on autostarted launches means creating the window `visible: false` and
   showing it in setup on every launch. That is the planned approach; the
   tradeoff (normal launches appear a frame or two later) is accepted unless it
   regresses perceived startup.
4. **JS wrapper** — add `@tauri-apps/plugin-autostart` (npm `^2.7.0`) to the
   package's dependencies and re-export its three functions in
   `plugins/system.js` as named re-exports (`enableAutostart`,
   `disableAutostart`, `isAutostartEnabled`) rather than a plain `export *`,
   which would collapse bare `enable` / `disable` / `isEnabled` into the flat
   `System` namespace. The `System` namespace in `plugins/index.js` picks them
   up unchanged. The `system.js` header comment ("no plugin crates, no extra
   capabilities") must be updated — this is the first plugin crate folded into
   `System`.

### Platform matrix

| Platform    | Registration                                         | Autostart behaviour                               |
| ----------- | ---------------------------------------------------- | ------------------------------------------------- |
| Windows     | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` | Launches with `--autostart`; window starts hidden |
| Linux       | XDG `.desktop` file in `~/.config/autostart/`        | Launches with `--autostart`; window starts hidden |
| macOS       | — (not offered in v1)                                | —                                                 |
| Android/iOS | — (plugin not registered)                            | —                                                 |
| Browser     | — (not applicable)                                   | —                                                 |

Linux note: when running as an AppImage, the plugin registers the AppImage file
itself (resolved from the `APPIMAGE` environment variable, falling back to the
current executable), so the entry keeps working across relocation; it does not
point at the temporary mount point.

Toolchain note: `tauri-plugin-autostart` 2.x requires Rust ≥ 1.90 — verify the
host/build-container toolchain before landing.

### App integration (Connect)

- A "Run on startup" switch in System settings, shown only when
  `window.platform === "desktop"` and the host OS is Windows/Linux (hidden on
  macOS), and only when background mode is available.
- Toggling calls `System.enableAutostart()` / `System.disableAutostart()`
  through the system provider's action pattern; the switch state comes from
  `isAutostartEnabled()` probed on mount and refreshed after each toggle.
- Five-language labels (en/pt/es/fr/de) following the existing label set.

### Acceptance

- On Windows and Linux: enabling registers the OS entry; after a reboot the app
  launches hidden with the tray present; disabling removes the entry; removing
  the entry externally is reflected by `isAutostartEnabled()`.
- macOS/Android/iOS builds compile without the crate, registration, or
  capability permission present, and the switch is not rendered on those
  targets.
- Normal (non-`--autostart`) launches still bring the main window up
  predictably (subject to the `visible: false` change above).
- `buildDir/` regeneration stays clean — the feature is expressed entirely
  through the registry and generators, with no hand-edited generated files.
- Docs to update when it ships: the `System` section and plugin table in this
  README, plus the Connect README's feature list.

## Native extension roadmap

**Status: proposed, not implemented.** The goal is to let applications add
Rust integrations without forking `@vistta/js-native` or editing generated
`src-tauri/` files. Tauri v2 remains the native host and permission boundary;
Vistta automates the integration plumbing rather than replacing it.

Today, `plugins.config.js` contains the runtime's fixed plugin registry.
`extraCargoDependencies` adds crates, but does not register their plugins or
expose commands. The runtime regenerates the Rust entry points and Cargo
manifest, so manual edits to those generated files are not durable.

### Phase 1: Consumer-defined Tauri plugins

- Define an application extension registry alongside the existing built-in
  plugins. Final configuration names and schema are still to be decided.
- Describe each extension's plugin identifier, Rust crate source (local path,
  registry version, or Git revision), Cargo features, supported platforms,
  initialization entry point, and available permissions.
- Keep extension source outside the generated build directory. Resolve local
  paths relative to a documented application configuration root, not the
  runtime package.
- Generate Cargo dependencies and plugin registration from the same resolved
  registry, with matching platform guards, including Windows-only plugins.
- Let applications explicitly grant extension permissions and scopes to
  selected windows/webviews. Do not automatically grant every declared command.
- Preserve standard Tauri plugin structure and independently maintained JS
  wrappers. No generated bindings are required for this first phase.
- Reject duplicate identifiers, conflicting dependency definitions, invalid
  platform declarations, and missing local crates with actionable errors.

**Acceptance:** an application can register a local Rust plugin, invoke a
permitted command from JS, and rebuild without losing its source. An ungranted
command is denied, and a Windows-only extension is absent from other targets.
Existing applications without extensions retain their generated behavior.

### Phase 2: Easier Rust authoring

- Add scaffolding for a minimal extension crate with commands, permission
  definitions, and optional setup, event, and cleanup handling.
- Evaluate a maintained Rust-to-TypeScript binding generator before defining
  a custom command or type schema. Generate wrappers and types only when an
  extension opts in.
- Document async commands, managed state, structured errors, event
  subscriptions, unsubscription, and cleanup on shutdown or window removal.
- Keep standard Tauri plugins as an escape hatch; avoid a second IPC protocol
  or arbitrary Rust source strings embedded in application configuration.

**Acceptance:** a sample extension exposes a typed command and an event
subscription without hand-written registration or invoke wrappers, and cleans
up its native resources when stopped.

### Phase 3: Windows desktop integration pilot

- Build a separate Windows extension to validate the registry against a real
  widget application using `@vistta/js` and `@vistta/ui`.
- Start with AppBar registration and screen-space reservation, non-activating
  bar windows, monitor/DPI changes, and reliable unregistration.
- Add active-window events and shared CPU/memory sampling for JS widgets;
  keep native state and sampling centralized rather than polling per widget.
- Treat audio/media controls, existing system-tray icon hosting, notification
  history, and virtual desktops as later investigations, not initial promises.

**Acceptance:** verify the bar on Windows across multiple monitors and DPI
settings, fullscreen transitions, Explorer restart, and normal shutdown.
Native resources and screen reservations must be released correctly.

### Boundaries and verification

- Rust extensions are compiled into the application. Adding or updating one
  requires a rebuild; runtime loading of native plugins is out of scope.
- Permissions restrict webview access to commands, not the extension's native
  Rust code. Only include trusted crates and use reproducible dependency pins.
- Extension authors still own OS API safety, thread affinity, native handles,
  and platform-specific behavior. Widget authors can remain JS-only.
- Add focused registry/generation tests for path resolution, platform guards,
  permissions, conflicts, and repeatable regeneration, plus compile and IPC
  coverage for a minimal consumer plugin. Use real Windows checks for the
  desktop pilot; generation tests alone cannot prove desktop behavior.
- Document the final configuration and a working example when each phase
  ships. This roadmap does not introduce a usable extension API today.

## Android status

The runtime supports foreground Android apps and a foreground-service-based
background scheduler (see [Scheduler](#scheduler) below).

**What's there:**

- `tauri-plugin-vistta` (at `rust/plugin/`) — the runtime's own Tauri plugin crate.
  On Android it registers a Kotlin `VisttaPlugin` class that owns:
  - `VisttaService` — the foreground service that holds the process + webview
    alive while a scheduler timer is active or a socket listener is registered
    with `mobile: { background: true }`. An open socket alone no longer starts it.
    Uses `foregroundServiceType="specialUse"` (Android 14+) so it is not
    subject to the `dataSync` time budget that kills long-running services.
    The service only calls `startForeground()` for actions started via
    `startForegroundService()` (`REGISTER`, `BACKGROUND_EVENTS_ON`); other actions
    (`CLEAR`, `STOP_IF_EMPTY`, `BACKGROUND_EVENTS_OFF`) are sent via `startService()`
    on an already-running service. If the first background listener registers
    while the app is already backgrounded (Android 12+ forbids the start),
    the service starts on the next resume. A null-intent system restart
    keeps the service non-foreground to avoid a
    `ForegroundServiceStartNotAllowedException` crash loop.
  - `VisttaNetwork` — the OkHttp client and Socket.IO Java client used for
    background fetch and background sockets. Sockets hold no permanent wake
    lock (only a 10 s lock per delivered event), back off reconnects up to
    5 minutes, disconnect while the device has no network, and reconnect
    immediately when a new default network appears. While the app is
    backgrounded (activity stopped), only events with a
    `mobile: { background: true }` listener reach the webview; the rest are
    dropped natively. On resume, a
    socket that dropped events reports `disconnect` and reconnects, so the
    app's normal reconnect handling resyncs.
  - `VisttaClipboard` — standard foreground clipboard operations and manual
    sync. Android limits normal clipboard reads to the focused app.
  - `VisttaScheduler` / `VisttaFetch` / `VisttaSocket` /
    `VisttaClipboard` / `VisttaInstaller` / `VisttaShortcuts` / `VisttaVad`
    JavascriptInterface bridges injected into the webview.
  - A default notification channel for the notification plugin.
  - The `<uses-permission>`s (`POST_NOTIFICATIONS`, `VIBRATE`, `WAKE_LOCK`,
    `FOREGROUND_SERVICE*`, `REQUEST_INSTALL_PACKAGES`, `RECORD_AUDIO`) and
    foreground `VisttaService` entry in the plugin's own `AndroidManifest.xml` — merged
    into the host app by Android's manifest merger, no host-file patching
    needed. `VisttaInstaller` (the APK installer bridge) uses the app's
    `FileProvider` (authorities `${applicationId}.fileprovider`, declared in
    the generated host manifest) to share the downloaded APK with the system
    package installer.
  - The `okhttp` and `socket.io-client` Maven deps in the plugin's own
    `build.gradle.kts`.
    On desktop/iOS the plugin is a no-op.
- `tauri-plugin-vistta-privileged-clipboard` (at
  `rust/privileged-clipboard-plugin/`) — a separate Android plugin for
  privileged clipboard backends. It currently provides opt-in Shizuku/Sui
  monitoring and owns the Shizuku provider, permissions, Binder monitor, and
  `VisttaPrivilegedClipboard` JavaScript bridge.
- `tauri-plugin-directory-sync` (at `rust/plugins/directory-sync/`) —
  the Windows/Linux and Android filesystem boundary for directory sync. It
  owns contained scans, hashing, checked chunk reads, staged writes,
  recoverable replacement, retained old copies, cancellation, and Android SAF
  tree grants. Bounded Android operations hold a `dataSync` foreground-service
  lease. Its permissions are generated into the host capability file.
- `patchAndroidStrings` — keeps launcher label + activity title in sync with
  `tauri.conf.json`
- `patchAndroidManifest` — sets the generated main activity to
  `android:windowSoftInputMode="adjustResize"` so Android reports IME insets
  to the activity
- `patchMainActivity` — rewrites the generated `MainActivity.kt` to apply
  system bar and IME (keyboard) insets as padding to the activity's root view,
  so the native Android WebView physically shrinks when the soft keyboard opens
  — below the DOM/Popover layer. The browser layout and the native HTML Popover
  API adapt naturally without any JS compensation. Status bar insets are
  applied as top padding so non-fullscreen apps don't draw behind the status
  bar. Combined with `adjustResize` above, this makes the keyboard work like a
  native app. The root view background color is controlled by the
  `VisttaTheme` bridge (see `Theme` plugin below). On desktop, the `Theme`
  plugin uses Tauri's `window.setTheme()` and `window.setBackgroundColor()`.
  The patch also wires launch-shortcut intents: `onCreate` and `onNewIntent`
  forward `org.vistta.runtime.LAUNCH_SHORTCUT` intents to `VisttaShortcuts`
  so they reach the webview as `launch-action` events (see
  [Accessibility](#accessibility)).
- `patchBuildTask` — rewrites Tauri 2.12.1's `BuildTask.kt` to invoke the
  absolute Node executable with the resolved Tauri CLI JavaScript entry point.
  No `tauri` npm script or PATH-resolved `.cmd`/`.bat` wrapper is required.
  The task invokes the CLI once: Cargo failures propagate instead of being
  masked by retries ending in a misleading `tauri.bat` launch error.
- `patchCargoToml` / `patchLibRs` / `patchMainRs` — full file writes, no
  marker comments
- `version` — read from the consumer's `package.json` and written to both
  `tauri.conf.json` and `Cargo.toml`, so bumping `package.json` propagates
  to the generated Tauri config and the Rust crate in one place. Override
  via `extraTauriConfig.version` if you need to decouple them.
- `nameSuffix()` (` (Dev)` in dev) — appended to the `tauri.conf.json`
  `productName`, so the dev build's installed-app name is distinct from
  the release build and both can coexist
- `devSuffix()` (` [DEV]` in dev) — appended to user-visible strings (window
  title on desktop, `strings.xml` `app_name` + `main_activity_title` on
  Android)
- `debugApplicationIdSuffix` (`.dev` in dev) — set in `tauri.conf.json`
  `bundle.android` by `mergeConfig`. Tauri appends it to the Android
  `applicationId` in debug builds so dev and release APKs install
  side-by-side. The `namespace` stays stable (no suffix) so the generated
  Kotlin source tree doesn't drift between dev/release — no stale
  package-dir cleanup needed.
- Android `app.assistant: true` — registers an ASSIST intent-filter so the
  app can be picked as the system Digital Assistant app (long-press power /
  assistant gesture). The trigger opens the app with a `launch-action`
  `{ id: "assistant", payload }`; the payload is published by JS via
  `Accessibility.setAssistant` (see [Accessibility](#accessibility)) and
  persisted natively for cold starts. Has no effect on desktop/iOS.
- Android `app.autofill: true` — registers the API 26+ AutofillService and
  authentication activity in the generated Android manifest, plus a launcher-app
  `<queries>` entry so the service can read target apps' signing certificates on
  Android 11+. Suggestions are also offered as keyboard inline chips on Android 11+
  (via `androidx.autofill`). It is off by
  default. The native runtime dispatches short-lived requests into the main
  Tauri WebView; apps subscribe through `Accessibility.onAutofillRequest` and
  must keep their vault unlocked. No credential is persisted in the
  native service. Generated manifest entries are removed when the flag is off.
  This integration has not been verified on an Android device.
- Desktop `app.background: true` — keeps the app alive in the background (tray
  icon + hide-on-close). The `tray-icon` Cargo feature is conditionally added.
  The tray menu is dynamic: JS publishes quick-actions via `Accessibility.setShortcuts`
  (see [Accessibility](#accessibility)) and clicks emit `launch-action` events back to
  the webview. The built-in Show/Hide item tracks and toggles the local window
  (`main`, or `ide` for hidden controllers). If no window exists, it emits a
  `launch-action` with id `show` so the controller can create it. Dynamic
  shortcuts do not automatically surface the IDE for hidden controllers.
  Has no effect on Android/iOS.
- Desktop apps run as a single instance (`tauri-plugin-single-instance`): a second
  launch shows the existing window (`main`, or `ide` when `app.visible: false`) and
  exits. Set `app.multipleInstances: true` to allow several instances.

**What's gone:**

- Foreground service for non-scheduler purposes (e.g. long-running sync
  workers)

**Android release signing.** Tauri does not support Android keystore
signing via `tauri.conf.json` — it must be done in Gradle. The runtime
auto-generates and manages the keystore for you:

- **Release builds**: if no keystore exists at `buildDir/android.keystore`,
  one is generated via `keytool` with a fixed alias (`upload`) and a
  cryptographically random 256-bit password. The password is persisted in
  `buildDir/android.keystore.properties`. The keystore is copied into
  `gen/android/app/release.keystore` and the Gradle `signingConfigs` block
  reads secrets from the build child process environment, not literal passwords
  in `app/build.gradle.kts` or command arguments. Local signing files use mode
  `0600` on POSIX; restrict their directory and ACLs on Windows. The persistent keystore in
  `buildDir/` is reused across builds so the signing key stays stable
  (same key = upgradeable APK).
- **Debug builds**: no keystore is used. Any previously-injected signing
  config is stripped from `build.gradle.kts` and the copied keystore is
  removed from `gen/android/app/`. The persistent keystore in `buildDir/`
  is kept for the next release build.

**Signing files are secrets.** Automatic generation is a local convenience, not
an OS keychain. Keep the keystore and properties file out of source control and
shared build artifacts, and back both up securely. The package excludes keystores
and their password properties from npm archives. Production/CI should provide a
backed-up keystore and `ANDROID_KEYSTORE_PASSWORD` through a secret manager.
Explicit keystores require a non-empty password; no password is guessed.
Existing signing identities are never silently replaced. Legacy keystores created
with an app-id-derived password are reused for compatibility: back them up and
change their store/key passwords with `keytool` before production use. Deleting a
deployed app's signing key can prevent future updates.

To use your own keystore instead of the auto-generated one, set
`keystore` to either a string (path only, password from `ANDROID_KEYSTORE_PASSWORD`
env var) or an object `{ file, password }` (used for both the keystore and the
key; alias is `upload`):

```javascript
await Tauri.build({
  platform: "android",
  buildDir: "./build",
  app: { id: "com.example.app", name: "My App" },
  keystore: { file: "./release.keystore", password: "..." },
});
```

## Release Validation

From this package directory in the workspace:

```bash
npm test
npm run test:package
npm run test:native
```

`npm test` covers signing, process execution, capabilities, lifecycle selection,
and generated icons. `test:package` packs the archive, checks for generated
outputs/secrets, installs it in an isolated consumer, and checks public exports.
It uses `--legacy-peer-deps` only for this fixture because the coordinated
`@vistta/js@0.0.1` peer is not published yet; this is not peer-compatibility
evidence. The normal consumer must install a compatible peer.

`test:native` additionally compiles a blank desktop release binary from that
installed archive. It requires Rust/Cargo and the host's Tauri prerequisites
(Visual C++ Build Tools on Windows, Xcode tools on macOS, or WebKitGTK/GTK,
ALSA, D-Bus and related development libraries on Linux). It does not launch a
window or build installers. The release workflow installs Linux prerequisites
and requires this native gate before publishing. Android deployment/signing and
cross-compilation still need their platform SDKs and device/toolchain validation.

The Tauri CLI is pinned to exactly `2.12.1`, invoked from this package's resolved
installation without `npx`, and checked against its installed manifest. Update
the dependency and `TAURI_VERSION` together when upgrading the baseline.
Rust crates have independent versions and semver ranges: retain the generated
`Cargo.lock` for reproducible consumer builds; CLI version `2.12.1` does not mean
that the Rust `tauri` crate has that version. Use a Patch release from `0.0.0`
for `0.0.1`, after the compatible framework peer is available.

## Integrations

Import plugin namespaces from `@vistta/js-native/plugins`:

```javascript
import {
  Clipboard,
  Dialog,
  Filesystem,
  Haptics,
  Notification,
  Recorder,
  Scheduler,
  Shell,
  Accessibility,
  System,
} from "@vistta/js-native/plugins";
```

`System` re-exports the Tauri core API modules (`@tauri-apps/api/app` and `@tauri-apps/api/path`) under one flat namespace — e.g. `System.getVersion()` and `System.downloadDir()`.

### Notifications

On Android 13+, the runtime permission **must** be requested before posting.
Use the exported notification API:

```javascript
import { Notification } from "@vistta/js-native/plugins";

const granted = (await Notification.isPermissionGranted()) || (await Notification.requestPermission()) === "granted";
if (granted) {
  await Notification.sendNotification({ title: "Hello", body: "From Vistta" });
}
```

The runtime auto-generates a monochrome `ic_stat_notification` drawable into
`res/drawable-*` so notifications render correctly on Android 5+. The full-colour
launcher icon will not display in the status bar.

### Filesystem

```javascript
import { Filesystem } from "@vistta/js-native/plugins";
await Filesystem.writeFile({ path: "test.txt", data: "Hello" });
const { data } = await Filesystem.readFile({ path: "test.txt" });
```

`Filesystem` also provides the native directory-sync boundary:

```javascript
import { Filesystem } from "@vistta/js-native/plugins";

const capability = await Filesystem.probeDirectorySync(directoryPath);
const selection = await Filesystem.selectSyncDirectory();

if (selection) {
  for await (const page of Filesystem.scanSyncDirectory(selection.path)) {
    if (page.complete) console.log(`Complete scan: ${page.count} entries`);
  }

  const source = await Filesystem.hashSyncFile(selection.path, "folder/file.bin");
  for await (const chunk of Filesystem.readSyncFileChunks(selection.path, "folder/file.bin", {
    fingerprint: source.fingerprint,
  })) {
    await upload(chunk);
  }
}
```

On desktop, selection uses the native folder picker and normal persistent OS
path access. On Android it uses `ACTION_OPEN_DOCUMENT_TREE` and retains the
read/write URI grant; a revoked or incomplete grant fails the probe. No broad
external-storage permission is requested. Capabilities distinguish streaming,
hashing, source revalidation, stable identity, watch support, and atomic,
durable, or merely recoverable replacement. SAF providers report atomic and
durable replacement as false even when their retained-copy sequence is usable.

`scanSyncDirectory()` performs a native recursive scan and yields deterministic
pages of at most 256 entries. Desktop revalidates every visited directory;
Android fingerprints and re-queries every provider child listing. Both reject
links or unsupported entries, non-NFC/non-portable names, and case-fold
collisions. Consumers must discard all pages unless the final page has
`complete: true`. Entries are written to an OS/app-cache spool and consumed in
strictly sequential bounded pages; an independent second walk must produce the
same count and digest before the first page is exposed.

`hashSyncFile()` streams SHA-256 with before/after metadata checks.
`readSyncFileChunks()` yields at most 1 MiB, checks every chunk against the
source fingerprint, then hashes the source again before the iterator completes;
callers must not commit uploaded content until iteration completes. Abort
signals cancel native scans and hashes.

Writes use `beginSyncFileWrite()`, `writeSyncFileChunk()`, and
`commitSyncFileWrite()`, or the `replaceSyncFile()` convenience helper. Desktop
flushes staged bytes, the replacement, and parent directories around atomic
same-filesystem renames. Android flushes its provider descriptor and uses an
immutable manifest plus prepared/backup/committed markers around provider
renames. Both retain the old copy for 30 days. `recoverSyncDirectory()` finishes
or rolls back interrupted commits and reports ambiguous states without
resurrecting a committed backup after a later deletion. `watchSyncDirectory()`
uses recursive desktop notifications plus polling; Android polls. Notifications
are reconciliation hints, never deletion evidence.

Android scans, hashes, writes, recovery, and streamed reads hold a bounded
`foregroundServiceType="dataSync"` lease. The service stops when the operation
finishes and implements the platform timeout callback; it does not make an
unbounded WebView task durable or bypass Android background-start restrictions.

The Rust implementation and Android Kotlin module have compile coverage, and
desktop recovery behavior has focused tests. Real Linux filesystems and Android
SAF providers still require the documented interruption/revocation field matrix;
Connect Sync rules remain disabled until that evidence and reconciliation exist.

### Haptics

```javascript
import { Haptics } from "@vistta/js-native/plugins";
await Haptics.impactFeedback({ style: "medium" });
await Haptics.vibrate(100);
```

### System

`System` groups the Tauri core API for app metadata and path resolution into
one flat namespace (the two modules have no overlapping export names):

- App info — `getVersion`, `getName`, `getTauriVersion`, `getIdentifier`, etc.
- Path helpers — `downloadDir`, `appDataDir`, `join`, `resolve`, `sep`, etc.
- Desktop login startup — `enableAutostart`, `disableAutostart`,
  `isAutostartEnabled` (official autostart plugin; `autostart:default`
  permissions). Registration is per OS user and is never enabled implicitly.

```javascript
import { System } from "@vistta/js-native/plugins";
const version = await System.getVersion();
const dir = await System.downloadDir();
const dest = await System.join(dir, "update.exe");
```

`System.downloadDir()` works out of the box — path resolution is part of the Tauri core API and doesn't require a separate permission. The fs scope already grants `$DOWNLOAD/**` for actual file access.

### Recorder

`Recorder` is the namespace for media capture. All capture types follow the
same contract: a start function resolves with a recording handle —
`{ on, stop }` — where `on(event, callback)` subscribes to recording events
and `stop()` resolves with `{ blob, stoppedBy }`.

Events:

- `"started"` — capture has actually begun (after permission/grant).
- `"vad"` — live voice-activity sample `{ rms, speech }` (audio only,
  fires ~every 100–200 ms). The tap starts with the recording when
  `autoStop` is enabled, or on the first `"vad"` subscription otherwise —
  samples only, enough to implement your own auto-stop.
- `"stopped"` — the recording ended; the payload is the same object `stop()`
  resolves with, delivered once before the promise settles. Once the
  recording reaches its terminal state (stopped or failed) every event
  listener on the handle is released.

- **Audio** (`startAudioRecording`) — Tauri: captured via
  `tauri-plugin-audio-recorder` (native capture over standard Tauri IPC; the
  Android runtime permission is requested through the plugin before recording
  starts). Mobile captures M4A/AAC and desktop WAV. Browser: the standard
  `MediaRecorder` pipeline (`getUserMedia`). Accepts an options object:
  `autoStop` (silence-aware auto-stop, below — `true` or an options object),
  `deviceId` (input device — desktop native), `quality`
  (`"low"|"medium"|"high"` — native capture), and the browser
  capture-processing toggles `echoCancellation`/`noiseSuppression`/`autoGainControl`.
- **Screen** (`startScreenRecording`) — Desktop/browser:
  `getDisplayMedia` + `MediaRecorder` (the user picks a screen, window, or
  tab). Android: `MediaProjection` via the system consent dialog — handled
  natively by `VisttaScreenRecorder` (Tauri commands
  `vistta|start_screen_recording` / `vistta|stop_screen_recording`), producing
  an MP4 in the app cache dir. Requires the `FOREGROUND_SERVICE_MEDIA_PROJECTION`
  permission (declared in the core plugin's manifest, merged at build time).
- **Camera** (`startCameraRecording`) — `getUserMedia({ video })` +
  `MediaRecorder` (front camera via `facingMode: "user"`); the platform
  permission dialog is surfaced by the WebView/browser.

```javascript
import { Recorder } from "@vistta/js-native/plugins";

// Call from a user gesture (mic button, etc.).
const recording = await Recorder.startAudioRecording();
recording.on("started", () => {
  /* capture has begun — update UI */
});

// ...
const { blob } = await recording.stop(); // Blob (M4A on mobile, WAV on desktop/browser)
if (blob) {
  // e.g. upload as FormData / convert to a data URL for a STT endpoint
}

// With options + events — capture config and live voice-activity feedback:
const recording2 = await Recorder.startAudioRecording({
  autoStop: true, // silence-aware auto-stop with defaults (enables "vad" too)
  deviceId: "...", // input device (desktop native)
  quality: "medium", // native capture quality (Tauri)
  echoCancellation: true, // browser capture processing (Tauri ignores)
  noiseSuppression: true,
  autoGainControl: true,
});
recording2.on("vad", ({ rms, speech }) => {
  /* live VAD feedback, fires ~every 100–200 ms while auto-stop runs */
});
recording2.on("stopped", ({ blob, stoppedBy }) => {
  /* fires once before stop() settles — useful for cleanup */
});

// Screen + camera follow the identical contract:
const screen = await Recorder.startScreenRecording();
const { blob: screenBlob } = await screen.stop(); // webm or mp4
const cam = await Recorder.startCameraRecording();
const { blob: cam } = await cam.stop(); // webm
```

Start functions reject on permission denial or capture failure with a
platform-appropriate message. A user gesture is required on most platforms —
invoke them from a UI event handler.

#### Silence-aware auto-stop (audio)

Audio recording can opt in to silence-aware auto-stop: once speech was
heard, the recording stops itself after the user has been quiet for
`trailingSilenceMs` — push-to-talk becomes voice-first. The stop function
resolves `{ blob, stoppedBy }` where `stoppedBy` is `"user"` (manual stop),
`"silence"` (trailing-silence window elapsed), `"no-speech"` (nothing said
within `initialSpeechTimeoutMs`), or `"max-duration"` (hard backstop).

```javascript
const recording = await Recorder.startAudioRecording({
  autoStop: {
    trailingSilenceMs: 2000, // silence after speech that stops the recording
    minDurationMs: 3000, // never auto-stop before this
    initialSpeechTimeoutMs: 10000, // cancel if no speech yet (0 = disabled)
    maxDurationMs: 45000, // hard backstop regardless of VAD state
  },
});
// `autoStop: true` is shorthand for exactly these defaults.

const { blob, stoppedBy } = await recording.stop(); // "user" | "silence" | "max-duration" | "no-speech"
```

Without `autoStop` the recording never stops itself — but `"vad"` events are
still available: the tap starts on the first `"vad"` subscription and
delivers `{ rms, speech }` samples, so you can implement your own auto-stop
(or a live level meter):

```javascript
const recording = await Recorder.startAudioRecording();
let lastSpeech = 0;
recording.on("vad", ({ rms, speech }) => {
  if (speech) lastSpeech = Date.now();
  else if (lastSpeech && Date.now() - lastSpeech > 2000) recording.stop(); // custom auto-stop
});
```

Timing order is `minDurationMs` floor → `trailingSilenceMs` window →
`maxDurationMs` backstop. The voice-activity detection uses an adaptive
noise floor with hysteresis (speech must rise above the floor by a margin)
and arms only after the first speech burst, so a pre-speech pause is never
cut short. Manual stop always wins if it happens first.

Live loudness is sourced per platform: browser/desktop fork the recorded
stream into a Web Audio `AnalyserNode` (a parallel tap — the recording is
untouched); Android uses the runtime's `VisttaVad` bridge (a parallel
`AudioRecord` tap, since the WebView media stack is bypassed there). The
bridge exposes its latest RMS and sample count as primitive values, which the
JS watcher polls every 100 ms. On desktop Tauri the tap runs via a parallel
`getUserMedia` stream; if that is denied, auto-stop degrades to manual-only.
Recording itself is unchanged by the VAD — it only triggers the existing stop
path.

### Accessibility

`Accessibility` exposes a cross-platform dynamic quick-action API. The app
declares a list of `{ id, label, icon?, payload? }` entries and a single
handler; the runtime pushes the entries to whichever native surface exists
and routes triggers back into JS.

- **Desktop** (when `app.background: true`) — entries become items in the
  system-tray menu, below the built-in `Show` and `Quit`. The menu is
  rebuilt at runtime whenever `setShortcuts` is called. Selecting an item
  emits a `launch-action` event the handler receives.
- **Android** — entries are published as dynamic launcher shortcuts via
  `ShortcutManagerCompat` (shown when the user long-presses the app icon).
  Selecting one (re)launches the activity with an intent whose extras carry
  the `id` and `payload`; `MainActivity` forwards the intent to the
  `VisttaShortcuts` bridge, which dispatches a `launch-action` event into
  the webview. Cold-start actions are stashed and flushed once the webview
  attaches.
- **iOS / browser** — `setShortcuts` is a no-op and `onLaunchAction` never
  fires.

```javascript
import { Accessibility } from "@vistta/js-native/plugins";

// Publish the current action set. Safe to call again later to update it
// (e.g. when a feature is enabled/disabled in settings).
await Accessibility.setShortcuts([
  { id: "sync.clipboard", label: "Sync clipboard" },
  { id: "notes.new", label: "New note" },
  { id: "search", label: "Search" },
  { id: "files.open", label: "Open files", payload: "root" },
]);

// Receive triggers from either surface.
Accessibility.onLaunchAction(({ id, payload }) => {
  switch (id) {
    case "sync.clipboard":
      /* ... */ break;
    case "notes.new":
      /* ... */ break;
    case "search":
      /* ... */ break;
    case "files.open":
      /* payload === "root" */ break;
  }
});

// System assistant trigger (Android, when built with `app.assistant: true`).
// Publishes the payload the trigger delivers; the event arrives with the
// fixed id "assistant" and this payload. Any JSON-serializable value works —
// serialization is handled by the runtime.
await Accessibility.setAssistant({ assistant: true });
```

On Android builds with `app.autofill: true`, `Accessibility.hasAutofill()`
reports whether the native transport is available. Use
`Accessibility.isAutofillEnabled()` to check system selection and
`Accessibility.openAutofillSettings()` to request it. Subscribe with
`Accessibility.onAutofillRequest(async ({ operation, data }) => response)`;
the returned function unsubscribes. Operations are `query`, `select`, and
`save`. The handler must return no credentials for a locked session, and
decrypt only on `select`. The Android `VisttaAutofill` JavascriptInterface
remains an internal transport; application code should not access it or
install a handler on `window`.

`icon` is an Android drawable resource name (no extension, no
`R.drawable.` prefix) bundled with the app; it is ignored on desktop
(tray items are text-only). If omitted (or unresolvable), the shortcut
publishes with a transparent icon so the launcher shows no icon instead
of the default app icon. `payload` is an opaque string forwarded
unchanged through the native layer — useful for parameterised actions
(e.g. opening a specific note id). On a cold-start launch from a shortcut,
`payload` is recovered from the intent extra, not the JS list, so it is
available before `setShortcuts` has run.

`setAssistant(payload)` publishes the payload for the system assistant
trigger (`ACTION_ASSIST`, Android only, when built with
`app.assistant: true`). The trigger always opens the app as the fixed
`assistant` action — only the payload is app-defined. The payload may be
any JSON-serializable value: the runtime serializes it for the native
layer and parses it back into the original JS value before the event is
delivered (plain strings pass through unchanged). The payload is
persisted natively so a cold-start trigger (before the webview boots)
still carries it; passing `null` clears it. No-op on iOS and browser
builds.

The connect app owns the single source of truth for the action set; native
code only carries `{ id, label, icon, payload }` in and `{ id, payload }`
out. Requires no additional permissions on Android — dynamic shortcuts are
part of the launcher contract.

### Shell

`Shell` re-exports the Tauri `@tauri-apps/plugin-shell` surface (`Command`,
`open`, etc.) and overrides `open` on Android: when `path` points to a local
`.apk` file, the system package installer is launched via the
`VisttaInstaller` JavascriptInterface bridge (injected by `VisttaPlugin`),
which converts the file path to a `content://` URI via the app's
`FileProvider` and fires `ACTION_VIEW` with the APK MIME type. This means
`Shell.open("/path/to/update.apk")` works uniformly across desktop and
Android — the caller does not need to branch by platform.

Requires the `REQUEST_INSTALL_PACKAGES` permission (declared in the core
plugin's `AndroidManifest.xml`, merged into the host app at build time).

```javascript
import { Shell } from "@vistta/js-native/plugins";
await Shell.open("/path/to/update.apk");
await Shell.open("https://github.com/vistta/vistta");
```

### Scheduler

`setBackgroundInterval` / `setBackgroundTimeout` work like `setInterval`
and `setTimeout`, but the callback keeps firing when the user backgrounds
the app, locks the device, or switches to another app. On Android the
runtime auto-starts a foreground service (`VisttaService`) which holds
the process + webview alive. The service is started on the first call
to `setBackgroundInterval` / `setBackgroundTimeout` and stopped when
the last timer is cleared. On desktop and browser the API is a thin
wrapper over `setInterval` / `setTimeout`.

```javascript
import {
  setBackgroundInterval,
  clearBackgroundInterval,
  setBackgroundTimeout,
  clearBackgroundTimeout,
} from "@vistta/js-native/plugins";

const id = setBackgroundInterval(() => {
  socket.send({ type: "ping", ts: Date.now() });
}, 30_000);

// later
clearBackgroundInterval(id);

const timeoutId = setBackgroundTimeout(() => {
  showReminder();
}, 5 * 60_000);
clearBackgroundTimeout(timeoutId);
```

The callback runs in the webview's JS context with full closure access,
so the existing `this`, the component tree, and any in-memory state are
preserved. Tauri emits a low-priority "Background sync active"
notification while the service is running; this can be dismissed by
the user but will re-appear the next time a timer is registered.

**What this is not:** a substitute for `AlarmManager` or `WorkManager`
when the device has been idle for hours. The foreground service is
allowed to run as long as the data sync is ongoing, but Doze mode may
defer wake-ups when the device is unplugged and idle. Use this for
sub-hour polling, keep-alive pings, and "I just need this to keep
firing while the user has me in their pocket." Use Android's native
`WorkManager` (or Tauri's notification plugin scheduled via a
`tauri-plugin-notification` schedule) for true time-of-day reminders.

#### Background `fetch` override (Android)

On Android, the `fetch` exported from `@vistta/js-native/plugins` is
routed through the `VisttaNetwork` OkHttp client (running in the
foreground service) whenever the `VisttaFetch` bridge is present. This
means `fetch()` calls complete even when the activity is paused — the
service's network stack is not bound to the activity lifecycle. When
the bridge is absent (desktop, web, iOS, or before the activity injects
the bridge), `fetch` falls through to the regular `window.fetch`.

> **Note:** this does not monkey-patch `window.fetch`. When the bridge
> is present, loading `@vistta/js-native/plugins` makes `Net.fetch` the
> fetch used by `request` from `@vistta/utils`, and the `@vistta/js` SPA
> client loads the plugins on mobile before the first route, so app
> requests go through the service with no setup.

The override is what makes background polling work: while the activity
is paused, the WebView's own network stack stops completing responses,
so a `fetch` started from JS would hang. The service has its own
network stack that is not bound to the activity lifecycle.

Limitations to be aware of:

- **Request bodies**: anything `fetch` accepts (`string`, `Blob`,
  `FormData`, `ArrayBuffer`, typed arrays, `URLSearchParams`) is
  normalised through `Request`, read fully, and sent with its
  `Content-Type` (including the multipart boundary). `ReadableStream`
  bodies are not supported.
- **Responses**: the head resolves the promise, then the body is
  streamed to a `ReadableStream` in 64 KiB chunks, so progress and
  `stream: true` reads work. Each chunk crosses the bridge as base64.
- **Local URLs**: same-origin (the bundled shell), `data:`, and `blob:`
  URLs always use `window.fetch`.
- **Timeouts**: none on reads, matching `window.fetch`; connecting
  times out after 15 seconds.
- **Cancellation**: `AbortSignal` is honored, and cancelling the
  response body aborts the native call. Aborting calls
  `VisttaNetwork.abortFetch(id)` and rejects with
  `DOMException("Aborted", "AbortError")`. Network failures reject with
  a `TypeError`, like `window.fetch`.
- **Cookies / CORS**: the service performs a plain HTTP request via
  OkHttp, so CORS does not apply and no cookie jar is kept; send auth
  as headers. Headers from the original request are forwarded, except
  ones `Request` forbids (such as `Cookie` and `Sec-*`).

## Clipboard

**Privacy:** Shizuku/Sui and other elevated clipboard backends can read clipboard
contents while the app is not focused. Enable them only with explicit user
consent, and treat captured content as potentially sensitive credentials. Do not
log, retain, or transmit background clipboard content without that consent.

```javascript
import { Clipboard } from "@vistta/js-native/plugins";

// Read/write the system clipboard (Tauri clipboard-manager commands).
await Clipboard.writeText("hello");
const text = await Clipboard.readText();
await Clipboard.clear();
```

### Background clipboard watching (Android 10+)

Android 10 (API 29) restricts normal `ClipboardManager.primaryClip` reads to
the focused app or the default IME. A foreground service and an
`AccessibilityService` do not grant background clipboard-read access.

`Clipboard.watchBackground(onClip)` delivers clipboard changes to a
callback. On Android, the dedicated privileged clipboard plugin automatically
uses Shizuku or Sui when it is running and Vistta is already authorized. On
desktop, iOS, or standard Android, it falls back to polling `readText()` on a
plain `setInterval`. On Android 10+ this only delivers while the app is
foregrounded, so it does not start the background service.

```javascript
import { Clipboard } from "@vistta/js-native/plugins";

const stop = Clipboard.watchBackground((text) => {
  console.log("clipboard changed:", text);
  // ...push to sync...
}, 2000);
// later
stop();
```

Authorize Vistta in Shizuku or Sui once. No backend-specific application code
is required; new watchers select the privileged backend automatically whenever
it is available.

| Platform              | Background reads                                             |
| --------------------- | ------------------------------------------------------------ |
| Android + Shizuku/Sui | Privileged plugin monitor after authorization                |
| Standard Android      | Polling; reads return null while backgrounded                |
| Desktop               | Polling via `setInterval` (works in background)              |
| iOS                   | Polling via `setInterval` (subject to iOS background limits) |

The Shizuku/Sui backend requires Shizuku or Sui to be running and Vistta to be
authorized, and falls back to standard foreground behavior if unavailable.
Root is not implemented; it requires a separately verified shell clipboard
transport before it can be exposed as another backend.

## Platform Detection

```javascript
if (window.__TAURI__) {
  // Running in Tauri (native app)
} else {
  // Running in browser (web)
}
```

## Running on Android

1. Install the Android SDK and ensure `ANDROID_HOME` is set.
2. Use `Tauri.run({ target: "android", ... })` — invokes `tauri android dev` under the hood.
3. Build an APK with `Tauri.build({ target: "android", ... })`.

## Running on iOS (macOS only)

Not yet supported via `Tauri.run` / `Tauri.build`. Use `npx tauri ios dev` directly inside
`buildDir` after running a desktop build at least once to populate the baseline.

## How It Works

The runtime's `build()` (and `run()`'s underlying `applyConfig`) seeds the
`buildDir` from the package's `rust/` directory and then runs the
generators:

```
rust/                                   verbatim `tauri init` baseline at TAURI_VERSION
```

1. `applyTemplate()` (in `apply-template.js`) copies `rust/` into
   `buildDir/`.
2. `patchMainRs` / `patchLibRs` / `patchCargoToml` regenerate the Rust
   entry points and plugin dependencies from `plugins.config.js`
   (single source of truth). The seeded `Cargo.toml` / `src/lib.rs` /
   `src/main.rs` are overwritten in full on every build.
3. `mergeConfig` writes `tauri.conf.json` from the JS config +
   `extraTauriConfig`.
4. `patchCapabilities` writes `capabilities/default.json` from
   `plugins.config.js` + `extraCapabilities`.
5. Android-only: `patchBuildTask`, `patchAndroidManifest`,
   `patchMainActivity`, `patchAndroidStrings`. These patch Tauri's
   _generated_ host files that cannot be plugin-ized (BuildTask.kt, the main
   activity soft-input mode + IME inset handling, and strings.xml launcher
   label). The dev/release `applicationId` split
   is handled natively by Tauri via `debugApplicationIdSuffix` in
   `tauri.conf.json` (set by `mergeConfig`) — no namespace/applicationId
   re-alignment or stale package-dir cleanup needed. The runtime's
   Android background features (foreground service, background fetch,
   background socket, JavascriptInterface bridges, permissions, Maven
   deps) are owned by the `tauri-plugin-vistta` crate at `rust/plugin/` and
   registered as a standard Tauri Android plugin — Android's manifest
   merger and Gradle dependency resolution pull them into the host app
   automatically.
6. `npx tauri (android) dev|build` runs.

The pinned Tauri version lives in `index.js` as `TAURI_VERSION` and
is also exported from the package. It must match the
`@tauri-apps/cli` version in `package.json` and the baseline inside
`rust/`.

All generated files in `buildDir/` are owned by the runtime —
customise via the config object, not by editing files in `buildDir`.

## Upgrading Tauri

When a new Tauri version ships:

1. Bump `@tauri-apps/cli` and `@tauri-apps/api` in `package.json`.
2. Bump `TAURI_VERSION` in `index.js` to match.
3. Run `tauri init` in a scratch project at the new version and copy
   the produced files into `rust/`, then compare against the
   previous baseline and reconcile any structural changes Tauri
   made (e.g. a new field in `tauri.conf.json`, a new default
   permission in `capabilities/default.json`).
4. The patch functions (`patchCargoToml`, `patchLibRs`, etc.) own
   their target files in full, so most upstream changes only affect
   the seed baseline — review the diff to make sure no new default
   needs to be threaded through the generators. The Android host-file
   patches (`patchBuildTask`, `patchAppGradleNamespace`) are regex-based
   against Tauri's generated output; if Tauri changes the shape of
   `BuildTask.kt` or `app/build.gradle.kts`, those patches may need
   updating. The `tauri-plugin-vistta` crate at `rust/plugin/` is unaffected
   by Tauri upgrades (it uses Tauri's stable plugin API).
5. Commit. The next `build()` will use the new baseline.

## Tauri Plugins Used

See `plugins.config.js` for the canonical list. As of writing:

| Plugin                                     | Purpose                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `tauri-plugin-vistta`                      | Android background scheduler, fetch, socket, and standard clipboard bridge (runtime-owned, at `rust/plugin/`) |
| `tauri-plugin-vistta-privileged-clipboard` | Android Shizuku/Sui clipboard monitor (runtime-owned, at `rust/privileged-clipboard-plugin/`)                 |
| `tauri-plugin-audio-recorder`              | Cross-platform microphone recording (WAV on desktop, M4A on mobile)                                           |
| `tauri-plugin-clipboard-manager`           | Clipboard access (read/write text, images, HTML; clear)                                                       |
| `tauri-plugin-dialog`                      | Native dialogs                                                                                                |
| `tauri-plugin-fs`                          | File system access                                                                                            |
| `tauri-plugin-haptics`                     | Haptic feedback                                                                                               |
| `tauri-plugin-notification`                | System notifications                                                                                          |
| `tauri-plugin-shell`                       | Open URLs, spawn processes                                                                                    |

## License

Licensed under the GNU General Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE) for the full terms.
