import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { normalizeRateLimits } from "../shared/quota.js";

const DEFAULT_TIMEOUT_MS = 18_000;
const SOURCE_CODEX_APP_SERVER = "codex-app-server";
const SERVER_MARKER = "codex-quota-pet-widget-app-server";
const CLIENT_INFO = {
  name: SERVER_MARKER,
  title: "Codex Quota Pet Widget App Server",
  version: "0.1.0",
};

let defaultReader = null;

export function getCodexHome() {
  return path.join(os.homedir(), ".codex");
}

export function createQuotaReader(options = {}) {
  return new CodexQuotaReader(options);
}

export async function readFreshQuotaSnapshot(options = {}) {
  if (!defaultReader) defaultReader = createQuotaReader();
  return defaultReader.readFreshQuotaSnapshot(options);
}

export function closeQuotaAppServer() {
  defaultReader?.close();
  defaultReader = null;
}

class CodexQuotaReader {
  constructor({
    spawnImpl = spawn,
    platform = process.platform,
    codexBin = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pidFilePath = defaultPidFilePath(),
    processTools = defaultProcessTools,
    fileTools = fs,
  } = {}) {
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.codexBin = codexBin;
    this.timeoutMs = timeoutMs;
    this.pidFilePath = pidFilePath;
    this.processTools = processTools;
    this.fileTools = fileTools;
    this.child = null;
    this.rpc = null;
    this.initializing = null;
    this.lastGoodSnapshot = null;
  }

  async readFreshQuotaSnapshot({ now = new Date() } = {}) {
    try {
      const rpc = await this.getRpc();
      const result = await rpc.request("account/rateLimits/read");
      const rateLimits = mapAppServerRateLimits(result?.rateLimits);
      if (!rateLimits.primary && !rateLimits.secondary) return createUnknownSnapshot(now);
      const snapshot = {
        ...normalizeRateLimits(rateLimits, now),
        source: SOURCE_CODEX_APP_SERVER,
      };
      this.lastGoodSnapshot = snapshot;
      return snapshot;
    } catch {
      this.resetBrokenClient();
      return this.lastGoodSnapshot
        ? createStaleSnapshot(this.lastGoodSnapshot, now)
        : createUnknownSnapshot(now);
    }
  }

  async getRpc() {
    if (this.rpc) return this.rpc;
    if (!this.initializing) this.initializing = this.start();
    return this.initializing;
  }

  async start() {
    cleanupStaleAppServer(this.pidFilePath, this.processTools, this.fileTools);
    this.child = spawnCodexAppServer(this.spawnImpl, this.platform, this.codexBin);
    const child = this.child;
    writePidFile(this.pidFilePath, this.child, this.fileTools);
    this.rpc = createJsonRpcClient(this.child, this.timeoutMs, () => {
      if (this.child !== child) return;
      this.rpc = null;
      this.child = null;
      this.initializing = null;
      removePidFile(this.pidFilePath, this.fileTools);
    });

    try {
      await this.rpc.request("initialize", { clientInfo: CLIENT_INFO });
      this.rpc.notify("initialized", {});
      await this.rpc.request("account/read", { refreshToken: false });
      return this.rpc;
    } catch (error) {
      this.resetBrokenClient();
      throw error;
    } finally {
      this.initializing = null;
    }
  }

  resetBrokenClient() {
    this.rpc?.close();
    this.rpc = null;
    this.child = null;
    removePidFile(this.pidFilePath, this.fileTools);
  }

  close() {
    this.rpc?.close();
    this.rpc = null;
    this.child = null;
    this.initializing = null;
    removePidFile(this.pidFilePath, this.fileTools);
  }
}

function defaultPidFilePath() {
  return path.join(getCodexHome(), "quota-pet-widget", "app-server.json");
}

function cleanupStaleAppServer(pidFilePath, processTools, fileTools) {
  const marker = readPidFile(pidFilePath, fileTools);
  if (marker?.marker !== SERVER_MARKER || !Number.isInteger(marker.pid)) return;
  if (processTools.isAlive(marker.pid)) {
    try {
      processTools.kill(marker.pid);
    } catch {
      // Best-effort stale cleanup only.
    }
  }
  removePidFile(pidFilePath, fileTools);
}

