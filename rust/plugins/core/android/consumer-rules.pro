# --- Vistta runtime bridge classes ---
-keep class org.vistta.runtime.VisttaPlugin { *; }

# Keep the JavascriptInterface bridges — WebView resolves method names by reflection.
-keep class org.vistta.runtime.VisttaPlugin$* {
    @android.webkit.JavascriptInterface <methods>;
}

# VisttaNetwork and VisttaService use reflection on Socket.IO options fields.
-keep class org.vistta.runtime.VisttaNetwork { *; }
-keep class org.vistta.runtime.VisttaService { *; }
-keep class org.vistta.runtime.VisttaService$* { *; }

# --- Socket.IO client (io.socket:socket.io-client) ---
-keep class io.socket.** { *; }
-dontwarn io.socket.**

# Socket.IO uses reflection to read Options fields by name.
-keepclassmembers class io.socket.client.IO$Options {
    public *;
}
-keepclassmembers class io.socket.engineio.client.Socket$Options {
    public *;
}

# --- OkHttp / Okio ---
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

-keepnames class okhttp3.internal.platform.** { *; }
-keep class okhttp3.internal.platform.Platform { *; }

# --- JSON (org.json is excluded from socket.io-client, but keep anyway) ---
-keep class org.json.** { *; }

# --- ML Kit (barcode-scanner plugin): minified release builds crashed on the first camera frame ---
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_** { *; }
-dontwarn com.google.mlkit.**
-dontwarn com.google.android.gms.internal.mlkit_vision_**
