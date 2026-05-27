import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { combinedStatus } from "../shared/quota.js";
import "./styles.css";

const PERIOD_RING_PATH =
  "M 8 1 A 7 7 0 0 1 15 8 V 34 A 7 7 0 0 1 8 41 A 7 7 0 0 1 1 34 V 8 A 7 7 0 0 1 8 1";
const WEEK_LABEL = "\u5468";
const UNKNOWN_LABEL = "\u672a\u77e5";
const RING_RADIUS = 7;
const RING_VERTICAL = 26;
const RING_QUARTER = (Math.PI * RING_RADIUS) / 2;
const RING_LENGTH = RING_VERTICAL * 2 + RING_QUARTER * 4;

window.addEventListener("error", (event) => {
  console.error("renderer-error", event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("renderer-unhandled", event.reason?.message ?? String(event.reason));
});

function App() {
  const [state, setState] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      const next = await window.quotaWidget.getState();
      if (mounted) setState(next);
    }
    refresh();
    const unsubscribe = window.quotaWidget.onStateChanged?.((next) => {
      if (mounted) setState(next);
    });
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      mounted = false;
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, []);

  const displayState =
    state ?? {
      status: "unknown",
      fiveHour: { remainingPercent: null, tone: "unknown", windowProgressPercent: null },
      weekly: { remainingPercent: null, tone: "unknown", windowProgressPercent: null },
    };

  const status = useMemo(
    () => combinedStatus(displayState.fiveHour.remainingPercent, displayState.weekly.remainingPercent),
    [displayState.fiveHour.remainingPercent, displayState.weekly.remainingPercent],
  );

  return (
    <button
      type="button"
      className={`quota-widget ${status.tone}`}
      title={titleForState(displayState)}
      tabIndex={-1}
    >
      <div className="bars" aria-label="Codex quota">
        <QuotaBar quota={displayState.fiveHour} shortLabel="5H" kind="five" />
        <QuotaBar quota={displayState.weekly} shortLabel={WEEK_LABEL} kind="week" />
      </div>
    </button>
  );
}

function QuotaBar({ quota, shortLabel, kind }) {
  const value = Number.isFinite(quota.remainingPercent) ? quota.remainingPercent : 0;
  const period = Number.isFinite(quota.windowProgressPercent) ? quota.windowProgressPercent : 0;
  const text = Number.isFinite(quota.remainingPercent) ? String(quota.remainingPercent) : "--";
  const periodPath = progressPathForPeriod(period);

  return (
    <span className={`quota-card ${quota.tone} ${kind}`} style={{ "--fill": `${value}%` }}>
      <span className="bar-label">{shortLabel}</span>
      <b className="bar-track">
        <svg className="period-svg" viewBox="0 0 16 42" preserveAspectRatio="none" aria-hidden="true">
          <path className="period-rail" d={PERIOD_RING_PATH} pathLength="100" />
          {periodPath ? <path className="period-progress" d={periodPath} /> : null}
        </svg>
        <span />
      </b>
      <em>{text}</em>
    </span>
  );
}

function progressPathForPeriod(percent) {
  let remaining = (clamp(percent, 0, 100) / 100) * RING_LENGTH;
  if (remaining <= 0) return "";

  let path = "M 8 1";

  function consumeArc(cx, cy, fromAngle, toAngle) {
    const length = Math.abs(toAngle - fromAngle) * RING_RADIUS;
    const take = Math.min(remaining, length);
    const direction = Math.sign(toAngle - fromAngle);
    const angle = fromAngle + direction * (take / RING_RADIUS);
    const x = cx + RING_RADIUS * Math.cos(angle);
    const y = cy + RING_RADIUS * Math.sin(angle);
    path += ` A 7 7 0 0 1 ${formatPoint(x)} ${formatPoint(y)}`;
    remaining -= take;
    return take === length;
  }

  function consumeLine(x, y, from, length) {
    const take = Math.min(remaining, length);
    const nextY = y > from ? from + take : from - take;
    path += ` L ${x} ${formatPoint(nextY)}`;
    remaining -= take;
    return take === length;
  }

  if (!consumeArc(8, 8, -Math.PI / 2, 0)) return path;
  if (!consumeLine(15, 34, 8, RING_VERTICAL)) return path;
  if (!consumeArc(8, 34, 0, Math.PI / 2)) return path;
  if (!consumeArc(8, 34, Math.PI / 2, Math.PI)) return path;
  if (!consumeLine(1, 8, 34, RING_VERTICAL)) return path;
  consumeArc(8, 8, Math.PI, (Math.PI * 3) / 2);
  return path;
}

function formatPoint(value) {
  return Number(value.toFixed(2));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function titleForState(state) {
  const five = state.fiveHour.remainingPercent ?? UNKNOWN_LABEL;
  const week = state.weekly.remainingPercent ?? UNKNOWN_LABEL;
  return `Codex \u989d\u5ea6\uff1a5 \u5c0f\u65f6 ${five}% / ${WEEK_LABEL} ${week}%`;
}

createRoot(document.getElementById("root")).render(<App />);
