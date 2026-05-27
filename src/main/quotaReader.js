import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeRateLimits } from "../shared/quota.js";

const SESSION_TAIL_BYTES = 256 * 1024;
const REALTIME_LOG_SCAN_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 32;
const SQLITE_RECENT_ID_WINDOW = 100_000;
const DEFAULT_CHATGPT_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";
const realtimeLogCache = new Map();
let sqliteCliAvailable = true;
const lastUsageEventByHome = new Map();

export function getCodexHome() {
  return path.join(os.homedir(), ".codex");
}

export async function readFreshQuotaSnapshot({
  codexHome = getCodexHome(),
  now = new Date(),
  fetchImpl = globalThis.fetch,
  usageTimeoutMs = 8_000,
} = {}) {
  const usageEvent = await fetchLatestUsageEvent(codexHome, fetchImpl, usageTimeoutMs);
  if (usageEvent) return snapshotFromEvent(usageEvent, now);
  const lastUsageEvent = lastUsageEventByHome.get(codexHome);
  if (lastUsageEvent) return snapshotFromEvent(lastUsageEvent, now);
  return readLatestQuotaSnapshot({ codexHome, now });
}

export function readLatestQuotaSnapshot({ codexHome = getCodexHome(), now = new Date() } = {}) {
  const liveEvent = findLatestRateLimitLogEvent(codexHome);
  if (liveEvent) return snapshotFromEvent(liveEvent, now);

  const activeEvent = findLatestEventInRoot(path.join(codexHome, "sessions"));
  if (activeEvent) return snapshotFromEvent(activeEvent, now);

  const archivedEvent = findLatestEventInRoot(path.join(codexHome, "archived_sessions"));
  if (archivedEvent) return snapshotFromEvent(archivedEvent, now);

  return createUnknownSnapshot(now);
}

async function fetchLatestUsageEvent(codexHome, fetchImpl, usageTimeoutMs) {
  if (typeof fetchImpl !== "function") return null;

  const auth = readChatgptAuth(codexHome);
  if (!auth?.accessToken) return null;

  const usageUrl = usageUrlFromBase(readChatgptBaseUrl(codexHome));
  try {
    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      "user-agent": "codex-quota-pet-widget",
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), Math.max(1, usageTimeoutMs));
    let response;
    try {
      response = await fetchImpl(usageUrl, { headers, signal: abortController.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) return null;
    const payload = await response.json();
    const rateLimits = rateLimitsFromUsagePayload(payload);
    if (!rateLimits?.primary && !rateLimits?.secondary) return null;
    const event = {
      rateLimits,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      source: usageUrl,
    };
    lastUsageEventByHome.set(codexHome, event);
    return event;
  } catch {
    return null;
  }
}

function readChatgptAuth(codexHome) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"));
    if (auth?.auth_mode === "apikey" || auth?.OPENAI_API_KEY) return null;
    return {
      accessToken: auth?.tokens?.access_token ?? null,
      accountId: auth?.tokens?.account_id ?? null,
    };
  } catch {
    return null;
  }
}

function readChatgptBaseUrl(codexHome) {
  try {
    const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    const match = config.match(/^\s*chatgpt_base_url\s*=\s*["']([^"']+)["']/m);
    if (match?.[1]) return match[1];
  } catch {
    // Default to the same ChatGPT backend URL Codex uses.
  }
  return DEFAULT_CHATGPT_BACKEND_BASE_URL;
}

function usageUrlFromBase(baseUrl) {
  let normalized = String(baseUrl || DEFAULT_CHATGPT_BACKEND_BASE_URL).trim();
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (
    (normalized.startsWith("https://chatgpt.com") || normalized.startsWith("https://chat.openai.com"))
    && !normalized.includes("/backend-api")
  ) {
    normalized = `${normalized}/backend-api`;
  }
  return normalized.includes("/backend-api")
    ? `${normalized}/wham/usage`
    : `${normalized}/api/codex/usage`;
}

function rateLimitsFromUsagePayload(payload) {
  const rateLimit = payload?.rate_limit;
  const primary = windowFromUsagePayload(rateLimit?.primary_window);
  const secondary = windowFromUsagePayload(rateLimit?.secondary_window);
  const rateLimits = {};
  if (primary) rateLimits.primary = primary;
  if (secondary) rateLimits.secondary = secondary;
  return rateLimits;
}

function windowFromUsagePayload(window) {
  if (!window || typeof window !== "object") return null;
  const windowMinutes = Number.isFinite(window.limit_window_seconds)
    ? Math.round(window.limit_window_seconds / 60)
    : null;
  return {
    used_percent: window.used_percent,
    window_minutes: windowMinutes,
    reset_at: window.reset_at,
  };
}

function findLatestRateLimitLogEvent(codexHome) {
  return findLatestRateLimitEventInSqlite(path.join(codexHome, "logs_2.sqlite"))
    ?? findLatestRateLimitEventInTextFile(path.join(codexHome, "logs_2.sqlite-wal"));
}

function findLatestEventInRoot(root) {
  return listJsonlFiles(root)
    .sort((a, b) => statMtimeMs(b) - statMtimeMs(a))
    .slice(0, MAX_FILES)
    .map((file) => findLatestRateLimitEvent(file))
    .filter(Boolean)
    .sort((a, b) => b.timestampMs - a.timestampMs)[0] ?? null;
}

