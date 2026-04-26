/* ================= SYSTEM SETTINGS ================= */

const SETTINGS = {
  defaultCycle: 16,
  defaultPlan: 1,

  breakTime: {
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
  }
};

/* ===== VARIABLES ===== */

let ramadanMode = false;
let timer = null;
let countdownValue = 0;
let actualCount = 0;
let downtimeSeconds = 0;
let lastScanTime = null;
let startTime = null;
let firstScanAtMs = null;
let isDowntime = false;
let pendingChassis = "";
let pendingModel = "";
let pendingEngine = "";
let pendingKey = "";
let scannedChassis = new Set();
let scannedModel = new Set();
let scannedEngine = new Set();
let scannedKey = new Set();
let duplicateLock = false;
let lastUpdateTime = 0;
let lastTableData = "";
let breakPauseStartMs = null;
let firebaseDb = null;
let firebaseCommandRef = null;
let firebaseLiveStateRef = null;
let isApplyingRemoteCommand = false;
let hasLocalSession = false;
let liveCountdownInterval = null;
const syncClientId = localStorage.getItem("SYNC_CLIENT_ID") || ("SYNC-" + Math.random().toString(36).slice(2));
localStorage.setItem("SYNC_CLIENT_ID", syncClientId);

/* ================= GOOGLE SHEET MIRROR LAYER ================= */

// 🔴 GANTI DENGAN LINK /exec WEB APP ANDA
const API_URL = "https://script.google.com/macros/s/AKfycbwwLUYjoT7GH0sfFCGZMJoeLApmPWWKEF5LsdNqvkRpstZjerG9d3zG78bh0RTA1Fu48Q/exec";

// Detect monitor mode (?monitor)
const isMonitor = window.location.search.includes("monitor");
const FIREBASE_COMMAND_PATH = "production/commands/latest";
const FIREBASE_LIVE_STATE_PATH = "production/liveState";
const FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyBFKY6pmz_1UPAmozY65aMnWr0n7Mdka8I",
  authDomain: "monitoring-system-61d36.firebaseapp.com",
  databaseURL: "https://monitoring-system-61d36-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "monitoring-system-61d36",
  storageBucket: "monitoring-system-61d36.firebasestorage.app",
  messagingSenderId: "86698501028",
  appId: "1:86698501028:web:797943828913de2e6d1731",
  measurementId: "G-SCSMT5BDZB"
};

/* ===== FORMAT ===== */

function format(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return (m < 10 ? "0" + m : m) + ":" + (sec < 10 ? "0" + sec : sec);
}

function parseMmSsToSeconds(text) {
  if (text == null || text === "") return 0;
  const t = String(text).trim();
  if (!t || t === "00:00" || t === "0:00") return 0;

  if (!isNaN(t)) {
    const sec = parseInt(t, 10);
    return Number.isFinite(sec) ? Math.max(sec, 0) : 0;
  }

  const sheetDateLike = t.includes("1899") || t.includes("1900");
  if (sheetDateLike) {
    const timeMatch = t.match(/T(\d{2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
      const m = parseInt(timeMatch[2], 10);
      const s = parseInt(timeMatch[3], 10);
      if ([m, s].every(Number.isFinite)) {
        return Math.max((m * 60) + s, 0);
      }
    }
  }

  const parts = t.split(/[:.]/).map(v => parseInt(v, 10));
  if (parts.some(v => !Number.isFinite(v))) return 0;

  if (parts.length === 2) {
    const [m, s] = parts;
    return Math.max((m * 60) + s, 0);
  }

  if (parts.length >= 3) {
    const [a, b, c] = parts;
    if (a >= 60 && c === 0) {
      return Math.max((a * 60) + b, 0);
    }
    return Math.max((a * 3600) + (b * 60) + c, 0);
  }

  return 0;
}

function sumDowntimeFromVisibleRows() {
  const table = document.getElementById("scanTable");
  if (!table) return 0;

  let total = 0;
  Array.from(table.rows).forEach(tr => {
    const statusCell = tr.cells[7];
    const downtimeCell = tr.cells[8];
    if (!statusCell || !downtimeCell) return;
    if (statusCell.innerText.trim() !== "DOWN TIME") return;
    const cleaned = cleanDowntime(downtimeCell.innerText || "");
    downtimeCell.innerText = cleaned;
    total += parseMmSsToSeconds(cleaned);
  });
  return total;
}

function refreshDowntimeCardStrict() {
  const total = sumDowntimeFromVisibleRows();
  downtimeSeconds = total;
  document.getElementById("downtime").innerText = format(total);
}

/* ===== DATE TIME ===== */

function updateDateTime() {
  const now = new Date();

  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  };

  document.getElementById("dateDisplay").innerText =
    now.toLocaleDateString("en-MY", options);

  document.getElementById("clock").innerText =
    now.toLocaleTimeString("en-MY");
}

/* ================= STRICT GLOBAL LOCK ================= */

async function checkAccess() {
  // ✅ Allow monitor screen
  if (window.location.search.includes("monitor")) {
    return true;
  }

  // Restore one-device lock using Apps Script lock endpoints.
  let deviceId = localStorage.getItem("DEVICE_ID");
  if (!deviceId) {
    deviceId = "DEV-" + Math.random().toString(36).substring(2);
    localStorage.setItem("DEVICE_ID", deviceId);
  }

  try {
    const res = await fetch(API_URL + "?checkLock=true");
    const data = await res.json();

    if (data.lock) {
      document.body.innerHTML = `
        <h1 style="
          color:red;
          text-align:center;
          margin-top:100px;
          font-size:40px;
        ">
          SYSTEM ALREADY OPEN ON ANOTHER SCREEN
        </h1>
      `;
      return false;
    }

    await fetch(API_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        lockRequest: true,
        deviceId: deviceId
      })
    });
  } catch (err) {
    console.log("Lock error:", err);
  }

  return true;
}

