# @vistta/js-runtime

Unified runtime for building cross-platform applications (mobile, desktop, web) using **Tauri v2**.

## Features

- **Single codebase** for all platforms: Android, macOS, Windows, Linux, and Web (iOS planned)
- **JS-only for app developers** — no Rust required; the runtime owns `src-tauri/`
- **Built-in integrations**: Clipboard, Dialog, Filesystem, Haptics, Notification, Shell
- **Smaller bundle than Electron** (Tauri ships a webview, not a full browser)

## Installation

```bash
npm install @vistta/js-runtime
```

## Quick Start

```javascript
import { Tauri } from "@vistta/js-runtime";

// Launches `tauri dev` for desktop, `tauri android dev` for Android.
await Tauri.run({
  platform: "desktop", // required: "desktop" | "android" | "ios" | "linux" | "windows" | "macos"
  buildDir: "./build", // src-tauri root for this app
  app: {
    id: "com.example.myapp",
    name: "My App",
  },
  title: "My App",
  backgroundColor: "#ffffff",
});
```

`run` and `build` are also available as named exports:

```javascript
import { run, build } from "@vistta/js-runtime";
```

## API

### `Tauri.run(config)`

Generates / refreshes `src-tauri/` files from the config, then runs the platform-specific
Tauri dev loop:

- `platform: "desktop"` (or `"linux"`/`"windows"`/`"macos"`) → `npx tauri dev`
- `platform: "android"` → `npx tauri android dev`
- `platform: "ios"` → not yet supported

`"windows"` and `"macos"` auto-set `crossCompile` to the appropriate Rust target triple; `"linux"` and `"desktop"` build natively. Cross-compilation is automatic — no extra flags needed.

```javascript
await Tauri.run({
  platform: "desktop",
  buildDir: "./build",
  app: {
    id: "com.example.app",
    name: "My App",
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

### `Tauri.build(config)`

Builds the Tauri app for distribution (Android APK, Windows installer, etc.).
Same config shape as `run`. The `platform` field is required.

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
    { identifier: "shell:allow-execute", allow: [{ name: "git", cmd: "git", args: true }] },
  ],

  // Override the default CSP (defaults to null = disabled).
  security: { csp: "default-src 'self'" },

  // Platform code-signing. Windows + macOS settings are forwarded to
  // tauri.conf.json bundle config. Android: provide a pre-existing keystore
  // path + password.
  keystore: { file: "./release.keystore", password: "..." },
  // Dev-only: pass through a custom dev server URL (otherwise frontendDist is used).
  devUrl: "http://localhost:5173",
});
```

> `extraTauriConfig` is deep-merged into the generated `tauri.conf.json`. Object
> properties merge recursively; **arrays from `extraTauriConfig` replace** the
> defaults rather than concatenating, so callers can fully control list-valued
> fields like `app.windows`.

#### Return value

`run` and `build` return different shapes:

- `run` returns an `exec` handle of `{ close, on, end }`. `run` is long-lived — keep the handle and call `handle.close()` to stop the dev process.
- `build` returns `{ type, paths }` where `type` is the build variant that was produced (`"release"` or `"debug"`) and `paths` is a list of absolute paths to the produced artifacts (APK/AAB for android, `.app`/`.ipa` for ios, installers + native binary for desktop). The runtime parses tauri output for `Finished ... at:` markers (both single-line `Finished 1 artifact at: <path>` and multi-line `Finished N bundles at:` followed by indented paths) and falls back to well-known default paths when no markers are emitted. The promise rejects with an `Error` on non-zero exit.

The CLI consumer (`@vistta/js`) takes the `paths` and copies each artifact to the build output directory using a versioned name derived from `artifactName()`:

```javascript
import { build, artifactName } from "@vistta/js-runtime";

const { type, paths } = await build({ platform: "android", buildDir: "./build", app: { name: "My App", version: "1.0.0" } });
for (const sourcePath of paths) {
  const name = artifactName({ appName: "My App", version: "1.0.0", type, sourcePath });
  // → "My-App-1.0.0.apk" / "My-App-1.0.0.aab" (android)
  // → "My-App-1.0.0_en-US.msi" / "My-App-1.0.0-setup.exe" (desktop installers)
  // → "My-App-1.0.0-release.exe" (desktop raw binary)
  // → "My-App-1.0.0.app" / ".ipa" (ios)
}
```

