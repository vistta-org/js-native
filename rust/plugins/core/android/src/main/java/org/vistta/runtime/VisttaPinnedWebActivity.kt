// Full-screen WebView for a server whose certificate is signed by a pinned
// CA (see VisttaPinned.openWeb). The page gets no JavascriptInterface
// bridges and no Tauri IPC: it is a remote origin. TLS errors are accepted
// only when the server certificate is signed by the pinned CA; links to
// other origins open in the system browser.

package org.vistta.runtime

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

class VisttaPinnedWebActivity : Activity() {

    companion object {
        const val EXTRA_URL = "org.vistta.runtime.pinned.URL"
        const val EXTRA_CA = "org.vistta.runtime.pinned.CA"
        const val EXTRA_TITLE = "org.vistta.runtime.pinned.TITLE"
    }

    private var webView: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)
        val ca = try {
            intent.getStringExtra(EXTRA_CA)?.let { VisttaPinned.parseCertificate(it) }
        } catch (_: Throwable) {
            null
        }
        if (url == null || ca == null) {
            finish()
            return
        }
        intent.getStringExtra(EXTRA_TITLE)?.let { title = it }
        val origin = Uri.parse(url).let { "${it.scheme}://${it.authority}" }

        val view = WebView(this)
        view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
        }
        view.webChromeClient = WebChromeClient()
        view.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                val leaf = x509(error.certificate)
                if (leaf != null && VisttaPinned.signedBy(leaf, ca)) handler.proceed() else handler.cancel()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                val sameOrigin = "${target.scheme}://${target.authority}" == origin
                if (sameOrigin || !request.isForMainFrame) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, target))
                } catch (_: Throwable) {}
                return true
            }
        }
        setContentView(view)
        webView = view
        if (savedInstanceState == null || view.restoreState(savedInstanceState) == null) view.loadUrl(url)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView?.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val view = webView
        if (view != null && view.canGoBack()) view.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webView?.apply {
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
        webView = null
        super.onDestroy()
    }

    private fun x509(certificate: SslCertificate?): X509Certificate? {
        if (certificate == null) return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return certificate.x509Certificate
        // API < 29 only exposes the DER bytes through the saved state bundle.
        val bytes = SslCertificate.saveState(certificate).getByteArray("x509-certificate") ?: return null
        return try {
            CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
        } catch (_: Throwable) {
            null
        }
    }
}
