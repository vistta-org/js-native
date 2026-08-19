# Shizuku instantiates the user service via reflection (Class.newInstance),
# so the class and its no-arg constructor must survive minification.
-keep class org.vistta.privilegedclipboard.ShizukuClipboardService { <init>(); }

# The Binder Stub classes and their inner Proxy classes are accessed via
# reflection (asInterface / transact). Keep them and their methods.
-keep class org.vistta.privilegedclipboard.ClipboardMonitor { *; }
-keep class org.vistta.privilegedclipboard.ClipboardMonitor$Stub { *; }
-keep class org.vistta.privilegedclipboard.ClipboardMonitor$Stub$Proxy { *; }
-keep class org.vistta.privilegedclipboard.ClipboardMonitorCallback { *; }
-keep class org.vistta.privilegedclipboard.ClipboardMonitorCallback$Stub { *; }
-keep class org.vistta.privilegedclipboard.ClipboardMonitorCallback$Stub$Proxy { *; }

# The plugin and its JavascriptInterface bridge are resolved by reflection.
-keep class org.vistta.privilegedclipboard.PrivilegedClipboardPlugin { *; }
-keep class org.vistta.privilegedclipboard.PrivilegedClipboardPlugin$* {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class org.vistta.privilegedclipboard.PrivilegedClipboardBridge { *; }
-keep class org.vistta.privilegedclipboard.ShizukuClipboard { *; }

# Shizuku API uses reflection internally.
-keep class rikka.shizuku.** { *; }
-dontwarn rikka.shizuku.**