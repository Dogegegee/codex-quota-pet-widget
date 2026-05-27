import { describe, expect, test } from "vitest";
import {
  calculateWidgetWindowBounds,
  extractAvatarOverlayState,
} from "../src/main/codexState.js";

describe("Codex avatar state", () => {
  test("extracts native pet mascot bounds from Codex global state", () => {
    const state = extractAvatarOverlayState({
      "electron-avatar-overlay-open": true,
      "electron-avatar-overlay-bounds": {
        x: 800,
        y: 600,
        width: 180,
        height: 120,
        mascot: { left: 20, top: 30, width: 80, height: 64 },
      },
    });

    expect(state.isOpen).toBe(true);
    expect(state.mascotBounds).toEqual({ x: 820, y: 630, width: 80, height: 64 });
  });

  test("places the narrow quota widget beside the native pet", () => {
    const bounds = calculateWidgetWindowBounds(
      { x: 100, y: 200, width: 72, height: 64 },
      { width: 44, height: 92 },
      { x: 0, y: 0, width: 400, height: 400 },
    );

    expect(bounds).toEqual({ x: 180, y: 186, width: 44, height: 92 });
  });

  test("places the widget outside the native overlay window when the pet window would cover it", () => {
    const bounds = calculateWidgetWindowBounds(
      { x: 81, y: 851, width: 113, height: 122 },
      { width: 48, height: 96 },
      { x: 0, y: 0, width: 1920, height: 1040 },
      null,
      { x: 1, y: 661, width: 356, height: 320 },
    );

    expect(bounds).toEqual({ x: 365, y: 864, width: 48, height: 96 });
  });
});
