const MAX_UNCHANGED_POLLS = 5;

export function shouldPauseQuotaPolling(snapshot) {
  const remaining = snapshot?.fiveHour?.remainingPercent;
  return remaining === 0 || remaining === 99;
}

export function nextQuotaPollingState(previousState, snapshot) {
  const signature = quotaSignature(snapshot);
  const unchangedCount = signature && signature === previousState?.signature
    ? (previousState.unchangedCount ?? 0) + 1
    : 1;

  return {
    signature,
    unchangedCount,
    paused: shouldPauseQuotaPolling(snapshot) || unchangedCount >= MAX_UNCHANGED_POLLS,
  };
}

function quotaSignature(snapshot) {
  const fiveHour = snapshot?.fiveHour?.remainingPercent;
  const weekly = snapshot?.weekly?.remainingPercent;
  if (!Number.isFinite(fiveHour) && !Number.isFinite(weekly)) return null;
  return `${fiveHour ?? "unknown"}/${weekly ?? "unknown"}`;
}
