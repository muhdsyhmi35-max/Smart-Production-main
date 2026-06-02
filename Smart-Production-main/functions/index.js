const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();
const db = admin.database();

const LIVE_STATE_PATH = "production/liveState";

function toInt(value, fallback = 0) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function toNum(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const BREAK_TIME = {
  normal: {
    weekday: [
      { start: 600, end: 620 },
      { start: 780, end: 840 }
    ],
    friday: [
      { start: 600, end: 620 },
      { start: 750, end: 870 }
    ]
  },
  ramadan: {
    weekday: [
      { start: 600, end: 610 },
      { start: 780, end: 830 }
    ],
    friday: [
      { start: 600, end: 610 },
      { start: 750, end: 860 }
    ]
  }
};

function getBreakWindowsForLocalDate(d, ramadanMode) {
  const day = d.getDay(); // 0..6 (0=Sun, 5=Fri)
  if (ramadanMode) {
    return day === 5 ? BREAK_TIME.ramadan.friday : BREAK_TIME.ramadan.weekday;
  }
  return day === 5 ? BREAK_TIME.normal.friday : BREAK_TIME.normal.weekday;
}

/** Seconds of scheduled break in [startMs, endMs] (local calendar). */
function scheduledBreakOverlapSec(startMs, endMs, ramadanMode) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  let totalMs = 0;
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard++ < 14) {
    const dayStart = new Date(cursor);
    dayStart.setHours(0, 0, 0, 0);
    const dayStartMs = dayStart.getTime();
    const nextDayMs = dayStartMs + 86400000;
    if (dayStartMs >= endMs) break;

    const windows = getBreakWindowsForLocalDate(dayStart, ramadanMode);
    for (const w of windows) {
      const segStart = dayStartMs + w.start * 60000;
      const segEnd = dayStartMs + w.end * 60000;
      const lo = Math.max(startMs, segStart);
      const hi = Math.min(endMs, segEnd);
      if (hi > lo) totalMs += hi - lo;
    }
    cursor = nextDayMs;
  }
  return Math.floor(totalMs / 1000);
}

// Keeps countdown/downtime advancing even when no browser is open.
exports.tickProductionClock = onSchedule("every 1 minutes", async () => {
  const nowMs = Date.now();
  const liveRef = db.ref(LIVE_STATE_PATH);
  const snap = await liveRef.get();

  if (!snap.exists()) {
    return;
  }

  const state = snap.val() || {};
  const status = String(state.status || "READY");
  const ramadanMode = !!state.ramadanMode;
  if (status !== "RUNNING") {
    return;
  }

  const plan = toInt(state.dailyPlan ?? state.plan, 0);
  const actual = toInt(state.actual, 0);
  const cycleTimeMin = toNum(state.cycleTimeMin, 0);
  const cycleTimeSec = Math.max(Math.floor(cycleTimeMin * 60), 1);

  const previousCountdown = Math.max(toInt(state.countdown, cycleTimeSec), 0);
  const previousDowntime = Math.max(toInt(state.totalDowntime, 0), 0);
  const previousUpdatedAt = toInt(state.updatedAt, nowMs);
  const firstScanAtMs = toInt(state.firstScanAtMs, 0);
  const lastScanAtMs = toInt(state.lastScanAtMs, 0);

  // Operator PC publishes live state every second while running — do not overwrite it.
  const sender = String(state.sender || "");
  const operatorFreshMs = nowMs - previousUpdatedAt;
  if (sender.startsWith("SYNC-") && operatorFreshMs < 180000) {
    return;
  }

  const elapsedSec = Math.max(Math.floor((nowMs - previousUpdatedAt) / 1000), 0);
  if (elapsedSec <= 0) {
    return;
  }

  // Scheduled breaks should pause both the countdown and downtime accrual.
  const breakSecInInterval = scheduledBreakOverlapSec(previousUpdatedAt, nowMs, ramadanMode);
  const productiveElapsedSec = Math.max(elapsedSec - breakSecInInterval, 0);

  const adjustedCountdown = Math.max(previousCountdown - productiveElapsedSec, 0);
  const extraDowntime = Math.max(productiveElapsedSec - previousCountdown, 0);
  const allowDowntime = plan === 0 || actual < plan;
  const totalDowntime = allowDowntime ? previousDowntime + extraDowntime : previousDowntime;

  let expected = 0;
  if (firstScanAtMs > 0) {
    const expectedElapsedSec = Math.max(Math.floor((nowMs - firstScanAtMs) / 1000), 0);
    const breakSecFromFirstScan = scheduledBreakOverlapSec(firstScanAtMs, nowMs, ramadanMode);
    const netExpectedElapsedSec = Math.max(0, expectedElapsedSec - breakSecFromFirstScan);
    expected = Math.floor(netExpectedElapsedSec / cycleTimeSec);
    if (plan > 0) {
      expected = Math.min(expected, plan);
    }
  }

  const delay = actual - expected;
  const balance = actual - plan;
  const efficiency = expected > 0 ? Math.floor((actual / expected) * 100) : 0;

  await liveRef.update({
    countdown: adjustedCountdown,
    totalDowntime: totalDowntime,
    expected: expected,
    delay: delay,
    balance: balance,
    efficiency: efficiency,
    firstScanAtMs: firstScanAtMs || null,
    lastScanAtMs: lastScanAtMs || null,
    updatedAt: nowMs
  });
});

