package org.vistta.runtime

import android.app.Activity
import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.text.InputType
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import org.json.JSONObject
import java.security.MessageDigest

class VisttaAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure
        val target = structure?.let { inspect(it) }
        if (target == null || target.password == null || cancellationSignal.isCanceled) {
            callback.onSuccess(null)
            return
        }
        VisttaAutofill.request("query", target.json()) { result ->
            if (cancellationSignal.isCanceled) {
                callback.onSuccess(null)
                return@request
            }
            val inline = Inline(this, if (Build.VERSION.SDK_INT >= 30) request.inlineSuggestionsRequest else null)
            if (result?.optBoolean("ready") != true) {
                val unlock = result?.optJSONObject("unlock")
                val label = unlock?.optString("label")?.take(120)?.takeIf { it.isNotBlank() }
                    ?: applicationInfo.loadLabel(packageManager).toString()
                val intent = target.put(Intent(this, VisttaAutofillUnlockActivity::class.java))
                    .putExtra("app", unlock?.optString("app")?.takeIf { it.isNotBlank() })
                val pending = PendingIntent.getActivity(
                    this, System.nanoTime().toInt(), intent,
                    PendingIntent.FLAG_ONE_SHOT or
                        (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
                )
                val response = FillResponse.Builder()
                val view = entryView(this, label)
                val chip = inline.next(label)
                if (Build.VERSION.SDK_INT >= 30 && chip != null)
                    response.setAuthentication(target.ids(), pending.intentSender, view, chip as android.service.autofill.InlinePresentation)
                else response.setAuthentication(target.ids(), pending.intentSender, view)
                callback.onSuccess(response.build())
                return@request
            }
            val (response, suggestions) = itemsResponse(this, target, result, inline)
            callback.onSuccess(if (suggestions > 0 || target.username != null) response.build() else null)
        }
    }

    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure
        val target = structure?.let { inspect(it) }
        if (target?.username == null || target.password == null || target.usernameValue.isNullOrBlank() ||
            target.passwordValue.isNullOrBlank()) {
            callback.onFailure("No login to save")
            return
        }
        val data = target.json().put("username", target.usernameValue).put("password", target.passwordValue)
        VisttaAutofill.request("save", data) { result ->
            if (result?.optBoolean("saved") == true) callback.onSuccess()
            else callback.onFailure("Unlock Vault to save the login")
        }
    }

    private fun inspect(structure: AssistStructure): Target? {
        val app = structure.activityComponent?.packageName ?: return null
        if (app == packageName) return null
        val digest = signerDigest(this, app)
        if (digest == null) return null
        var userId: AutofillId? = null
        var passwordId: AutofillId? = null
        var userValue: String? = null
        var passwordValue: String? = null
        var lastTextId: AutofillId? = null
        var lastTextValue: String? = null
        var domain: String? = null
        var scheme: String? = null
        var invalidDomain = false
        var count = 0
        fun walk(node: AssistStructure.ViewNode) {
            if (++count > MAX_NODES) return
            val host = node.webDomain
            if (!host.isNullOrEmpty()) {
                if (domain != null && domain != host) invalidDomain = true
                domain = host
                if (Build.VERSION.SDK_INT >= 28) node.webScheme?.lowercase()?.let { scheme = it }
            }
            val hints = node.autofillHints?.map { it.lowercase() } ?: emptyList()
            val html = node.htmlInfo?.attributes?.associate { it.first to it.second } ?: emptyMap()
            val autocomplete = html["autocomplete"]?.lowercase() ?: ""
            val type = html["type"]?.lowercase() ?: ""
            val id = node.autofillId
            if (id != null && node.autofillType == android.view.View.AUTOFILL_TYPE_TEXT) {
                val inputClass = node.inputType and InputType.TYPE_MASK_CLASS
                val variation = node.inputType and InputType.TYPE_MASK_VARIATION
                val text = node.autofillValue?.takeIf { it.isText }?.textValue?.toString()
                val isPassword = hints.any { it.contains("password") } || type == "password" ||
                    autocomplete == "current-password" ||
                    (inputClass == InputType.TYPE_CLASS_TEXT && variation in PASSWORD_VARIATIONS) ||
                    (inputClass == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
                val isUser = hints.any { it == "username" || it == "emailaddress" || it == "email" } ||
                    autocomplete == "username" || autocomplete == "email" || type == "email" ||
                    (inputClass == InputType.TYPE_CLASS_TEXT && variation in EMAIL_VARIATIONS)
                if (passwordId == null && isPassword) {
                    passwordId = id
                    passwordValue = text
                } else if (userId == null && isUser) {
                    userId = id
                    userValue = text
                } else if (passwordId == null && !isPassword) {
                    lastTextId = id
                    lastTextValue = text
                }
            }
            for (index in 0 until node.childCount) {
                if (count >= MAX_NODES) break
                walk(node.getChildAt(index))
            }
        }
        for (index in 0 until structure.windowNodeCount) {
            if (count >= MAX_NODES) break
            walk(structure.getWindowNodeAt(index).rootViewNode)
        }
        if (count >= MAX_NODES || invalidDomain || passwordId == null) return null
        if (userId == null) {
            userId = lastTextId
            userValue = lastTextValue
        }
        val canonical = domain?.let { host ->
            try { java.net.URI("https://$host").host?.lowercase()?.takeIf { it == host.lowercase() } }
            catch (_: Exception) { null }
        }
        if (domain != null && canonical == null) return null
        return Target(app, digest, canonical, userId, passwordId!!, userValue, passwordValue,
            if (scheme == "http") "http" else "https")
    }

    private companion object {
        const val MAX_NODES = 5000
        val PASSWORD_VARIATIONS = setOf(
            InputType.TYPE_TEXT_VARIATION_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
        )
        val EMAIL_VARIATIONS = setOf(
            InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
            InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS,
        )
    }
}

