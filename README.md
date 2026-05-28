# @vistta/js-runtime

Unified runtime for building cross-platform applications (mobile, desktop, web) using **Tauri v2**.

## Features

- **Single codebase** for all platforms: Android, iOS, macOS, Windows, Linux, and Web
- **Native integrations**: Camera, Filesystem, Haptics, Status Bar, Notifications, Shell, and more
- **Small bundle size**: ~10MB vs ~150MB for Electron
- **JS-only for app developers**: Rust backend is included in the package

## Installation

```bash
npm install @vistta/js-runtime
```

## Quick Start

```javascript
import { Tauri } from "@vistta/js-runtime";

// Initialize and run the app
await Tauri.run({
  app: {
    id: "com.example.myapp",
    name: "My App",
  },
  buildDir: "./build",
  title: "My App",
  backgroundColor: "#ffffff",
});
```

## API

### `Tauri.run(config)`

Launches the Tauri app in development mode.

```javascript
await Tauri.run({
  app: {
    id: "com.example.app", // Required: App identifier
    name: "My App", // Display name
    width: 1280, // Window width
    height: 800, // Window height
    minWidth: 320, // Minimum window width
    minHeight: 480, // Minimum window height
    center: true, // Center on screen
    resizable: true, // Allow resize
    fullscreen: false, // Start in fullscreen
    devTools: false, // Open DevTools on start
  },
  buildDir: "./build", // Web build output directory
  title: "My App", // Window title
  icon: "icon.png", // Icon path (relative to buildDir)
  backgroundColor: "#ffffff", // Window background color
});
```

### `Tauri.build(config)`

Builds the Tauri app for distribution (Android APK, Windows installer, etc.).

```javascript
await Tauri.build({
  app: { id: "com.example.app", name: "My App" },
  buildDir: "./build",
});
```

## Integrations

Import integrations from `@vistta/js-runtime/integrations`:

### Camera

```javascript
import { Camera } from "@vistta/js-runtime/integrations";

// Take a photo
const photo = await Camera.takePhoto();

// Pick from gallery
const image = await Camera.pickImage();
```

### Filesystem

```javascript
import { Filesystem } from "@vistta/js-runtime/integrations";

// Read file
const { data } = await Filesystem.readFile({ path: "test.txt" });

// Write file
await Filesystem.writeFile({ path: "test.txt", data: "Hello" });
```

### Haptics

```javascript
import { Haptics } from "@vistta/js-runtime/integrations";

// Impact feedback
await Haptics.impact({ style: "medium" });

// Notification feedback
await Haptics.notification({ type: "success" });

// Vibrate
await Haptics.vibrate();
```

### StatusBar

```javascript
import { StatusBar } from "@vistta/js-runtime/integrations";

await StatusBar.setStyle({ style: "dark" });
await StatusBar.setBackgroundColor({ color: "#ff0000" });
await StatusBar.hide();
await StatusBar.show();
```

### System

```javascript
import { System } from "@vistta/js-runtime/integrations";

// Listen for app state changes
const cleanup = await System.onStateChange(({ isActive }) => {
  console.log("App is", isActive ? "active" : "inactive");
});

// Get app info
const info = await System.getInfo();
console.log(info.name, info.version);

// Listen for back button (Android)
await System.onBackButton(({ canGoBack }) => {
  if (canGoBack) history.back();
});

// Exit app
await System.exit();
```

### SplashScreen

```javascript
import { SplashScreen } from "@vistta/js-runtime/integrations";

await SplashScreen.show({ autoHide: true });
await SplashScreen.hide({ fadeOutDuration: 300 });
```

## Platform Detection

In your app code, detect Tauri runtime:

```javascript
if (window.__TAURI__) {
  // Running in Tauri (native app)
} else {
  // Running in browser (web)
}
```

## Running on Android

1. Ensure Android SDK is installed (`ANDROID_HOME` environment variable)
2. Run development:
   ```bash
   npx tauri android dev
   ```
3. Build APK:
   ```bash
   npx tauri android build
   ```

## Running on iOS (macOS only)

1. Ensure Xcode is installed
2. Run development:
   ```bash
   npx tauri ios dev
   ```
3. Build:
   ```bash
   npx tauri ios build
   ```

## Running on Desktop

```bash
# Development
npx tauri dev

# Build for distribution
npx tauri build
```

## How It Works

1. `Tauri.run()` copies the `tauri/` template folder to `src-tauri/` in the user's project
2. It merges your config into `tauri.conf.json`
3. Runs `npx tauri dev` which:
   - Compiles the Rust backend
   - Starts the web dev server
   - Launches the native window

The user **never writes Rust code** — the template handles all native functionality.

## Tauri Plugins Used

| Plugin                            | Purpose                    |
| --------------------------------- | -------------------------- |
| `@tauri-apps/plugin-camera`       | Camera access              |
| `@tauri-apps/plugin-dialog`       | Native dialogs             |
| `@tauri-apps/plugin-fs`           | File system access         |
| `@tauri-apps/plugin-haptics`      | Haptic feedback            |
| `@tauri-apps/plugin-notification` | System notifications       |
| `@tauri-apps/plugin-os`           | OS information             |
| `@tauri-apps/plugin-shell`        | Open URLs, spawn processes |
| `@tauri-apps/plugin-statusbar`    | Status bar control         |
| `@tauri-apps/plugin-app`          | App lifecycle events       |

## License

Apache 2.0 with Commons Clause