/* ===== RAMADAN + BREAK ===== */

function isBreakTime() {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();

  let breaks = [];

  if (ramadanMode) {
    if (day === 5) {
      breaks = SETTINGS.breakTime.ramadan.friday;
    } else {
      breaks = SETTINGS.breakTime.ramadan.weekday;
    }
  } else if (day === 5) {
    breaks = SETTINGS.breakTime.normal.friday;
  } else {
    breaks = SETTINGS.breakTime.normal.weekday;
  }

  for (const b of breaks) {
    if (current >= b.start && current < b.end) {
      return true;
    }
  }

  return false;
}

function calculateExpectedOutput() {
  if (isMonitor) return 0;
  if (!firstScanAtMs) {
    return timer ? 1 : 0;
  }
  if (!timer) {
    return actualCount;
  }

  // ✅ STOP expected when target achieved
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  if (actualCount >= plan && plan > 0) {
    return plan;
  }

  const now = new Date();
  const elapsedSec = Math.floor((now.getTime() - firstScanAtMs) / 1000);

  const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;

  // 🚫 Tolak break time
  let breakSeconds = 0;
  const tempTime = new Date(firstScanAtMs);

  while (tempTime < now) {
    if (isBreakTime()) {
      breakSeconds += 60;
    }
    tempTime.setMinutes(tempTime.getMinutes() + 1);
  }

  let netTime = elapsedSec - breakSeconds;
  if (netTime < 0) netTime = 0;

  let expected = Math.floor(netTime / cycleTimeSec);
  if (plan > 0) {
    expected = Math.min(expected, plan);
  }

  // Start expected from 1 once production is active.
  expected = Math.max(expected, 1);

  // 🔥 START SHOW AFTER FIRST SCAN
  if (actualCount > 0 && expected === 0) {
    expected = 1;
  }

  return expected;
}

function calculateAvailabilityPercent() {
  let expected = calculateExpectedOutput();
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  if (plan > 0) {
    expected = Math.min(expected, plan);
  }
  if (expected <= 0) return 0;

  return Math.floor((actualCount / expected) * 100);
}

/* ===== STATUS ===== */

function setStatus(text, color) {
  const el = document.getElementById("status");
  el.innerText = text;
  el.className = "big-number " + color;
}

function initFirebaseSync() {
  if (!window.firebase || !window.firebase.database) {
    console.warn("Firebase SDK not loaded.");
    return false;
  }

  if (!FIREBASE_CONFIG.databaseURL || !FIREBASE_CONFIG.apiKey || !FIREBASE_CONFIG.projectId) {
    console.warn("Firebase config is incomplete. Fill FIREBASE_CONFIG first.");
    return false;
  }

  if (!firebase.apps.length) {
    firebase.initializeApp(FIREBASE_CONFIG);
  }

  firebaseDb = firebase.database();
  firebaseCommandRef = firebaseDb.ref(FIREBASE_COMMAND_PATH);
  firebaseLiveStateRef = firebaseDb.ref(FIREBASE_LIVE_STATE_PATH);

  firebaseCommandRef.on("value", snapshot => {
    const command = snapshot.val();
    if (!command || !command.action) return;
    if (command.sender === syncClientId) return;
    applyRemoteCommand(command.action);
  });

  if (isMonitor) {
    firebaseLiveStateRef.on("value", snapshot => {
      const liveState = snapshot.val();
      if (!liveState) return;
      applyLiveState(liveState);
    });
  }

  return true;
}

function publishSyncCommand(action) {
  if (!firebaseCommandRef || isApplyingRemoteCommand) return;

  firebaseCommandRef.set({
    action: action,
    sender: syncClientId,
    sentAt: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    console.log("Firebase command publish error:", err);
  });
}

function publishLiveStateToFirebase(state) {
  if (!firebaseLiveStateRef) return;

  firebaseLiveStateRef.set({
    ...state,
    sender: syncClientId,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    console.log("Firebase live state publish error:", err);
  });
}

function stopLiveCountdownTicker() {
  if (liveCountdownInterval) {
    clearInterval(liveCountdownInterval);
    liveCountdownInterval = null;
  }
}

function startLiveCountdownTicker(baseCountdown, status, updatedAt) {
  stopLiveCountdownTicker();

  const countdownEl = document.getElementById("countdown");
  if (!countdownEl) return;

  // Main operator screen uses its own production timer logic.
  if (!isMonitor) {
    countdownValue = baseCountdown;
    countdownEl.innerText = format(baseCountdown);
    return;
  }

  if (status !== "RUNNING") {
    countdownValue = baseCountdown;
    countdownEl.innerText = format(baseCountdown);
    return;
  }

  const syncedAt = Number(updatedAt) || Date.now();

  const render = () => {
    const elapsedSec = Math.floor((Date.now() - syncedAt) / 1000);
    const adjusted = Math.max(baseCountdown - elapsedSec, 0);
    countdownValue = adjusted;
    countdownEl.innerText = format(adjusted);
  };

  render();
  liveCountdownInterval = setInterval(render, 1000);
}

