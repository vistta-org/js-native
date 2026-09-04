import fs from "@vistta/fs";
import { devSuffix, exec, resolveAppId, writeIfChanged } from "../utils/index.js";

const DEV = process.env.NODE_ENV === "development";

const STRINGS = { begin: "<!-- vistta:strings:begin -->", end: "<!-- vistta:strings:end -->" };

// Note: the runtime's Android background features (foreground service,
// background fetch, background socket, JavascriptInterface bridges,
// notification channel, and the okhttp / socket.io-client Gradle deps)
// now live in the `tauri-plugin-vistta` crate at `rust/plugin/android/`. They are
// registered as a standard Tauri Android plugin via
// `register_android_plugin("org.vistta.runtime", "VisttaPlugin")` from the
// crate's `src/lib.rs`. Android's manifest merger and Gradle's dependency
// resolution pull the plugin's own `<uses-permission>`s, `<service>` entry,
// and Maven deps into the host app automatically — no host-file patching
// needed for those.
//
// The remaining host-file patches are `patchBuildTask` (rewrites the
// generated BuildTask.kt to call the tauri binary directly instead of
// `npm run -- tauri`), `patchAndroidManifest` (soft-keyboard resize mode),
// `patchMainActivity` (IME inset application so the WebView shrinks for the
// keyboard below the DOM/Popover layer), and `patchAndroidStrings` (launcher
// label sync).
// These patch Tauri's *generated* host files that cannot be plugin-ized.
//
// The namespace/applicationId re-alignment patch (`patchAppGradleNamespace`)
// and the stale package-dir sweep (`cleanupStalePackageDirs`) have been
// removed. The dev/release applicationId split is now handled natively by
// Tauri via `bundle.android.debugApplicationIdSuffix` in tauri.conf.json
// (set by mergeConfig). The namespace stays stable across dev/release, so
// WRY's generated package tree never drifts and no cleanup is needed.

/**
 * Rewrites Tauri 2.11.2's generated `BuildTask.kt` to call the `tauri` CLI
 * binary directly, instead of going through `npm run -- tauri ...`. The
 * latter assumes the consumer's `package.json` has a `tauri` script; this
 * runtime reaches the tauri binary via `npx tauri` from `index.js`, not
 * through an npm script. Rewriting to a direct invocation makes the
 * consumer's `package.json` self-contained (no `tauri` script required).
 *
 * Idempotent: also recognises and rewrites a previously-patched form
 * (`executable = "tauri"`, args list without the `run`/`--`/`tauri` prefix).
 * If Tauri changes the file's shape dramatically the patch silently
 * no-ops — the build will then fail with a clear error from Gradle.
 */
export async function patchBuildTask(targetDir, config) {
  const appId = resolveAppId(config);
  const packagePath = appId.replace(/\./g, "/");
  const buildTaskPath = fs.resolve(
    targetDir,
    "gen",
    "android",
    "buildSrc",
    "src",
    "main",
    "java",
    packagePath,
    "kotlin",
    "BuildTask.kt",
  );
  if (!fs.existsSync(buildTaskPath)) return;
  let content = String(await fs.readFile(buildTaskPath, "utf8"));
  // The tauri binary is resolved from PATH that Gradle passes to the task;
  // node_modules/.bin is on that PATH (where the tauri CLI lives once the
  // runtime's transitive deps install it). `npx` is NOT on that PATH.
  content = content.replace(/val\s+executable\s*=\s*"""(?:npm|npx)"""\s*;?/g, 'val executable = """tauri""";');
  // Strip the `run`/`--`/`tauri` prefix from the args list, in either order.
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"run"\s*,\s*"--"\s*,\s*"tauri"\s*,\s*/g, "val args = listOf(");
  content = content.replace(/val\s+args\s*=\s*listOf\(\s*"tauri"\s*,\s*/g, "val args = listOf(");
  await writeIfChanged(buildTaskPath, content);
}

