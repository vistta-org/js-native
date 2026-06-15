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

  // Platform code-signing. Windows + macOS settings are forwarded to
  // tauri.conf.json bundle config. Android: provide a pre-existing keystore
  // path + credentials; the runtime does not auto-generate one.
  signing: {
    android: {
      keystorePath: "./release.keystore",
      keystorePasswordEnv: "ANDROID_KEYSTORE_PASSWORD",
      minSdkVersion: 24,
      versionCode: 12,
    },
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

## Android status

The runtime supports foreground Android apps and a foreground-service-based
background scheduler (see [Scheduler](#scheduler) below).

**What's there:**

- `patchAndroidManifest` — adds `POST_NOTIFICATIONS` + `VIBRATE` permissions,
  plus the `<service>` entry and `FOREGROUND_SERVICE*` permissions for the
  scheduler service.
- `patchAndroidStrings` — keeps launcher label + activity title in sync with
  `tauri.conf.json`
- `patchMainActivity` — registers a default notification channel for the
  notification plugin, and a `VisttaScheduler` JavascriptInterface used by
  the Scheduler JS API to start/stop timers.
- `patchVisttaService` — writes the synthesized `VisttaService.kt` (the
  foreground service that holds the process + webview alive while a
  scheduler timer is active).
- `patchBuildTask` — rewrites Tauri 2.11.2's `BuildTask.kt` to call the
  `tauri` CLI directly instead of going through `npm run -- tauri ...`, so
  the consumer's `package.json` doesn't need a `tauri` script
- `patchCargoToml` / `patchLibRs` / `patchMainRs` — full file writes, no
  marker comments
- `nameSuffix()` (`.dev` in dev) — appended to the `tauri.conf.json`
  `productName`, so the dev build's installed-app name is distinct from the
  release build and both can coexist
- `crateNameSuffix()` (`-dev` in dev) — appended to the Cargo `[package].name`
  (and therefore the binary artifact name on disk). Cargo identifiers forbid
  dots, so the crate suffix uses a dash
- `devSuffix()` (` [DEV]` in dev) — appended to user-visible strings (window
  title on desktop, `strings.xml` `app_name` + `main_activity_title` on
  Android)
- `resolveAppId()` — the Android `applicationId` gets a `.dev` suffix in dev
  so dev and release APKs can be installed side-by-side
- Desktop `app.background: true` — keeps the app alive in the background (tray
  icon + hide-on-close). The `tray-icon` Cargo feature is conditionally added.
  Has no effect on Android/iOS.

**What's gone:**

- Foreground service for non-scheduler purposes (e.g. long-running sync
  workers)
- Auto-generated release keystore + Gradle `signingConfigs` injection

**Roadmap — release signing.** The Android replacement will be a
platform alarm API (e.g. Android `WorkManager` with a JS-side scheduler)
so the runtime can wake the app on a schedule without holding a
foreground service.

In the meantime, if you need a release-signed APK, generate a keystore
yourself (`keytool -genkeypair ... -keystore release.keystore`) and
wire its credentials into your build via env vars. The `tauri.conf.json`
`bundle.android` block (minSdkVersion, versionCode) is still populated
from `config.signing.android` for you.

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
`buildDir` after running a desktop build at least once to populate the template baseline.

## How It Works

The runtime's `build()` (and `run()`'s underlying `applyConfig`) seeds the
`buildDir` from the package's `template/` directory and then runs the
generators:

```
template/                                verbatim `tauri init` baseline at TAURI_VERSION
```

1. `applyTemplate()` (in `apply-template.js`) copies `template/` into
   `buildDir/`.
2. `patchMainRs` / `patchLibRs` / `patchCargoToml` regenerate the Rust
   entry points and plugin dependencies from `plugins.config.js`
   (single source of truth). The seeded `Cargo.toml` / `src/lib.rs` /
   `src/main.rs` are overwritten in full on every build.
3. `mergeConfig` writes `tauri.conf.json` from the JS config +
   `extraTauriConfig`.
4. `patchCapabilities` writes `capabilities/default.json` from
   `plugins.config.js` + `extraCapabilities`.
5. Android-only: `patchAndroidManifest`, `patchAndroidStrings`,
   `patchMainActivity`, `patchBuildTask`, `patchVisttaService`. Tauri
   files are patched in place; the runtime doesn't own them end-to-end
   on Android. The service file (`VisttaService.kt`) is a full-file
   write owned by the runtime.
6. `npx tauri (android) dev|build` runs.

The pinned Tauri version lives in `index.js` as `TAURI_VERSION` and
is also exported from the package. It must match the
`@tauri-apps/cli` version in `package.json` and the baseline inside
`template/`.

All generated files in `buildDir/` are owned by the runtime —
customise via the config object, not by editing files in `buildDir`.

## Upgrading Tauri

When a new Tauri version ships:

1. Bump `@tauri-apps/cli` and `@tauri-apps/api` in `package.json`.
2. Bump `TAURI_VERSION` in `index.js` to match.
3. Run `tauri init` in a scratch project at the new version and copy
   the produced files into `template/`, then compare against the
   previous baseline and reconcile any structural changes Tauri
   made (e.g. a new field in `tauri.conf.json`, a new default
   permission in `capabilities/default.json`).
4. The patch functions (`patchCargoToml`, `patchLibRs`, etc.) own
   their target files in full, so most upstream changes only affect
   the seed baseline — review the diff to make sure no new default
   needs to be threaded through the generators.
5. Commit. The next `build()` will use the new baseline.

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
