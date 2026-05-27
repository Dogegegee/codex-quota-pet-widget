export function shouldPauseQuotaPolling(snapshot) {
  const remaining = snapshot?.fiveHour?.remainingPercent;
  return remaining === 0 || remaining === 99;
}
