import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createQuotaReader } from "../src/main/quotaReader.js";

function createMockSpawn({ onRequest, failToSpawn = false } = {}) {
  const calls = [];
  const requests = [];
  let nextPid = 10_000;
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.pid = nextPid;
    nextPid += 1;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      child.emit("close", 0);
    };

    if (failToSpawn) {
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child;
    }

    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        requests.push(request);
        const responses = onRequest?.(request) ?? [];
        for (const response of Array.isArray(responses) ? responses : [responses]) {
          child.stdout.write(`${JSON.stringify(response)}\n`);
        }
      }
    });

    return child;
  };

  return { spawnImpl, calls, requests };
}

describe("quota reader", () => {
  test("reuses one Codex app-server connection across quota reads", async () => {
    let readCount = 0;
    const { spawnImpl, calls, requests } = createMockSpawn({
      onRequest(request) {
        if (request.method === "initialize") {
          return { id: request.id, result: { serverInfo: { name: "codex" } } };
        }
        if (request.method === "account/read") {
          return { id: request.id, result: { account: { type: "chatgpt", planType: "plus" } } };
        }
        if (request.method === "account/rateLimits/read") {
          readCount += 1;
          return {
            id: request.id,
            result: {
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: readCount === 1 ? 8 : 9, windowDurationMins: 300, resetsAt: 1780470869 },
                secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1780880489 },
              },
            },
          };
        }
        return [];
      },
    });
    const reader = createQuotaReader({ spawnImpl, platform: "linux", pidFilePath: null });

    const first = await reader.readFreshQuotaSnapshot({
      now: new Date("2026-06-03T02:30:00.000Z"),
    });
    const second = await reader.readFreshQuotaSnapshot({
      now: new Date("2026-06-03T02:31:00.000Z"),
    });
    reader.close();

    expect(calls).toEqual([{ command: "codex", args: ["app-server"] }]);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
      "account/rateLimits/read",
    ]);
    expect(first.status).toBe("ok");
    expect(first.fiveHour.remainingPercent).toBe(92);
    expect(first.fiveHour.windowMinutes).toBe(300);
    expect(second.fiveHour.remainingPercent).toBe(91);
    expect(second.weekly.remainingPercent).toBe(69);
    expect(second.source).toBe("codex-app-server");
  });

  test("uses the runnable Codex binary directly on Windows when available", async () => {
    const { spawnImpl, calls } = createMockSpawn({
      onRequest(request) {
        if (request.method === "initialize") return { id: request.id, result: {} };
        if (request.method === "account/read") return { id: request.id, result: { account: { type: "chatgpt" } } };
        if (request.method === "account/rateLimits/read") {
          return { id: request.id, result: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } } };
        }
        return [];
      },
    });
    const reader = createQuotaReader({
      spawnImpl,
      platform: "win32",
      codexBin: "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\abc\\codex.exe",
      pidFilePath: null,
    });

    await reader.readFreshQuotaSnapshot({
      now: new Date("2026-06-03T02:30:00.000Z"),
    });
    reader.close();

    expect(calls).toEqual([{
      command: "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\abc\\codex.exe",
      args: ["app-server"],
    }]);
  });

  test("ignores notifications and waits for the matching JSON-RPC response id", async () => {
    const { spawnImpl } = createMockSpawn({
      onRequest(request) {
        if (request.method === "initialize") {
          return [
            { method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 99 } } } },
            { id: 999, result: { ignored: true } },
            { id: request.id, result: {} },
          ];
        }
        if (request.method === "account/read") return { id: request.id, result: { account: { type: "chatgpt" } } };
        if (request.method === "account/rateLimits/read") {
          return [
            { method: "remoteControl/status/changed", params: {} },
            { id: request.id, result: { rateLimits: { primary: { usedPercent: 44, windowDurationMins: 300 } } } },
          ];
        }
        return [];
      },
    });
    const reader = createQuotaReader({ spawnImpl, platform: "linux", pidFilePath: null });

    const snapshot = await reader.readFreshQuotaSnapshot({
      now: new Date("2026-06-03T02:30:00.000Z"),
    });
    reader.close();

    expect(snapshot.fiveHour.remainingPercent).toBe(56);
  });

  test("does not fall back to local logs when app-server cannot return quota", async () => {
    const { spawnImpl } = createMockSpawn({ failToSpawn: true });
    const reader = createQuotaReader({ spawnImpl, platform: "linux", pidFilePath: null, timeoutMs: 20 });

    const snapshot = await reader.readFreshQuotaSnapshot({
      now: new Date("2026-06-03T02:30:00.000Z"),
    });
    reader.close();

    expect(snapshot.status).toBe("unknown");
    expect(snapshot.fiveHour.remainingPercent).toBe(null);
    expect(snapshot.source).toBe(null);
  });

  test("keeps the last valid quota snapshot when a later app-server read fails", async () => {
    let failNextRead = false;
    const { spawnImpl } = createMockSpawn({
      onRequest(request) {
        if (request.method === "initialize") return { id: request.id, result: {} };
        if (request.method === "account/read") return { id: request.id, result: { account: { type: "chatgpt" } } };
        if (request.method === "account/rateLimits/read") {
          if (failNextRead) return { id: request.id, error: { message: "temporary failure" } };
          return {
            id: request.id,
            result: {
              rateLimits: {
                primary: { usedPercent: 42, windowDurationMins: 300 },
                secondary: { usedPercent: 37, windowDurationMins: 10080 },
              },
            },
          };
        }
        return [];
      },
    });
    const reader = createQuotaReader({ spawnImpl, platform: "linux", pidFilePath: null });

    const first = await reader.readFreshQuotaSnapshot({ now: new Date("2026-06-03T02:30:00.000Z") });
    failNextRead = true;
    const second = await reader.readFreshQuotaSnapshot({ now: new Date("2026-06-03T02:31:00.000Z") });
    reader.close();

    expect(first.status).toBe("ok");
    expect(first.fiveHour.remainingPercent).toBe(58);
    expect(second.status).toBe("stale");
    expect(second.fiveHour.remainingPercent).toBe(58);
    expect(second.weekly.remainingPercent).toBe(63);
    expect(second.source).toBe("codex-app-server");
  });

  test("cleans up a marked stale app-server before starting a new one", async () => {
    const killed = [];
    const processTools = {
      isAlive: (pid) => pid === 12345,
      kill: (pid) => killed.push(pid),
    };
    const { spawnImpl } = createMockSpawn({
      onRequest(request) {
        if (request.method === "initialize") return { id: request.id, result: {} };
        if (request.method === "account/read") return { id: request.id, result: { account: { type: "chatgpt" } } };
        if (request.method === "account/rateLimits/read") {
          return { id: request.id, result: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } } };
        }
        return [];
      },
    });
    const pidFiles = new Map([
      ["marker.json", JSON.stringify({ marker: "codex-quota-pet-widget-app-server", pid: 12345 })],
    ]);
    const reader = createQuotaReader({
      spawnImpl,
      platform: "linux",
      pidFilePath: "marker.json",
      processTools,
      fileTools: createMemoryFileTools(pidFiles),
    });

    const snapshot = await reader.readFreshQuotaSnapshot({ now: new Date("2026-06-03T02:30:00.000Z") });
    reader.close();

    expect(killed).toEqual([12345]);
    expect(snapshot.fiveHour.remainingPercent).toBe(75);
  });

  test("cleans up the marker when the app-server exits unexpectedly", async () => {
    let spawnedChild;
    const { spawnImpl } = createMockSpawn({
      onRequest(request) {
        if (request.method === "initialize") return { id: request.id, result: {} };
        if (request.method === "account/read") return { id: request.id, result: { account: { type: "chatgpt" } } };
        if (request.method === "account/rateLimits/read") {
          return { id: request.id, result: { rateLimits: { primary: { usedPercent: 35, windowDurationMins: 300 } } } };
        }
        return [];
      },
    });
    const wrappedSpawn = (...args) => {
      spawnedChild = spawnImpl(...args);
      return spawnedChild;
    };
    const pidFiles = new Map();
    const reader = createQuotaReader({
      spawnImpl: wrappedSpawn,
      platform: "linux",
      pidFilePath: "marker.json",
      fileTools: createMemoryFileTools(pidFiles),
    });

    await reader.readFreshQuotaSnapshot({ now: new Date("2026-06-03T02:30:00.000Z") });
    expect(pidFiles.has("marker.json")).toBe(true);
    spawnedChild.emit("close", 0);

    expect(pidFiles.has("marker.json")).toBe(false);
  });
});

function createMemoryFileTools(files) {
  return {
    mkdirSync() {},
    writeFileSync(file, value) {
      files.set(file, value);
    },
    readFileSync(file) {
      if (!files.has(file)) throw new Error("not found");
      return files.get(file);
    },
    rmSync(file) {
      files.delete(file);
    },
  };
}
