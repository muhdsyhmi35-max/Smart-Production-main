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
/** null = rolling local \"today\" for downtime total; else YYYY-MM-DD for a specific day. */
let downtimeFilterDate = null;
/** null = today in graph filters; else YYYY-MM-DD. */
let graphFilterDate = null;
let graphPeriod = "day";
let graphRangeStartDate = null;
let graphRangeEndDate = null;
/** null = today in history filter; else YYYY-MM-DD. */
let historyFilterDate = null;
/** null = today in summary filter; else YYYY-MM-DD. */
let summaryFilterDate = null;
let downtimeFilterExpanded = false;
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
let efficiencyPercent = 0;
let breakPauseStartMs = null;
let pauseStartMs = null;
let lastTimerTickMs = null;
const DEBUG_DOWNTIME = false;
let firebaseDb = null;
let firebaseCommandRef = null;
let firebaseLiveStateRef = null;
let isApplyingRemoteCommand = false;
let hasLocalSession = false;
let liveCountdownInterval = null;
let monitorDowntimeOverrideSec = null;
let monitorFirebaseNetConnected = false;
let monitorLiveStateReceived = false;
let monitorLiveStateError = null;
let initialLiveStateLoaded = false;
const firebaseSessionStartedAt = Date.now();
const LOCAL_LIVE_STATE_KEY = "TF2_LIVE_STATE_SNAPSHOT";
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

function setMonitorConnectionStatus(isConnected) {
  if (!isMonitor) return;
  monitorFirebaseNetConnected = !!isConnected;
  const badge = document.getElementById("monitorConnectionStatus");
  if (!badge) return;
  badge.textContent = isConnected ? "LIVE" : "DISCONNECTED";
  badge.classList.toggle("offline", !isConnected);
  updateMonitorDataNotice();
}

/** Explains empty monitor KPIs: offline, permission denied, or main PC not publishing yet. */
function updateMonitorDataNotice() {
  if (!isMonitor) return;

  let bar = document.getElementById("monitorDataNotice");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "monitorDataNotice";
    bar.className = "monitor-data-notice";
    const header = document.querySelector(".header");
    if (header && header.parentNode) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  let msg = "";
  let show = true;
  if (monitorLiveStateError) {
    const code = monitorLiveStateError.code || "";
    msg = code === "PERMISSION_DENIED"
      ? "Firebase: permission denied reading production/liveState. Open Firebase Console → Realtime Database → Rules and allow .read on this path for monitors (or match how the main PC authenticates)."
      : ("Firebase: " + (monitorLiveStateError.message || String(monitorLiveStateError)));
  } else if (!monitorFirebaseNetConnected) {
    msg = "Cannot reach Firebase (check internet). KPIs update when the connection is restored.";
  } else if (!monitorLiveStateReceived) {
    msg = "Waiting for live data from the main PC. There the operator must open this app (without ?monitor), start/use production so values publish to Firebase. This URL must end with ?monitor.";
  } else {
    show = false;
  }

  bar.style.display = show ? "block" : "none";
  bar.textContent = msg;
}

/* ===== FORMAT ===== */

function format(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return (m < 10 ? "0" + m : m) + ":" + (sec < 10 ? "0" + sec : sec);
}

function toIsoDateLocal(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function getActiveDowntimeDayKey() {
  if (downtimeFilterDate) return downtimeFilterDate;
  return toIsoDateLocal(new Date());
}

/** Map table Date cell (e.g. DD/MM/YYYY) to YYYY-MM-DD for filtering. */
function parseDisplayDateToIsoKey(dateText) {
  const t = String(dateText || "").trim();
  if (!t) return null;
  const dm = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dm) {
    const d0 = dm[1].padStart(2, "0");
    const m0 = dm[2].padStart(2, "0");
    return `${dm[3]}-${m0}-${d0}`;
  }
  const ms = Date.parse(t);
  if (Number.isFinite(ms)) return toIsoDateLocal(new Date(ms));
  return null;
}

function syncDowntimeDayPickerUi() {
  const el = document.getElementById("downtimeDayFilter");
  if (el) el.value = getActiveDowntimeDayKey();
}

function onDowntimeDayFilterChange() {
  const el = document.getElementById("downtimeDayFilter");
  if (!el) return;
  const v = (el.value || "").trim().slice(0, 10);
  const todayK = toIsoDateLocal(new Date());
  downtimeFilterDate = v && v !== todayK ? v : null;
  refreshDowntimeCardFromTable();
  if (!isMonitor) updateLiveStateOnly();
}

function onDowntimeDayTodayClick() {
  downtimeFilterDate = null;
  syncDowntimeDayPickerUi();
  refreshDowntimeCardFromTable();
  if (!isMonitor) updateLiveStateOnly();
}

function toggleDowntimeDateFilter(forceOpen) {
  const card = document.getElementById("downtimeCard");
  if (!card) return;
  if (typeof forceOpen === "boolean") {
    downtimeFilterExpanded = forceOpen;
  } else {
    downtimeFilterExpanded = !downtimeFilterExpanded;
  }
  card.classList.toggle("show-date-filter", downtimeFilterExpanded);
}

function getActiveGraphDayKey() {
  return graphFilterDate || toIsoDateLocal(new Date());
}

function syncGraphDayPickerUi() {
  const el = document.getElementById("graphDayFilter");
  if (el) el.value = getActiveGraphDayKey();
}

function onGraphDayFilterChange() {
  const el = document.getElementById("graphDayFilter");
  if (!el) return;
  const v = (el.value || "").trim().slice(0, 10);
  const todayK = toIsoDateLocal(new Date());
  graphFilterDate = v && v !== todayK ? v : null;
  renderGraphCharts();
}

function onGraphDayTodayClick() {
  graphFilterDate = null;
  syncGraphDayPickerUi();
  renderGraphCharts();
}

