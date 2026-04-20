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

  const elapsedSec = Math.max(Math.floor((nowMs - previousUpdatedAt) / 1000), 0);
  if (elapsedSec <= 0) {
    return;
  }

  const adjustedCountdown = Math.max(previousCountdown - elapsedSec, 0);
  const extraDowntime = Math.max(elapsedSec - previousCountdown, 0);
  const allowDowntime = plan === 0 || actual < plan;
  const totalDowntime = allowDowntime ? previousDowntime + extraDowntime : previousDowntime;

  let expected = 0;
  if (firstScanAtMs > 0) {
    const expectedElapsedSec = Math.max(Math.floor((nowMs - firstScanAtMs) / 1000), 0);
    expected = Math.floor(expectedElapsedSec / cycleTimeSec);
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

