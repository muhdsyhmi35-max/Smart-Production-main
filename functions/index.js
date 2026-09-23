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

// Keeps countdown advancing even when no browser is open.
// Does not zero Expected when firstScanAtMs is missing — that made TVs show Delay = Actual.
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
  const previousUpdatedAt = toInt(state.updatedAt, nowMs);
  const firstScanAtMs = toInt(state.firstScanAtMs, 0);
  const lastScanAtMs = toInt(state.lastScanAtMs, 0);
  const startedAtMs = toInt(state.startedAtMs, 0);

  const elapsedSec = Math.max(Math.floor((nowMs - previousUpdatedAt) / 1000), 0);
  if (elapsedSec <= 0 && lastScanAtMs <= 0) {
    return;
  }

  let adjustedCountdown;
  if (lastScanAtMs > 0) {
    const idleSec = Math.max(Math.floor((nowMs - lastScanAtMs) / 1000), 0);
    adjustedCountdown = Math.max(cycleTimeSec - idleSec, 0);
  } else {
    adjustedCountdown = Math.max(previousCountdown - elapsedSec, 0);
  }

  const patch = {
    countdown: adjustedCountdown,
    lastScanAtMs: lastScanAtMs || null,
    updatedAt: nowMs
  };

  const expectedAnchor = firstScanAtMs > 0 ? firstScanAtMs : (startedAtMs > 0 ? startedAtMs : 0);
  if (expectedAnchor > 0) {
    let expected = Math.floor(Math.max(nowMs - expectedAnchor, 0) / 1000 / cycleTimeSec);
    if (plan > 0) {
      expected = Math.min(expected, plan);
    }
    patch.expected = expected;
    patch.delay = actual - expected;
    patch.balance = actual - plan;
    patch.firstScanAtMs = firstScanAtMs || null;
  }

  await liveRef.update(patch);
});
