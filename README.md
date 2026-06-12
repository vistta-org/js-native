# @vistta/js-runtime

Unified runtime for building cross-platform applications (mobile, desktop, web) using **Tauri v2**.

## Features

- **Single codebase** for all platforms: Android, iOS, macOS, Windows, Linux, and Web
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
  target: "desktop", // required: "desktop" | "android" | "ios"
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

- `target: "desktop"` → `npx tauri dev`
- `target: "android"` → `npx tauri android dev`
- `target: "ios"` → not yet supported

```javascript
await Tauri.run({
  target: "desktop",
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
    background: false, // tray on desktop / foreground service on Android
  },
  title: "My App",
  icon: "icon.png", // relative to buildDir/www
  backgroundColor: "#ffffff",
});
```

### `Tauri.build(config)`

Builds the Tauri app for distribution (Android APK, Windows installer, etc.).
Same config shape as `run`. The `target` field is required.

```javascript
await Tauri.build({
  target: "android",
  buildDir: "./build",
  app: { id: "com.example.app", name: "My App" },
});
```

### Extension points

Power-user escape hatches so you can extend the generated `src-tauri/` without
forking the runtime. All are optional and deep-merged into the defaults.

```javascript
await Tauri.build({
  target: "desktop",
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

  // Platform code-signing — credentials should come from env vars, not config.
  signing: {
    android: { keystorePath: "./release.keystore", minSdkVersion: 24, versionCode: 12 },
    windows: { certificateThumbprint: "...", digestAlgorithm: "sha256", timestampUrl: "http://timestamp.digicert.com" },
    macos: {
      signingIdentity: "Developer ID Application: ...",
      providerShortName: "TEAMID",
      entitlements: "./entitlements.plist",
    },
  },

  // Stream tauri stdout/stderr line-by-line (replaces inherited stdio).
  onOutput: (msg, isError) => console[isError ? "error" : "log"](msg),

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
- `build` returns `{ type, paths }` where `type` is the build variant that was produced (`"release"` or `"debug"`) and `paths` is a list of absolute paths to the produced artifacts (APK/AAB for android, `.app`/`.ipa` for ios, the native binary for desktop). The runtime parses tauri output for `Finished ... at:` markers and falls back to well-known default paths if no markers are emitted. The promise rejects with an `Error` on non-zero exit.

The CLI consumer (`@vistta/js`) takes the `paths` and copies each artifact to the build output directory using a versioned name derived from `artifactName()`:

```javascript
import { build, artifactName } from "@vistta/js-runtime";

const { type, paths } = await build({ target: "android", buildDir: "./build", app: { name: "My App", version: "1.0.0" } });
for (const sourcePath of paths) {
  const name = artifactName({ appName: "My App", version: "1.0.0", type, sourcePath });
  // → "My-App-1.0.0.apk" / "My-App-1.0.0.aab" (android)
  // → "My-App-1.0.0-release.exe" (desktop)
  // → "My-App-1.0.0.app" / ".ipa" (ios)
}
```

#### `artifactName({ appName, version, type, sourcePath })`

Derives a versioned destination filename for an artifact produced by `build()`. The naming convention is:

- Android APK: `<App-Name>-<version>-<type>.apk`
- Android AAB: `<App-Name>-<version>.aab`
- Desktop binary: `<App-Name>-<version>-<type><.exe?>` (where the type segment is `-release` or `-debug`)
- iOS `.app`/`.ipa`: `<App-Name>-<version><.ext>`

Whitespace and reserved filesystem characters (`/ \ : * ? " < > |`) in `appName` and `version` are collapsed to a single `-` so the filename is safe on Windows, macOS, and Linux.

## Android signing & debug builds

### Release keystore (auto-generated and backed up)

For release Android builds the runtime needs a signing keystore. If one does not
already exist at the configured `signing.android.keystorePath` (default
`gen/android/app/keystore/release.keystore`), the runtime generates a 2048-bit
RSA keystore with a random password and persists the credentials alongside it.

Because `tauri android init` regenerates the `gen/android` tree from scratch —
which would wipe an in-tree keystore — the runtime mirrors the keystore and its
credentials to a persistent `.keystore/` directory in `buildDir`. On the next
build it restores them into `gen/android` before signing, so the **release
signing identity stays stable across regenerations**. Commit `.keystore/` to keep
the identity reproducible; treat it as a secret.