function restoreProductionTimerFromLiveState(status, countdown, expected, syncedFirstScanAtMs, syncedUpdatedAt, syncedLastScanAtMs) {
  if (isMonitor) return;
  if (status !== "RUNNING" && status !== "DOWN TIME") return;
  if (timer) return;

  const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const nowMs = Date.now();
  let adjustedCountdown = parseInt(countdown, 10) || 0;
  let missedDowntimeSec = 0;
  let elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);

  if (syncedLastScanAtMs) {
    const elapsedSinceLastScanSec = Math.max(Math.floor((nowMs - Number(syncedLastScanAtMs)) / 1000), 0);
    adjustedCountdown = Math.max(cycleTimeSec - elapsedSinceLastScanSec, 0);
    missedDowntimeSec = Math.max(elapsedSinceLastScanSec - cycleTimeSec, 0);
    elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);
  } else {
    const syncedAtMs = Number(syncedUpdatedAt) || nowMs;
    const elapsedSinceSyncSec = Math.max(Math.floor((nowMs - syncedAtMs) / 1000), 0);
    const syncedCountdown = parseInt(countdown, 10) || 0;
    adjustedCountdown = Math.max(syncedCountdown - elapsedSinceSyncSec, 0);
    missedDowntimeSec = Math.max(elapsedSinceSyncSec - syncedCountdown, 0);
    elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);
  }
  const elapsedForExpected = Math.max((parseInt(expected, 10) || 0) * cycleTimeSec, 0);
  const now = new Date();
  const reconstructedBaseTime = new Date(now.getTime() - (elapsedInCycle * 1000));
  const reconstructedFirstScanAtMs = now.getTime() - (elapsedForExpected + elapsedInCycle) * 1000;

  // Expected output is locked to first scan time.
  if (syncedFirstScanAtMs) {
    firstScanAtMs = Number(syncedFirstScanAtMs);
  } else if (!firstScanAtMs) {
    firstScanAtMs = reconstructedFirstScanAtMs;
  }

  if (actualCount > 0) {
    lastScanTime = syncedLastScanAtMs ? new Date(Number(syncedLastScanAtMs)) : reconstructedBaseTime;
  }

  // Catch up downtime that happened while browser was closed/refreshed.
  if (missedDowntimeSec > 0 && (plan === 0 || actualCount < plan)) {
    downtimeSeconds += missedDowntimeSec;
    isDowntime = true;
  }

  countdownValue = adjustedCountdown;

  // Mark as active session and resume real downtime logic.
  hasLocalSession = true;
  startProduction(false);
}

function applyLiveState(state) {
  const plan = parseInt(state.plan, 10) || 0;
  const dailyPlan = parseInt(state.dailyPlan, 10) || plan;
  const cycleTimeMin = parseFloat(state.cycleTimeMin) || (parseFloat(document.getElementById("cycleTarget").value) || SETTINGS.defaultCycle);
  const actual = parseInt(state.actual, 10) || 0;
  const balance = parseInt(state.balance, 10) || 0;
  const status = state.status || "READY";
  const totalDowntime = parseInt(state.totalDowntime, 10) || 0;
  const countdown = parseInt(state.countdown, 10) || 0;
  const expected = parseInt(state.expected, 10) || 0;
  const delay = parseInt(state.delay, 10) || 0;
  const efficiency = parseInt(state.efficiency, 10) || 0;
  const lotNo = state.lotNo || "";

  // Keep local variables aligned so refresh doesn't revert values.
  actualCount = actual;
  downtimeSeconds = totalDowntime;
  firstScanAtMs = state.firstScanAtMs ? Number(state.firstScanAtMs) : firstScanAtMs;

  const effEl = document.getElementById("efficiency");
  effEl.innerText = efficiency + "%";

  if (efficiency < 90) {
    effEl.className = "big-number status-red";
  } else if (efficiency < 100) {
    effEl.className = "big-number status-orange";
  } else {
    effEl.className = "big-number status-green";
  }

  document.getElementById("plan").innerText = plan;
  if (!isMonitor) {
    document.getElementById("dailyPlanTarget").value = dailyPlan;
    document.getElementById("cycleTarget").value = cycleTimeMin;
  }
  const lotInput = document.getElementById("lotInput");
  if (lotInput) {
    lotInput.value = lotNo;
  }
  document.getElementById("actual").innerText = actual;
  startLiveCountdownTicker(countdown, status, state.updatedAt);
  refreshDowntimeCardStrict();
  document.getElementById("expected").innerText = expected;
  if (state.lastScanAtMs) {
    lastScanTime = new Date(Number(state.lastScanAtMs));
  }
  restoreProductionTimerFromLiveState(status, countdown, expected, state.firstScanAtMs, state.updatedAt, state.lastScanAtMs);

  const balanceEl = document.getElementById("balance");
  if (balance < 0) {
    balanceEl.className = "big-number status-red";
    balanceEl.innerText = balance;
  } else if (balance > 0) {
    balanceEl.className = "big-number status-green";
    balanceEl.innerText = "+" + balance;
  } else {
    balanceEl.className = "big-number status-blue";
    balanceEl.innerText = "0";
  }

  const delayEl = document.getElementById("delay");
  delayEl.className = "big-number";

  if (delay < 0) {
    delayEl.classList.add("status-red");
  } else if (delay > 0) {
    delayEl.classList.add("status-green");
  } else {
    delayEl.classList.add("status-blue");
  }

  delayEl.innerText = delay > 0 ? ("+" + delay) : delay;

  const downtimeCard = document.getElementById("downtimeCard");
  const downtimeText = document.getElementById("downtime");

  if (status === "DOWN TIME") {
    setStatus("DOWN TIME", "status-red blink");
    downtimeCard.classList.add("downtime-alert", "blink");
    downtimeText.classList.add("status-red", "blink");
  } else if (status === "RUNNING") {
    setStatus("RUNNING", "status-green pulse");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  } else if (status === "TARGET ACHIEVED") {
    setStatus("TARGET ACHIEVED", "status-green");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  } else if (status === "BEHIND SCHEDULE") {
    setStatus("BEHIND SCHEDULE", "status-red blink");
  } else if (status === "BREAK TIME") {
    setStatus("BREAK TIME", "status-orange");
  } else if (status === "PAUSED") {
    setStatus("PAUSED", "status-orange");
  } else {
    setStatus(status, "status-blue");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  }
}

