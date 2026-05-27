import { describe, expect, test } from "vitest";
import { shouldPauseQuotaPolling } from "../src/main/quotaPolling.js";

describe("quota polling policy", () => {
  test("pauses polling when the five hour quota is exhausted or visually full", () => {
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: 0 } })).toBe(true);
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: 99 } })).toBe(true);
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: 54 } })).toBe(false);
  });

  test("keeps polling while the five hour quota is unknown", () => {
    expect(shouldPauseQuotaPolling({ fiveHour: { remainingPercent: null } })).toBe(false);
  });
});
