import { describe, expect, test } from "vitest";
import { nextQuotaPollingState } from "../src/main/quotaPolling.js";

describe("quota polling policy", () => {
  test("pauses polling after five unchanged quota snapshots", () => {
    let state = { paused: false, unchangedCount: 0, signature: null };
    const snapshot = {
      fiveHour: { remainingPercent: 54 },
      weekly: { remainingPercent: 32 },
    };

    for (let index = 0; index < 4; index += 1) {
      state = nextQuotaPollingState(state, snapshot);
      expect(state.paused).toBe(false);
    }

    state = nextQuotaPollingState(state, snapshot);
    expect(state.paused).toBe(true);
    expect(state.unchangedCount).toBe(5);
  });

  test("resets unchanged count when the quota value changes", () => {
    const first = nextQuotaPollingState(
      { paused: false, unchangedCount: 4, signature: "54/32" },
      { fiveHour: { remainingPercent: 53 }, weekly: { remainingPercent: 32 } },
    );

    expect(first.paused).toBe(false);
    expect(first.unchangedCount).toBe(1);
    expect(first.signature).toBe("53/32");
  });

  test("does not special case exhausted or visually full quota values", () => {
    const exhausted = nextQuotaPollingState(
      { paused: false, unchangedCount: 0, signature: null },
      { fiveHour: { remainingPercent: 0 }, weekly: { remainingPercent: 32 } },
    );
    const full = nextQuotaPollingState(
      { paused: false, unchangedCount: 0, signature: null },
      { fiveHour: { remainingPercent: 99 }, weekly: { remainingPercent: 32 } },
    );

    expect(exhausted.paused).toBe(false);
    expect(full.paused).toBe(false);
  });

  test("session-triggered refresh wakes polling even when the quota value is unchanged", () => {
    const state = nextQuotaPollingState(
      { paused: true, unchangedCount: 5, signature: "54/32" },
      { fiveHour: { remainingPercent: 54 }, weekly: { remainingPercent: 32 } },
      { resetUnchanged: true },
    );

    expect(state.paused).toBe(false);
    expect(state.unchangedCount).toBe(1);
    expect(state.signature).toBe("54/32");
  });
});
