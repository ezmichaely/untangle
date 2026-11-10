const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let worker = null;
let mainWindow = null;
/** @type {Map<string, {resolve: Function, reject: Function}>} */
const pending = new Map();
let stdoutBuf = "";

function dbPath() {
  return path.join(app.getPath("userData"), "untangle.db");
}

function workerEntry() {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "packages", "worker", "dist", "cli.js"),
    path.join(__dirname, "..", "..", "packages", "worker", "dist", "cli.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Worker CLI not built. Run: pnpm --filter @untangle/worker build");
}

function startWorker() {
  if (worker) return;
  const entry = workerEntry();
  worker = spawn("node", [entry], {
    env: { ...process.env, UNTANGLE_DB: dbPath() },
    stdio: ["pipe", "pipe", "pipe"],
  });

  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event) {
        mainWindow?.webContents.send("worker:event", msg.event);
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || "worker error"));
      }
    }
  });

  worker.stderr.on("data", (d) => {
    console.error("[worker]", d.toString());
  });

  worker.on("exit", (code) => {
    console.error("worker exited", code);
    worker = null;
    for (const [, p] of pending) p.reject(new Error("worker exited"));
    pending.clear();
  });
}

function callWorker(command) {
  startWorker();
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (!worker || !worker.stdin) {
      pending.delete(id);
      reject(new Error("worker stdin unavailable"));
      return;
    }
    worker.stdin.write(`${JSON.stringify({ id, command })}\n`);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  if (!app.isPackaged) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("worker:call", async (_e, command) => callWorker(command));
  ipcMain.handle("dialog:pickDirectory", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (worker) worker.kill();
  if (process.platform !== "darwin") app.quit();
});