> Android Gradle resolves `storeFile` relative to the `:app` module, so the
> keystore must live inside `gen/android` at build time — the `.keystore/` mirror
> exists purely so it can be restored after a regeneration.

### Parallel debug install

Dev builds (`run`, or `build` under `NODE_ENV=development`) are produced as the
`debug` variant with the application id suffixed by `.debug` (e.g.
`com.example.app.debug`). Combined with the debug build type's auto-generated
debug keystore, the resulting APK **installs side-by-side with the release
build** instead of overwriting it. The `namespace` and package source paths are
unchanged — only the runtime `applicationId` is suffixed — so the activity class
remains `<app.id>.MainActivity`. The release `applicationId` is never modified.

### WebView devtools on Android

The dev build also enables the system WebView's content debugger
(`WebView.setWebContentsDebuggingEnabled(true)`) at MainActivity start, gated
on `BuildConfig.DEBUG` so the call is compiled out of release builds. Combined
with the debug variant's `android:debuggable="true"`, the app's webview shows
up in Chrome at `chrome://inspect/#devices`, so you can attach DevTools
(console, network, elements) against a Vistta Android dev build the same way
you would for a native Android app. The call is removed entirely from release
APKs, so remote inspection is never reachable for shipped builds.

### `(DEV)` title suffix

Dev builds append ` [DEV]` to the runtime-default `productName` and window
`title` in `tauri.conf.json`, so dev and release builds are visually
distinguishable when both are installed on the same desktop or device
launcher. Custom values supplied via `config.app.title` / `config.title` /
`config.app.name` are kept verbatim — the suffix is only added to the
runtime defaults, so a release build is always bit-identical to a build made
without `NODE_ENV=development` and projects that already set their own
labels see no change.

On Android the same suffix is also pushed into `res/values/strings.xml`
(`app_name` + `main_activity_title`) so the launcher label and the in-app
title bar actually render with the ` [DEV]` tag — without this, Tauri's
init-time-generated `strings.xml` is never re-touched by the runtime and
the launcher keeps showing the unsuffixed name even when `productName` in
`tauri.conf.json` is updated. The patch only touches the default-locale
file the manifest's `android:label` references; localisation files
(e.g. `res/values-pt/strings.xml`) are left untouched. Toggling between
dev and release switches the suffix in both directions on the next build.

## Integrations

Import plugin namespaces from `@vistta/js-runtime/plugins`:

```javascript
import { Clipboard, Dialog, Filesystem, Haptics, Notification, Shell } from "@vistta/js-runtime/plugins";
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

### Clipboard / Dialog / Shell

Re-exports of the matching `@tauri-apps/plugin-*` packages — see their docs for the full API.

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
`buildDir` after running a desktop build at least once to generate `src-tauri/`.

## How It Works

1. `applyTemplate()` copies `template/` → `buildDir/`.
2. `patchMainRs`, `patchLibRs`, `patchCargoToml` regenerate the Rust entry points and
   plugin dependencies from `plugins.config.js` (single source of truth).
3. `mergeConfig` writes `tauri.conf.json` from the JS config + `extraTauriConfig`.
4. `patchCapabilities` merges `extraCapabilities` into `capabilities/default.json`.
5. Android-only: `patchAndroidManifest`, `patchBuildTask`, and (if `app.background`)
   `generateForegroundService` + `patchMainActivity`.
6. `npx tauri (android) dev|build` runs.

All generated files are owned by the runtime — customise via the config object, not by
editing files in `buildDir`.

## Tauri Plugins Used

See `plugins.config.js` for the canonical list. As of writing:

| Plugin                           | Purpose                    |
| -------------------------------- | -------------------------- |
| `tauri-plugin-clipboard-manager` | Clipboard access           |
| `tauri-plugin-dialog`            | Native dialogs             |
| `tauri-plugin-fs`                | File system access         |
| `tauri-plugin-haptics`           | Haptic feedback            |
| `tauri-plugin-notification`      | System notifications       |
| `tauri-plugin-shell`             | Open URLs, spawn processes |

## License

Apache 2.0 with Commons Clause