function loadInitialLiveState() {
  if (!firebaseLiveStateRef) return;

  firebaseLiveStateRef.once("value")
    .then(snapshot => {
      const liveState = snapshot.val();
      if (!liveState) return;
      applyLiveState(liveState);
    })
    .catch(err => console.log("Firebase initial live state error:", err));
}

function applyRemoteCommand(action) {
  isApplyingRemoteCommand = true;

  if (action === "start") {
    startProduction(false);
  } else if (action === "stop") {
    stopProduction(false);
  } else if (action === "reset") {
    resetProduction(false);
  }

  isApplyingRemoteCommand = false;
}

/* ===== START ===== */

function startProduction(shouldSync = true) {
  if (isMonitor) return;
  if (timer) return;

  hasLocalSession = true;

  if (shouldSync) {
    publishSyncCommand("start");
  }

  // Set start time if first run
  if (!startTime) {
    startTime = new Date();
  }

  // If no scan yet, set initial countdown
  if (countdownValue === 0) {
    countdownValue = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  }

  timer = setInterval(() => {
    if (isBreakTime()) {
      if (breakPauseStartMs == null) {
        breakPauseStartMs = Date.now();
      }
      setStatus("BREAK TIME", "status-orange");
      updateDisplay();
      return;
    }

    if (breakPauseStartMs != null) {
      const breakPausedMs = Math.max(Date.now() - breakPauseStartMs, 0);
      if (lastScanTime) {
        lastScanTime = new Date(lastScanTime.getTime() + breakPausedMs);
      } else if (startTime) {
        startTime = new Date(startTime.getTime() + breakPausedMs);
      }
      breakPauseStartMs = null;
    }

    const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;

    // 🔥 USE REAL TIME (FIXED)
    const now = new Date();

    // use startTime if no scan yet
    const baseTime = lastScanTime || startTime;

    const diff = Math.floor((now - baseTime) / 1000);
    countdownValue = Math.max(cycleTimeSec - diff, 0);
    const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;

    if (countdownValue === 0) {
      isDowntime = true;
      // Accumulate downtime every second while line is late (before target reached).
      if (actualCount < plan || plan === 0) {
        downtimeSeconds += 1;
      }
    } else {
      isDowntime = false;
    }

    updateDisplay();
  }, 1000);
}

/* STOP */
function stopProduction(shouldSync = true) {
  hasLocalSession = true;

  if (shouldSync) {
    publishSyncCommand("stop");
  }

  clearInterval(timer);
  timer = null;
  breakPauseStartMs = null;
  setStatus("PAUSED", "status-orange");
}

/* RESET */
function resetProduction(shouldSync = true) {
  hasLocalSession = true;

  if (shouldSync) {
    publishSyncCommand("reset");
  }

  clearInterval(timer);
  timer = null;
  countdownValue = 0;
  actualCount = 0;
  downtimeSeconds = 0;
  lastScanTime = null;
  startTime = null;
  firstScanAtMs = null;
  breakPauseStartMs = null;
  pendingChassis = "";
  pendingModel = "";
  pendingEngine = "";
  pendingKey = "";
  scannedChassis.clear();
  scannedModel.clear();
  scannedEngine.clear();
  scannedKey.clear();
  isDowntime = false;
  duplicateLock = false;
  document.getElementById("scanTable").innerHTML = "";

  setStatus("READY", "status-blue");
  updateDisplay();
  updateLiveStateOnly();
}

/* ===== SCAN CHASSIS ===== */

document.getElementById("chassisInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    const value = this.value.trim();

    /* DUPLICATE CHECK */
    if (scannedChassis.has(value)) {
      duplicateLock = true;
      setStatus("DUPLICATE CHASSIS", "status-red blink");
      this.value = "";
      return;
    }

    duplicateLock = false;
    pendingChassis = value;
    scannedChassis.add(value);

    this.value = "";
    document.getElementById("modelInput").focus();
  }
});

/* ===== SCAN MODEL ===== */

document.getElementById("modelInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    if (pendingChassis === "") return;

    const model = this.value.trim();

    duplicateLock = false;
    pendingModel = model;
    scannedModel.add(model);

    this.value = "";
    document.getElementById("engineInput").focus();
  }
});

/* ===== SCAN ENGINE NO ===== */

document.getElementById("engineInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    if (pendingModel === "") return;

    const value = this.value.trim();

    /* DUPLICATE CHECK */
    if (scannedEngine.has(value)) {
      duplicateLock = true;
      setStatus("DUPLICATE ENGINE", "status-red blink");
      this.value = "";
      return;
    }

    duplicateLock = false;
    pendingEngine = value;
    scannedEngine.add(value);

    this.value = "";
    document.getElementById("keyInput").focus();
  }
});

/* ===== SCAN KEY ===== */

