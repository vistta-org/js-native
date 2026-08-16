// Vistta.js Runtime Android installer bridge.
//
// Exposes a single `installApk(path)` JavascriptInterface that launches the
// system package installer for a local APK file. The APK must live in a
// directory covered by the app's FileProvider (see res/xml/file_paths.xml —
// `external-path path="."` covers the app-private external storage where
// Tauri's `$DOWNLOAD` base dir resolves on Android).
//
// Flow:
//   1. JS writes the APK via `@tauri-apps/plugin-fs` to `Filesystem.BaseDirectory.Download`.
//   2. JS resolves the absolute path via `System.downloadDir()` + `System.join()`.
//   3. JS calls `VisttaInstaller.installApk(absolutePath)`.
//   4. This bridge converts the path to a `content://` URI via FileProvider,
//      grants the installer permission to read it, and fires
//      `ACTION_VIEW` with the APK MIME type — which launches the system
//      "Install / Update app" UI.
//
// Requires the `android.permission.REQUEST_INSTALL_PACKAGES` permission
// declared in the manifest (added alongside this file).

package org.vistta.runtime

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import java.io.File

object VisttaInstaller {

    private var activity: Activity? = null

    fun attachActivity(activity: Activity) {
        this.activity = activity
    }

    /**
     * Launches the system package installer for the APK at [path].
     *
     * @param path Absolute filesystem path to the `.apk` file (must be inside
     *             a FileProvider-visible directory).
     * @return `true` if the installer intent was started, `false` otherwise.
     */
    @JavascriptInterface
    fun installApk(path: String): Boolean {
        val act = activity ?: return false
        val file = File(path)
        if (!file.exists()) return false
        val authority = "${act.packageName}.fileprovider"
        val uri: Uri = FileProvider.getUriForFile(act, authority, file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            act.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}