function getDayKeysBetween(startIso, endIso) {
  if (!startIso || !endIso) return [];
  const [sy, sm, sd] = String(startIso).split("-").map(v => parseInt(v, 10));
  const [ey, em, ed] = String(endIso).split("-").map(v => parseInt(v, 10));
  let cur = new Date(sy, (sm || 1) - 1, sd || 1);
  let end = new Date(ey, (em || 1) - 1, ed || 1);
  if (!Number.isFinite(cur.getTime()) || !Number.isFinite(end.getTime())) return [];
  if (cur > end) [cur, end] = [end, cur];
  const out = [];
  while (cur <= end) {
    out.push(toIsoDateLocal(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function getDefaultGraphRangeFromPeriod() {
  const anchor = getActiveGraphDayKey();
  const keys = getPeriodDayKeys(anchor, graphPeriod);
  if (!keys.length) return { start: anchor, end: anchor };
  return { start: keys[0], end: keys[keys.length - 1] };
}

function getActiveGraphRange() {
  if (graphRangeStartDate && graphRangeEndDate) {
    const keys = getDayKeysBetween(graphRangeStartDate, graphRangeEndDate);
    if (keys.length) return { start: keys[0], end: keys[keys.length - 1] };
  }
  return getDefaultGraphRangeFromPeriod();
}

function syncGraphRangePickerUi() {
  const startEl = document.getElementById("graphRangeStart");
  const endEl = document.getElementById("graphRangeEnd");
  const range = getActiveGraphRange();
  if (startEl) startEl.value = range.start;
  if (endEl) endEl.value = range.end;
}

function onGraphRangeFilterChange() {
  const startEl = document.getElementById("graphRangeStart");
  const endEl = document.getElementById("graphRangeEnd");
  if (!startEl || !endEl) return;
  const sv = (startEl.value || "").trim().slice(0, 10);
  const ev = (endEl.value || "").trim().slice(0, 10);
  if (!sv || !ev) return;
  const keys = getDayKeysBetween(sv, ev);
  if (!keys.length) return;
  graphRangeStartDate = keys[0];
  graphRangeEndDate = keys[keys.length - 1];
  graphFilterDate = graphRangeStartDate;
  syncGraphRangePickerUi();
  renderGraphCharts();
}

function onGraphRangeTodayClick() {
  const today = toIsoDateLocal(new Date());
  graphRangeStartDate = today;
  graphRangeEndDate = today;
  graphFilterDate = null;
  syncGraphRangePickerUi();
  renderGraphCharts();
}

function onGraphPeriodChange(period) {
  graphPeriod = (period === "week" || period === "month") ? period : "day";
  syncGraphPeriodButtonsUi();
  if (!graphRangeStartDate || !graphRangeEndDate) syncGraphRangePickerUi();
  renderGraphCharts();
}

function syncGraphPeriodButtonsUi() {
  const dayBtn = document.getElementById("graphPeriodDayBtn");
  const weekBtn = document.getElementById("graphPeriodWeekBtn");
  const monthBtn = document.getElementById("graphPeriodMonthBtn");
  [dayBtn, weekBtn, monthBtn].forEach(btn => btn && btn.classList.remove("active"));
  if (graphPeriod === "week" && weekBtn) weekBtn.classList.add("active");
  else if (graphPeriod === "month" && monthBtn) monthBtn.classList.add("active");
  else if (dayBtn) dayBtn.classList.add("active");
}

function getWeekStartIso(anchorIso) {
  const [y, m, d] = String(anchorIso).split("-").map(v => parseInt(v, 10));
  const dt = new Date(y, (m || 1) - 1, d || 1);
  const day = dt.getDay(); // 0 Sun .. 6 Sat
  const mondayOffset = day === 0 ? -6 : (1 - day);
  dt.setDate(dt.getDate() + mondayOffset);
  return toIsoDateLocal(dt);
}

function getPeriodDayKeys(anchorIso, period) {
  const [y, m, d] = String(anchorIso).split("-").map(v => parseInt(v, 10));
  const base = new Date(y, (m || 1) - 1, d || 1);
  const keys = [];
  if (period === "week") {
    const weekStartIso = getWeekStartIso(anchorIso);
    const [wy, wm, wd] = weekStartIso.split("-").map(v => parseInt(v, 10));
    const ws = new Date(wy, (wm || 1) - 1, wd || 1);
    for (let i = 0; i < 7; i++) {
      const dt = new Date(ws);
      dt.setDate(ws.getDate() + i);
      keys.push(toIsoDateLocal(dt));
    }
    return keys;
  }
  if (period === "month") {
    const start = new Date(base.getFullYear(), base.getMonth(), 1);
    const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    for (let i = 1; i <= end.getDate(); i++) {
      const dt = new Date(start.getFullYear(), start.getMonth(), i);
      keys.push(toIsoDateLocal(dt));
    }
    return keys;
  }
  return [anchorIso];
}

function getActiveSummaryDayKey() {
  return summaryFilterDate || toIsoDateLocal(new Date());
}

function syncSummaryDayPickerUi() {
  const el = document.getElementById("summaryDayFilter");
  if (el) el.value = getActiveSummaryDayKey();
}

function onSummaryDayFilterChange() {
  const el = document.getElementById("summaryDayFilter");
  if (!el) return;
  const v = (el.value || "").trim().slice(0, 10);
  const todayK = toIsoDateLocal(new Date());
  summaryFilterDate = v && v !== todayK ? v : null;
  showSummaryPage();
}

function onSummaryDayTodayClick() {
  summaryFilterDate = null;
  showSummaryPage();
}

function formatIsoDateAsDmy(isoDate) {
  const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(isoDate || "");
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (![y, mo, d].every(Number.isFinite)) return String(isoDate || "");
  return `${d}/${mo}/${y}`;
}

function formatIsoDateAsDdMmYy(isoDate) {
  const m = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(isoDate || "");
  const yy = String(parseInt(m[1], 10) % 100).padStart(2, "0");
  const mm = String(parseInt(m[2], 10)).padStart(2, "0");
  const dd = String(parseInt(m[3], 10)).padStart(2, "0");
  return `${dd}/${mm}/${yy}`;
}

function formatIsoRangeAsDdMmYy(startIso, endIso) {
  const startFmt = formatIsoDateAsDdMmYy(startIso);
  const endFmt = formatIsoDateAsDdMmYy(endIso);
  return startIso === endIso ? startFmt : `${startFmt} to ${endFmt}`;
}

function getActiveHistoryDayKey() {
  return historyFilterDate || toIsoDateLocal(new Date());
}

function syncHistoryDayPickerUi() {
  const el = document.getElementById("historyDayFilter");
  if (el) el.value = getActiveHistoryDayKey();
}

function applyHistoryDateFilter() {
  const table = document.getElementById("scanTable");
  if (!table) return;
  const dayKey = getActiveHistoryDayKey();
  let visibleNo = 1;
  Array.from(table.rows).forEach(tr => {
    const rowDay = tr.dataset.scanDate || parseDisplayDateToIsoKey(tr.cells[1]?.innerText);
    const show = !!rowDay && rowDay === dayKey;
    tr.style.display = show ? "" : "none";
    if (show) {
      const noCell = tr.cells[0];
      if (noCell) noCell.innerText = String(visibleNo++);
    }
  });
}

function onHistoryDayFilterChange() {
  const el = document.getElementById("historyDayFilter");
  if (!el) return;
  const v = (el.value || "").trim().slice(0, 10);
  const todayK = toIsoDateLocal(new Date());
  historyFilterDate = v && v !== todayK ? v : null;
  applyHistoryDateFilter();
}

function onHistoryDayTodayClick() {
  historyFilterDate = null;
  syncHistoryDayPickerUi();
  applyHistoryDateFilter();
}

/** Parse "MM:SS" (or "M:SS") from table / sheet display into seconds. */
function parseMmSsToSeconds(text) {
  if (text == null || text === "") return 0;
  const t = String(text).trim();
  if (!t || t === "00:00" || t === "0:00") return 0;

  // 66:46 / 66.46 / 66:46:00 / 66.46.00 / 1900-01-01T11:50:35.000Z / numeric seconds
  // Google Sheets duration cells can arrive as day fractions (e.g. 0.003472222 for 00:05).
  const numeric = Number(t);
  if (Number.isFinite(numeric)) {
    if (numeric > 0 && numeric < 1) {
      return Math.max(Math.round(numeric * 86400), 0);
    }
    return Math.max(Math.round(numeric), 0);
  }

  // Google Sheets date artifacts like 1899/1900 can be serialized as ISO strings.
  // Extract hh:mm:ss directly from the string to avoid timezone shifts.
  const sheetDateLike = t.includes("1899") || t.includes("1900");
  if (sheetDateLike) {
    const timeMatch = t.match(/T(\d{2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      const s = parseInt(timeMatch[3], 10);
      if ([h, m, s].every(Number.isFinite)) {
        // Some locales serialize duration 00:03 as 1899-12-29T17:07:35.000Z.
        // Decode by removing the legacy KL base offset (17:04:35) when detected.
        const total = (h * 3600) + (m * 60) + s;
        const klLegacyBase = (17 * 3600) + (4 * 60) + 35;
        const shifted = total - klLegacyBase;
        if (shifted >= 0 && shifted <= 12 * 3600) {
          // Legacy payload encodes each elapsed second as +1 minute tick
          // from the base (17:04:35). Convert back to real seconds.
          if (shifted % 60 === 0) return Math.floor(shifted / 60);
          return shifted;
        }

        // Fallback: keep MM:SS behavior for other sheet artifacts.
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
    // Some sheet durations arrive like 66.46.00 (intended 66:46).
    if (a >= 60 && c === 0) {
      return Math.max((a * 60) + b, 0);
    }
    return Math.max((a * 3600) + (b * 60) + c, 0);
  }

  return 0;
}

/** Sum downtime from rendered rows for DOWN TIME on the active downtime day only. */
function sumBookedDowntimeFromScanTable() {
  let total = 0;
  const table = document.getElementById("scanTable");
  if (!table) return 0;
  const dayKey = getActiveDowntimeDayKey();
  Array.from(table.rows).forEach(tr => {
    const rowDay = tr.dataset.scanDate || parseDisplayDateToIsoKey(tr.cells[1]?.innerText);
    if (!rowDay || rowDay !== dayKey) return;
    const downtimeCell = tr.cells[9];
    const statusCell = tr.cells[8];
    if (!downtimeCell || !statusCell) return;
    if (statusCell.innerText.trim() !== "DOWN TIME") return;
    const cleaned = cleanDowntime(downtimeCell.innerText || "");
    downtimeCell.innerText = cleaned;
    total += parseMmSsToSeconds(cleaned);
  });
  return total;
}

/** Booked downtime: from table rows when present, else in-memory (e.g. before Sheet reload). */
function getBookedDowntimeSec() {
  const table = document.getElementById("scanTable");
  if (!table || table.rows.length === 0) return 0;
  return sumBookedDowntimeFromScanTable();
}

function syncDowntimeSecondsFromTable() {
  const table = document.getElementById("scanTable");
  if (table && table.rows.length > 0) {
    downtimeSeconds = sumBookedDowntimeFromScanTable();
  }
}

/** Row # in column index 0 (top row = 1). Call after rebuild or insertRow(0). */
function renumberScanTable() {
  const table = document.getElementById("scanTable");
  if (!table) return;
  Array.from(table.rows).forEach((tr, i) => {
    const noCell = tr.cells[0];
    if (noCell) noCell.innerText = String(i + 1);
  });
}

function refreshDowntimeCardFromTable() {
  // Monitor: for \"today\" (rolling) use Firebase downtime so it matches main PC instantly
  // when the sheet table lags; for a past day, sum from the table only.
  if (isMonitor && downtimeFilterDate === null && Number.isFinite(monitorDowntimeOverrideSec) && monitorDowntimeOverrideSec >= 0) {
    downtimeSeconds = monitorDowntimeOverrideSec;
    document.getElementById("downtime").innerText = format(monitorDowntimeOverrideSec);
    renderDowntimeDebugPanel();
    return;
  }

  const table = document.getElementById("scanTable");
  const total = table && table.rows.length > 0
    ? sumBookedDowntimeFromScanTable()
    : 0;
  downtimeSeconds = total;
  document.getElementById("downtime").innerText = format(total);
  renderDowntimeDebugPanel();
}

function renderDowntimeDebugPanel() {
  if (!DEBUG_DOWNTIME) return;

  const table = document.getElementById("scanTable");
  if (!table) return;

  let panel = document.getElementById("downtimeDebugPanel");
  if (!panel) {
    panel = document.createElement("pre");
    panel.id = "downtimeDebugPanel";
    panel.style.cssText = [
      "position:fixed",
      "right:10px",
      "bottom:10px",
      "max-width:520px",
      "max-height:45vh",
      "overflow:auto",
      "z-index:99999",
      "padding:10px",
      "border-radius:8px",
      "border:1px solid rgba(148,163,184,.4)",
      "background:rgba(2,6,23,.92)",
      "color:#cbd5e1",
      "font:12px/1.4 Consolas, monospace",
      "white-space:pre-wrap"
    ].join(";");
    document.body.appendChild(panel);
  }

  let running = 0;
  const lines = [];
  lines.push("Downtime Debug (DOWN TIME rows only)");

  const dayKey = getActiveDowntimeDayKey();
  Array.from(table.rows).forEach((tr, idx) => {
    const rowDay = tr.dataset.scanDate || parseDisplayDateToIsoKey(tr.cells[1]?.innerText);
    if (!rowDay || rowDay !== dayKey) return;
    const statusCell = tr.cells[8];
    const downtimeCell = tr.cells[9];
    const status = statusCell ? statusCell.innerText.trim() : "";
    const raw = downtimeCell ? String(downtimeCell.innerText || "").trim() : "";
    const cleaned = cleanDowntime(raw);
    const sec = parseMmSsToSeconds(cleaned);
    const included = status === "DOWN TIME";
    if (included) running += sec;
    lines.push(
      `r${idx + 1} status=${status || "-"} raw="${raw}" clean="${cleaned}" sec=${sec} ${included ? "[+]" : "[-]"} total=${running}`
    );
  });

  lines.push(`Card total: ${format(running)} (${running}s)`);
  panel.textContent = lines.join("\n");
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

function getBreakWindowsForDate(dateObj) {
  const day = dateObj.getDay();
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

  return breaks;
}

function isBreakTimeAt(dateObj) {
  const current = dateObj.getHours() * 60 + dateObj.getMinutes();
  const breaks = getBreakWindowsForDate(dateObj);
  for (const b of breaks) {
    if (current >= b.start && current < b.end) {
      return true;
    }
  }

  return false;
}

function isBreakTime() {
  return isBreakTimeAt(new Date());
}

function getBreakOverlapMs(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let total = 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const cursor = new Date(fromMs);
  cursor.setHours(0, 0, 0, 0);

  for (let dayStart = cursor.getTime(); dayStart < toMs; dayStart += dayMs) {
    const dayDate = new Date(dayStart);
    const breaks = getBreakWindowsForDate(dayDate);
    breaks.forEach(b => {
      const breakStartMs = dayStart + (b.start * 60 * 1000);
      const breakEndMs = dayStart + (b.end * 60 * 1000);
      const overlapStart = Math.max(fromMs, breakStartMs);
      const overlapEnd = Math.min(toMs, breakEndMs);
      if (overlapEnd > overlapStart) {
        total += (overlapEnd - overlapStart);
      }
    });
  }

  return total;
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

  // Exclude scheduled break overlap from expected output timeline.
  const breakSeconds = Math.floor(getBreakOverlapMs(firstScanAtMs, now.getTime()) / 1000);

  let netTime = elapsedSec - breakSeconds;
  if (netTime < 0) netTime = 0;

  let expected = Math.floor(netTime / cycleTimeSec);
  if (plan > 0) {
    expected = Math.min(expected, plan);
  }

  // Start expected from 1 once production is active.
  expected = Math.max(expected, 1);

  //  START SHOW AFTER FIRST SCAN
  if (actualCount > 0 && expected === 0) {
    expected = 1;
  }

  return expected;
}

function getTotalDowntimeSec() {
  return getBookedDowntimeSec();
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

function refreshEfficiencyPercent() {
  efficiencyPercent = calculateAvailabilityPercent();
}

function computeEfficiencyFromCards() {
  const expectedVal = parseInt(document.getElementById("expected").innerText, 10);
  const actualVal = parseInt(document.getElementById("actual").innerText, 10);
  if (!Number.isFinite(expectedVal) || expectedVal <= 0) return 0;
  if (!Number.isFinite(actualVal) || actualVal < 0) return 0;
  return Math.floor((actualVal / expectedVal) * 100);
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

  if (isMonitor) {
    const connectedRef = firebaseDb.ref(".info/connected");
    connectedRef.on("value", snap => setMonitorConnectionStatus(!!snap.val()));
  }

  firebaseCommandRef.on("value", snapshot => {
    const command = snapshot.val();
    if (!command || !command.action) return;
    if (command.sender === syncClientId) return;
    const sentAt = Number(command.sentAt) || 0;
    // Ignore historical commands when a page first attaches. Replaying an old
    // stop/reset on reopen can wipe a valid running session before restore.
    if (sentAt > 0 && sentAt < firebaseSessionStartedAt) return;
    applyRemoteCommand(command.action);
  });

  if (isMonitor) {
    firebaseLiveStateRef.on(
      "value",
      snapshot => {
        monitorLiveStateError = null;
        const liveState = snapshot.val();
        if (!liveState) {
          monitorLiveStateReceived = false;
          updateMonitorDataNotice();
          return;
        }
        applyLiveState(liveState);
      },
      err => {
        monitorLiveStateError = err;
        monitorLiveStateReceived = false;
        console.error("Monitor live state listener:", err);
        updateMonitorDataNotice();
      }
    );
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

  // Use update (merge) so other writers (e.g. scheduled tick) cannot wipe fields
  // like dailyPlan / cycleTimeMin between publishes.
  firebaseLiveStateRef.update({
    ...state,
    settings: {
      dailyPlan: state.dailyPlan ?? state.plan,
      cycleTimeMin: state.cycleTimeMin
    },
    sender: syncClientId,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    console.log("Firebase live state publish error:", err);
  });
}

function saveLocalLiveStateSnapshot(state) {
  try {
    localStorage.setItem(LOCAL_LIVE_STATE_KEY, JSON.stringify({
      ...state,
      updatedAt: Date.now()
    }));
  } catch (err) {
    console.log("Local live state save error:", err);
  }
}

function readLocalLiveStateSnapshot() {
  try {
    const raw = localStorage.getItem(LOCAL_LIVE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.log("Local live state read error:", err);
    return null;
  }
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
  const nowMs = Date.now();
  let adjustedCountdown = parseInt(countdown, 10) || 0;
  let elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);

  if (syncedLastScanAtMs) {
    const elapsedSinceLastScanSec = Math.max(Math.floor((nowMs - Number(syncedLastScanAtMs)) / 1000), 0);
    adjustedCountdown = Math.max(cycleTimeSec - elapsedSinceLastScanSec, 0);
    elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);
  } else {
    const syncedAtMs = Number(syncedUpdatedAt) || nowMs;
    const elapsedSinceSyncSec = Math.max(Math.floor((nowMs - syncedAtMs) / 1000), 0);
    const syncedCountdown = parseInt(countdown, 10) || 0;
    adjustedCountdown = Math.max(syncedCountdown - elapsedSinceSyncSec, 0);
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
  } else {
    // If production was started manually (no completed scan yet), base the countdown
    // on reconstructed start time so refresh does not "reset" the timer.
    startTime = reconstructedBaseTime;
  }

  // Downtime is booked on each completed 4-scan (same as the scan table). Offline gap is
  // included in the next scan's diff; booking it here would double-count.

  countdownValue = adjustedCountdown;

  // Mark as active session and resume real downtime logic.
  hasLocalSession = true;
  startProduction(false);
}

function parseFirebaseInt(val) {
  if (val === undefined || val === null || val === "") return null;
  const n = parseInt(String(val).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFirebaseFloat(val) {
  if (val === undefined || val === null || val === "") return null;
  const n = parseFloat(String(val).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Daily plan + cycle (minutes) as stored in Firebase (settings first, then top-level). */
function readPlanAndCycleFromFirebase(state) {
  const settings = state.settings || {};
  const daily =
    parseFirebaseInt(settings.dailyPlan) ??
    parseFirebaseInt(state.dailyPlan) ??
    parseFirebaseInt(state.plan);
  const cycle =
    parseFirebaseFloat(settings.cycleTimeMin) ??
    parseFirebaseFloat(state.cycleTimeMin) ??
    parseFirebaseFloat(state.cycleTarget);
  return { daily, cycle };
}

function applyLiveState(state) {
  const resolvePositiveNumber = (primary, secondary, fallback) => {
    const p = Number(primary);
    if (Number.isFinite(p) && p > 0) return p;
    const s = Number(secondary);
    if (Number.isFinite(s) && s > 0) return s;
    return fallback;
  };

  const plan = parseInt(state.plan, 10) || 0;
  const currentDailyPlan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || SETTINGS.defaultPlan;
  const currentCycleTime = parseFloat(document.getElementById("cycleTarget").value) || SETTINGS.defaultCycle;
  let effectivePlan;
  let cycleTimeMin;

  if (isMonitor) {
    // Monitor: boxes mirror Firebase only (no local defaults masking stale reads).
    const { daily, cycle } = readPlanAndCycleFromFirebase(state);
    effectivePlan = daily != null && daily > 0 ? daily : 0;
    cycleTimeMin = cycle != null && cycle > 0 ? cycle : SETTINGS.defaultCycle;

    const planInput = document.getElementById("dailyPlanTarget");
    const cycleInput = document.getElementById("cycleTarget");
    planInput.value = daily != null && daily > 0 ? String(daily) : "";
    cycleInput.value = cycle != null && cycle > 0 ? String(cycle) : "";
    document.getElementById("plan").innerText = daily != null && daily > 0 ? String(daily) : "-";
  } else {
    effectivePlan = resolvePositiveNumber(state.dailyPlan, plan, currentDailyPlan);
    cycleTimeMin = resolvePositiveNumber(state.cycleTimeMin, state.cycleTarget, currentCycleTime);
  }
  const actual = parseInt(state.actual, 10) || 0;
  const balance = parseInt(state.balance, 10) || 0;
  const status = state.status || "READY";
  const countdown = parseInt(state.countdown, 10) || 0;
  const expected = parseInt(state.expected, 10) || 0;
  const delay = parseInt(state.delay, 10) || 0;
  const stateEfficiency = parseInt(state.efficiency, 10) || 0;
  const lotNo = state.lotNo || "";
  const downtimeDayIn = typeof state.downtimeDay === "string" && state.downtimeDay.trim()
    ? state.downtimeDay.trim().slice(0, 10)
    : null;
  if (isMonitor && downtimeDayIn) {
    const todayK = toIsoDateLocal(new Date());
    downtimeFilterDate = downtimeDayIn === todayK ? null : downtimeDayIn;
    syncDowntimeDayPickerUi();
  }
  const fbTotalDowntime = Number(state.totalDowntime);
  if (isMonitor && Number.isFinite(fbTotalDowntime) && fbTotalDowntime >= 0) {
    monitorDowntimeOverrideSec = fbTotalDowntime;
  }

  // Keep local variables aligned so refresh doesn't revert values.
  actualCount = actual;
  syncDowntimeSecondsFromTable();
  firstScanAtMs = state.firstScanAtMs ? Number(state.firstScanAtMs) : firstScanAtMs;
  const effEl = document.getElementById("efficiency");

  if (!isMonitor) {
    document.getElementById("plan").innerText = effectivePlan;
    document.getElementById("dailyPlanTarget").value = String(effectivePlan);
    document.getElementById("cycleTarget").value = String(cycleTimeMin);
  }
  const lotInput = document.getElementById("lotInput");
  if (lotInput) {
    lotInput.value = lotNo;
  }
  document.getElementById("actual").innerText = actual;
  document.getElementById("expected").innerText = expected;
  const liveEfficiency = computeEfficiencyFromCards();
  efficiencyPercent = Number.isFinite(liveEfficiency) ? liveEfficiency : stateEfficiency;
  effEl.innerText = efficiencyPercent + "%";
  if (efficiencyPercent < 90) {
    effEl.className = "big-number status-red";
  } else if (efficiencyPercent < 100) {
    effEl.className = "big-number status-orange";
  } else {
    effEl.className = "big-number status-green";
  }
  startLiveCountdownTicker(countdown, status, state.updatedAt);
  syncDowntimeSecondsFromTable();
  if (isMonitor && Number.isFinite(monitorDowntimeOverrideSec) && monitorDowntimeOverrideSec >= 0) {
    document.getElementById("downtime").innerText = format(monitorDowntimeOverrideSec);
  } else {
    document.getElementById("downtime").innerText = format(getBookedDowntimeSec());
  }
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

  if (isMonitor) {
    monitorLiveStateReceived = true;
    monitorLiveStateError = null;
    updateMonitorDataNotice();
  }
}

function loadInitialLiveState() {
  if (!firebaseLiveStateRef) return;

  firebaseLiveStateRef.once("value")
    .then(snapshot => {
      const firebaseState = snapshot.val();
      const localState = readLocalLiveStateSnapshot();
      let liveState = firebaseState;

      const firebaseUpdatedAt = Number(firebaseState && firebaseState.updatedAt) || 0;
      const localUpdatedAt = Number(localState && localState.updatedAt) || 0;

      // Refresh on the same PC should prefer the fresher local snapshot if Firebase
      // was temporarily overwritten with READY/0 during reload.
      if (localState && localUpdatedAt > firebaseUpdatedAt) {
        liveState = {
          ...(firebaseState || {}),
          ...localState
        };
      }

      if (!liveState) return;
      applyLiveState(liveState);
      initialLiveStateLoaded = true;
    })
    .catch(err => console.log("Firebase initial live state error:", err));
}

function loadMonitorStateFromFirebase() {
  if (!isMonitor) return;
  if (!firebaseLiveStateRef) return;

  firebaseLiveStateRef.once("value")
    .then(snapshot => {
      const liveState = snapshot.val();
      if (!liveState) return;
      applyLiveState(liveState);
    })
    .catch(err => console.log("Firebase monitor state error:", err));
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

  // If resuming from PAUSED, shift base time forward by paused duration
  // so countdown truly stops while paused.
  if (pauseStartMs != null) {
    const pausedMs = Math.max(Date.now() - pauseStartMs, 0);
    if (lastScanTime) {
      lastScanTime = new Date(lastScanTime.getTime() + pausedMs);
    } else if (startTime) {
      startTime = new Date(startTime.getTime() + pausedMs);
    }
    pauseStartMs = null;
  }

  // If no scan yet, set initial countdown
  if (countdownValue === 0) {
    countdownValue = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  }

  timer = setInterval(() => {
    const nowMs = Date.now();
    if (lastTimerTickMs != null) {
      const breakGapMs = getBreakOverlapMs(lastTimerTickMs, nowMs);
      if (breakGapMs > 0) {
        if (lastScanTime) {
          lastScanTime = new Date(lastScanTime.getTime() + breakGapMs);
        } else if (startTime) {
          startTime = new Date(startTime.getTime() + breakGapMs);
        }
      }
    }
    lastTimerTickMs = nowMs;

    if (isBreakTime()) {
      if (breakPauseStartMs == null) {
        breakPauseStartMs = nowMs;
      }
      setStatus("BREAK TIME", "status-orange");
      updateDisplay();
      return;
    }

    // Break overlap has already been compensated via getBreakOverlapMs(lastTimerTickMs, nowMs).
    // Do not add break pause again here, otherwise countdown gets extra time after break.
    if (breakPauseStartMs != null) {
      breakPauseStartMs = null;
    }

    const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;

    // 🔥 USE REAL TIME (FIXED)
    const now = new Date(nowMs);

    // use startTime if no scan yet
    const baseTime = lastScanTime || startTime;

    const diff = Math.floor((now - baseTime) / 1000);
    countdownValue = Math.max(cycleTimeSec - diff, 0);

    if (countdownValue === 0) {
      isDowntime = true;
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
  lastTimerTickMs = null;
  breakPauseStartMs = null;
  // Remember pause moment; we will compensate on resume.
  pauseStartMs = Date.now();
  setStatus("PAUSED", "status-orange");
  updateDisplay();
  updateLiveStateOnly();
}

/* RESET */
function resetProduction(shouldSync = true) {
  hasLocalSession = true;

  if (shouldSync) {
    publishSyncCommand("reset");
  }

  clearInterval(timer);
  timer = null;
  lastTimerTickMs = null;
  countdownValue = 0;
  actualCount = 0;
  downtimeSeconds = 0;
  lastScanTime = null;
  startTime = null;
  firstScanAtMs = null;
  efficiencyPercent = 0;
  breakPauseStartMs = null;
  pauseStartMs = null;
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
    const planForRow = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;

    const now = new Date();
    const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;

    const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
    let downtimeEvent = "";

    if (lastScanTime) {
      const diffSec = Math.floor((now - lastScanTime) / 1000);
      if (diffSec > cycleTimeSec) {
        const actualDowntime = diffSec - cycleTimeSec;

        // Count downtime only before target (or when plan is open-ended 0).
        if (plan === 0 || (actualCount + 1) <= plan) {
          downtimeEvent = format(actualDowntime);
          downtimeSeconds += actualDowntime;
          isDowntime = true;
        } else {
          downtimeEvent = "";
          isDowntime = false;
        }
      } else {
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

    row.insertCell(0).innerText = "";
    row.insertCell(1).innerText = now.toLocaleDateString();
    row.insertCell(2).innerText = now.toLocaleTimeString();
    row.insertCell(3).innerText = lot;
    row.insertCell(4).innerText = model;
    row.insertCell(5).innerText = chassis;
    row.insertCell(6).innerText = engine;
    row.insertCell(7).innerText = key;

    const statusCell = row.insertCell(8);
    const downtimeCell = row.insertCell(9);

    if (downtimeEvent) {
      statusCell.innerText = "DOWN TIME";
      statusCell.classList.add("status-red");
      downtimeCell.innerText = downtimeEvent;
      downtimeCell.classList.add("status-red");
    } else {
      statusCell.innerText = "SCANNED";
      statusCell.classList.add("status-green");
      downtimeCell.innerText = "";
    }

    row.dataset.scanDate = toIsoDateLocal(now);
    row.dataset.scanPlan = String(planForRow);
    renumberScanTable();

    // One completed 4-scan cycle = one actual unit.
    actualCount++;
    refreshEfficiencyPercent();
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
  // Keep accumulated card aligned with sum of visible table downtime rows.
  syncDowntimeSecondsFromTable();
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const balance = actualCount - plan;
  const displayBalance = balance > 0 ? ("+" + balance) : balance;

  // EXPECTED CALCULATION
  let expected = calculateExpectedOutput();
  const statusText = document.getElementById("status").innerText.trim();
  // When paused/stopped timer is not running, preserve previously displayed
  // expected value instead of collapsing expected to actual (which forces 100%).
  if (!timer && (statusText === "PAUSED" || statusText === "BREAK TIME")) {
    const expectedShown = parseInt(document.getElementById("expected").innerText, 10);
    if (Number.isFinite(expectedShown) && expectedShown > expected) {
      expected = expectedShown;
    }
  }

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

  // Display Expected/Actual first, then compute efficiency from cards
  // so the efficiency value always matches what user sees.
  document.getElementById("expected").innerText = expected;
  document.getElementById("actual").innerText = actualCount;
  const efficiency = computeEfficiencyFromCards();
  efficiencyPercent = efficiency;

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
  document.getElementById("plan").innerText = plan;
  document.getElementById("countdown").innerText = format(countdownValue);
  refreshDowntimeCardFromTable();

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
      const statusCell = cells[8];
      const downtimeCell = cells[9];

      let statusClass = "";
      if (statusCell.classList.contains("status-red")) {
        statusClass = "status-red";
      } else if (statusCell.classList.contains("status-green")) {
        statusClass = "status-green";
      }

      let downtimeClass = "";
      if (downtimeCell.classList.contains("status-red")) {
        downtimeClass = "status-red";
      } else if (downtimeCell.classList.contains("status-orange")) {
        downtimeClass = "status-orange";
      }

      tableRows += `
<tr>
<td>${cells[0].innerText}</td> <td>${cells[1].innerText}</td> <td>${cells[2].innerText}</td> <td>${cells[3].innerText}</td> <td>${cells[4].innerText}</td> <td>${cells[5].innerText}</td> <td>${cells[6].innerText}</td> <td>${cells[7].innerText}</td> <td class="${statusClass}">${cells[8].innerText}</td> <td class="${downtimeClass}">${cells[9].innerText}</td> </tr>`;
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
<th>No</th>
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
  const data = [["No", "Date", "Time", "Lot", "Model", "Chassis", "Engine No", "Key No", "Status", "Downtime"]];

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
        cells[8].innerText,
        cells[9].innerText
      ]);
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(data);

  for (let i = 1; i < data.length; i++) {
    const cell = "I" + (i + 1);
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

function toggleHistoryPanel(forceOpen) {
  const panel = document.getElementById("historyPanel");
  if (!panel) return;

  let open;
  if (typeof forceOpen === "boolean") {
    open = forceOpen;
  } else {
    open = !panel.classList.contains("open");
  }

  if (open) {
    document.body.classList.remove("summary-mode");
    const summaryPage = document.getElementById("summaryPage");
    if (summaryPage) summaryPage.classList.remove("open");
    document.body.classList.remove("graph-mode");
    const graphPage = document.getElementById("graphPage");
    if (graphPage) graphPage.classList.remove("open");
    document.body.classList.add("history-mode");
    panel.classList.add("open");
    syncHistoryDayPickerUi();
    applyHistoryDateFilter();
    triggerEnterAnimation(panel);
  } else {
    document.body.classList.remove("history-mode");
    panel.classList.remove("open");
  }
  updateViewToggleMenuItem();
}

function toggleMenuDropdown(forceOpen) {
  const menu = document.getElementById("menuDropdown");
  if (!menu) return;
  updateViewToggleMenuItem();
  if (typeof forceOpen === "boolean") {
    menu.classList.toggle("open", forceOpen);
    return;
  }
  menu.classList.toggle("open");
}

function openHistoryPanelFromMenu() {
  toggleMenuDropdown(false);
  // Delay open by a tick so outside-click handlers from the same click
  // cannot immediately close the newly opened panel.
  setTimeout(() => toggleHistoryPanel(true), 0);
}

function openSummaryFromMenu() {
  toggleMenuDropdown(false);
  showSummaryPage();
}

function toggleRamadanFromMenu() {
  toggleMenuDropdown(false);
  toggleRamadan();
}

function updateViewToggleMenuItem() {
  // Keep fixed labels, only highlight active section like sidebar.
  const main = document.getElementById("mainPageMenuItem");
  const summary = document.getElementById("dailySummaryMenuItem");
  const graph = document.getElementById("graphMenuItem");
  const history = document.getElementById("historyMenuItem");
  [main, summary, graph, history].forEach(el => {
    if (el) el.classList.remove("active");
  });

  if (document.body.classList.contains("summary-mode")) {
    if (summary) summary.classList.add("active");
  } else if (document.body.classList.contains("graph-mode")) {
    if (graph) graph.classList.add("active");
  } else if (document.body.classList.contains("history-mode")) {
    if (history) history.classList.add("active");
  } else {
    if (main) main.classList.add("active");
  }
}

function toggleViewFromMenu() {
  showSummaryPage();
}

function showMainPage() {
  toggleMenuDropdown(false);
  document.body.classList.remove("summary-mode");
  document.body.classList.remove("graph-mode");
  document.body.classList.remove("history-mode");
  const summaryPage = document.getElementById("summaryPage");
  if (summaryPage) summaryPage.classList.remove("open");
  const graphPage = document.getElementById("graphPage");
  if (graphPage) graphPage.classList.remove("open");
  const historyPanel = document.getElementById("historyPanel");
  if (historyPanel) historyPanel.classList.remove("open");
  triggerEnterAnimation(document.querySelector(".dashboard"));
  triggerEnterAnimation(document.querySelector(".bottom-row"));
  updateViewToggleMenuItem();
}

function parseHourFromTimeText(timeText) {
  const text = String(timeText || "").trim().toLowerCase();
  const match = text.match(/(\d{1,2}):\d{2}(?::\d{2})?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  if (!Number.isFinite(hour)) return null;
  const ampm = (match[2] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;
  return hour;
}

function buildSummaryBarChart(title, labels, values, color, valueSuffix = "") {
  if (!labels.length || !values.length) {
    return `<div class="summary-graph-empty">No data</div>`;
  }
  const width = 500;
  const height = 170;
  const leftPad = 36;
  const rightPad = 12;
  const topPad = 14;
  const bottomPad = 28;
  const chartW = width - leftPad - rightPad;
  const chartH = height - topPad - bottomPad;
  const maxVal = Math.max(...values, 1);
  const stepX = chartW / labels.length;
  const barW = Math.max(Math.min(stepX * 0.58, 36), 10);

  const bars = labels.map((label, i) => {
    const v = values[i];
    const x = leftPad + (i * stepX) + ((stepX - barW) / 2);
    const h = Math.max((v / maxVal) * chartH, v > 0 ? 2 : 0);
    const y = topPad + (chartH - h);
    return `
      <rect class="summary-bar" style="animation-delay:${i * 90}ms" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="2" fill="${color}" opacity="0.9"></rect>
      <text x="${(x + (barW / 2)).toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#94a3b8" font-size="9">${label}</text>
      <text x="${(x + (barW / 2)).toFixed(2)}" y="${(Math.max(y - 3, 10)).toFixed(2)}" text-anchor="middle" fill="#e2e8f0" font-size="9">${v}${valueSuffix}</text>
    `;
  }).join("");

  return `
    <div class="summary-graph-card-title">${title}</div>
    <svg viewBox="0 0 ${width} ${height}" class="summary-chart-svg" role="img" aria-label="${title}">
      <line x1="${leftPad}" y1="${topPad + chartH}" x2="${width - rightPad}" y2="${topPad + chartH}" stroke="rgba(148,163,184,.45)" stroke-width="1"></line>
      <line x1="${leftPad}" y1="${topPad}" x2="${leftPad}" y2="${topPad + chartH}" stroke="rgba(148,163,184,.45)" stroke-width="1"></line>
      ${bars}
    </svg>
  `;
}

function getPlanActualForPeriod(anchorDay, period = "day") {
  const range = getActiveGraphRange();
  const periodKeys = getDayKeysBetween(range.start, range.end);
  const periodKeySet = new Set(periodKeys);
  const rows = document.querySelectorAll("#scanTable tr");
  const planByDay = {};
  let actual = 0;

  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || !periodKeySet.has(rowDay)) return;
    actual += 1;
    if (!Number.isFinite(planByDay[rowDay])) {
      const planVal = parseInt((row.dataset.scanPlan || "").trim(), 10);
      if (Number.isFinite(planVal) && planVal > 0) planByDay[rowDay] = planVal;
    }
  });

  let plan = 0;
  periodKeys.forEach(day => {
    if (Number.isFinite(planByDay[day]) && planByDay[day] > 0) {
      plan += planByDay[day];
    } else {
      const hist = getHistoricalPlanForDay(day);
      if (Number.isFinite(hist) && hist > 0) plan += hist;
    }
  });

  if (plan <= 0) {
    const planRaw = document.getElementById("plan").innerText.trim();
    const planCard = parseInt(planRaw, 10);
    const planInput = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
    const fallbackDayPlan = Number.isFinite(planCard) && planCard > 0 ? planCard : planInput;
    const multiplier = Math.max(periodKeys.length, 1);
    plan = Math.max(0, fallbackDayPlan * multiplier);
  }

  return { plan, actual };
}

function buildPlanVsActualChart(dayKey = getActiveGraphDayKey(), period = graphPeriod) {
  const range = getActiveGraphRange();
  const rangeLabel = formatIsoRangeAsDdMmYy(range.start, range.end);
  const dayKeys = getDayKeysBetween(range.start, range.end);
  const daySet = new Set(dayKeys);
  const periodLabel = period === "week" ? "Week" : period === "month" ? "Month" : "Day";

  const dailyActualMap = {};
  const rows = document.querySelectorAll("#scanTable tr");
  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || !daySet.has(rowDay)) return;
    dailyActualMap[rowDay] = (dailyActualMap[rowDay] || 0) + 1;
  });

  const totalDailyPlan = dayKeys.reduce((sum, key) => {
    const hist = getHistoricalPlanForDay(key);
    if (Number.isFinite(hist) && hist > 0) return sum + hist;
    return sum;
  }, 0);
  let fallbackDayPlan = parseInt(document.getElementById("plan").innerText.trim(), 10);
  if (!Number.isFinite(fallbackDayPlan) || fallbackDayPlan <= 0) {
    fallbackDayPlan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  }
  const totalPlan = totalDailyPlan > 0 ? totalDailyPlan : Math.max(0, fallbackDayPlan * Math.max(dayKeys.length, 1));

  let runningActual = 0;
  const actualSeries = dayKeys.map(k => {
    runningActual += (dailyActualMap[k] || 0);
    return runningActual;
  });
  const targetSeries = dayKeys.map((_, i) => {
    if (!dayKeys.length) return 0;
    return Math.round((totalPlan * (i + 1)) / dayKeys.length);
  });

  const finalActual = actualSeries[actualSeries.length - 1] || 0;
  const diff = finalActual - totalPlan;
  const diffNote = totalPlan > 0
    ? (diff === 0 ? "On target" : diff > 0 ? `Ahead by ${diff}` : `Behind by ${Math.abs(diff)}`)
    : "";

  if (totalPlan <= 0 && finalActual <= 0) {
    return `
      <div class="summary-graph-card-title">Plan vs Actual</div>
      <div class="summary-graph-empty">No daily plan or actual output yet</div>`;
  }

  const width = 620;
  const height = 190;
  const leftPad = 56;
  const rightPad = 16;
  const topPad = 24;
  const bottomPad = 30;
  const chartW = width - leftPad - rightPad;
  const chartH = height - topPad - bottomPad;
  const maxVal = Math.max(totalPlan, finalActual, 1);
  const xStep = dayKeys.length <= 1 ? chartW : (chartW / (dayKeys.length - 1));
  const yBase = topPad + chartH;
  const toY = (v) => yBase - ((v / maxVal) * chartH);
  const formatNum = (n) => Number(n || 0).toLocaleString();

  const actualPoints = dayKeys.map((_, i) => ({
    x: leftPad + (xStep * i),
    y: toY(actualSeries[i] || 0),
    value: actualSeries[i] || 0
  }));
  const targetPoints = dayKeys.map((_, i) => ({
    x: leftPad + (xStep * i),
    y: toY(targetSeries[i] || 0),
    value: targetSeries[i] || 0
  }));
  const actualPath = actualPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const targetPath = targetPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const areaPath = actualPoints.length
    ? `${actualPath} L ${actualPoints[actualPoints.length - 1].x.toFixed(2)} ${yBase.toFixed(2)} L ${actualPoints[0].x.toFixed(2)} ${yBase.toFixed(2)} Z`
    : "";
  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const ratio = i / yTicks;
    const y = topPad + (chartH * ratio);
    const v = Math.round(maxVal * (1 - ratio));
    return `
      <line x1="${leftPad}" y1="${y.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(30,64,175,.2)" stroke-width="1"></line>
      <text x="${(leftPad - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#94a3b8" font-size="10">${formatNum(v)}</text>
    `;
  }).join("");
  const labelStride = dayKeys.length > 24 ? 3 : dayKeys.length > 16 ? 2 : 1;
  const xLabels = dayKeys.map((k, i) => {
    if (i % labelStride !== 0 && i !== dayKeys.length - 1) return "";
    const d = new Date(`${k}T00:00:00`);
    const label = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const x = leftPad + (xStep * i);
    return `<text x="${x.toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#94a3b8" font-size="9">${label}</text>`;
  }).join("");
  const actualDots = actualPoints.map((p, i) => {
    const dTxt = formatIsoDateAsDdMmYy(dayKeys[i]);
    const vTxt = formatNum(p.value);
    return `<circle class="trend-dot" style="animation-delay:${i * 45}ms" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4.2" fill="#4ade80"><title>Actual\n${dTxt}: ${vTxt}</title></circle>`;
  }).join("");
  const targetDots = targetPoints.map((p, i) => {
    const dTxt = formatIsoDateAsDdMmYy(dayKeys[i]);
    const vTxt = formatNum(p.value);
    return `<circle class="trend-dot" style="animation-delay:${i * 45}ms" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4.2" fill="#3b82f6"><title>Target\n${dTxt}: ${vTxt}</title></circle>`;
  }).join("");

  return `
      <div class="trend-header">
        <div class="trend-title-wrap">
          <div class="trend-title">PRODUCTION TREND</div>
          <div class="trend-subtitle">${periodLabel}: ${rangeLabel}</div>
        </div>
        <div class="trend-legend">
          <span class="trend-legend-item"><i class="trend-swatch trend-swatch-actual"></i>Actual</span>
          <span class="trend-legend-item"><i class="trend-swatch trend-swatch-target"></i>Target</span>
        </div>
      </div>
      ${diffNote ? `<div class="plan-actual-diff">${diffNote}</div>` : ""}
      <div class="trend-units">Units</div>
      <svg viewBox="0 0 ${width} ${height}" class="summary-chart-svg summary-chart-plan-actual" role="img" aria-label="Production trend chart">
        <defs>
          <linearGradient id="actualTrendFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(74,222,128,.35)"></stop>
            <stop offset="100%" stop-color="rgba(74,222,128,0)"></stop>
          </linearGradient>
        </defs>
        ${gridLines}
        ${areaPath ? `<path d="${areaPath}" fill="url(#actualTrendFill)"></path>` : ""}
        <path class="trend-line trend-line-target" d="${targetPath}" fill="none" stroke="#3b82f6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></path>
        <path class="trend-line trend-line-actual" d="${actualPath}" fill="none" stroke="#4ade80" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></path>
        ${targetDots}
        ${actualDots}
        ${xLabels}
      </svg>
      <div class="plan-actual-sub">${totalPlan > 0 ? `Target ${formatNum(totalPlan)} | Actual ${formatNum(finalActual)}` : `Actual ${formatNum(finalActual)}`}</div>
  `;
}

function getHistoricalPlanForDay(dayKey) {
  const rows = document.querySelectorAll("#scanTable tr");
  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (!cells.length) continue;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (rowDay !== dayKey) continue;
    const planVal = parseInt((row.dataset.scanPlan || "").trim(), 10);
    if (Number.isFinite(planVal) && planVal > 0) return planVal;
  }
  return null;
}

function collectHourlyGraphData(dayKey = getActiveGraphDayKey(), period = graphPeriod) {
  const rows = document.querySelectorAll("#scanTable tr");
  const range = getActiveGraphRange();
  const periodKeys = getDayKeysBetween(range.start, range.end);
  const periodKeySet = new Set(periodKeys);
  const outputByBucket = {};
  const downtimeByBucket = {};

  if (period === "day" && periodKeys.length === 1) {
    const oneDay = periodKeys[0];
    rows.forEach(row => {
      const cells = row.querySelectorAll("td");
      if (cells.length === 0) return;
      const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
      if (!rowDay || rowDay !== oneDay) return;
      const hour = parseHourFromTimeText(cells[2]?.innerText || "");
      if (hour == null) return;
      outputByBucket[hour] = (outputByBucket[hour] || 0) + 1;
      const downtimeSec = parseMmSsToSeconds(cells[9]?.innerText || "");
      if (downtimeSec > 0) {
        downtimeByBucket[hour] = (downtimeByBucket[hour] || 0) + downtimeSec;
      }
    });

    const hourKeys = Array.from(new Set([
      ...Object.keys(outputByBucket),
      ...Object.keys(downtimeByBucket)
    ].map(v => parseInt(v, 10)).filter(Number.isFinite))).sort((a, b) => a - b);
    const labels = hourKeys.map(h => `${String(h).padStart(2, "0")}:00`);
    const outputVals = hourKeys.map(h => outputByBucket[h] || 0);
    const downtimeMins = hourKeys.map(h => {
      const sec = downtimeByBucket[h] || 0;
      if (sec <= 0) return 0;
      return Math.max(1, Math.round(sec / 60));
    });
    return { labels, outputVals, downtimeMins, bucketName: "Hour" };
  }

  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length === 0) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || !periodKeySet.has(rowDay)) return;
    outputByBucket[rowDay] = (outputByBucket[rowDay] || 0) + 1;
    const downtimeSec = parseMmSsToSeconds(cells[9]?.innerText || "");
    if (downtimeSec > 0) {
      downtimeByBucket[rowDay] = (downtimeByBucket[rowDay] || 0) + downtimeSec;
    }
  });

  const labels = periodKeys.map(k => {
    if (period === "week") {
      const dt = new Date(`${k}T00:00:00`);
      const dName = dt.toLocaleDateString(undefined, { weekday: "short" });
      return `${dName} ${k.slice(8, 10)}`;
    }
    return String(parseInt(k.slice(8, 10), 10));
  });
  const outputVals = periodKeys.map(k => outputByBucket[k] || 0);
  const downtimeMins = periodKeys.map(k => {
    const sec = downtimeByBucket[k] || 0;
    if (sec <= 0) return 0;
    return Math.max(1, Math.round(sec / 60));
  });
  return { labels, outputVals, downtimeMins, bucketName: "Day" };
}

function renderGraphCharts() {
  const graphBody = document.getElementById("graphChartsBody");
  if (!graphBody) return;
  const activeDay = getActiveGraphDayKey();
  const range = getActiveGraphRange();
  const rangeLabel = formatIsoRangeAsDdMmYy(range.start, range.end);
  const { labels, downtimeMins } = collectHourlyGraphData(activeDay, graphPeriod);
  const periodLabel = graphPeriod === "week" ? "Week" : graphPeriod === "month" ? "Month" : "Day";
  const periodKeys = getDayKeysBetween(range.start, range.end);
  const keySet = new Set(periodKeys);
  const rows = document.querySelectorAll("#scanTable tr");
  const dayProduced = {};
  const dayDowntimeSec = {};
  periodKeys.forEach(k => { dayProduced[k] = 0; dayDowntimeSec[k] = 0; });
  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || !keySet.has(rowDay)) return;
    dayProduced[rowDay] = (dayProduced[rowDay] || 0) + 1;
    const statusText = (cells[8]?.innerText || "").trim().toUpperCase();
    if (statusText === "DOWN TIME") {
      dayDowntimeSec[rowDay] = (dayDowntimeSec[rowDay] || 0) + parseMmSsToSeconds(cells[9]?.innerText || "");
    }
  });
  const defaultDailyPlan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const dayTarget = {};
  periodKeys.forEach(k => {
    const p = getHistoricalPlanForDay(k);
    dayTarget[k] = (Number.isFinite(p) && p > 0) ? p : defaultDailyPlan;
  });
  const totalProduced = periodKeys.reduce((s, k) => s + (dayProduced[k] || 0), 0);
  const totalTarget = periodKeys.reduce((s, k) => s + (dayTarget[k] || 0), 0);
  const totalDowntimeMin = Math.max(0, Math.round(periodKeys.reduce((s, k) => s + (dayDowntimeSec[k] || 0), 0) / 60));
  const avgRate = totalProduced > 0 ? (totalProduced / Math.max(periodKeys.length * 8, 1)) : 0;
  const dailyRows = periodKeys.map(k => {
    const produced = dayProduced[k] || 0;
    const target = dayTarget[k] || 0;
    const balance = produced - target;
    const ach = target > 0 ? ((produced / target) * 100) : 0;
    const dtMin = Math.max(0, Math.round((dayDowntimeSec[k] || 0) / 60));
    return `<tr>
      <td>${formatIsoDateAsDdMmYy(k)}</td>
      <td>${target}</td>
      <td>${produced}</td>
      <td class="${balance < 0 ? "summary-downtime-red" : "summary-status-scanned"}">${balance > 0 ? "+" : ""}${balance}</td>
      <td>${ach.toFixed(1)}%</td>
      <td>${dtMin}</td>
    </tr>`;
  }).join("");
  const planActualChart = buildPlanVsActualChart(activeDay, graphPeriod);
  const downtimeChart = buildSummaryBarChart(`Downtime Trend (${periodLabel}: ${rangeLabel})`, labels, downtimeMins, "#ef4444");
  graphBody.innerHTML = `
    <div class="report-kpi-grid">
      <div class="report-kpi"><span>Total Produced</span><strong>${totalProduced}</strong><em>units</em></div>
      <div class="report-kpi"><span>Total Target</span><strong>${totalTarget}</strong><em>units</em></div>
      <div class="report-kpi"><span>Production Balance</span><strong class="${(totalProduced-totalTarget) < 0 ? "neg" : "pos"}">${(totalProduced-totalTarget) > 0 ? "+" : ""}${totalProduced-totalTarget}</strong><em>units</em></div>
      <div class="report-kpi"><span>Total Downtime</span><strong class="neg">${totalDowntimeMin}</strong><em>min</em></div>
      <div class="report-kpi"><span>Average Rate</span><strong>${avgRate.toFixed(1)}</strong><em>units/hr</em></div>
    </div>
    <div class="report-chart-grid">
      <div class="summary-graph-card">${planActualChart}</div>
      <div class="summary-graph-card">${downtimeChart}</div>
    </div>
    <div class="report-table-wrap">
      <div class="summary-graph-card-title">Daily Summary</div>
      <div class="report-table-scroll">
        <table class="report-mini-table">
          <thead><tr><th>Date</th><th>Target</th><th>Produced</th><th>Balance</th><th>Achv</th><th>Downtime</th></tr></thead>
          <tbody>${dailyRows || `<tr><td colspan="6">No data</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}

function showGraphPageFromMenu() {
  toggleMenuDropdown(false);
  showGraphPage();
}

function showGraphPage() {
  let graphPage = document.getElementById("graphPage");
  if (!graphPage) {
    graphPage = document.createElement("div");
    graphPage.id = "graphPage";
    graphPage.className = "graph-page";
    document.body.appendChild(graphPage);
  }

  graphPage.innerHTML = `
    <div class="summary-head">Production Report</div>
    <div class="graph-filter-row">
      <div class="report-selects">
        <select><option>Daily Production Report</option></select>
        <select><option>All Shifts</option></select>
        <select><option>All Lines</option></select>
      </div>
      <div class="graph-period-toggle" role="group" aria-label="Graph period">
        <button type="button" id="graphPeriodDayBtn" class="graph-period-btn">Day</button>
        <button type="button" id="graphPeriodWeekBtn" class="graph-period-btn">Week</button>
        <button type="button" id="graphPeriodMonthBtn" class="graph-period-btn">Month</button>
      </div>
      <div class="graph-range-box">
        <span class="graph-range-label">DATE RANGE</span>
        <div class="graph-range-inputs">
          <input type="date" id="graphRangeStart" title="Graph range start date">
          <span class="graph-range-sep">-</span>
          <input type="date" id="graphRangeEnd" title="Graph range end date">
          <button type="button" id="graphRangeTodayBtn" class="graph-today-btn">Today</button>
        </div>
      </div>
    </div>
    <div class="report-body" id="graphChartsBody">
    </div>
  `;
  syncGraphRangePickerUi();
  syncGraphPeriodButtonsUi();
  const graphRangeStart = document.getElementById("graphRangeStart");
  const graphRangeEnd = document.getElementById("graphRangeEnd");
  const graphRangeTodayBtn = document.getElementById("graphRangeTodayBtn");
  const graphPeriodDayBtn = document.getElementById("graphPeriodDayBtn");
  const graphPeriodWeekBtn = document.getElementById("graphPeriodWeekBtn");
  const graphPeriodMonthBtn = document.getElementById("graphPeriodMonthBtn");
  if (graphRangeStart) graphRangeStart.addEventListener("change", onGraphRangeFilterChange);
  if (graphRangeEnd) graphRangeEnd.addEventListener("change", onGraphRangeFilterChange);
  if (graphRangeTodayBtn) graphRangeTodayBtn.addEventListener("click", onGraphRangeTodayClick);
  if (graphPeriodDayBtn) graphPeriodDayBtn.addEventListener("click", () => onGraphPeriodChange("day"));
  if (graphPeriodWeekBtn) graphPeriodWeekBtn.addEventListener("click", () => onGraphPeriodChange("week"));
  if (graphPeriodMonthBtn) graphPeriodMonthBtn.addEventListener("click", () => onGraphPeriodChange("month"));
  renderGraphCharts();

  document.body.classList.remove("summary-mode");
  document.body.classList.remove("history-mode");
  const summaryPage = document.getElementById("summaryPage");
  if (summaryPage) summaryPage.classList.remove("open");
  const historyPanel = document.getElementById("historyPanel");
  if (historyPanel) historyPanel.classList.remove("open");
  document.body.classList.add("graph-mode");
  graphPage.classList.add("open");
  triggerEnterAnimation(graphPage);
  updateViewToggleMenuItem();
}

function showSummaryPage() {
  toggleMenuDropdown(false);
  const activeDay = getActiveSummaryDayKey();
  let plan = getHistoricalPlanForDay(activeDay);
  if (!Number.isFinite(plan) || plan < 0) {
    plan = parseInt(document.getElementById("plan").innerText, 10) || 0;
  }
  if (!Number.isFinite(plan) || plan < 0) {
    plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  }

  let actual = 0;
  let downtimeSec = 0;
  const expected = plan > 0 ? plan : 0;

  const rows = document.querySelectorAll("#scanTable tr");
  let tableRows = "";
  let rowNo = 1;
  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (cells.length > 0) {
      const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
      if (!rowDay || rowDay !== activeDay) return;
      const statusText = (cells[8]?.innerText || "").trim().toUpperCase();
      const isDowntime = statusText === "DOWN TIME";
      const statusClass = isDowntime ? "summary-status-downtime" : "summary-status-scanned";
      const downtimeClass = isDowntime ? "summary-downtime-red" : "";
      actual += 1;
      if (isDowntime) downtimeSec += parseMmSsToSeconds(cells[9]?.innerText || "");
      tableRows += `<tr>
        <td>${rowNo++}</td>
        <td>${cells[1].innerText}</td>
        <td>${cells[2].innerText}</td>
        <td>${cells[3].innerText}</td>
        <td>${cells[4].innerText}</td>
        <td>${cells[5].innerText}</td>
        <td>${cells[6].innerText}</td>
        <td>${cells[7].innerText}</td>
        <td class="${statusClass}">${cells[8].innerText}</td>
        <td class="${downtimeClass}">${cells[9].innerText}</td>
      </tr>`;
    }
  });
  const downtime = format(downtimeSec);
  const diff = actual - plan;
  const diffDisplaySafe = diff > 0 ? ("+" + diff) : String(diff);
  const efficiency = plan > 0 ? `${Math.floor((actual / plan) * 100)}%` : "0%";

  let summaryPage = document.getElementById("summaryPage");
  if (!summaryPage) {
    summaryPage = document.createElement("div");
    summaryPage.id = "summaryPage";
    summaryPage.className = "summary-page";
    document.body.appendChild(summaryPage);
  }

  summaryPage.innerHTML = `
    <div class="summary-head">Daily Summary</div>
    <div class="summary-filter-row">
      <label for="summaryDayFilter">Date</label>
      <input type="date" id="summaryDayFilter" title="Select date for daily summary">
      <button type="button" id="summaryDayTodayBtn" class="summary-today-btn">Today</button>
    </div>
    <div class="summary-grid">
      <div class="summary-tile"><span>Date</span><strong>${formatIsoDateAsDmy(activeDay)}</strong></div>
      <div class="summary-tile"><span>Plan</span><strong>${plan}</strong></div>
      <div class="summary-tile"><span>Actual</span><strong>${actual}</strong></div>
      <div class="summary-tile"><span>Expected</span><strong>${expected}</strong></div>
      <div class="summary-tile"><span>Difference</span><strong>${diffDisplaySafe}</strong></div>
      <div class="summary-tile"><span>Downtime</span><strong>${downtime}</strong></div>
      <div class="summary-tile"><span>Efficiency</span><strong>${efficiency}</strong></div>
    </div>
    <div class="summary-table-wrap">
      <table>
        <thead>
          <tr>
            <th>No</th><th>Date</th><th>Time</th><th>Lot</th><th>Model</th><th>Chassis</th><th>Engine No</th><th>Key No</th><th>Status</th><th>Downtime</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;
  syncSummaryDayPickerUi();
  const summaryDayFilter = document.getElementById("summaryDayFilter");
  const summaryDayTodayBtn = document.getElementById("summaryDayTodayBtn");
  if (summaryDayFilter) summaryDayFilter.addEventListener("change", onSummaryDayFilterChange);
  if (summaryDayTodayBtn) summaryDayTodayBtn.addEventListener("click", onSummaryDayTodayClick);

  document.body.classList.add("summary-mode");
  document.body.classList.remove("graph-mode");
  document.body.classList.remove("history-mode");
  const graphPage = document.getElementById("graphPage");
  if (graphPage) graphPage.classList.remove("open");
  const historyPanel = document.getElementById("historyPanel");
  if (historyPanel) historyPanel.classList.remove("open");
  summaryPage.classList.add("open");
  triggerEnterAnimation(summaryPage);
  updateViewToggleMenuItem();
}

function triggerEnterAnimation(el) {
  if (!el) return;
  el.classList.remove("enter-anim");
  // Force reflow so animation can replay each time.
  void el.offsetWidth;
  el.classList.add("enter-anim");
}

document.addEventListener("click", (event) => {
  const menu = document.getElementById("menuDropdown");
  const menuBtn = event.target.closest(".menu-btn");
  const clickedMenu = event.target.closest("#menuDropdown");

  if (menu && menu.classList.contains("open") && !menuBtn && !clickedMenu) {
    toggleMenuDropdown(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    toggleMenuDropdown(false);
    if (document.body.classList.contains("history-mode")) {
      showMainPage();
    }
  }
});

/* ===== RAMADHAN TOGGLE ===== */

function toggleRamadan() {
  ramadanMode = !ramadanMode;

  const btn = document.getElementById("ramadanToggle");
  if (!btn) return;

  if (ramadanMode) {
    btn.innerText = "🌙 Ramadhan : ON";
  } else {
    btn.innerText = "🌙 Ramadhan : OFF";
  }
  // Keep menu item visual style consistent (no forced ON/OFF background fill).
  btn.style.background = "";

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

  const efficiency = efficiencyPercent;

  const balance = actual - plan;
  const status = document.getElementById("status").innerText.trim();
  const lotNo = document.getElementById("lotInput").value || "";
  const bookedDowntime = getBookedDowntimeSec();
  const liveStatePayload = {
    plan: plan,
    dailyPlan: plan,
    cycleTimeMin: cycleTimeMin,
    actual: actual,
    balance: balance,
    lotNo: lotNo,
    status: status,
    countdown: countdownValue,
    bookedDowntime: bookedDowntime,
    totalDowntime: bookedDowntime,
    downtimeDay: getActiveDowntimeDayKey(),
    expected: expected,
    delay: delay,
    efficiency: efficiency,
    firstScanAtMs: firstScanAtMs,
    lastScanAtMs: lastScanTime ? lastScanTime.getTime() : null
  };

  saveLocalLiveStateSnapshot(liveStatePayload);

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
      totalDowntime: bookedDowntime,
      downtimeDay: getActiveDowntimeDayKey(),
      expected: expected,
      delay: delay,
      efficiency: efficiency
    })
  });

  publishLiveStateToFirebase(liveStatePayload);
}

function sendToSheet(chassis, model, engine, key, lot, status, downtimeEvent) {
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const actual = actualCount;

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
      // Keep scan row payload in strict sheet column order.
      downtimeEvent: downtimeEvent
    })
  })
    .catch(err => console.log("Sheet error:", err));
}

function cleanDowntime(raw) {
  if (raw == null || raw === "") return "";
  const sec = parseMmSsToSeconds(raw);
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

function inferStatusColumnIndex(scanRows) {
  if (!scanRows || scanRows.length === 0) return -1;
  let bestIdx = -1;
  let bestScore = 0;
  const sample = scanRows.slice(0, Math.min(scanRows.length, 25));
  sample.forEach(row => {
    row.forEach((value, idx) => {
      const t = String(value || "").trim().toUpperCase();
      if (t === "SCANNED" || t === "DOWN TIME") {
        const score = (t === "DOWN TIME") ? 2 : 1;
        if (score > 0) {
          const next = (bestIdx === idx ? bestScore : 0) + score;
          if (next > bestScore) {
            bestScore = next;
            bestIdx = idx;
          }
        }
      }
    });
  });
  return bestScore > 0 ? bestIdx : -1;
}

function looksLikeDurationToken(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;
  if (/^\d{1,4}[:.]\d{1,2}([:.]\d{1,2})?$/.test(t)) return true;
  if (/T\d{2}:\d{2}:\d{2}/.test(t) && (t.includes("1899") || t.includes("1900"))) return true;
  return false;
}

function pickBestDowntimeValue(row, primaryIdx, candidateIdxs, legacyLayout) {
  if (legacyLayout) return row[7] || "";

  // In header-based layouts, trust the explicit downtime-event column first.
  // This keeps monitor values exactly aligned with Google Sheet and prevents
  // accidental picks from time/date columns when payload shape changes.
  if (primaryIdx >= 0) {
    const primaryRaw = row[primaryIdx];
    return primaryRaw == null ? "" : primaryRaw;
  }

  // If there is no explicit primary index, use the first non-empty downtime-like
  // candidate column (already filtered to avoid total/accumulator headers).
  for (const i of candidateIdxs) {
    if (i < 0) continue;
    const raw = row[i];
    if (raw == null || String(raw).trim() === "") continue;
    return raw;
  }

  return "";
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
      const idxPlan = getIdx("daily plan", "plan", "dailyplan", "target");
      const idxModel = getIdx("model");
      const idxChassis = getIdx("chassis");
      const idxEngine = getIdx("engine", "engine no", "engine no.");
      const idxKey = getIdx("key", "key no", "key no.");
      const idxStatusByHeader = getIdx("status", "state");
      const idxStatus = idxStatusByHeader >= 0 ? idxStatusByHeader : inferStatusColumnIndex(scanRows);
      const idxDowntime = resolveDowntimeEventColumnIndex(scanHeader);
      const downtimeCandidateIdxs = resolveDowntimeCandidateIndices(scanHeader);
      const legacyLayout = idxStatusByHeader < 0 && idxStatus < 0;
      const table = document.getElementById("scanTable");

      // Convert to string for comparison
      const newTableData = JSON.stringify(scanRows);

      if (newTableData !== lastTableData) {
        lastTableData = newTableData;

        table.innerHTML = "";

        scanRows.sort((a, b) => {
          const ta = a && a[0] ? new Date(a[0]).getTime() : 0;
          const tb = b && b[0] ? new Date(b[0]).getTime() : 0;
          return tb - ta;
        });

        scanRows.forEach(row => {
          const newRow = table.insertRow();

          const fullDateTime = new Date(row[0]);
          newRow.insertCell(0).innerText = "";
          newRow.insertCell(1).innerText = fullDateTime.toLocaleDateString("en-GB");
          newRow.insertCell(2).innerText = fullDateTime.toLocaleTimeString("en-GB", {
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
          }).toLowerCase();

          newRow.insertCell(3).innerText = legacyLayout
            ? (row[1] || "-")
            : idxLot >= 0
              ? (row[idxLot] || "-")
              : "-";
          newRow.insertCell(4).innerText = legacyLayout
            ? (row[2] || "-")
            : idxModel >= 0
              ? (row[idxModel] || "-")
              : "-";
          newRow.insertCell(5).innerText = legacyLayout
            ? (row[3] || "-")
            : idxChassis >= 0
              ? (row[idxChassis] || "-")
              : "-";
          newRow.insertCell(6).innerText = legacyLayout
            ? (row[4] || "-")
            : idxEngine >= 0
              ? (row[idxEngine] || "-")
              : "-";
          newRow.insertCell(7).innerText = legacyLayout
            ? (row[5] || "-")
            : idxKey >= 0
              ? (row[idxKey] || "-")
              : "-";

          const statusCell = newRow.insertCell(8);
          const statusText = legacyLayout ? (row[6] || "") : idxStatus >= 0 ? (row[idxStatus] || "") : "";
          statusCell.innerText = statusText;

          if (statusText === "SCANNED") statusCell.className = "status-green";
          if (statusText === "DOWN TIME") statusCell.className = "status-red";

          const downtimeCell = newRow.insertCell(9);

          if (statusText === "DOWN TIME") {
            const rawDowntime = pickBestDowntimeValue(row, idxDowntime, downtimeCandidateIdxs, legacyLayout);
            const cleaned = cleanDowntime(rawDowntime);
            downtimeCell.innerText = cleaned;
            downtimeCell.className = "status-red";
          } else {
            downtimeCell.innerText = "";
          }
          newRow.dataset.scanDate = Number.isFinite(fullDateTime.getTime())
            ? toIsoDateLocal(fullDateTime)
            : parseDisplayDateToIsoKey(newRow.cells[1]?.innerText);
          const rawPlan = idxPlan >= 0 ? row[idxPlan] : "";
          const planVal = parseInt(String(rawPlan ?? "").trim(), 10);
          newRow.dataset.scanPlan = Number.isFinite(planVal) && planVal > 0 ? String(planVal) : "";
        });
        renumberScanTable();
        applyHistoryDateFilter();
        syncDowntimeSecondsFromTable();
        refreshDowntimeCardFromTable();
      }
      // Always keep accumulated downtime card synced to rendered rows,
      // even when table data payload is unchanged (e.g. timer stopped/target achieved).
      refreshDowntimeCardFromTable();
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

const downtimeDayFilterEl = document.getElementById("downtimeDayFilter");
const downtimeDayTodayBtn = document.getElementById("downtimeDayTodayBtn");
if (downtimeDayFilterEl) {
  downtimeDayFilterEl.addEventListener("change", onDowntimeDayFilterChange);
}
if (downtimeDayTodayBtn) {
  downtimeDayTodayBtn.addEventListener("click", onDowntimeDayTodayClick);
}
const downtimeCard = document.getElementById("downtimeCard");
if (downtimeCard) {
  downtimeCard.addEventListener("dblclick", () => toggleDowntimeDateFilter());
}
const historyDayFilterEl = document.getElementById("historyDayFilter");
const historyDayTodayBtn = document.getElementById("historyDayTodayBtn");
if (historyDayFilterEl) {
  historyDayFilterEl.addEventListener("change", onHistoryDayFilterChange);
}
if (historyDayTodayBtn) {
  historyDayTodayBtn.addEventListener("click", onHistoryDayTodayClick);
}

window.onload = async function() {
  // 🔐 MUST WAIT ACCESS CHECK
  const allowed = await checkAccess();
  if (!allowed) return;

  syncDowntimeDayPickerUi();
  toggleDowntimeDateFilter(false);

  updateDateTime();
  setInterval(updateDateTime, 1000);
  initFirebaseSync();
  loadInitialLiveState();

  if (isMonitor) {
    document.body.classList.add("monitor-mode");

    const monitorCard = document.querySelector(".bottom-row .card.wide");
    if (monitorCard) {
      const monitorTitle = monitorCard.querySelector("h3");
      if (monitorTitle) monitorTitle.textContent = "CONNECTION STATUS";
      const scanGrid = monitorCard.querySelector(".scan-grid");
      if (scanGrid) {
        scanGrid.innerHTML = `
          <div class="monitor-status-wrap">
            <div class="monitor-only-text">MONITOR ONLY</div>
            <div id="monitorConnectionStatus" class="monitor-connection-badge">LIVE</div>
          </div>
        `;
      }
    }

    const chassisInput = document.getElementById("chassisInput");
    const modelInput = document.getElementById("modelInput");
    const engineInput = document.getElementById("engineInput");
    const keyInput = document.getElementById("keyInput");
    if (chassisInput) chassisInput.style.display = "none";
    if (modelInput) modelInput.style.display = "none";
    if (engineInput) engineInput.style.display = "none";
    if (keyInput) keyInput.style.display = "none";

    document.getElementById("cycleTarget").readOnly = true;
    document.getElementById("dailyPlanTarget").readOnly = true;

    // Dashboard cards/status: Firebase realtime listener source of truth
    // (attached in initFirebaseSync). Avoid duplicate polling reads.
    loadMonitorStateFromFirebase();

    // Scan table rows: Google Sheet source of truth.
    loadLiveData();
    setInterval(loadLiveData, 3000);
    updateMonitorDataNotice();
  } else {
    // IMPORTANT:
    // On refresh, do not immediately publish "READY + countdown 0" to Firebase,
    // otherwise it can overwrite an in-progress RUNNING state before we finish
    // reading and applying the existing live state.
    //
    // We only start publishing after user interaction (inputs / scans) sets
    // hasLocalSession = true, OR after live state has been loaded.

    // Reload scan history from Sheet after refresh (main screen).
    loadLiveData();
    setInterval(loadLiveData, 3000);
    setInterval(() => {
      if (!initialLiveStateLoaded && !hasLocalSession) return;
      updateLiveStateOnly();
    }, 2000);
  }
  updateViewToggleMenuItem();
};