const ASSIST_MARKER = "<!-- vistta:assistant -->";

/**
 * Patches Tauri's generated `AndroidManifest.xml`:
 * - soft-keyboard resize mode (IME insets),
 * - when `config.app.assistant` is set, an ASSIST intent-filter on the main
 *   activity so the app can be picked as the system Digital Assistant app
 *   (long-press power / assistant gesture). Idempotent via a marker comment.
 * @param {string} targetDir
 * @param {any} [config]
 */
export async function patchAndroidManifest(targetDir, config) {
  const manifestPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "AndroidManifest.xml");
  if (!fs.existsSync(manifestPath)) return;
  let content = String(await fs.readFile(manifestPath, "utf8"));
  const activity = /<activity\b(?=[^>]*android:name="(?:\.MainActivity|[^"]*\.MainActivity)")[^>]*>/;
  const match = content.match(activity)?.[0];
  if (!match) return;
  // adjustResize makes Android report IME insets to the activity; the
  // IME-inset listener added by patchMainActivity applies them as bottom
  // padding to the WebView root so the WebView physically shrinks.
  const patched = /android:windowSoftInputMode=/.test(match)
    ? match.replace(/android:windowSoftInputMode="[^"]*"/, 'android:windowSoftInputMode="adjustResize"')
    : match.replace(/>$/, '\n            android:windowSoftInputMode="adjustResize">');
  content = content.replace(activity, patched);
  const assistantEnabled = !!config?.app?.assistant;
  if (assistantEnabled && !hasAssistantIntentFilter(content)) {
    // Insert the ASSIST filter directly after the opening <activity ...> tag.
    // The activity element already closes itself — no </activity> tail here
    // (appending one duplicates the existing closer and breaks the merger).
    const filter =
      `${ASSIST_MARKER}\n            ` +
      "<intent-filter>\n" +
      '                <action android:name="android.intent.action.ASSIST" />\n' +
      '                <category android:name="android.intent.category.DEFAULT" />\n' +
      "            </intent-filter>";
    content = content.replace(patched, `${patched}\n            ${filter}`);
  } else if (!assistantEnabled && hasAssistantIntentFilter(content) && content.includes(ASSIST_MARKER)) {
    // Flag removed — strip the marker comment and the filter block after it.
    content = content.replace(new RegExp(`\\s*${ASSIST_MARKER}[\\s\\S]*?</intent-filter>`), "");
  }
  await writeIfChanged(manifestPath, content);
}

function hasAssistantIntentFilter(content) {
  return /<action\s+android:name="android\.intent\.action\.ASSIST"/.test(content);
}

const IME_MARKER = "// vistta:ime-insets";

/**
 * Rewrites Tauri's generated `MainActivity.kt` to apply system bar and IME
 * (keyboard) insets as padding to the activity's root view. Combined with
 * `android:windowSoftInputMode="adjustResize"` (set by `patchAndroidManifest`),
 * this makes the native Android WebView physically shrink when the soft
 * keyboard opens — below the DOM/Popover layer — so the browser layout and
 * the native HTML Popover API adapt naturally without any JS compensation.
 * Status bar insets are applied as top padding so non-fullscreen apps don't
 * draw behind the status bar.
 *
 * Idempotent: recognises a previously-patched file via `IME_MARKER` and
 * rewrites it in full. If Tauri changes the file's shape dramatically the
 * patch silently no-ops — the build will then fail with a clear error from
 * Gradle.
 *
 * The root view's background color is controlled by the `VisttaStatusBar`
 * bridge in `VisttaPlugin.kt` (called from JS via `setStatusBarColor`).
 *
 * This patch also wires launch-shortcut intents: `onCreate` and
 * `onNewIntent` forward any `org.vistta.runtime.LAUNCH_SHORTCUT` intent to
 * `VisttaShortcuts.dispatchIntent`, which dispatches a `launch-action`
 * event into the webview (or stashes it for cold start).
 */
