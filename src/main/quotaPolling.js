const MAX_UNCHANGED_POLLS = 5;

export function nextQuotaPollingState(previousState, snapshot, options = {}) {
  const signature = quotaSignature(snapshot);
  const unchangedCount = !options.resetUnchanged && signature && signature === previousState?.signature
    ? (previousState.unchangedCount ?? 0) + 1
    : 1;

  return {
    signature,
    unchangedCount,
    paused: unchangedCount >= MAX_UNCHANGED_POLLS,
  };
}

function quotaSignature(snapshot) {
  const fiveHour = snapshot?.fiveHour?.remainingPercent;
  const weekly = snapshot?.weekly?.remainingPercent;
  if (!Number.isFinite(fiveHour) && !Number.isFinite(weekly)) return null;
  return `${fiveHour ?? "unknown"}/${weekly ?? "unknown"}`;
}