class VisttaAutofillActivity : Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val item = intent.getIntExtra("item", -1)
        val usernameId = intent.getParcelableExtra<AutofillId>("usernameId")
        val passwordId = intent.getParcelableExtra<AutofillId>("passwordId")
        val targetPackage = intent.getStringExtra("package")
        val digest = intent.getStringExtra("digest")
        if (item < 0 || passwordId == null || targetPackage == null || digest == null ||
            targetPackage == packageName || signerDigest(this, targetPackage) != digest) { finish(); return }
        val data = JSONObject()
            .put("id", item)
            .put("package", intent.getStringExtra("package"))
            .put("sha256", intent.getStringExtra("digest"))
            .put("domain", intent.getStringExtra("domain") ?: "")
            .put("scheme", intent.getStringExtra("scheme") ?: "https")
        VisttaAutofill.request("select", data) { result ->
            if (isFinishing || result == null || !result.has("password")) { finish(); return@request }
            val presentation = entryView(this, "Vault login")
            val dataset = Dataset.Builder()
            usernameId?.let { dataset.setValue(it, AutofillValue.forText(result.optString("username")), presentation) }
            dataset.setValue(passwordId, AutofillValue.forText(result.getString("password")), presentation)
            setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset.build()))
            finish()
        }
    }
}

class VisttaAutofillUnlockActivity : Activity() {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var target: Target? = null
    private var deadline = 0L
    private var done = false

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val target = Target.from(intent)
        if (target == null || target.packageName == packageName ||
            signerDigest(this, target.packageName) != target.digest) { finish(); return }
        this.target = target
        deadline = android.os.SystemClock.uptimeMillis() + UNLOCK_TIMEOUT_MS
        if (savedInstanceState == null) {
            packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                intent.getStringExtra("app")?.let {
                    launch.action = VisttaShortcuts.ACTION_LAUNCH_SHORTCUT
                    launch.putExtra(VisttaShortcuts.EXTRA_SHORTCUT_ID, it)
                }
                startActivity(launch)
            }
        }
        poll()
    }

    private fun poll() {
        val target = target ?: return
        if (done || isFinishing) return
        if (android.os.SystemClock.uptimeMillis() > deadline) { finish(); return }
        VisttaAutofill.request("query", target.json()) { result ->
            if (done || isFinishing) return@request
            if (result?.optBoolean("ready") != true) {
                handler.postDelayed(::poll, 1000)
                return@request
            }
            done = true
            val request = if (Build.VERSION.SDK_INT >= 30)
                intent.getParcelableExtra<android.view.inputmethod.InlineSuggestionsRequest>(AutofillManager.EXTRA_INLINE_SUGGESTIONS_REQUEST)
            else null
            val (response, suggestions) = itemsResponse(this, target, result, Inline(this, request))
            if (suggestions > 0 || target.username != null)
                setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response.build()))
            VisttaAutofill.returnToCaller()
            finish()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private companion object {
        const val UNLOCK_TIMEOUT_MS = 5 * 60_000L
    }
}

internal data class Target(
    val packageName: String, val digest: String, val domain: String?,
    val username: AutofillId?, val password: AutofillId,
    val usernameValue: String? = null, val passwordValue: String? = null,
    val scheme: String = "https",
) {
    fun json(): JSONObject = JSONObject().put("package", packageName).put("sha256", digest)
        .put("domain", domain ?: "").put("scheme", scheme)

    fun ids(): Array<AutofillId> = listOfNotNull(username, password).toTypedArray()

    fun put(intent: Intent): Intent = intent
        .putExtra("package", packageName)
        .putExtra("digest", digest)
        .putExtra("domain", domain)
        .putExtra("scheme", scheme)
        .putExtra("usernameId", username)
        .putExtra("passwordId", password)

    companion object {
        @Suppress("DEPRECATION")
        fun from(intent: Intent): Target? {
            val packageName = intent.getStringExtra("package") ?: return null
            val digest = intent.getStringExtra("digest") ?: return null
            val password = intent.getParcelableExtra<AutofillId>("passwordId") ?: return null
            return Target(packageName, digest, intent.getStringExtra("domain"),
                intent.getParcelableExtra("usernameId"), password,
                scheme = if (intent.getStringExtra("scheme") == "http") "http" else "https")
        }
    }
}