function writePidFile(pidFilePath, child, fileTools) {
  if (!pidFilePath) return;
  if (!Number.isInteger(child?.pid)) return;
  try {
    fileTools.mkdirSync(path.dirname(pidFilePath), { recursive: true });
    fileTools.writeFileSync(
      pidFilePath,
      JSON.stringify({
        version: 1,
        marker: SERVER_MARKER,
        pid: child.pid,
        startedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
  } catch {
    // The quota reader still works without a marker file.
  }
}

function readPidFile(pidFilePath, fileTools) {
  if (!pidFilePath) return null;
  try {
    return JSON.parse(fileTools.readFileSync(pidFilePath, "utf8"));
  } catch {
    return null;
  }
}

function removePidFile(pidFilePath, fileTools) {
  if (!pidFilePath) return;
  try {
    fileTools.rmSync(pidFilePath, { force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

const defaultProcessTools = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill(pid) {
    process.kill(pid);
  },
};

function spawnCodexAppServer(spawnImpl, platform, codexBin) {
  if (platform === "win32") {
    const windowsCodexBin = codexBin ?? findWindowsCodexBinary();
    if (windowsCodexBin) {
      return spawnImpl(windowsCodexBin, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    }

    return spawnImpl("powershell.exe", ["-NoProfile", "-Command", "codex app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  return spawnImpl("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function findWindowsCodexBinary() {
  const root = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
    : null;
  if (!root) return null;

  try {
    const candidates = [];
    collectCodexBinaries(root, candidates);
    return candidates
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file ?? null;
  } catch {
    return null;
  }
}

function collectCodexBinaries(dir, candidates) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCodexBinaries(file, candidates);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    }
  }
}

function createJsonRpcClient(child, timeoutMs, onUnexpectedClose = null) {
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const stdout = createInterface({ input: child.stdout });

  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  child.on?.("error", failAll);
  child.on?.("close", (code) => {
    if (!closed && pending.size > 0) failAll(new Error(`codex app-server closed with code ${code ?? "unknown"}`));
    if (!closed) onUnexpectedClose?.(code);
  });

  stdout.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.error) {
      request.reject(new Error(message.error.message ?? "Codex app-server JSON-RPC error"));
      return;
    }
    request.resolve(message.result);
  });

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("Codex app-server client is closed"));
      const id = nextId;
      nextId += 1;
      const payload = params === undefined ? { id, method } : { id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, Math.max(1, timeoutMs));
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (!error) return;
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    notify(method, params) {
      if (closed) return;
      const payload = params === undefined ? { method } : { method, params };
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    },
    close() {
      closed = true;
      stdout.close();
      failAll(new Error("Codex app-server client closed"));
      try {
        child.stdin.end();
      } catch {
        // Ignore shutdown errors.
      }
      try {
        child.kill();
      } catch {
        // Ignore shutdown errors.
      }
    },
  };
}

function mapAppServerRateLimits(rateLimits) {
  return {
    primary: mapAppServerWindow(rateLimits?.primary),
    secondary: mapAppServerWindow(rateLimits?.secondary),
  };
}

function mapAppServerWindow(window) {
  if (!window || typeof window !== "object") return null;
  return {
    used_percent: window.usedPercent,
    window_minutes: window.windowDurationMins,
    reset_at: window.resetsAt,
  };
}

export function createUnknownSnapshot(now = new Date()) {
  const emptyLimit = {
    remainingPercent: null,
    usedPercent: null,
    windowMinutes: null,
    resetsAt: null,
    tone: "unknown",
  };
  return {
    status: "unknown",
    syncedAt: now.toISOString(),
    fiveHour: { ...emptyLimit, id: "5h", label: "5h" },
    weekly: { ...emptyLimit, id: "week", label: "week" },
    source: null,
  };
}

function createStaleSnapshot(snapshot, now = new Date()) {
  return {
    ...snapshot,
    status: "stale",
    syncedAt: now.toISOString(),
    fiveHour: { ...snapshot.fiveHour },
    weekly: { ...snapshot.weekly },
  };
}