function snapshotFromEvent(event, now) {
  return {
    ...normalizeRateLimits(event.rateLimits, now),
    source: event.source,
  };
}

function listJsonlFiles(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(entry.path, entry.name));
  } catch {
    return [];
  }
}

function statMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function findLatestRateLimitEvent(file) {
  const tail = readFileTail(file);
  const lines = tail.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      const rateLimits = parsed?.payload?.rate_limits;
      if (rateLimits?.primary || rateLimits?.secondary) {
        const timestampMs = Number.isFinite(Date.parse(parsed.timestamp))
          ? Date.parse(parsed.timestamp)
          : statMtimeMs(file);
        return {
          rateLimits,
          timestamp: parsed.timestamp ?? null,
          timestampMs,
          source: file,
        };
      }
    } catch {
      // Ignore partial tail lines and unrelated log entries.
    }
  }
  return null;
}

function findLatestRateLimitEventInTextFile(file) {
  const stats = safeStat(file);
  if (!stats) return null;

  const cacheKey = `${stats.size}:${stats.mtimeMs}`;
  const cached = realtimeLogCache.get(file);
  if (cached?.cacheKey === cacheKey) return cached.event;

  const tail = readFileTail(file, REALTIME_LOG_SCAN_BYTES, stats);
  const marker = 'websocket event: {"type":"codex.rate_limits"';
  const markerIndex = tail.lastIndexOf(marker);
  if (markerIndex === -1) {
    const event = cached?.event ?? null;
    realtimeLogCache.set(file, { cacheKey, event });
    return event;
  }

  const jsonStart = tail.indexOf("{", markerIndex);
  const jsonEnd = findMatchingJsonBrace(tail, jsonStart);
  if (jsonStart === -1 || jsonEnd === -1) {
    const event = cached?.event ?? null;
    realtimeLogCache.set(file, { cacheKey, event });
    return event;
  }

  try {
    const parsed = JSON.parse(tail.slice(jsonStart, jsonEnd + 1));
    const rateLimits = parsed?.rate_limits;
    if (!rateLimits?.primary && !rateLimits?.secondary) {
      const event = cached?.event ?? null;
      realtimeLogCache.set(file, { cacheKey, event });
      return event;
    }
    const fileMtimeMs = stats.mtimeMs;
    const event = {
      rateLimits,
      timestamp: new Date(fileMtimeMs).toISOString(),
      timestampMs: fileMtimeMs,
      fileMtimeMs,
      source: `${file}#codex.rate_limits`,
    };
    realtimeLogCache.set(file, { cacheKey, event });
    return event;
  } catch {
    const event = cached?.event ?? null;
    realtimeLogCache.set(file, { cacheKey, event });
    return event;
  }
}

function findLatestRateLimitEventInSqlite(file) {
  const stats = safeStat(file);
  if (!stats || !sqliteCliAvailable) return null;

  try {
    const rowsJson = execFileSync(
      "sqlite3",
      [
        "-readonly",
        "-json",
        file,
        "select id, ts, ts_nanos, feedback_log_body from logs "
          + `where id > (select max(id)-${SQLITE_RECENT_ID_WINDOW} from logs) `
          + "and target='codex_api::endpoint::responses_websocket' "
          + "and feedback_log_body like '%codex.rate_limits%' "
          + "order by id desc limit 1;",
      ],
      { encoding: "utf8", timeout: 1500, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const rows = JSON.parse(rowsJson || "[]");
    const row = rows[0];
    return row ? parseRateLimitEventFromLogBody(row.feedback_log_body, file, row.ts, row.ts_nanos) : null;
  } catch (error) {
    if (error?.code === "ENOENT") sqliteCliAvailable = false;
  }

  return null;
}

function parseRateLimitEventFromLogBody(body, file, seconds, nanos) {
  if (typeof body !== "string") return null;

  const marker = 'websocket event: {"type":"codex.rate_limits"';
  const markerIndex = body.lastIndexOf(marker);
  if (markerIndex === -1) return null;

  const jsonStart = body.indexOf("{", markerIndex);
  const jsonEnd = findMatchingJsonBrace(body, jsonStart);
  if (jsonStart === -1 || jsonEnd === -1) return null;

  try {
    const parsed = JSON.parse(body.slice(jsonStart, jsonEnd + 1));
    const rateLimits = parsed?.rate_limits;
    if (!rateLimits?.primary && !rateLimits?.secondary) return null;

    const timestampMs = Number.isFinite(seconds)
      ? (seconds * 1000) + (Number.isFinite(nanos) ? Math.floor(nanos / 1_000_000) : 0)
      : statMtimeMs(file);
    return {
      rateLimits,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      fileMtimeMs: statMtimeMs(file),
      source: `${file}#codex.rate_limits`,
    };
  } catch {
    return null;
  }
}

function readFileTail(file, maxBytes = SESSION_TAIL_BYTES, knownStats = null) {
  try {
    const stats = knownStats ?? fs.statSync(file);
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, "r");
    try {
      fs.readSync(handle, buffer, 0, length, start);
    } finally {
      fs.closeSync(handle);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function findMatchingJsonBrace(raw, startIndex) {
  if (startIndex < 0) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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
    fiveHour: { ...emptyLimit, id: "5h", label: "5小时" },
    weekly: { ...emptyLimit, id: "week", label: "周" },
    source: null,
  };
}
