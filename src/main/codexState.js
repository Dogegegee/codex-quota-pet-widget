import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getCodexHome() {
  return path.join(os.homedir(), ".codex");
}

export function getCodexGlobalStatePath(codexHome = getCodexHome()) {
  return path.join(codexHome, ".codex-global-state.json");
}

export function readCodexGlobalState(filePath = getCodexGlobalStatePath()) {
  try {
    return parseCodexGlobalState(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function parseCodexGlobalState(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return parseAvatarOverlayFields(raw);
  }
}

export function extractAvatarOverlayState(globalState) {
  const isOpen = globalState?.["electron-avatar-overlay-open"] === true;
  if (!isOpen) {
    return { isOpen: false, placement: null, overlayBounds: null, mascotBounds: null, trayBounds: null };
  }

  const bounds = globalState?.["electron-avatar-overlay-bounds"];
  const anchor = bounds?.anchor;
  const mascot = bounds?.mascot;
  if (!isRect(anchor) && !(isRect(bounds) && isSizeRect(mascot))) {
    return {
      isOpen: true,
      placement: bounds?.placement ?? null,
      overlayBounds: isRect(bounds)
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : null,
      mascotBounds: null,
      trayBounds: null,
    };
  }

  const mascotBounds = isRect(anchor)
    ? { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
    : {
        x: bounds.x + mascot.left,
        y: bounds.y + mascot.top,
        width: mascot.width,
        height: mascot.height,
      };

  return {
    isOpen: true,
    placement: bounds?.placement ?? null,
    overlayBounds: isRect(bounds)
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null,
    mascotBounds,
    trayBounds: isRect(bounds) && isSizeRect(bounds?.tray)
      ? {
          x: bounds.x + bounds.tray.left,
          y: bounds.y + bounds.tray.top,
          width: bounds.tray.width,
          height: bounds.tray.height,
        }
      : null,
  };
}

export function calculateWidgetWindowBounds(
  mascotBounds,
  widgetSize = { width: 44, height: 92 },
  screenArea,
  trayBounds = null,
  overlayBounds = null,
) {
  const area = {
    x: screenArea.x ?? 0,
    y: screenArea.y ?? 0,
    width: screenArea.width,
    height: screenArea.height,
  };
  const gap = 8;
  const preferred = {
    x: mascotBounds.x + mascotBounds.width + gap,
    y: mascotBounds.y + Math.round((mascotBounds.height - widgetSize.height) / 2),
    width: widgetSize.width,
    height: widgetSize.height,
  };
  if (!intersects(preferred, trayBounds) && !intersects(preferred, overlayBounds)) {
    return normalizeBounds(preferred, area, widgetSize);
  }

  const outsideOverlay = overlayBounds
    ? {
        x: overlayBounds.x + overlayBounds.width + gap,
        y: preferred.y,
        width: widgetSize.width,
        height: widgetSize.height,
      }
    : null;
  if (outsideOverlay && !intersects(outsideOverlay, trayBounds)) {
    return normalizeBounds(outsideOverlay, area, widgetSize);
  }

  return normalizeBounds(
    {
      x: mascotBounds.x + mascotBounds.width + gap,
      y: Math.max(mascotBounds.y, (trayBounds?.y ?? mascotBounds.y) + (trayBounds?.height ?? 0) + gap),
      width: widgetSize.width,
      height: widgetSize.height,
    },
    area,
    widgetSize,
  );
}

function parseAvatarOverlayFields(raw) {
  const isOpenMatch = raw.match(/"electron-avatar-overlay-open"\s*:\s*(true|false)/);
  const boundsKey = `"electron-avatar-overlay-bounds"`;
  const boundsKeyIndex = raw.indexOf(boundsKey);
  const open = isOpenMatch?.[1] === "true";
  if (boundsKeyIndex === -1) return { "electron-avatar-overlay-open": open };

  const objectStart = raw.indexOf("{", boundsKeyIndex + boundsKey.length);
  const objectEnd = findMatchingBrace(raw, objectStart);
  if (objectStart === -1 || objectEnd === -1) return { "electron-avatar-overlay-open": open };

  try {
    return {
      "electron-avatar-overlay-open": open,
      "electron-avatar-overlay-bounds": JSON.parse(raw.slice(objectStart, objectEnd + 1)),
    };
  } catch {
    return { "electron-avatar-overlay-open": open };
  }
}

function findMatchingBrace(raw, startIndex) {
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

function normalizeBounds(candidate, area, widgetSize) {
  return {
    x: clamp(Math.round(candidate.x), area.x, Math.max(area.x, area.x + area.width - widgetSize.width)),
    y: clamp(Math.round(candidate.y), area.y, Math.max(area.y, area.y + area.height - widgetSize.height)),
    width: widgetSize.width,
    height: widgetSize.height,
  };
}

function intersects(a, b) {
  if (b == null) return false;
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}


function isRect(value) {
  return (
    value != null &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  );
}

function isSizeRect(value) {
  return (
    value != null &&
    Number.isFinite(value.left) &&
    Number.isFinite(value.top) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
