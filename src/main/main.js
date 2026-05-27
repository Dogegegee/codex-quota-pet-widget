import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateWidgetWindowBounds,
  extractAvatarOverlayState,
  getCodexGlobalStatePath,
  readCodexGlobalState,
} from "./codexState.js";
import { readFreshQuotaSnapshot, readLatestQuotaSnapshot } from "./quotaReader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const widgetSize = { width: 52, height: 100 };
const refreshIntervalMs = 5_000;
const positionIntervalMs = 500;
let widgetWindow = null;
let refreshTimer = null;
let positionTimer = null;
let sessionWatcher = null;
let sessionDebounce = null;
let latestState = null;
let lastLoggedQuotaSignature = null;
let quotaRefreshInFlight = false;
const logPath = path.join(os.homedir(), ".codex", "quota-pet-widget", "widget.log");

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
app.whenReady().then(() => {
    widgetWindow = createWidgetWindow();
    registerIpc();
    startPositionLoop();
    startQuotaLoop();
  });

  app.on("second-instance", () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    positionWidget({ allowShow: true });
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

function createWidgetWindow() {
  const window = new BrowserWindow({
    width: widgetSize.width,
    height: widgetSize.height,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    type: "toolbar",
    backgroundColor: "#101216",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.setAlwaysOnTop(true, "screen-saver", 1);
  installContextMenu(window);
  window.webContents.on("console-message", (_event, level, message) =>
    log(`renderer console ${level} ${message}`),
  );

  if (process.env.CODEX_QUOTA_DEV_SERVER_URL) {
    window.loadURL(process.env.CODEX_QUOTA_DEV_SERVER_URL);
  } else if (isDev) {
    window.loadFile(path.join(__dirname, "../../dist/index.html"));
  } else {
    window.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return window;
}

function installContextMenu(window) {
  const menu = Menu.buildFromTemplate([
    {
      label: "退出额度挂件",
      click: () => app.quit(),
    },
  ]);

  window.webContents.on("context-menu", () => {
    menu.popup({ window });
  });
}

function registerIpc() {
  ipcMain.handle("quota:get-state", () => getQuotaState());
}

function startPositionLoop() {
  positionWidget();
  positionTimer = setInterval(positionWidget, positionIntervalMs);
  app.on("before-quit", () => {
    if (positionTimer) clearInterval(positionTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    if (sessionDebounce) clearTimeout(sessionDebounce);
    sessionWatcher?.close();
  });
}

function startQuotaLoop() {
  refreshQuota();
  refreshTimer = setInterval(refreshQuota, refreshIntervalMs);
  startSessionWatch();
}

function startSessionWatch() {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  try {
    sessionWatcher = fs.watch(sessionsDir, { recursive: true }, (_eventType, filename) => {
      const changedFile = String(filename ?? "");
      if (changedFile && !changedFile.endsWith(".jsonl")) return;
      if (sessionDebounce) clearTimeout(sessionDebounce);
      sessionDebounce = setTimeout(() => {
        sessionDebounce = null;
        refreshQuota();
      }, 1200);
    });
  } catch (error) {
    log(`session watcher failed ${error?.message ?? error}`);
  }
}

function getQuotaState() {
  if (!latestState) latestState = readLatestQuotaSnapshot();
  return latestState;
}

async function refreshQuota() {
  if (quotaRefreshInFlight) return latestState;
  quotaRefreshInFlight = true;
  try {
    latestState = await readFreshQuotaSnapshot();
    logQuotaChange(latestState);
    broadcastState(latestState);
    return latestState;
  } finally {
    quotaRefreshInFlight = false;
  }
}

function broadcastState(state) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.webContents.send("quota:state-changed", state);
}

function positionWidget({ allowShow = true } = {}) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;

  const globalState = readCodexGlobalState(getCodexGlobalStatePath());
  const avatar = extractAvatarOverlayState(globalState);
  if (!avatar.isOpen || !avatar.mascotBounds) {
    widgetWindow.hide();
    return;
  }

  const display = screen.getDisplayMatching(avatar.mascotBounds);
  const nextBounds = calculateWidgetWindowBounds(
    avatar.mascotBounds,
    getWidgetSize(avatar.mascotBounds),
    display.workArea,
    avatar.trayBounds,
  );
  const current = widgetWindow.getBounds();
  if (!sameBounds(current, nextBounds)) {
    widgetWindow.setBounds(nextBounds, false);
    log(`position ${JSON.stringify({ mascot: avatar.mascotBounds, tray: avatar.trayBounds, nextBounds })}`);
  }
  if (allowShow) {
    widgetWindow.setAlwaysOnTop(true, "screen-saver", 1);
    const wasVisible = widgetWindow.isVisible();
    if (!wasVisible) widgetWindow.showInactive();
    widgetWindow.moveTop();
    if (!wasVisible) {
      log(`show ${JSON.stringify({ visible: widgetWindow.isVisible(), bounds: widgetWindow.getBounds() })}`);
    }
  }
}

function getWidgetSize(mascotBounds) {
  const height = clamp(Math.round(mascotBounds.height * 0.78), 82, 100);
  return {
    width: height < 92 ? 48 : 52,
    height,
  };
}

function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function log(message) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Logging should never affect the overlay.
  }
}

function logQuotaChange(state) {
  const signature = `${state.fiveHour.remainingPercent}/${state.weekly.remainingPercent}/${state.source}`;
  if (signature === lastLoggedQuotaSignature) return;
  lastLoggedQuotaSignature = signature;
  log(
    `quota ${JSON.stringify({
      fiveHour: state.fiveHour.remainingPercent,
      weekly: state.weekly.remainingPercent,
      syncedAt: state.syncedAt,
      source: state.source,
    })}`,
  );
}
