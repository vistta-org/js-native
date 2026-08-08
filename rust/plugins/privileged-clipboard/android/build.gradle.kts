plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

layout.buildDirectory.set(rootProject.layout.projectDirectory.dir("../../../.build/privileged-clipboard/android"))

android {
    namespace = "org.vistta.privilegedclipboard"
    compileSdk = 36

    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
    implementation(project(":tauri-android"))
}