document.getElementById("keyInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    if (pendingChassis === "" || pendingModel === "" || pendingEngine === "") return;

    const key = this.value.trim();

    /* ===== DUPLICATE CHECK KEY ===== */
    if (scannedKey.has(key)) {
      duplicateLock = true;
      setStatus("DUPLICATE KEY", "status-red blink");
      this.value = "";
      return;
    }

    duplicateLock = false;

    pendingKey = key;
    scannedKey.add(key);

    /* --- START COUNTDOWN ONLY AFTER ALL 4 SCANS COMPLETE --- */
    if (!timer) {
      startProduction();
    }

    const chassis = pendingChassis;
    const model = pendingModel;
    const engine = pendingEngine;
    const lot = document.getElementById("lotInput").value || "-";

    const now = new Date();
    const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;

    let downtimeEvent = "";

    if (lastScanTime) {
      const diffSec = Math.floor((now - lastScanTime) / 1000);

      if (diffSec > cycleTimeSec) {
        const actualDowntime = diffSec - cycleTimeSec;
        const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;

        // ✅ ONLY BEFORE TARGET
        if ((actualCount + 1) <= plan) {
          downtimeEvent = format(actualDowntime);
          isDowntime = true;
        } else {
          downtimeEvent = "";
          isDowntime = false;
        }

        // ✅ TRIGGER STATUS
        isDowntime = true;
      } else {
        // ✅ TAK DOWNTIME
        isDowntime = false;
      }
    } else {
      isDowntime = false;
    }

    lastScanTime = now;
    if (!firstScanAtMs) {
      firstScanAtMs = now.getTime();
    }

    const row = document.getElementById("scanTable").insertRow(0);

    row.insertCell(0).innerText = now.toLocaleDateString();
    row.insertCell(1).innerText = now.toLocaleTimeString();
    row.insertCell(2).innerText = lot;
    row.insertCell(3).innerText = model;
    row.insertCell(4).innerText = chassis;
    row.insertCell(5).innerText = engine;
    row.insertCell(6).innerText = key;

    const statusCell = row.insertCell(7);
    const downtimeCell = row.insertCell(8);

    if (downtimeEvent) {
      statusCell.innerText = "DOWN TIME";
      statusCell.classList.add("status-red");
      downtimeCell.innerText = downtimeEvent;
      downtimeCell.classList.add("status-red");
    } else {
      statusCell.innerText = "SCANNED";
      statusCell.classList.add("status-green");
    }

    // One completed 4-scan cycle = one actual unit.
    actualCount++;
    hasLocalSession = true;
    countdownValue = cycleTimeSec;
    isDowntime = false;

    updateDisplay();

    sendToSheet(
      chassis,
      model,
      engine,
      key,
      lot,
      statusCell.innerText,
      downtimeEvent
    );

    pendingChassis = "";
    pendingModel = "";
    pendingEngine = "";
    pendingKey = "";

    this.value = "";

    setTimeout(() => {
      document.getElementById("chassisInput").focus();
    }, 50);
  }
});

/* ===== UPDATE DISPLAY ===== */

function updateDisplay() {
  if (isMonitor) return;
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const balance = actualCount - plan;
  const displayBalance = balance > 0 ? ("+" + balance) : balance;

  // EXPECTED CALCULATION
  let expected = calculateExpectedOutput();

  // ✅ FORCE CORRECT LOGIC AFTER TARGET
  if (actualCount >= plan && plan > 0) {
    expected = plan;
  }
  const delay = actualCount - expected;
  const delayEl = document.getElementById("delay");

  delayEl.className = "big-number";

  if (delay < 0) {
    delayEl.classList.add("status-red");
  } else if (delay > 0) {
    delayEl.classList.add("status-green");
  } else {
    delayEl.classList.add("status-blue");
  }

  delayEl.innerText = delay > 0 ? ("+" + delay) : delay;

  const efficiency = calculateAvailabilityPercent();

  const effEl = document.getElementById("efficiency");
  effEl.innerText = efficiency + "%";

  if (efficiency < 90) {
    effEl.className = "big-number status-red";
  } else if (efficiency < 100) {
    effEl.className = "big-number status-orange";
  } else {
    effEl.className = "big-number status-green";
  }

  // Display Expected
  document.getElementById("expected").innerText = expected;
  document.getElementById("plan").innerText = plan;
  document.getElementById("actual").innerText = actualCount;
  document.getElementById("countdown").innerText = format(countdownValue);
  refreshDowntimeCardStrict();

  const balanceEl = document.getElementById("balance");
  if (balance < 0) { balanceEl.className = "big-number status-red"; }
  else if (balance > 0) { balanceEl.className = "big-number status-green"; }
  else { balanceEl.className = "big-number status-blue"; }
  balanceEl.innerText = displayBalance;
  if (delay < 0) {
    setStatus("BEHIND SCHEDULE", "status-red blink");
  }

  /* ================= LOGIK STATUS BARU ================= */
  if (isBreakTime()) {
    setStatus("BREAK TIME", "status-orange");
  } else if (duplicateLock) {
    setStatus("DUPLICATE SCAN", "status-red blink");
  } else if (isDowntime) {
    setStatus("DOWN TIME", "status-red blink");
  } else if (actualCount >= plan && plan > 0) {
    clearInterval(timer); timer = null; countdownValue = 0; isDowntime = false;
    setStatus("TARGET ACHIEVED", "status-green");
  } else if (pendingChassis !== "" && pendingModel === "") {
    setStatus("WAITING MODEL", "status-orange");
  } else if (pendingModel !== "" && pendingEngine === "") {
    setStatus("WAITING ENGINE", "status-orange");
  } else if (pendingEngine !== "" && pendingKey === "") {
    setStatus("WAITING KEY", "status-orange");
  } else if (timer) {
    setStatus("RUNNING", "status-green pulse");
  } else {
    setStatus("READY", "status-blue");
  }

  const downtimeCard = document.getElementById("downtimeCard");
  const downtimeText = document.getElementById("downtime");
  if (isDowntime) {
    downtimeCard.classList.add("downtime-alert", "blink");
    downtimeText.classList.add("status-red", "blink");
  } else {
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  }
}

/* ===== DAILY SUMMARY ===== */

