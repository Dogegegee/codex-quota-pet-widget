import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readFreshQuotaSnapshot, readLatestQuotaSnapshot } from "../src/main/quotaReader.js";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeCodexHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quota-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

describe("quota reader", () => {
  test("prefers the live Codex usage endpoint over stale local logs", async () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "test-token",
          account_id: "test-account",
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite-wal"),
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":88,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":40,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );

    const fetchImpl = async (url, options) => {
      expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
      expect(options.headers.authorization).toBe("Bearer test-token");
      expect(options.headers["ChatGPT-Account-Id"]).toBe("test-account");
      return {
        ok: true,
        async json() {
          return {
            rate_limit: {
              primary_window: {
                used_percent: 9,
                limit_window_seconds: 18000,
                reset_at: 1779880302,
              },
              secondary_window: {
                used_percent: 62,
                limit_window_seconds: 604800,
                reset_at: 1780215936,
              },
            },
          };
        },
      };
    };

    const snapshot = await readFreshQuotaSnapshot({
      codexHome,
      now: new Date("2026-05-27T06:16:00.000Z"),
      fetchImpl,
    });

    expect(snapshot.fiveHour.remainingPercent).toBe(91);
    expect(snapshot.weekly.remainingPercent).toBe(38);
    expect(snapshot.source).toBe("https://chatgpt.com/backend-api/wham/usage");
  });

  test("falls back to local quota logs when live usage cannot be read", async () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-token" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite-wal"),
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":14,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":29,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );

    const snapshot = await readFreshQuotaSnapshot({
      codexHome,
      now: new Date("2026-05-26T02:30:00.000Z"),
      fetchImpl: async () => ({ ok: false }),
    });

    expect(snapshot.fiveHour.remainingPercent).toBe(86);
    expect(snapshot.weekly.remainingPercent).toBe(71);
    expect(snapshot.source).toContain("logs_2.sqlite-wal");
  });

  test("times out a stalled live usage request instead of waiting indefinitely", async () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-token" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite-wal"),
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":82,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":28,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );

    const startedAt = Date.now();
    let sawAbortSignal = false;
    const snapshot = await readFreshQuotaSnapshot({
      codexHome,
      now: new Date("2026-05-26T02:30:00.000Z"),
      usageTimeoutMs: 10,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        sawAbortSignal = options?.signal instanceof AbortSignal;
        options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(sawAbortSignal).toBe(true);
    expect(snapshot.fiveHour.remainingPercent).toBe(18);
    expect(snapshot.source).toContain("logs_2.sqlite-wal");
  });

  test("keeps the last live usage snapshot instead of regressing to stale local logs", async () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-token" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite-wal"),
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":1,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":1,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );
    const liveResponse = {
      ok: true,
      async json() {
        return {
          rate_limit: {
            primary_window: { used_percent: 16, limit_window_seconds: 18000, reset_at: 1779880302 },
            secondary_window: { used_percent: 63, limit_window_seconds: 604800, reset_at: 1780215936 },
          },
        };
      },
    };

    const first = await readFreshQuotaSnapshot({
      codexHome,
      now: new Date("2026-05-27T06:20:00.000Z"),
      fetchImpl: async () => liveResponse,
    });
    const second = await readFreshQuotaSnapshot({
      codexHome,
      now: new Date("2026-05-27T06:21:00.000Z"),
      fetchImpl: async () => ({ ok: false }),
    });

    expect(first.fiveHour.remainingPercent).toBe(84);
    expect(second.fiveHour.remainingPercent).toBe(84);
    expect(second.weekly.remainingPercent).toBe(37);
    expect(second.source).toBe("https://chatgpt.com/backend-api/wham/usage");
  });

  test("prefers Codex websocket rate limit logs over session jsonl snapshots", () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "sessions", "active.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T02:00:00.000Z",
        type: "event_msg",
        payload: { rate_limits: { primary: { used_percent: 95, window_minutes: 300 } } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite-wal"),
      [
        'noise websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":20,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":30,"window_minutes":10080,"reset_at":1780215936}}}',
        'newer websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":8,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":31,"window_minutes":10080,"reset_at":1780215936}}}',
      ].join("\n"),
      "utf8",
    );

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T02:30:00.000Z") });

    expect(snapshot.fiveHour.remainingPercent).toBe(92);
    expect(snapshot.weekly.remainingPercent).toBe(69);
    expect(snapshot.source).toContain("logs_2.sqlite-wal");
  });

  test("finds realtime rate limit logs even when sqlite padding follows the event", () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "sessions", "stale.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T02:00:00.000Z",
        type: "event_msg",
        payload: { rate_limits: { primary: { used_percent: 96, window_minutes: 300 } } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite-wal"),
      [
        'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":15,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":32,"window_minutes":10080,"reset_at":1780215936}}}',
        "x".repeat(300 * 1024),
      ].join("\n"),
      "utf8",
    );

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T02:30:00.000Z") });

    expect(snapshot.fiveHour.remainingPercent).toBe(85);
    expect(snapshot.weekly.remainingPercent).toBe(68);
    expect(snapshot.source).toContain("logs_2.sqlite-wal");
  });

  test("prefers wal realtime logs over checkpointed sqlite logs", () => {
    const codexHome = makeCodexHome();
    const walPath = path.join(codexHome, "logs_2.sqlite-wal");
    const sqlitePath = path.join(codexHome, "logs_2.sqlite");
    fs.writeFileSync(
      walPath,
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":11,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":33,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );
    fs.writeFileSync(
      sqlitePath,
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":18,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":18,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );
    fs.utimesSync(sqlitePath, new Date("2026-05-26T03:00:00.000Z"), new Date("2026-05-26T03:00:00.000Z"));
    fs.utimesSync(walPath, new Date("2026-05-26T02:00:00.000Z"), new Date("2026-05-26T02:00:00.000Z"));

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T03:30:00.000Z") });

    expect(snapshot.fiveHour.remainingPercent).toBe(89);
    expect(snapshot.weekly.remainingPercent).toBe(67);
    expect(snapshot.source).toContain("logs_2.sqlite-wal");
  });

  test("keeps the cached wal event instead of falling back to stale sqlite during wal rotation", () => {
    const codexHome = makeCodexHome();
    const walPath = path.join(codexHome, "logs_2.sqlite-wal");
    const sqlitePath = path.join(codexHome, "logs_2.sqlite");
    fs.writeFileSync(
      walPath,
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":12,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":34,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );
    fs.writeFileSync(
      sqlitePath,
      'websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":18,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":18,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );

    const first = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T03:30:00.000Z") });
    fs.writeFileSync(walPath, "sqlite wal frame padding without quota event", "utf8");
    const second = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T03:31:00.000Z") });

    expect(first.fiveHour.remainingPercent).toBe(88);
    expect(second.fiveHour.remainingPercent).toBe(88);
    expect(second.weekly.remainingPercent).toBe(66);
    expect(second.source).toContain("logs_2.sqlite-wal");
  });

  test("does not parse stale rate limits by scanning the sqlite database as plain text", () => {
    const codexHome = makeCodexHome();
    fs.writeFileSync(
      path.join(codexHome, "logs_2.sqlite"),
      'old sqlite page websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":18,"window_minutes":300,"reset_at":1779795365},"secondary":{"used_percent":18,"window_minutes":10080,"reset_at":1780215936}}}',
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "sessions", "fresh.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T03:40:00.000Z",
        type: "event_msg",
        payload: {
          rate_limits: {
            primary: { used_percent: 64, window_minutes: 300 },
            secondary: { used_percent: 41, window_minutes: 10080 },
          },
        },
      }),
      "utf8",
    );

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T03:41:00.000Z") });

    expect(snapshot.fiveHour.remainingPercent).toBe(36);
    expect(snapshot.weekly.remainingPercent).toBe(59);
    expect(snapshot.source).toContain("fresh.jsonl");
  });

  test("reads the latest rate limit event from Codex session jsonl files", () => {
    const codexHome = makeCodexHome();
    const logPath = path.join(codexHome, "sessions", "session.jsonl");
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ type: "event_msg", payload: { rate_limits: { primary: { used_percent: 20, window_minutes: 300 } } } }),
        JSON.stringify({
          timestamp: "2026-05-26T02:05:00.000Z",
          type: "event_msg",
          payload: {
            rate_limits: {
              primary: { used_percent: 62, window_minutes: 300, resets_at: 1779768000 },
              secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1780200000 },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T02:06:00.000Z") });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.fiveHour.remainingPercent).toBe(38);
    expect(snapshot.weekly.remainingPercent).toBe(82);
    expect(snapshot.source).toContain("session.jsonl");
  });

  test("chooses the newest rate limit event across recent files by event timestamp", () => {
    const codexHome = makeCodexHome();
    const sessionsDir = path.join(codexHome, "sessions");
    fs.writeFileSync(
      path.join(sessionsDir, "older-mtime.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T02:10:00.000Z",
        type: "event_msg",
        payload: {
          rate_limits: {
            primary: { used_percent: 90, window_minutes: 300 },
            secondary: { used_percent: 10, window_minutes: 10080 },
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sessionsDir, "newer-event.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T02:20:00.000Z",
        type: "event_msg",
        payload: {
          rate_limits: {
            primary: { used_percent: 35, window_minutes: 300 },
            secondary: { used_percent: 25, window_minutes: 10080 },
          },
        },
      }),
      "utf8",
    );

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T02:30:00.000Z") });

    expect(snapshot.fiveHour.remainingPercent).toBe(65);
    expect(snapshot.weekly.remainingPercent).toBe(75);
    expect(snapshot.source).toContain("newer-event.jsonl");
  });

  test("prefers active sessions over archived sessions when active quota data exists", () => {
    const codexHome = makeCodexHome();
    fs.mkdirSync(path.join(codexHome, "archived_sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "archived_sessions", "archived.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T02:30:00.000Z",
        type: "event_msg",
        payload: { rate_limits: { primary: { used_percent: 95, window_minutes: 300 } } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "sessions", "active.jsonl"),
      JSON.stringify({
        timestamp: "2026-05-26T02:00:00.000Z",
        type: "event_msg",
        payload: { rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } },
      }),
      "utf8",
    );

    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T02:35:00.000Z") });

    expect(snapshot.fiveHour.remainingPercent).toBe(60);
    expect(snapshot.source).toContain("active.jsonl");
  });

  test("returns an unknown snapshot when no quota event exists", () => {
    const codexHome = makeCodexHome();
    const snapshot = readLatestQuotaSnapshot({ codexHome, now: new Date("2026-05-26T02:06:00.000Z") });

    expect(snapshot.status).toBe("unknown");
    expect(snapshot.fiveHour.remainingPercent).toBe(null);
    expect(snapshot.weekly.remainingPercent).toBe(null);
  });
});