export async function patchMainActivity(targetDir, config) {
  const appId = resolveAppId(config);
  const packagePath = appId.replace(/\./g, "/");
  const mainActivityPath = fs.resolve(
    targetDir,
    "gen",
    "android",
    "app",
    "src",
    "main",
    "java",
    packagePath,
    "MainActivity.kt",
  );
  if (!fs.existsSync(mainActivityPath)) return;
  const content = [
    `package ${appId}`,
    ``,
    `import android.content.Intent`,
    `import android.os.Bundle`,
    `import androidx.activity.enableEdgeToEdge`,
    `import androidx.core.view.ViewCompat`,
    `import androidx.core.view.WindowInsetsCompat`,
    `import org.vistta.runtime.VisttaShortcuts`,
    ``,
    `class MainActivity : TauriActivity() {`,
    `  ${IME_MARKER}`,
    `  override fun onCreate(savedInstanceState: Bundle?) {`,
    `    enableEdgeToEdge()`,
    `    super.onCreate(savedInstanceState)`,
    `    val root = findViewById<android.view.View>(android.R.id.content)`,
    `    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->`,
    `      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())`,
    `      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom`,
    `      v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime))`,
    `      insets`,
    `    }`,
    `    // Forward launch-shortcut intents that opened this activity so the`,
    `    // VisttaShortcuts bridge can dispatch them into the webview once it`,
    `    // attaches. On a cold start the webview is not ready yet;`,
    `    // VisttaShortcuts stashes the action and flushes it from VisttaPlugin.load.`,
    `    VisttaShortcuts.dispatchIntent(intent)`,
    `  }`,
    ``,
    `  override fun onNewIntent(intent: Intent) {`,
    `    super.onNewIntent(intent)`,
    `    setIntent(intent)`,
    `    VisttaShortcuts.dispatchIntent(intent)`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  await writeIfChanged(mainActivityPath, content);
}

const SIGNING = { begin: "// vistta:signing:begin", end: "// vistta:signing:end" };
const RELEASE_SIGNING = { begin: "// vistta:release-signing:begin", end: "// vistta:release-signing:end" };

/**
 * Manages the Android release signing keystore and injects a
 * `signingConfigs` block into the generated `app/build.gradle.kts`.
 *
 * **Release builds**: if no keystore exists at `buildDir/android.keystore`,
 * one is generated via `keytool` with a fixed alias ("upload") and a
 * persistent password stored in `buildDir/android.keystore.properties`.
 * The keystore is copied into `gen/android/app/release.keystore` and the
 * Gradle file is patched to use it. The password is read from the
 * properties file (not env vars) so the build is self-contained.
 *
 * **Debug builds**: the signing config is removed from `build.gradle.kts`
 * and the copied keystore is deleted from `gen/android/app/`. The
 * persistent keystore in `buildDir/` is kept so the next release build
 * can reuse it (same signing key = upgradeable APK).
 *
 * If `config.keystore` is set, that keystore is used instead of the
 * auto-generated one. It can be a string (path only, password from
 * `ANDROID_KEYSTORE_PASSWORD` env var) or an object `{ file, password }`.
 * The password is used for both the keystore and the key; alias is `upload`.
 */
export async function patchAppGradleSigning(targetDir, config) {
  const appGradlePath = fs.resolve(targetDir, "gen", "android", "app", "build.gradle.kts");
  if (!fs.existsSync(appGradlePath)) return;
  let content = String(await fs.readFile(appGradlePath, "utf8"));

  // Debug builds: strip any signing config and remove the copied keystore.
  if (DEV) {
    content = content.replace(new RegExp(`${escapeRe(SIGNING.begin)}[\\s\\S]*?${escapeRe(SIGNING.end)}\n?`), "");
    content = content.replace(
      new RegExp(`${escapeRe(RELEASE_SIGNING.begin)}[\\s\\S]*?${escapeRe(RELEASE_SIGNING.end)}\n?`),
      "",
    );
    content = content.replace(/(\s*)signingConfig = signingConfigs\.getByName\("visttaRelease"\)\n/, "$1");
    const copiedKeystore = fs.resolve(targetDir, "gen", "android", "app", "release.keystore");
    if (fs.existsSync(copiedKeystore)) await fs.rm(copiedKeystore, { force: true });
    await writeIfChanged(appGradlePath, content);
    return;
  }

  // Release builds: ensure a keystore exists and wire it into Gradle.
  const ks = config?.keystore;
  const explicit = typeof ks === "string" ? ks : ks?.file;
  let keystorePath;
  let storePassword;
  let keyAlias;
  let keyPassword;

  if (explicit) {
    // User-provided keystore: password from the keystore object or
    // ANDROID_KEYSTORE_PASSWORD env var. Used for both the keystore and the
    // key. Alias is always "upload".
    keystorePath = explicit;
    keyAlias = "upload";
    storePassword = (typeof ks === "object" ? ks.password : "") || process.env.ANDROID_KEYSTORE_PASSWORD || "";
    keyPassword = storePassword;
  } else {
    // Auto-generated keystore: stored in buildDir, password in a properties file.
    const keystoreDir = targetDir;
    keystorePath = fs.resolve(keystoreDir, "android.keystore");
    const propsPath = fs.resolve(keystoreDir, "android.keystore.properties");
    keyAlias = "upload";

    if (!fs.existsSync(keystorePath)) {
      // Generate a new keystore. Use a deterministic password derived from
      // the app id so it's stable across builds but not trivially guessable.
      // The password is persisted in a properties file alongside the keystore.
      storePassword = generateKeystorePassword(config);
      keyPassword = storePassword;
      await fs.writeFile(propsPath, `storePassword=${storePassword}\nkeyPassword=${keyPassword}\nkeyAlias=${keyAlias}\n`);
      await exec("keytool", [
        "-genkeypair",
        "-keystore",
        keystorePath,
        "-alias",
        keyAlias,
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "10000",
        "-storepass",
        storePassword,
        "-keypass",
        keyPassword,
        "-dname",
        "CN=Vistta, OU=Vistta, O=Vistta, L=Unknown, ST=Unknown, C=Unknown",
      ]).end();
    } else if (fs.existsSync(propsPath)) {
      // Load existing password from the properties file.
      const props = String(await fs.readFile(propsPath, "utf8"));
      storePassword = props.match(/^storePassword=(.*)$/m)?.[1] || "";
      keyPassword = props.match(/^keyPassword=(.*)$/m)?.[1] || storePassword;
      keyAlias = props.match(/^keyAlias=(.*)$/m)?.[1] || "upload";
    } else {
      // Keystore exists but no properties file — can't recover the password.
      throw new Error(
        `Keystore exists at ${keystorePath} but no properties file found at ${propsPath}. Delete the keystore to regenerate, or provide a keystore config with a password.`,
      );
    }
  }

  // Copy the keystore into gen/android/app/ so Gradle can find it with a
  // relative path. This keeps the persistent keystore in buildDir safe
  // from `tauri android init` re-generation.
  const copiedKeystore = fs.resolve(targetDir, "gen", "android", "app", "release.keystore");
  await fs.cp(keystorePath, copiedKeystore, { force: true });

  const signingBlock = [
    SIGNING.begin,
    `    signingConfigs {`,
    `        create("visttaRelease") {`,
    `            storeFile = file("release.keystore")`,
    `            storePassword = "${escapeKotlinString(storePassword)}"`,
    `            keyAlias = "${escapeKotlinString(keyAlias)}"`,
    `            keyPassword = "${escapeKotlinString(keyPassword)}"`,
    `        }`,
    `    }`,
    SIGNING.end,
  ].join("\n");

  // Insert the signingConfigs block inside the android { } block, before buildTypes.
  const signingRe = new RegExp(`${escapeRe(SIGNING.begin)}[\\s\\S]*?${escapeRe(SIGNING.end)}`);
  if (signingRe.test(content)) {
    content = content.replace(signingRe, signingBlock);
  } else {
    content = content.replace(/(\n {4}buildTypes \{)/, `\n${signingBlock}\n$1`);
  }

  // Wire the release build type to use the signing config.
  const releaseSigningBlock = `${RELEASE_SIGNING.begin}\n            signingConfig = signingConfigs.getByName("visttaRelease")\n${RELEASE_SIGNING.end}`;
  const releaseRe = new RegExp(`${escapeRe(RELEASE_SIGNING.begin)}[\\s\\S]*?${escapeRe(RELEASE_SIGNING.end)}`);
  if (releaseRe.test(content)) {
    content = content.replace(releaseRe, releaseSigningBlock);
  } else {
    content = content.replace(/(getByName\("release"\) \{[\s\S]*?isMinifyEnabled = true)/, `$1\n${releaseSigningBlock}`);
  }

  await writeIfChanged(appGradlePath, content);
}

/**
 * Generates a stable but non-trivial password for the auto-generated
 * keystore, derived from the app id. This is not a security measure —
 * the keystore is a build artifact, not a production secret. The
 * password just needs to be consistent across builds so the keystore
 * can be reused.
 */
function generateKeystorePassword(config) {
  const id = config?.app?.id || "org.vistta.app";
  // Simple hash: not cryptographically secure, just stable.
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return `vistta-${(hash >>> 0).toString(36)}-release`;
}

function escapeKotlinString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

/**
 * Tauri generates `res/values/strings.xml` once on `tauri android init` and
 * never touches it again — so the launcher label (`@string/app_name`) and
 * the in-app title (`@string/main_activity_title`) keep whatever was baked
 * in at init time, even when `productName` in `tauri.conf.json` is later
 * updated.
 *
 * Brings the two strings back in sync with the runtime's source of truth
 * (`config.app.name` + the shared `devSuffix`). Idempotent; toggling
 * between dev and release switches the suffix in both directions on the
 * next build.
 *
 * Only touches the default-locale file the manifest's `android:label`
 * references; localisation files (e.g. `res/values-pt/strings.xml`) are
 * left untouched.
 */
export async function patchAndroidStrings(targetDir, config) {
  const stringsPath = fs.resolve(targetDir, "gen", "android", "app", "src", "main", "res", "values", "strings.xml");
  if (!fs.existsSync(stringsPath)) return;
  const appName = config?.app?.name || config?.title || "Vistta App";
  const suffix = devSuffix();

  let content = String(await fs.readFile(stringsPath, "utf8"));
  for (const name of ["app_name", "main_activity_title"]) {
    const re = new RegExp(`(<string\\s+name="${name}"\\s*>)([^<]*)(</string>)`);
    const replacement = `$1${appName}${suffix}$3`;
    if (re.test(content)) {
      content = content.replace(re, replacement);
    } else {
      content = ensureBlock(content, STRINGS, `    <string name="${name}">${appName}${suffix}</string>`, (c, generated) =>
        c.replace(/(<\/resources>)/, `${generated}\n$1`),
      );
    }
  }

  await writeIfChanged(stringsPath, content);
}

/**
 * Idempotently inserts/updates a marker-delimited block in `content`.
 * If the markers are absent, `insertFallback(content, generatedBlock)` is
 * invoked once to place the block; subsequent runs re-use the markers.
 */
function ensureBlock(content, marker, body, insertFallback) {
  const generated = body ? `${marker.begin}\n${body}\n${marker.end}` : `${marker.begin}\n${marker.end}`;
  const re = new RegExp(`${escapeRe(marker.begin)}[\\s\\S]*?${escapeRe(marker.end)}`);
  if (re.test(content)) return content.replace(re, generated);
  return insertFallback(content, generated);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