internal fun entryView(context: Context, label: String): RemoteViews {
    val night = (context.resources.configuration.uiMode and
        android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
    // OEM autofill popups ignore the app theme, so set both colors explicitly.
    return RemoteViews(context.packageName, android.R.layout.simple_list_item_1).apply {
        setTextViewText(android.R.id.text1, label)
        setTextColor(android.R.id.text1, if (night) android.graphics.Color.WHITE else android.graphics.Color.BLACK)
        setInt(android.R.id.text1, "setBackgroundColor", if (night) 0xFF2B2B2B.toInt() else android.graphics.Color.WHITE)
    }
}

internal fun itemsResponse(context: Context, target: Target, result: JSONObject, inline: Inline): Pair<FillResponse.Builder, Int> {
    val response = FillResponse.Builder()
    val entries = result.optJSONArray("items")
    var suggestions = 0
    for (index in 0 until minOf(entries?.length() ?: 0, 20)) {
        val entry = entries?.optJSONObject(index) ?: continue
        val id = entry.optInt("id", -1)
        val name = entry.optString("name").take(120)
        if (id < 0 || name.isBlank()) continue
        val intent = target.put(Intent(context, VisttaAutofillActivity::class.java)).putExtra("item", id)
        val pending = PendingIntent.getActivity(
            context, android.os.Process.myPid() xor id xor System.nanoTime().toInt(), intent,
            PendingIntent.FLAG_ONE_SHOT or
                (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
        )
        response.addDataset(dataset(target, entryView(context, name), inline.next(name), pending))
        suggestions++
    }
    val open = result.optJSONObject("open")
    val openLabel = open?.optString("label")?.take(120)?.takeIf { it.isNotBlank() }
    if (suggestions == 0 && openLabel != null) {
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            open.optString("app").takeIf { it.isNotBlank() }?.let {
                launch.action = VisttaShortcuts.ACTION_LAUNCH_SHORTCUT
                launch.putExtra(VisttaShortcuts.EXTRA_SHORTCUT_ID, it)
            }
            val pending = PendingIntent.getActivity(
                context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            response.addDataset(dataset(target, entryView(context, openLabel), inline.next(openLabel), pending))
            suggestions++
        }
    }
    target.username?.let {
        response.setSaveInfo(SaveInfo.Builder(
            SaveInfo.SAVE_DATA_TYPE_USERNAME or SaveInfo.SAVE_DATA_TYPE_PASSWORD,
            arrayOf(it, target.password),
        ).build())
    }
    return response to suggestions
}

@Suppress("DEPRECATION")
private fun dataset(target: Target, view: RemoteViews, chip: Any?, pending: PendingIntent): Dataset {
    val dataset = Dataset.Builder(view)
    if (Build.VERSION.SDK_INT >= 30 && chip != null)
        dataset.setInlinePresentation(chip as android.service.autofill.InlinePresentation)
    target.username?.let { dataset.setValue(it, null) }
    dataset.setValue(target.password, null)
    dataset.setAuthentication(pending.intentSender)
    return dataset.build()
}

/** Builds keyboard (inline) suggestion chips within the IME's requested limits; null below Android 11. */
internal class Inline(private val context: Context, private val request: Any?) {
    private var count = 0

    fun next(label: String): Any? {
        if (Build.VERSION.SDK_INT < 30) return null
        val request = request as? android.view.inputmethod.InlineSuggestionsRequest ?: return null
        val specs = request.inlinePresentationSpecs
        if (specs.isEmpty() || count >= request.maxSuggestionCount) return null
        val spec = specs[minOf(count, specs.size - 1)]
        if (!androidx.autofill.inline.UiVersions.getVersions(spec.style)
                .contains(androidx.autofill.inline.UiVersions.INLINE_UI_VERSION_1)) return null
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        val attribution = PendingIntent.getActivity(context, 1, launch, PendingIntent.FLAG_IMMUTABLE)
        val content = androidx.autofill.inline.v1.InlineSuggestionUi.newContentBuilder(attribution)
            .setTitle(label)
            .setStartIcon(android.graphics.drawable.Icon.createWithResource(context, context.applicationInfo.icon))
            .build()
        count++
        return android.service.autofill.InlinePresentation(content.slice, spec, false)
    }
}

@Suppress("DEPRECATION")
internal fun signerDigest(context: Context, app: String): String? {
    return try {
        val manager = context.packageManager
        val signatures = if (Build.VERSION.SDK_INT >= 28) {
            manager.getPackageInfo(app, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners
        } else manager.getPackageInfo(app, PackageManager.GET_SIGNATURES).signatures
        if (signatures?.size != 1) return null
        MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray())
            .joinToString("") { "%02x".format(it) }
    } catch (_: Exception) { null }
}