function openSummary() {
  const plan = parseInt(document.getElementById("plan").innerText, 10) || 0;
  const actual = parseInt(document.getElementById("actual").innerText, 10) || 0;
  const downtime = document.getElementById("downtime").innerText;
  const diff = actual - plan;
  const diffDisplay = diff > 0 ? ("+" + diff) : diff;

  // Ambil semua baris dari jadual papan pemuka
  const rows = document.querySelectorAll("#scanTable tr");
  let tableRows = "";

  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length > 0) {
      const statusCell = cells[7];
      const downtimeCell = cells[8];

      let statusClass = "";
      if (statusCell.classList.contains("status-red")) {
        statusClass = "status-red";
      } else if (statusCell.classList.contains("status-green")) {
        statusClass = "status-green";
      }

      let downtimeClass = "";
      if (downtimeCell.classList.contains("status-red")) {
        downtimeClass = "status-red";
      }

      tableRows += `
<tr>
<td>${cells[0].innerText}</td> <td>${cells[1].innerText}</td> <td>${cells[2].innerText}</td> <td>${cells[3].innerText}</td> <td>${cells[4].innerText}</td> <td>${cells[5].innerText}</td> <td>${cells[6].innerText}</td> <td class="${statusClass}">${cells[7].innerText}</td> <td class="${downtimeClass}">${cells[8].innerText}</td> </tr>`;
    }
  });

  const htmlContent = `
<html>
<head>
<title>Daily Summary Report</title>
<style>
body{
margin:0;
font-family:'Segoe UI',sans-serif;
background:#0b1220;
color:#e5e7eb;
padding:40px;
}
h1{
text-align:center;
color:#60a5fa;
margin-bottom:30px;
font-size:36px;
font-weight: 800;
}
.summary-card {
    border-radius: 20px;
    background: #111827;
    width: 450px;
    margin: 0 auto 50px auto;
    padding: 10px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
}
.summary-table{
width:100%;
border-collapse:collapse;
}
.summary-table th,
.summary-table td{
padding:14px;
text-align:center;
}
.summary-table th{
background:#1f2937;
color:#60a5fa;
font-weight:bold;
text-align: left;
width: 50%;
border-radius: 10px 0 0 10px;
}
.summary-table td {
    font-size: 18px;
    font-weight: bold;
}
.detail-table-container {
    background: #111827;
    border-radius: 15px;
    padding: 10px;
    overflow: hidden;
    box-shadow: 0 4px 6px rgba(0,0,0,0.3);
}
table.detail-table{
width:100%;
border-collapse:collapse;
}
.detail-table th, .detail-table td{
padding:12px;
text-align:center;
border-bottom: 1px solid #1f2937;
font-size: 14px;
}
.detail-table th{
background:#1f2937;
color:#60a5fa;
font-weight:bold;
text-transform: uppercase;
}
.detail-table tr:last-child td {
    border-bottom: none;
}
.detail-table tr:nth-child(even){
background:#0f172a;
}
.status-green{
color:#22c55e !important;
font-weight:bold;
}
.status-red{
color:#ef4444 !important;
font-weight:bold;
}
.action-buttons{
text-align:center;
margin-top:40px;
}
.action-buttons button{
padding:12px 28px;
margin:0 12px;
border:none;
border-radius:30px;
font-size:15px;
font-weight:bold;
cursor:pointer;
background:#2563eb;
color:white;
transition: background 0.2s;
}
.action-buttons button:hover{
background:#1d4ed8;
}
@media print{
body{
background:white !important;
color:black !important;
padding:20px !important;
}
h1{ color: black !important; }
.summary-card, .detail-table-container {
background:white !important;
color:black !important;
box-shadow:none !important;
border: 1px solid #ccc;
}
.summary-table th, .detail-table th {
background:#f0f0f0 !important;
color:black !important;
border: 1px solid #ccc !important;
}
.summary-table td, .detail-table td{
color:black !important;
border:1px solid #ccc !important;
}
.status-green{
color:#22c55e !important;
-webkit-print-color-adjust: exact;
print-color-adjust: exact;
}
.status-red{
color:#ef4444 !important;
-webkit-print-color-adjust: exact;
print-color-adjust: exact;
}
.action-buttons{ display:none !important; }
}
</style>
</head>
<body>
<h1>DAILY SUMMARY REPORT</h1>
<div class="summary-card">
<table class="summary-table">
<tr>
<th>Date</th>
<td>${new Date().toLocaleDateString()}</td>
</tr>
<tr>
<th>Plan</th>
<td>${plan}</td>
</tr>
<tr>
<th>Actual</th>
<td>${actual}</td>
</tr>
<tr>
<th>Difference</th>
<td>${diffDisplay}</td>
</tr>
<tr>
<th>Total Downtime</th>
<td class="${downtime !== "00:00" ? "status-red" : ""}">${downtime}</td>
</tr>
<tr>
<th>Total Units Scanned</th>
<td>${actual}</td>
</tr>
</table>
</div>
<div class="detail-table-container">
<table class="detail-table">
<thead>
<tr>
<th>Date</th>
<th>Time</th>
<th>Lot</th>
<th>Model</th>
<th>Chassis</th>
<th>Engine No</th>
<th>Key No</th>
<th>Status</th>
<th>Downtime</th>
</tr>
</thead>
<tbody>
${tableRows}
</tbody>
</table>
</div>
<div class="action-buttons">
<button onclick="window.print()">Print Report / Save PDF</button>
<button onclick="window.opener.downloadExcel()">Download Excel</button>
</div>
</body>
</html>
`;

  // Buka tetingkap laporan baru
  const newWindow = window.open();
  newWindow.document.write(htmlContent);
  newWindow.document.close();
}

/* ===== EXCEL ===== */

