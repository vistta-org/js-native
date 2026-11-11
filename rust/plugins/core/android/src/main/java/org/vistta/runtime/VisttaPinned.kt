// Pinned HTTPS for apps that talk to self-hosted servers with their own CA
// (e.g. a LAN host whose certificate is signed by a CA it generated itself).
// Android does not trust such CAs, and asking users to install them is
// clunky and shows a "network may be monitored" warning, so trust is pinned
// per CA instead:
//
//   fetchCertificate(id, url)  GET <origin>/ca.crt WITHOUT trust (it is public)
//                              and report its PEM + SHA-256 fingerprint. The
//                              caller must compare the fingerprint with one it
//                              got out of band (QR code, or user confirmation).
//   request(id, url, method, headersJson, body, caPem)
//                              HTTPS request trusting ONLY the given CA.
//   openWeb(url, caPem, title) Full-screen WebView (VisttaPinnedWebActivity)
//                              that accepts certificates signed by that CA.
//
// Results come back as `vistta-pinned` window events: { id, ok, status,
// body, headers, pem, fingerprint, error }. Host names are not checked: the
// pinned CA is unique to one server, and LAN addresses change.

package org.vistta.runtime

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.io.ByteArrayInputStream
import java.lang.ref.WeakReference
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

object VisttaPinned {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val executor = Executors.newCachedThreadPool { r ->
        Thread(r, "vistta-pinned").apply { isDaemon = true }
    }
    private val clients = ConcurrentHashMap<String, OkHttpClient>()

    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    @Volatile
    private var activityRef: WeakReference<Activity>? = null

    fun attachWebView(webView: WebView) {
        webViewRef = WeakReference(webView)
    }

    fun attachActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    // --- certificates -------------------------------------------------------

    fun parseCertificate(pem: String): X509Certificate =
        CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(pem.trim().toByteArray(Charsets.US_ASCII))) as X509Certificate

    /** SHA-256 of the DER encoding as `AA:BB:…` (same format as Node's fingerprint256). */
    fun fingerprint(certificate: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString(":") { "%02X".format(it.toInt() and 0xff) }

    /** True when [leaf] is signed by [ca] and currently valid. */
    fun signedBy(leaf: X509Certificate, ca: X509Certificate): Boolean = try {
        leaf.checkValidity()
        leaf.verify(ca.publicKey)
        true
    } catch (_: Throwable) {
        false
    }

    private fun pinnedClient(caPem: String): OkHttpClient = clients.getOrPut(caPem) {
        val ca = parseCertificate(caPem)
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("ca", ca)
        }
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        val trust = factory.trustManagers.filterIsInstance<X509TrustManager>().first()
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
        OkHttpClient.Builder()
            .sslSocketFactory(context.socketFactory, trust)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    /** Accepts any certificate: only used to download the public CA, never with credentials. */
    private val downloadClient: OkHttpClient by lazy {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val context = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustAll), SecureRandom()) }
        OkHttpClient.Builder()
            .sslSocketFactory(context.socketFactory, trustAll)
            .hostnameVerifier { _, _ -> true }
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    // --- bridge -------------------------------------------------------------

    private const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"

    /** Android 17+ drops LAN connections until the user allows local network access. */
    private fun withLocalNetwork(id: String, task: () -> Unit) {
        val activity = activityRef?.get()
        if (Build.VERSION.SDK_INT < 37 || activity == null ||
            ContextCompat.checkSelfPermission(activity, LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED
        ) return task()
        val registry = (activity as? ComponentActivity)?.activityResultRegistry ?: return task()
        mainHandler.post {
            var launcher: ActivityResultLauncher<String>? = null
            launcher = registry.register("vistta-local-network-$id", ActivityResultContracts.RequestPermission()) { granted ->
                launcher?.unregister()
                if (granted) task()
                else dispatchError(id, IllegalStateException("Local network access was denied. Allow Nearby devices for this app in Android settings to reach computers on your network."))
            }
            launcher.launch(LOCAL_NETWORK)
        }
    }

    fun fetchCertificate(id: String, url: String) = withLocalNetwork(id) {
        executor.execute {
            try {
                val request = Request.Builder().url(url).get().build()
                downloadClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw IllegalStateException("The host answered HTTP ${response.code}")
                    val pem = response.body?.string() ?: throw IllegalStateException("Empty certificate")
                    val certificate = parseCertificate(pem)
                    if (certificate.basicConstraints < 0) throw IllegalStateException("The host sent a certificate that is not a CA")
                    dispatch(id, JSONObject().put("ok", true).put("pem", pem).put("fingerprint", fingerprint(certificate)))
                }
            } catch (error: Throwable) {
                dispatchError(id, error)
            }
        }
    }

    fun request(id: String, url: String, method: String, headersJson: String, body: String?, caPem: String) = withLocalNetwork(id) {
        executor.execute {
            try {
                val upper = method.uppercase()
                val headers = if (headersJson.isEmpty()) JSONObject() else JSONObject(headersJson)
                val builder = Request.Builder().url(url)
                val type = headers.keys().asSequence().firstOrNull { it.equals("content-type", true) }
                    ?.let { headers.getString(it).toMediaTypeOrNull() }
                when {
                    upper == "GET" -> builder.get()
                    upper == "HEAD" -> builder.head()
                    else -> builder.method(upper, (body ?: "").toRequestBody(type))
                }
                for (key in headers.keys()) {
                    if (key.lowercase() in setOf("host", "content-length", "connection", "transfer-encoding")) continue
                    builder.header(key, headers.getString(key))
                }
                pinnedClient(caPem).newCall(builder.build()).execute().use { response ->
                    val result = JSONObject()
                        .put("ok", response.isSuccessful)
                        .put("status", response.code)
                        .put("body", response.body?.string() ?: "")
                    val responseHeaders = JSONObject()
                    for ((name, value) in response.headers) responseHeaders.put(name.lowercase(), value)
                    dispatch(id, result.put("headers", responseHeaders))
                }
            } catch (error: Throwable) {
                dispatchError(id, error)
            }
        }
    }

    fun openWeb(url: String, caPem: String, title: String) {
        val activity = activityRef?.get() ?: return
        parseCertificate(caPem)
        mainHandler.post {
            activity.startActivity(
                Intent(activity, VisttaPinnedWebActivity::class.java)
                    .putExtra(VisttaPinnedWebActivity.EXTRA_URL, url)
                    .putExtra(VisttaPinnedWebActivity.EXTRA_CA, caPem)
                    .putExtra(VisttaPinnedWebActivity.EXTRA_TITLE, title),
            )
        }
    }

    private fun dispatchError(id: String, error: Throwable) {
        val message = error.message ?: error.javaClass.simpleName
        dispatch(id, JSONObject().put("ok", false).put("status", 0).put("error", message))
    }

    private fun dispatch(id: String, detail: JSONObject) {
        val webView = webViewRef?.get() ?: return
        detail.put("id", id)
        val js = "(function(){try{window.dispatchEvent(new CustomEvent('vistta-pinned',{detail:" + detail + "}))}catch(e){}})()"
        mainHandler.post { webView.evaluateJavascript(js, null) }
    }
}
