import fs from "@vistta/fs";

export async function mergeConfig(targetDir, config) {
  const confPath = fs.resolve(targetDir, "tauri.conf.json");

  const tauriConf = {
    $schema: "https://schema.tauri.app/config/2",
    productName: config?.app?.name || config?.title || "Vistta App",
    identifier: config?.app?.id || "org.vistta.app",
    version: "0.1.0",
    build: {
      beforeBuildCommand: "",
      beforeDevCommand: "",
      frontendDist: "www",
    },
    app: {
      withGlobalTauri: true,
      windows: [
        {
          title: config?.app?.title || config?.title || "Vistta App",
          width: config?.app?.width || 1280,
          height: config?.app?.height || 800,
          minWidth: config?.app?.minWidth || 320,
          minHeight: config?.app?.minHeight || 480,
          center: config?.app?.center !== undefined ? config.app.center : true,
          resizable: config?.app?.resizable !== undefined ? config.app.resizable : true,
          fullscreen: config?.app?.fullscreen !== undefined ? config.app.fullscreen : false,
          decorations: true,
          transparent: false,
          alwaysOnTop: false,
        },
      ],
      security: { csp: null },
    },
    bundle: {
      active: true,
      targets: "all",
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    },
    plugins: { shell: { open: true } },
  };

  if (config?.backgroundColor) tauriConf.app.windows[0].backgroundColor = config.backgroundColor;

  await fs.writeFile(confPath, JSON.stringify(tauriConf, null, 2));
}