function downloadExcel() {
  const wb = XLSX.utils.book_new();
  const data = [["Date", "Time", "Lot", "Model", "Chassis", "Engine No", "Key No", "Status", "Downtime"]];

  document.querySelectorAll("#scanTable tr").forEach(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length > 0) {
      data.push([
        cells[0].innerText,
        cells[1].innerText,
        cells[2].innerText,
        cells[3].innerText,
        cells[4].innerText,
        cells[5].innerText,
        cells[6].innerText,
        cells[7].innerText,
        cells[8].innerText
      ]);
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(data);

  for (let i = 1; i < data.length; i++) {
    const cell = "E" + (i + 1);
    if (ws[cell]) {
      if (ws[cell].v === "DOWN TIME") {
        ws[cell].s = { font: { color: { rgb: "FF0000" }, bold: true } };
      }
      if (ws[cell].v === "SCANNED") {
        ws[cell].s = { font: { color: { rgb: "00AA00" }, bold: true } };
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, "Daily Report");
  XLSX.writeFile(wb, "Daily_Summary_Report.xlsx");
}

/* ===== FULL SCREEN ===== */

function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

/* ===== RAMADHAN TOGGLE ===== */

function toggleRamadan() {
  ramadanMode = !ramadanMode;

  const btn = document.getElementById("ramadanToggle");

  if (ramadanMode) {
    btn.innerText = "🌙 Ramadhan : ON";
    btn.style.background = "#16a34a";
  } else {
    btn.innerText = " 🌙 Ramadhan : OFF";
    btn.style.background = "#2563eb";
  }

  updateDisplay();
}

function updateLiveStateOnly() {
  if (isMonitor) return;
  if (!hasLocalSession) return;

  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const cycleTimeMin = parseFloat(document.getElementById("cycleTarget").value) || SETTINGS.defaultCycle;
  const actual = actualCount;

  let expected = calculateExpectedOutput();
  if (plan > 0) {
    expected = Math.min(expected, plan);
  }
  let delay = actual - expected;

  // Efficiency card now represents Availability (%), not attainment.
  const efficiency = calculateAvailabilityPercent();

  const balance = actual - plan;
  const status = document.getElementById("status").innerText.trim();
  const lotNo = document.getElementById("lotInput").value || "";

  fetch(API_URL, {
    method: "POST",
    mode: "no-cors",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      liveOnly: true,
      plan: plan,
      dailyPlan: plan,
      cycleTimeMin: cycleTimeMin,
      actual: actual,
      balance: balance,
      status: status,
      countdown: countdownValue,
      totalDowntime: downtimeSeconds,
      expected: expected,
      delay: delay,
      efficiency: efficiency
    })
  });

  publishLiveStateToFirebase({
    plan: plan,
    dailyPlan: plan,
    cycleTimeMin: cycleTimeMin,
    actual: actual,
    balance: balance,
    lotNo: lotNo,
    status: status,
    countdown: countdownValue,
    totalDowntime: downtimeSeconds,
    expected: expected,
    delay: delay,
    efficiency: efficiency,
    firstScanAtMs: firstScanAtMs,
    lastScanAtMs: lastScanTime ? lastScanTime.getTime() : null
  });
}

function sendToSheet(chassis, model, engine, key, lot, status, downtimeEvent) {
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const actual = actualCount;
  const balance = actual - plan;

  fetch(API_URL, {
    method: "POST",
    mode: "no-cors",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      lot: lot,
      model: model,
      chassis: chassis,
      engine: engine,
      key: key,
      status: status,
      plan: plan,
      actual: actual,
      balance: balance,
      downtimeEvent: downtimeEvent,
      totalDowntime: downtimeSeconds,
      countdown: countdownValue
    })
  })
    .catch(err => console.log("Sheet error:", err));
}

function cleanDowntime(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return format(Math.max(0, Math.floor(raw)));
  }
  const sec = parseMmSsToSeconds(String(raw));
  return format(sec);
}

/** Prefer explicit downtime-event headers; avoid totals/accumulators. */
function resolveDowntimeEventColumnIndex(scanHeader) {
  const exact = [
    "downtimeevent",
    "downtime event",
    "downtime_event",
    "downtime (event)",
    "downtime duration"
  ];
  for (const c of exact) {
    const i = scanHeader.indexOf(c);
    if (i >= 0) return i;
  }
  for (let i = 0; i < scanHeader.length; i++) {
    const h = scanHeader[i];
    if (!h || !h.includes("downtime")) continue;
    if (/total|accum|sum|cumulative|running/i.test(h)) continue;
    return i;
  }
  return -1;
}

function resolveDowntimeCandidateIndices(scanHeader) {
  const out = [];
  for (let i = 0; i < scanHeader.length; i++) {
    const h = scanHeader[i];
    if (!h || !h.includes("downtime")) continue;
    if (/total|accum|sum|cumulative|running/i.test(h)) continue;
    out.push(i);
  }
  return out;
}

function pickBestDowntimeValue(row, primaryIdx, candidateIdxs, legacyLayout) {
  if (legacyLayout) return row[7] || "";

  const seen = new Set();
  const idxsToCheck = [];
  if (primaryIdx >= 0) idxsToCheck.push(primaryIdx);
  candidateIdxs.forEach(i => idxsToCheck.push(i));

  // If multiple downtime columns exist, pick smallest non-zero value
  // to avoid selecting cumulative totals (e.g. 11:35 vs event 00:07).
  let bestRaw = "";
  let bestSec = Number.POSITIVE_INFINITY;
  idxsToCheck.forEach(i => {
    if (i < 0 || seen.has(i)) return;
    seen.add(i);
    const raw = row[i];
    if (raw == null || String(raw).trim() === "") return;
    const sec = parseMmSsToSeconds(String(raw));
    if (sec > 0 && sec < bestSec) {
      bestSec = sec;
      bestRaw = raw;
    }
  });
  if (bestRaw !== "") return bestRaw;

  // If only zero-like values exist (e.g. 00:00), still prefer explicit primary.
  if (primaryIdx >= 0) {
    const primaryRaw = row[primaryIdx];
    if (primaryRaw != null && String(primaryRaw).trim() !== "") return primaryRaw;
  }

  // Legacy fallback index for old sheet layouts.
  return row[7] || "";
}

