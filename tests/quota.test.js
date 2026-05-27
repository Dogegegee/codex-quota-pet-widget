import { describe, expect, test } from "vitest";
import { normalizeRateLimits, remainingFromUsed, toneForRemaining } from "../src/shared/quota.js";

describe("quota normalization", () => {
  test("maps Codex primary and secondary rate limits into five hour and weekly quota", () => {
    const snapshot = normalizeRateLimits(
      {
        primary: { used_percent: 13, window_minutes: 300, resets_at: 1779768000 },
        secondary: { used_percent: 73, window_minutes: 10080, resets_at: 1780200000 },
      },
      new Date("2026-05-26T02:00:00.000Z"),
    );

    expect(snapshot.fiveHour.remainingPercent).toBe(87);
    expect(snapshot.weekly.remainingPercent).toBe(27);
    expect(snapshot.fiveHour.windowMinutes).toBe(300);
    expect(snapshot.weekly.windowMinutes).toBe(10080);
    expect(snapshot.syncedAt).toBe("2026-05-26T02:00:00.000Z");
  });

  test("calculates quota window progress from reset time and window length", () => {
    const snapshot = normalizeRateLimits(
      {
        primary: { used_percent: 13, window_minutes: 300, reset_at: 1779768000 },
        secondary: { used_percent: 30, window_minutes: 10080, reset_at: 1780200000 },
      },
      new Date("2026-05-26T09:30:00.000+08:00"),
    );

    expect(snapshot.fiveHour.windowProgressPercent).toBe(50);
    expect(snapshot.weekly.windowProgressPercent).toBeGreaterThan(0);
  });

  test("leaves quota window progress unknown without reset time or window length", () => {
    const snapshot = normalizeRateLimits(
      { primary: { used_percent: 13, window_minutes: 300 } },
      new Date("2026-05-26T09:30:00.000+08:00"),
    );

    expect(snapshot.fiveHour.windowProgressPercent).toBe(null);
  });

  test("estimates quota as refreshed after the reset time passes without a newer event", () => {
    const snapshot = normalizeRateLimits(
      {
        primary: { used_percent: 100, window_minutes: 300, reset_at: 1779768000 },
      },
      new Date("2026-05-26T04:15:00.000Z"),
    );

    expect(snapshot.fiveHour.remainingPercent).toBe(100);
    expect(snapshot.fiveHour.usedPercent).toBe(0);
    expect(snapshot.fiveHour.resetsAt).toBe("2026-05-26T09:00:00.000Z");
    expect(snapshot.fiveHour.windowProgressPercent).toBe(5);
    expect(snapshot.fiveHour.tone).toBe("safe");
  });

  test("does not immediately jump to full quota during the reset settle window", () => {
    const snapshot = normalizeRateLimits(
      {
        primary: { used_percent: 55, window_minutes: 300, reset_at: 1779768000 },
      },
      new Date("2026-05-26T04:01:00.000Z"),
    );

    expect(snapshot.fiveHour.remainingPercent).toBe(45);
    expect(snapshot.fiveHour.usedPercent).toBe(55);
    expect(snapshot.fiveHour.resetsAt).toBe("2026-05-26T04:00:00.000Z");
    expect(snapshot.fiveHour.windowProgressPercent).toBe(100);
    expect(snapshot.fiveHour.tone).toBe("watch");
  });

  test("clamps invalid or out of range used percentages", () => {
    expect(remainingFromUsed(-20)).toBe(100);
    expect(remainingFromUsed(42.4)).toBe(58);
    expect(remainingFromUsed(130)).toBe(0);
    expect(remainingFromUsed(null)).toBe(null);
  });

  test("uses three visual tones for safe, watch, and low remaining quota", () => {
    expect(toneForRemaining(80)).toBe("safe");
    expect(toneForRemaining(35)).toBe("watch");
    expect(toneForRemaining(12)).toBe("low");
    expect(toneForRemaining(null)).toBe("unknown");
  });
});
