const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const bundledSite = path.join(__dirname, "site");
const WEB_ROOT = fs.existsSync(path.join(bundledSite, "index.html"))
  ? bundledSite
  : path.join(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png"
};

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^[/\\]+/, "");
      const filePath = path.resolve(WEB_ROOT, relative);
      if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store"
        });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

function createWindow(port) {
  const iconPath = path.join(__dirname, "app-icon.ico");
  const win = new BrowserWindow({
    show: false,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: "#020617",
    title: "TF 2 Production Monitoring",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  ipcMain.on("window-minimize", () => {
    win.returnToFullscreen = win.isFullScreen();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.minimize();
  });

  ipcMain.on("window-restore", () => {
    if (win.isFullScreen() || win.isMaximized()) {
      win.setFullScreen(false);
      win.unmaximize();
    } else {
      win.setFullScreen(true);
    }
  });

  ipcMain.on("window-close", () => {
    win.close();
  });

  win.on("restore", () => {
    if (win.returnToFullscreen) {
      win.returnToFullscreen = false;
      win.setFullScreen(true);
    }
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${port}/index.html?monitor=1`);
  win.once("ready-to-show", () => {
    win.setFullScreen(true);
    win.show();
    win.focus();
  });

  return win;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let localServer = null;

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.tf2.productionmonitoring");
    const started = await startLocalServer();
    localServer = started.server;
    createWindow(started.port);

    globalShortcut.register("F11", () => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return;
      const next = !win.isFullScreen();
      win.setFullScreen(next);
      if (!next) win.maximize();
    });
  });

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.setFullScreen(true);
    win.show();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (localServer) localServer.close();
    app.quit();
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });
}
