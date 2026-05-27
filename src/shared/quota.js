export function normalizeRateLimits(rateLimits, now = new Date()) {
  const fiveHourLimit = findLimit(rateLimits, "primary", 300);
  const weeklyLimit = findLimit(rateLimits, "secondary", 10080);

  return {
    status: fiveHourLimit || weeklyLimit ? "ok" : "unknown",
    syncedAt: now.toISOString(),
    fiveHour: normalizeLimit("5h", "5h", fiveHourLimit, now),
    weekly: normalizeLimit("week", "week", weeklyLimit, now),
  };
}

export function remainingFromUsed(usedPercent) {
  if (!Number.isFinite(usedPercent)) return null;
  return clamp(Math.round(100 - usedPercent), 0, 100);
}

export function toneForRemaining(remainingPercent) {
  if (!Number.isFinite(remainingPercent)) return "unknown";
  if (remainingPercent <= 20) return "low";
  if (remainingPercent <= 50) return "watch";
  return "safe";
}

export function combinedStatus(fiveHourRemaining, weeklyRemaining) {
  const values = [fiveHourRemaining, weeklyRemaining].filter(Number.isFinite);
  if (values.length === 0) return { tone: "unknown" };
  const min = Math.min(...values);
  if (min <= 20) return { tone: "low" };
  if (min <= 50) return { tone: "watch" };
  return { tone: "safe" };
}

function normalizeLimit(id, label, limit, now) {
  const resetSeconds = limit?.resets_at ?? limit?.reset_at;
  const windowMinutes = Number.isFinite(limit?.window_minutes) ? limit.window_minutes : null;
  const windowState = normalizeWindow(now, resetSeconds, windowMinutes);
  const rawUsedPercent = Number.isFinite(limit?.used_percent) ? clamp(Math.round(limit.used_percent), 0, 100) : null;
  const usedPercent = windowState.didRollOver ? 0 : rawUsedPercent;
  const remainingPercent = remainingFromUsed(usedPercent);

  return {
    id,
    label,
    remainingPercent,
    usedPercent,
    windowMinutes,
    resetsAt: windowState.resetsAt,
    windowProgressPercent: windowState.progressPercent,
    tone: toneForRemaining(remainingPercent),
  };
}

function normalizeWindow(now, resetSeconds, windowMinutes) {
  if (!Number.isFinite(resetSeconds) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return { didRollOver: false, resetsAt: null, progressPercent: null };
  }

  const resetMs = resetSeconds * 1000;
  const durationMs = windowMinutes * 60 * 1000;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return { didRollOver: false, resetsAt: null, progressPercent: null };

  if (nowMs >= resetMs) {
    const cyclesElapsed = Math.floor((nowMs - resetMs) / durationMs) + 1;
    const currentStartMs = resetMs + ((cyclesElapsed - 1) * durationMs);
    const nextResetMs = resetMs + (cyclesElapsed * durationMs);
    return {
      didRollOver: true,
      resetsAt: new Date(nextResetMs).toISOString(),
      progressPercent: clamp(Math.round(((nowMs - currentStartMs) / durationMs) * 100), 0, 100),
    };
  }

  const startMs = resetMs - durationMs;
  return {
    didRollOver: false,
    resetsAt: new Date(resetMs).toISOString(),
    progressPercent: clamp(Math.round(((nowMs - startMs) / durationMs) * 100), 0, 100),
  };
}

function findLimit(rateLimits, preferredKey, windowMinutes) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const preferred = rateLimits[preferredKey];
  if (preferred && typeof preferred === "object") return preferred;
  return Object.values(rateLimits).find((value) => value?.window_minutes === windowMinutes) ?? null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
