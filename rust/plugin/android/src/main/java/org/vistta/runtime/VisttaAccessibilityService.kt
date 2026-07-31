// AccessibilityService whose sole purpose is to obtain the background
// clipboard-read privilege that Android 10+ (API 29+) reserves for the
// foreground app, the default IME, or an enabled AccessibilityService.
//
// We do not consume any accessibility events and do not touch the UI
// tree; the `accessibility-event-types` / `canRetrieveWindowContent`
// flags in `res/xml/vistta_accessibility_config.xml` are configured to
// request the minimum surface. The service exists only so that
// `ClipboardManager` reads performed from its context succeed while the
// app is backgrounded.
//
// Lifecycle:
//   - The user enables "Vistta" under Settings → Accessibility. Android
//     instantiates and binds the service; `onServiceConnected()` runs.
//   - `onServiceConnected()` registers an `OnPrimaryClipChangedListener`
//     on the system `ClipboardManager`. The listener posts to
//     `VisttaClipboard.onClipChanged()`, which reads the clip and pushes
//     it into the webview.
//   - When the user disables the service, `onUnbind()` removes the
//     listener. The JS side detects the loss via
//     `VisttaClipboard.isAccessibilityEnabled()`.
//
// Note: the listener is registered against the *application context*,
// not the service itself. `ClipboardManager` is a system singleton, so
// the registration survives as long as the service is bound. Reading
// `primaryClip` from within the listener callback is allowed because
// the owning process has an active AccessibilityService.

package org.vistta.runtime

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.accessibility.AccessibilityEvent

class VisttaAccessibilityService : AccessibilityService() {

    private var clipboardManager: ClipboardManager? = null
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        VisttaClipboard.attachContext(applicationContext)
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (cm != null) {
            clipboardManager = cm
            val l = ClipboardManager.OnPrimaryClipChangedListener {
                // Read primaryClip HERE, inside the service callback. The
                // accessibility service's process has the clipboard-read
                // privilege; reading from the application context in
                // VisttaClipboard does NOT. So we extract the text here and
                // hand only the string to VisttaClipboard for delivery.
                val clip: ClipData? = try {
                    cm.primaryClip
                } catch (_: Throwable) {
                    null
                }
                if (clip == null || clip.itemCount == 0) return@OnPrimaryClipChangedListener
                val item = clip.getItemAt(0)
                val text = item?.text?.toString() ?: return@OnPrimaryClipChangedListener
                VisttaClipboard.onClipChanged(text)
            }
            listener = l
            try {
                cm.addPrimaryClipChangedListener(l)
            } catch (_: Throwable) {
                // Some OEM ROMs throw if the listener is added before the
                // service is fully bound. Ignore — the next clip change
                // will still fire once registration succeeds.
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally unused. We only need the clipboard-read privilege
        // that comes with being an enabled AccessibilityService.
    }

    override fun onInterrupt() {
        // No-op.
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        val cm = clipboardManager
        val l = listener
        if (cm != null && l != null) {
            try {
                cm.removePrimaryClipChangedListener(l)
            } catch (_: Throwable) {}
        }
        listener = null
        clipboardManager = null
        return super.onUnbind(intent)
    }
}