#### `artifactName({ appName, version, type, sourcePath })`

Derives a versioned destination filename for an artifact produced by `build()`. The naming convention is:

- Android APK: `<App-Name>-<version>-<type>.apk`
- Android AAB: `<App-Name>-<version>.aab`
- Desktop installer (msi/nsis/deb/rpm/AppImage/dmg): `<App-Name>-<version><...suffix><.ext>` (Tauri's own filename is preserved; the type segment is not added)
- Desktop raw binary: `<App-Name>-<version>-<type><.exe?>` (where the type segment is `-release` or `-debug`)
- iOS `.app`/`.ipa`: `<App-Name>-<version><.ext>`

Whitespace and reserved filesystem characters (`/ \ : * ? " < > |`) in `appName` and `version` are collapsed to a single `-` so the filename is safe on Windows, macOS, and Linux.

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

## Android status

The runtime supports foreground Android apps and a foreground-service-based
background scheduler (see [Scheduler](#scheduler) below).

**What's there:**

- `tauri-plugin-vistta` (at `rust/plugin/`) — the runtime's own Tauri plugin crate.
  On Android it registers a Kotlin `VisttaPlugin` class that owns:
  - `VisttaService` — the foreground service that holds the process + webview
    alive while a scheduler timer is active or a background socket is open.
    Uses `foregroundServiceType="specialUse"` (Android 14+) so it is not
    subject to the `dataSync` time budget that kills long-running services.
    The service only calls `startForeground()` for actions started via
    `startForegroundService()` (`REGISTER`, `SOCKET_OPENED`); other actions
    (`CLEAR`, `STOP_IF_EMPTY`, `SOCKET_CLOSED`) are sent via `startService()`
    on an already-running service. A null-intent system restart stops the
    service immediately to avoid a `ForegroundServiceStartNotAllowedException`
    crash loop.
  - `VisttaNetwork` — the OkHttp client and Socket.IO Java client used for
    background fetch and background sockets.
  - `VisttaScheduler` / `VisttaFetch` / `VisttaSocket` JavascriptInterface
    bridges injected into the webview.
  - A default notification channel for the notification plugin.
  - The `<uses-permission>`s (`POST_NOTIFICATIONS`, `VIBRATE`, `WAKE_LOCK`,
    `FOREGROUND_SERVICE*`) and `<service>` entry in the plugin's own
    `AndroidManifest.xml` — merged into the host app by Android's manifest
    merger, no host-file patching needed.
  - The `okhttp` and `socket.io-client` Maven deps in the plugin's own
    `build.gradle.kts`.
    On desktop/iOS the plugin is a no-op.
- `patchAndroidStrings` — keeps launcher label + activity title in sync with
  `tauri.conf.json`
- `patchBuildTask` — rewrites Tauri 2.11.2's `BuildTask.kt` to call the
  `tauri` CLI directly instead of going through `npm run -- tauri ...`, so
  the consumer's `package.json` doesn't need a `tauri` script
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
- Desktop `app.background: true` — keeps the app alive in the background (tray
  icon + hide-on-close). The `tray-icon` Cargo feature is conditionally added.
  Has no effect on Android/iOS.

**What's gone:**

- Foreground service for non-scheduler purposes (e.g. long-running sync
  workers)
- Auto-generated release keystore (you must provide your own)

**Android release signing.** Tauri does not support Android keystore
signing via `tauri.conf.json` — it must be done in Gradle. The runtime
auto-generates and manages the keystore for you:

- **Release builds**: if no keystore exists at `buildDir/android.keystore`,
  one is generated via `keytool` with a fixed alias (`upload`) and a
  stable password derived from the app id. The password is persisted in
  `buildDir/android.keystore.properties`. The keystore is copied into
  `gen/android/app/release.keystore` and the Gradle `signingConfigs` block
  is injected into `app/build.gradle.kts`. The persistent keystore in
  `buildDir/` is reused across builds so the signing key stays stable
  (same key = upgradeable APK).
- **Debug builds**: no keystore is used. Any previously-injected signing
  config is stripped from `build.gradle.kts` and the copied keystore is
  removed from `gen/android/app/`. The persistent keystore in `buildDir/`
  is kept for the next release build.

To use your own keystore instead of the auto-generated one, set
`keystore` to either a string (path only, password from `ANDROID_KEYSTORE_PASSWORD`
env var) or an object `{ file, password }` (used for both the keystore and the
key; alias is `upload`):

```javascript
await Tauri.build({
  target: "android",
  buildDir: "./build",
  app: { id: "com.example.app", name: "My App" },
  keystore: { file: "./release.keystore", password: "..." },
});
```

## Integrations

Import plugin namespaces from `@vistta/js-runtime/plugins`:

```javascript
import { Clipboard, Dialog, Filesystem, Haptics, Notification, Scheduler, Shell } from "@vistta/js-runtime/plugins";
```

### Notifications

On Android 13+, the runtime permission **must** be requested before posting.
Use the bundled helper:

```javascript
import { Notification, ensureNotificationPermission } from "@vistta/js-runtime/plugins";

if (await ensureNotificationPermission()) {
  await Notification.sendNotification({ title: "Hello", body: "From Vistta" });
}
```

The runtime auto-generates a monochrome `ic_stat_notification` drawable into
`res/drawable-*` so notifications render correctly on Android 5+. The full-colour
launcher icon will not display in the status bar.

### Filesystem

```javascript
import { Filesystem } from "@vistta/js-runtime/plugins";
await Filesystem.writeFile({ path: "test.txt", data: "Hello" });
const { data } = await Filesystem.readFile({ path: "test.txt" });
```

### Haptics

```javascript
import { Haptics } from "@vistta/js-runtime/plugins";
await Haptics.impactFeedback({ style: "medium" });
await Haptics.vibrate(100);
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
} from "@vistta/js-runtime/plugins";

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

On Android, the `fetch` exported from `@vistta/js-runtime/plugins` is
routed through the `VisttaNetwork` OkHttp client (running in the
foreground service) whenever the `VisttaFetch` bridge is present. This
means `fetch()` calls complete even when the activity is paused — the
service's network stack is not bound to the activity lifecycle. When
the bridge is absent (desktop, web, iOS, or before the activity injects
the bridge), `fetch` falls through to the regular `window.fetch`.

> **Note:** this applies to the `fetch` function imported from
> `@vistta/js-runtime/plugins`, not to `window.fetch` globally. The
> runtime does not monkey-patch `window.fetch`.

The override is what makes background polling work: while the activity
is paused, the WebView's own network stack stops completing responses,
so a `fetch` started from JS would hang. The service has its own
network stack that is not bound to the activity lifecycle.

The override is transparent to consumers — code that does
`fetch(url)` or `request.get(...)` inside a tick callback Just Works on
Android. Limitations to be aware of:

- **Request bodies**: `string`, `ArrayBuffer`, and typed arrays are
  supported. `Blob` and `FormData` are rejected (the bridge has no
  streaming-read path for them).
- **Streaming responses**: not supported. The service buffers the full
  response before delivering. Use non-streaming fetches.
- **Cancellation**: `AbortSignal` is honored. Aborting the signal calls
  `VisttaNetwork.abortFetch(id)` and rejects the promise with
  `DOMException("Aborted", "AbortError")`.
- **Auth / CORS**: not affected. The service performs a plain HTTP
  request via OkHttp, so CORS does not apply (this is the OS's HTTP
  client, not a browser fetch). Auth headers from the original request
  are forwarded.

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
5. Android-only: `patchBuildTask`, `patchAndroidStrings`. These patch
   Tauri's _generated_ host files that cannot be plugin-ized (BuildTask.kt
   and strings.xml launcher label). The dev/release `applicationId` split
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

| Plugin                           | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `tauri-plugin-vistta`            | Android background scheduler, fetch, and socket bridge (runtime-owned, at `rust/plugin/`) |
| `tauri-plugin-clipboard-manager` | Clipboard access                                                                          |
| `tauri-plugin-dialog`            | Native dialogs                                                                            |
| `tauri-plugin-fs`                | File system access                                                                        |
| `tauri-plugin-haptics`           | Haptic feedback                                                                           |
| `tauri-plugin-notification`      | System notifications                                                                      |
| `tauri-plugin-shell`             | Open URLs, spawn processes                                                                |

## License

Apache 2.0 with Commons Clause
