import { app, BrowserWindow, net, protocol } from "electron/main";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const buildDir = process.argv[2] || join(process.cwd(), "build");
const debug = process.argv.includes("--debug");
const configIdx = process.argv.indexOf("--config");
const desktopConfig = configIdx !== -1 ? JSON.parse(process.argv[configIdx + 1] || "{}") : {};

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(() => {
  protocol.handle("app", (request) => {
    let pathname = new URL(request.url).pathname;
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    const filePath = join(buildDir, decodeURIComponent(pathname));
    return net.fetch(pathToFileURL(filePath).href);
  });

  const win = new BrowserWindow({
    width: desktopConfig.width || 1280,
    height: desktopConfig.height || 800,
    minWidth: desktopConfig.minWidth || undefined,
    minHeight: desktopConfig.minHeight || undefined,
    frame: desktopConfig.frame !== false,
    title: desktopConfig.title || app.name || "Vistta App",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL("app://localhost/");
  if (debug) win.webContents.openDevTools();

  app.on("window-all-closed", () => app.quit());
});