// Ambil data untuk MONITOR PC
function loadLiveData() {
  fetch(API_URL, { cache: "no-store" })
    .then(res => res.json())
    .then(data => {
      const now = Date.now();
      if (now - lastUpdateTime < 1000) return;
      lastUpdateTime = now;

      // ✅ Scan table stays from Google Sheet only
      if (!data || !data.scan || data.scan.length <= 1) {
        return;
      }

      const scanRows = data.scan.slice(1);
      const scanHeader = (data.scan[0] || []).map(v =>
        String(v || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ")
      );
      const getIdx = (...candidates) => {
        for (const c of candidates) {
          const i = scanHeader.indexOf(c);
          if (i >= 0) return i;
        }
        return -1;
      };
      const idxLot = getIdx("lot", "lot no", "lotno");
      const idxModel = getIdx("model");
      const idxChassis = getIdx("chassis");
      const idxEngine = getIdx("engine", "engine no", "engine no.");
      const idxKey = getIdx("key", "key no", "key no.");
      const idxStatus = getIdx("status", "state");
      const idxDowntime = resolveDowntimeEventColumnIndex(scanHeader);
      const downtimeCandidateIdxs = resolveDowntimeCandidateIndices(scanHeader);
      const legacyLayout = idxStatus < 0;
      const table = document.getElementById("scanTable");

      // Convert to string for comparison
      const newTableData = JSON.stringify(scanRows);

      if (newTableData !== lastTableData) {
        lastTableData = newTableData;

        table.innerHTML = "";

        scanRows.reverse().forEach(row => {
          const newRow = table.insertRow();

          const fullDateTime = new Date(row[0]);
          newRow.insertCell(0).innerText = fullDateTime.toLocaleDateString("en-GB");
          newRow.insertCell(1).innerText = fullDateTime.toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
          }).toLowerCase();

          newRow.insertCell(2).innerText = legacyLayout
            ? (row[1] || "-")
            : idxLot >= 0
              ? (row[idxLot] || "-")
              : "-";
          newRow.insertCell(3).innerText = legacyLayout
            ? (row[2] || "-")
            : idxModel >= 0
              ? (row[idxModel] || "-")
              : "-";
          newRow.insertCell(4).innerText = legacyLayout
            ? (row[3] || "-")
            : idxChassis >= 0
              ? (row[idxChassis] || "-")
              : "-";
          newRow.insertCell(5).innerText = legacyLayout
            ? (row[4] || "-")
            : idxEngine >= 0
              ? (row[idxEngine] || "-")
              : "-";
          newRow.insertCell(6).innerText = legacyLayout
            ? (row[5] || "-")
            : idxKey >= 0
              ? (row[idxKey] || "-")
              : "-";

          const statusCell = newRow.insertCell(7);
          const statusText = legacyLayout ? (row[6] || "") : idxStatus >= 0 ? (row[idxStatus] || "") : "";
          statusCell.innerText = statusText;

          if (statusText === "SCANNED") statusCell.className = "status-green";
          if (statusText === "DOWN TIME") statusCell.className = "status-red";

          const downtimeCell = newRow.insertCell(8);

          if (statusText === "DOWN TIME") {
            const rawDowntime = pickBestDowntimeValue(row, idxDowntime, downtimeCandidateIdxs, legacyLayout);
            downtimeCell.innerText = cleanDowntime(rawDowntime);
            downtimeCell.className = "status-red";
          } else {
            downtimeCell.innerText = "";
          }
        });
        refreshDowntimeCardStrict();
      }
      refreshDowntimeCardStrict();
    })
    .catch(err => console.log("Monitor load error:", err));
}

/* ===== INITIALIZE SYSTEM ===== */

document.getElementById("cycleTarget").value = SETTINGS.defaultCycle;
document.getElementById("dailyPlanTarget").value = SETTINGS.defaultPlan;

document.getElementById("cycleTarget").addEventListener("input", () => {
  if (!timer) {
    countdownValue = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  }
  hasLocalSession = true;
  updateDisplay();
  updateLiveStateOnly();
});

document.getElementById("dailyPlanTarget").addEventListener("input", () => {
  hasLocalSession = true;
  updateDisplay();
  updateLiveStateOnly();
});

document.getElementById("lotInput").addEventListener("input", () => {
  hasLocalSession = true;
  updateLiveStateOnly();
});

window.onload = async function() {
  // 🔐 MUST WAIT ACCESS CHECK
  const allowed = await checkAccess();
  if (!allowed) return;

  updateDateTime();
  setInterval(updateDateTime, 1000);
  initFirebaseSync();
  loadInitialLiveState();

  if (isMonitor) {
    document.body.classList.add("monitor-mode");

    document.getElementById("chassisInput").style.display = "none";
    document.getElementById("modelInput").style.display = "none";
    document.getElementById("engineInput").style.display = "none";
    document.getElementById("keyInput").style.display = "none";

    loadLiveData();
    setInterval(loadLiveData, 1000);
  } else {
    // Reload scan history from Sheet after refresh (main screen).
    loadLiveData();
    setInterval(loadLiveData, 3000);
    setInterval(updateLiveStateOnly, 1000);
  }
};
