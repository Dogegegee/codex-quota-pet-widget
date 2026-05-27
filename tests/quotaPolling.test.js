import { describe, expect, test } from "vitest";
import { nextQuotaPollingState, shouldPauseQuotaPolling } from "../src/main/quotaPolling.js";

describe("quota polling policy", () => {
  test("pauses polling when the five hour quota is exhausted or visually full", () => {
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: 0 } })).toBe(true);
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: 99 } })).toBe(true);
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: 54 } })).toBe(false);
  });

  test("keeps polling while the five hour quota is unknown", () => {
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: null } })).toBe(false);
  });

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
});
