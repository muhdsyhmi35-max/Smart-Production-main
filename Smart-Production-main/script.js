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
  },

  /**
   * PRODUCTION TREND / report totals: when to draw a blue Target bar without a per-day plan in history.
   * Default: no scans + no saved plan → target 0 (Daily Plan is not copied onto blank weekdays).
   * Legacy: set implicitDailyPlanOnInactiveWeekdays true to assume Daily Plan on inactive weekdays.
   */
  productionTrend: {
    implicitDailyPlanOnInactiveWeekdays: false,
    zeroTargetOnInactiveWeekends: true
  },
  shiftSchedule: {
    startMinute: (8 * 60),      // 08:00
    endMinute: (17 * 60) + 30,  // 17:30
    enableAutoWindow: true
  }
};

/* ===== VARIABLES ===== */

let ramadanMode = false;
let timer = null;
let countdownValue = 0;
let actualCount = 0;
let downtimeSeconds = 0;
let graphFilterDate = null;
let graphPeriod = "week";
let graphWtPreset = "normal";
let graphRangeStartDate = null;
let graphRangeEndDate = null;
let graphFocusedDayKey = null; // when clicking Production Trend, cards show this day only
let graphReportCache = null; // cached maps for the currently rendered Production Report range
let historyFilterDate = null;
let summaryFilterDate = null;
let lastScanTime = null;
/** Wall-clock ms of last completed key scan; never shifted for breaks (used for downtime + countdown). */
let lastScanWallMs = null;
let startTime = null;
let firstScanAtMs = null;
let isDowntime = false;
let pendingChassis = "";
let pendingModel = "";
let pendingEngine = "";
let pendingKey = "";
/** Completed 4-scan units for today (visible history rows only). */
let scannedUnits = new Set();

/** Same value in sheet vs scanner may differ by case/spaces; use for duplicate checks only. */
function normalizeScanId(value) {
  return String(value || "").trim().toUpperCase();
}

function isUsableScanId(value) {
  const id = normalizeScanId(value);
  return id.length > 0 && id !== "-";
}

/** Fingerprint of one completed 4-scan unit (chassis + engine + key). */
function unitScanFingerprint(chassis, engine, key) {
  return [
    normalizeScanId(chassis),
    normalizeScanId(engine),
    normalizeScanId(key)
  ].join("|");
}
const GRAPH_WT_PRESET_MINS = {
  normal: 460,
  halfday: 300,
  friday: 400
};
const GRAPH_WT_PRESET_STORAGE_KEY = "TF2_GRAPH_WT_PRESET";
const NON_PRODUCTION_DAYS_KEY = "TF2_NON_PRODUCTION_DAYS";
let duplicateLock = false;
let lastUpdateTime = 0;
let lastTableData = "";
let efficiencyPercent = 0;
const DEBUG_DOWNTIME = false;
let firebaseDb = null;
let firebaseCommandRef = null;
let firebaseLiveStateRef = null;
let firebaseShiftScheduleRef = null;
let isApplyingRemoteCommand = false;
let hasLocalSession = false;
/** Operator: avoid calendar-day reset until first Firebase live-state read completes (prevents stale overwrite). */
let initialLiveStateHydrated = false;
let liveCountdownInterval = null;
let clockInterval = null;
let liveDataPollInterval = null;
let liveStatePollInterval = null;
let monitorFirebaseNetConnected = false;
let monitorLiveStateReceived = false;
let monitorLiveStateError = null;
let shiftScheduleInterval = null;
let overtimeUntilMs = null;
const syncClientId = localStorage.getItem("SYNC_CLIENT_ID") || ("SYNC-" + Math.random().toString(36).slice(2));
localStorage.setItem("SYNC_CLIENT_ID", syncClientId);

const APP_ROLE_STORAGE_KEY = "TF2_DASHBOARD_ROLE";
const APP_ADMIN_SESSION_KEY = "TF2_ADMIN_SESSION_OK";
const SHIFT_SCHEDULE_STORAGE_KEY = "TF2_SHIFT_SCHEDULE";
/** Tracks crossing into / out of the configured shift window (localStorage). */
const SHIFT_WINDOW_STATE_KEY = "TF2_SHIFT_WINDOW_STATE";
/** ISO date + shift bounds — new calendar shift session even if window state was stuck "in". */
const SHIFT_PERIOD_KEY = "TF2_SHIFT_ACTIVE_PERIOD";
/** Last local calendar day (YYYY-MM-DD) when operator dashboard was synced — rollover triggers reset. */
const DASHBOARD_CALENDAR_DAY_KEY = "TF2_DASHBOARD_CALENDAR_DAY";

/** Change these credentials for your deployment (client-side only; not secret from devtools). */
const ADMIN_LOGIN = {
  user: "admin",
  pass: "1400"
};

function getAppRole() {
  try {
    const v = sessionStorage.getItem(APP_ROLE_STORAGE_KEY);
    if (v !== "admin") return "operator";
    if (sessionStorage.getItem(APP_ADMIN_SESSION_KEY) !== "1") {
      sessionStorage.setItem(APP_ROLE_STORAGE_KEY, "operator");
      return "operator";
    }
    return "admin";
  } catch {
    return "operator";
  }
}

function isAdminRole() {
  return getAppRole() === "admin";
}

function setAppRole(role) {
  if (role === "admin") return;
  try {
    sessionStorage.removeItem(APP_ADMIN_SESSION_KEY);
    sessionStorage.setItem(APP_ROLE_STORAGE_KEY, "operator");
  } catch (_) {}
  applyAppRoleUi();
}

function grantAdminAfterLogin() {
  try {
    sessionStorage.setItem(APP_ADMIN_SESSION_KEY, "1");
    sessionStorage.setItem(APP_ROLE_STORAGE_KEY, "admin");
  } catch (_) {}
  applyAppRoleUi();
}

function showAdminLoginModal() {
  const overlay = document.getElementById("adminLoginOverlay");
  if (!overlay) return;
  const err = document.getElementById("adminLoginError");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const pass = document.getElementById("adminLoginPass");
  const user = document.getElementById("adminLoginUser");
  if (pass) pass.value = "";
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => (user || pass)?.focus());
}

function closeAdminLoginModal() {
  const overlay = document.getElementById("adminLoginOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  const pass = document.getElementById("adminLoginPass");
  if (pass) pass.value = "";
}

function onAdminLoginBackdropClick(event) {
  if (event.target === event.currentTarget) closeAdminLoginModal();
}

function submitAdminLogin() {
  const u = document.getElementById("adminLoginUser")?.value?.trim() || "";
  const p = document.getElementById("adminLoginPass")?.value || "";
  const err = document.getElementById("adminLoginError");
  if (u === ADMIN_LOGIN.user && p === ADMIN_LOGIN.pass) {
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    closeAdminLoginModal();
    grantAdminAfterLogin();
    return;
  }
  if (err) {
    err.textContent = "Invalid user ID or password.";
    err.hidden = false;
  }
}

function syncRoleDropdownAria() {
  const trigger = document.getElementById("roleTrigger");
  const dd = document.getElementById("roleDropdown");
  if (!trigger || !dd) return;
  trigger.setAttribute("aria-expanded", dd.classList.contains("open") ? "true" : "false");
}

function applyAppRoleUi() {
  const admin = isAdminRole();
  document.body.classList.toggle("role-admin", admin);
  document.body.classList.toggle("role-operator", !admin);
  const label = document.getElementById("roleLabel");
  if (label) label.textContent = admin ? "Admin" : "Operator";
  document.querySelectorAll(".header-role-option").forEach(btn => {
    const role = btn.getAttribute("data-role");
    const sel = (admin && role === "admin") || (!admin && role === "operator");
    btn.setAttribute("aria-selected", sel ? "true" : "false");
    btn.classList.toggle("selected", sel);
  });
  if (!admin) {
    toggleMenuDropdown(false);
    toggleRoleDropdown(false);
    if (
      document.body.classList.contains("summary-mode") ||
      document.body.classList.contains("graph-mode") ||
      document.body.classList.contains("history-mode")
    ) {
      showMainPage();
    }
  }
  if (isMonitor && document.body.classList.contains("monitor-mode")) {
    const wantedLayout = admin ? MONITOR_LAYOUT_OPERATOR_MIRROR_KEY : MONITOR_LAYOUT_LEGACY_KEY;
    const currentLayout = document.body.dataset.monitorLayout || "";
    if (currentLayout && currentLayout !== wantedLayout) {
      window.location.reload();
      return;
    }
  }
  syncRoleDropdownAria();
  syncGraphWtControl();
}

function toggleRoleDropdown(forceOpen) {
  const dd = document.getElementById("roleDropdown");
  const trigger = document.getElementById("roleTrigger");
  if (!dd || !trigger) return;
  let open;
  if (typeof forceOpen === "boolean") {
    open = forceOpen;
  } else {
    open = !dd.classList.contains("open");
  }
  dd.classList.toggle("open", open);
  dd.setAttribute("aria-hidden", open ? "false" : "true");
  syncRoleDropdownAria();
}

function onRoleTriggerClick(event) {
  event.stopPropagation();
  toggleRoleDropdown();
}

function onRoleOptionClick(event, role) {
  event.stopPropagation();
  toggleRoleDropdown(false);
  if (role === "admin") {
    if (isAdminRole()) return;
    showAdminLoginModal();
    return;
  }
  setAppRole("operator");
}

function isNonProductionMode() {
  return graphWtPreset === "nonproduction";
}

function loadNonProductionDaysSet() {
  try {
    const raw = localStorage.getItem(NON_PRODUCTION_DAYS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)) : []);
  } catch (_) {
    return new Set();
  }
}

function saveNonProductionDaysSet(daySet) {
  try {
    localStorage.setItem(NON_PRODUCTION_DAYS_KEY, JSON.stringify([...daySet]));
  } catch (_) {}
}

function markNonProductionDay(dayKey, active) {
  if (!dayKey) return;
  const set = loadNonProductionDaysSet();
  if (active) set.add(dayKey);
  else set.delete(dayKey);
  saveNonProductionDaysSet(set);
}

function syncNonProductionDayMarkForToday() {
  markNonProductionDay(toIsoDateLocal(new Date()), isNonProductionMode());
}

/** True for ISO day keys marked non-production (includes today while mode is active). */
function isNonProductionDay(dayKey) {
  if (!dayKey) return isNonProductionMode();
  const today = toIsoDateLocal(new Date());
  if (dayKey === today && isNonProductionMode()) return true;
  return loadNonProductionDaysSet().has(dayKey);
}

function normalizeGraphWtPreset(v) {
  const x = String(v || "").trim().toLowerCase();
  if (x === "halfday" || x === "half-day") return "halfday";
  if (x === "nonproduction" || x === "non-production" || x === "non production") return "nonproduction";
  return "normal";
}

function getGraphWtPresetLabel(preset) {
  if (preset === "halfday") return "Half Day";
  if (preset === "nonproduction") return "Non Production";
  return "Normal Hour";
}

function loadGraphWtPresetFromStorage() {
  try {
    const stored = localStorage.getItem(GRAPH_WT_PRESET_STORAGE_KEY);
    if (stored) graphWtPreset = normalizeGraphWtPreset(stored);
  } catch (_) {}
  if (graphWtPreset === "friday") graphWtPreset = "normal";
  syncNonProductionDayMarkForToday();
}

function saveGraphWtPresetToStorage() {
  try {
    localStorage.setItem(GRAPH_WT_PRESET_STORAGE_KEY, graphWtPreset);
  } catch (_) {}
}

function setScanInputsEnabled(enabled) {
  ["chassisInput", "modelInput", "engineInput", "keyInput"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !enabled;
    el.readOnly = !enabled;
    el.classList.toggle("scan-disabled", !enabled);
    if (!enabled) el.blur();
  });
}

function applyNonProductionMode() {
  if (isMonitor) return;
  document.body.classList.add("non-production-mode");
  clearInterval(timer);
  timer = null;
  isDowntime = false;
  duplicateLock = false;
  pendingChassis = "";
  pendingModel = "";
  pendingEngine = "";
  pendingKey = "";
  setScanInputsEnabled(false);
  setStatus("NON PRODUCTION", "status-orange");
  updateDisplay();
  updateLiveStateOnly();
}

function applyGraphWtPresetEffects(prevPreset) {
  if (isMonitor) {
    applyGraphWtControlUi();
    return;
  }
  if (isNonProductionMode()) {
    applyNonProductionMode();
    return;
  }
  document.body.classList.remove("non-production-mode");
  setScanInputsEnabled(true);
  if (prevPreset === "nonproduction") {
    updateDisplay();
    updateLiveStateOnly();
  }
}

function syncGraphWtDropdownAria() {
  const trigger = document.getElementById("graphWtTrigger");
  const dd = document.getElementById("graphWtDropdown");
  if (!trigger || !dd) return;
  trigger.setAttribute("aria-expanded", dd.classList.contains("open") ? "true" : "false");
}

function toggleGraphWtDropdown(forceOpen) {
  const dd = document.getElementById("graphWtDropdown");
  const trigger = document.getElementById("graphWtTrigger");
  if (!dd || !trigger) return;
  let open;
  if (typeof forceOpen === "boolean") {
    open = forceOpen;
  } else {
    open = !dd.classList.contains("open");
  }
  dd.classList.toggle("open", open);
  dd.setAttribute("aria-hidden", open ? "false" : "true");
  syncGraphWtDropdownAria();
}

function onGraphWtTriggerClick(event) {
  event.stopPropagation();
  toggleGraphWtDropdown();
}

function applyGraphWtControlUi() {
  if (graphWtPreset === "friday") graphWtPreset = "normal";
  const preset = normalizeGraphWtPreset(graphWtPreset);
  graphWtPreset = preset;
  const label = document.getElementById("graphWtLabel");
  if (label) label.textContent = getGraphWtPresetLabel(preset);
  document.querySelectorAll(".header-wt-option").forEach(btn => {
    const w = normalizeGraphWtPreset(btn.getAttribute("data-wt"));
    const sel = w === preset;
    btn.setAttribute("aria-selected", sel ? "true" : "false");
    btn.classList.toggle("selected", sel);
  });
}

function onGraphWtOptionClick(event, preset) {
  event.stopPropagation();
  toggleGraphWtDropdown(false);
  const p = normalizeGraphWtPreset(preset);
  if (graphWtPreset === p) return;
  const prev = graphWtPreset;
  graphWtPreset = p;
  saveGraphWtPresetToStorage();
  syncNonProductionDayMarkForToday();
  applyGraphWtControlUi();
  applyGraphWtPresetEffects(prev);
  renderGraphCharts();
}

/* ================= GOOGLE SHEET MIRROR LAYER ================= */

// 🔴 GANTI DENGAN LINK /exec WEB APP ANDA
const API_URL = "https://script.google.com/macros/s/AKfycbwwLUYjoT7GH0sfFCGZMJoeLApmPWWKEF5LsdNqvkRpstZjerG9d3zG78bh0RTA1Fu48Q/exec";

// Detect monitor mode (?monitor)
const isMonitor = window.location.search.includes("monitor");
const MONITOR_LAYOUT_DATASET_KEY = "monitorLayoutV1";
const MONITOR_LAYOUT_LEGACY_KEY = "monitorLegacy";
/** Admin monitor (?monitor): same dashboard + bottom row as operator TV layout (no compact grid). */
const MONITOR_LAYOUT_OPERATOR_MIRROR_KEY = "monitorOperatorMirror";
const FIREBASE_COMMAND_PATH = "production/commands/latest";
const FIREBASE_LIVE_STATE_PATH = "production/liveState";
/** Operator (main) writes; ?monitor PCs read and mirror local shift / auto-window. */
const FIREBASE_SHIFT_SCHEDULE_PATH = "production/shiftSchedule";
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

/* ===== MONITOR TV LAYOUT (?monitor only) ===== */

function applyMonitorDashboardLayout() {
  if (!isMonitor || document.body.dataset.monitorLayout === MONITOR_LAYOUT_DATASET_KEY) return;
  const dock = document.getElementById("monitorConnectionDock");
  const dashboard = document.querySelector(".dashboard");
  if (!dock || !dashboard) return;

  const lineCard = document.querySelector("#status")?.closest(".card.wide");
  const downtimeCard = document.getElementById("downtimeCard");
  const efficiencyCard = document.querySelector("#efficiency")?.closest(".card");
  const planCard = document.querySelector("#plan")?.closest(".card");
  const balanceCard = document.querySelector("#balance")?.closest(".card");
  if (!lineCard || !downtimeCard || !planCard || !balanceCard || !efficiencyCard) return;

  document.body.dataset.monitorLayout = MONITOR_LAYOUT_DATASET_KEY;
  document.body.classList.add("monitor-layout-active");
  dashboard.classList.add("monitor-dashboard-relayout");

  dock.innerHTML = `
    <div class="monitor-status-wrap monitor-connection-dock-inner">
      <div class="monitor-only-text">MONITOR ONLY</div>
      <div id="monitorConnectionStatus" class="monitor-connection-badge">LIVE</div>
    </div>
  `;

  ["countdown", "actual", "expected", "delay"].forEach((id, i) => {
    const c = document.getElementById(id)?.closest(".card");
    if (c) {
      c.classList.add("monitor-grid-top");
      c.classList.add("monitor-top-" + (i + 1));
    }
  });

  const stack = document.createElement("div");
  stack.className = "monitor-downtime-eff-stack monitor-grid-downtime-stack";
  downtimeCard.parentNode.insertBefore(stack, downtimeCard);
  stack.appendChild(downtimeCard);

  planCard.classList.add("monitor-grid-plan");
  balanceCard.classList.add("monitor-grid-balance");

  lineCard.classList.remove("wide");
  lineCard.classList.add("monitor-grid-line-status", "monitor-line-status-card");
  dashboard.appendChild(lineCard);
}

/** Admin monitor: operator-style 4+4 dashboard cards + CONNECTION STATUS / LINE STATUS bottom row (inputs hidden by monitor-mode). */
function applyOperatorStyleMonitorDashboard() {
  if (!isMonitor || document.body.dataset.monitorLayout === MONITOR_LAYOUT_OPERATOR_MIRROR_KEY) return;

  document.body.dataset.monitorLayout = MONITOR_LAYOUT_OPERATOR_MIRROR_KEY;
  document.body.classList.remove("monitor-layout-active");
  document.body.classList.add("monitor-operator-dashboard");

  const dock = document.getElementById("monitorConnectionDock");
  if (dock) dock.innerHTML = "";

  const dashboard = document.querySelector(".dashboard");
  if (dashboard) dashboard.classList.remove("monitor-dashboard-relayout");

  const scanCard = document.querySelector(".bottom-row .card.wide:first-child");
  if (!scanCard) return;

  const title = scanCard.querySelector("h3");
  if (title) title.textContent = "CONNECTION STATUS";

  if (scanCard.querySelector(".monitor-inline-connection")) return;

  const wrap = document.createElement("div");
  wrap.className = "monitor-status-wrap monitor-inline-connection";
  wrap.innerHTML = `
      <div class="monitor-only-text">MONITOR ONLY</div>
      <div id="monitorConnectionStatus" class="monitor-connection-badge">LIVE</div>
    `;
  scanCard.appendChild(wrap);
}

function applyLegacyMonitorDashboardLayout() {
  if (!isMonitor) return;
  document.body.dataset.monitorLayout = MONITOR_LAYOUT_LEGACY_KEY;
  document.body.classList.remove("monitor-layout-active");
  document.body.classList.remove("monitor-operator-dashboard");

  const dock = document.getElementById("monitorConnectionDock");
  if (dock) dock.innerHTML = "";

  const monitorCard = document.querySelector(".bottom-row .card.wide");
  if (!monitorCard) return;
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

/* ===== FORMAT ===== */

function format(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

function toIsoDateLocal(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** Calendar day for downtime totals: matches History table date filter (rolling local \"today\" when cleared). */
function getActiveDowntimeDayKey() {
  return getActiveHistoryDayKey();
}

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

/** Local Saturday/Sunday for an ISO calendar day (YYYY-MM-DD). */
function isWeekendIsoDay(isoKey) {
  if (!isoKey) return false;
  const [y, m, d] = String(isoKey).split("-").map(v => parseInt(v, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
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

const datePickerRegistry = new WeakMap();

function destroyDatePicker(el) {
  const fp = datePickerRegistry.get(el);
  if (fp) {
    fp.destroy();
    datePickerRegistry.delete(el);
  }
}

function setDatePickerValue(el, isoDate) {
  if (!el) return;
  const fp = datePickerRegistry.get(el);
  if (fp) {
    if (isoDate) fp.setDate(isoDate, false);
    else fp.clear();
    return;
  }
  el.value = isoDate || "";
}

function initDatePicker(el, options = {}) {
  if (!el || typeof flatpickr !== "function") return null;
  destroyDatePicker(el);
  const userOnChange = options.onChange;
  const fp = flatpickr(el, {
    dateFormat: "Y-m-d",
    altInput: true,
    altFormat: "d/m/Y",
    altInputClass: "app-date-input",
    allowInput: false,
    disableMobile: true,
    monthSelectorType: "dropdown",
    animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ...options,
    onChange(selectedDates, dateStr, instance) {
      if (typeof userOnChange === "function") userOnChange(selectedDates, dateStr, instance);
    }
  });
  datePickerRegistry.set(el, fp);
  return fp;
}

function initGraphRangeDatePickers() {
  const startEl = document.getElementById("graphRangeStart");
  const endEl = document.getElementById("graphRangeEnd");
  if (!startEl || !endEl) return;

  let startFp;
  let endFp;

  endFp = initDatePicker(endEl, {
    onChange() {
      if (endEl.value) startFp?.set("maxDate", endEl.value);
      onGraphRangeFilterChange();
    }
  });
  startFp = initDatePicker(startEl, {
    onChange() {
      if (endEl.value) endFp?.set("minDate", startEl.value);
      onGraphRangeFilterChange();
    }
  });

  if (startEl.value) endFp.set("minDate", startEl.value);
  if (endEl.value) startFp.set("maxDate", endEl.value);
}

function initSingleDayDatePicker(el, onChange) {
  return initDatePicker(el, { onChange });
}

function syncGraphRangePickerUi() {
  const startEl = document.getElementById("graphRangeStart");
  const endEl = document.getElementById("graphRangeEnd");
  const range = getActiveGraphRange();
  setDatePickerValue(startEl, range.start);
  setDatePickerValue(endEl, range.end);
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
  graphPeriod = (period === "week" || period === "month") ? period : "week";
  // Anchor on the latest selected day to avoid landing on empty early dates
  // when toggling Day/Week/Month back-to-back.
  const anchor = graphRangeEndDate || graphRangeStartDate || getActiveGraphDayKey();
  graphFilterDate = anchor;
  const periodKeys = getPeriodDayKeys(anchor, graphPeriod);
  if (periodKeys.length) {
    graphRangeStartDate = periodKeys[0];
    graphRangeEndDate = periodKeys[periodKeys.length - 1];
  }
  syncGraphPeriodButtonsUi();
  syncGraphRangePickerUi();
  renderGraphCharts();
}

function syncGraphWtControl() {
  const headerExisting = document.getElementById("headerGraphWtWrap");
  if (headerExisting) headerExisting.remove();
  const controlsExisting = document.getElementById("controlsGraphWtWrap");
  if (controlsExisting) controlsExisting.remove();

  const inGraph = document.body.classList.contains("graph-mode");
  if (inGraph) return;
  const controlsBar = document.querySelector(".controls");
  if (!controlsBar) return;
  const actions = document.querySelector(".control-actions");

  const wrap = document.createElement("div");
  wrap.id = "controlsGraphWtWrap";
  wrap.className = "header-wt-dd-wrap controls-wt-wrap";
  wrap.innerHTML = `
    <button type="button" class="header-pill header-wt-trigger" id="graphWtTrigger" onclick="onGraphWtTriggerClick(event)" aria-expanded="false" aria-haspopup="listbox" aria-label="Select working time mode">
      <span class="header-pill-icon">⏱</span><span id="graphWtLabel">Normal Hour</span><span class="header-role-caret header-wt-caret" aria-hidden="true">▾</span>
    </button>
    <div class="header-wt-dropdown" id="graphWtDropdown" role="listbox" aria-labelledby="graphWtTrigger" aria-hidden="true">
      <button type="button" class="header-wt-option" data-wt="normal" role="option" onclick="onGraphWtOptionClick(event, 'normal')">Normal Hour</button>
      <button type="button" class="header-wt-option" data-wt="halfday" role="option" onclick="onGraphWtOptionClick(event, 'halfday')">Half Day</button>
      <button type="button" class="header-wt-option" data-wt="nonproduction" role="option" onclick="onGraphWtOptionClick(event, 'nonproduction')">Non Production</button>
    </div>
  `;

  if (isMonitor) {
    controlsBar.appendChild(wrap);
  } else if (actions) {
    actions.insertBefore(wrap, actions.firstChild);
  } else {
    controlsBar.appendChild(wrap);
  }
  applyGraphWtControlUi();
  syncGraphWtDropdownAria();
  if (isMonitor) return;
  if (isNonProductionMode()) applyNonProductionMode();
  else {
    document.body.classList.remove("non-production-mode");
    setScanInputsEnabled(true);
  }
}

function syncGraphPeriodButtonsUi() {
  const weekBtn = document.getElementById("graphPeriodWeekBtn");
  const monthBtn = document.getElementById("graphPeriodMonthBtn");
  [weekBtn, monthBtn].forEach(btn => btn && btn.classList.remove("active"));
  if (graphPeriod === "month" && monthBtn) monthBtn.classList.add("active");
  else if (weekBtn) weekBtn.classList.add("active");
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

function getActiveHistoryDayKey() {
  return historyFilterDate || toIsoDateLocal(new Date());
}

function syncHistoryDayPickerUi() {
  const el = document.getElementById("historyDayFilter");
  setDatePickerValue(el, getActiveHistoryDayKey());
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
  rebuildScannedSetsFromTable();
  refreshDowntimeCardFromTable();
}

function onHistoryDayTodayClick() {
  historyFilterDate = null;
  syncHistoryDayPickerUi();
  applyHistoryDateFilter();
  rebuildScannedSetsFromTable();
  refreshDowntimeCardFromTable();
}

function getActiveSummaryDayKey() {
  return summaryFilterDate || toIsoDateLocal(new Date());
}

function syncSummaryDayPickerUi() {
  const el = document.getElementById("summaryDayFilter");
  setDatePickerValue(el, getActiveSummaryDayKey());
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

/** Parse "MM:SS" (or "M:SS") from table / sheet display into seconds. */
function parseMmSsToSeconds(text) {
  if (text == null || text === "") return 0;
  const t = String(text).trim();
  if (!t || t === "00:00" || t === "0:00") return 0;

  // Google Sheets can return time duration as day-fraction decimal (e.g. 5s = 0.00005787...).
  // Detect long decimal fractions and convert from days -> seconds.
  const dayFractionMatch = t.match(/^(\d+)\.(\d+)$/);
  if (dayFractionMatch) {
    const whole = parseInt(dayFractionMatch[1], 10);
    const fraction = dayFractionMatch[2] || "";
    const asNumber = Number(t);
    if (Number.isFinite(asNumber) && fraction.length > 2) {
      const secFromDayFraction = Math.round(asNumber * 86400);
      return Math.max(secFromDayFraction, 0);
    }
    if (Number.isFinite(whole) && Number.isFinite(parseInt(fraction, 10))) {
      return Math.max((whole * 60) + parseInt(fraction, 10), 0);
    }
  }

  // Plain numeric values without separators are interpreted as seconds.
  if (!/[.:]/.test(t) && !isNaN(t)) {
    const sec = Math.round(Number(t));
    return Number.isFinite(sec) ? Math.max(sec, 0) : 0;
  }

  // Sheets often turns duration "04:27" (4m 27s) into clock time "4:27:00 AM".
  const sheetsClockDowntime = t.match(/^(\d{1,2}):(\d{2}):00(?:\.0+)?\s*(AM|PM)?$/i);
  if (sheetsClockDowntime) {
    const mins = parseInt(sheetsClockDowntime[1], 10);
    const secs = parseInt(sheetsClockDowntime[2], 10);
    if (Number.isFinite(mins) && Number.isFinite(secs) && mins < 60 && secs < 60) {
      return Math.max(mins * 60 + secs, 0);
    }
  }

  // Google Sheets date artifacts like 1899/1900 can be serialized as ISO strings.
  // Extract hh:mm:ss directly from the string to avoid timezone shifts.
  const sheetDateLike = t.includes("1899") || t.includes("1900");
  if (sheetDateLike) {
    const dt = new Date(t);
    if (Number.isFinite(dt.getTime())) {
      // Excel/Sheets duration serials around 1899/1900 can be emitted as UTC timestamps.
      // Convert by subtracting serial-zero anchor in UTC (captures historical timezone offset).
      const serialZeroUtcMs = Date.parse("1899-12-29T17:04:35.000Z");
      if (Number.isFinite(serialZeroUtcMs)) {
        const shiftedSec = Math.round((dt.getTime() - serialZeroUtcMs) / 1000);
        if (shiftedSec <= 0) return 0;
        // Some legacy payloads encode elapsed seconds as minute ticks from the anchor.
        // Example: 1899-12-30T01:55:35Z => shifted 31860, real duration 531s (8:51).
        if (shiftedSec % 60 === 0) {
          const collapsed = Math.floor(shiftedSec / 60);
          if (collapsed >= 0 && collapsed <= 12 * 3600) return collapsed;
        }
        return shiftedSec;
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

function isRowStatusDownTime(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim().toUpperCase();
  return s === "DOWN TIME" || s === "DOWNTIME";
}

/** Sum downtime from DOWN TIME rows on the same calendar day as the History filter (rolling \"today\" when cleared). */
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
    if (!isRowStatusDownTime(statusCell.innerText)) return;
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

function renumberScanTable() {
  const table = document.getElementById("scanTable");
  if (!table) return;
  Array.from(table.rows).forEach((tr, i) => {
    const noCell = tr.cells[0];
    if (noCell) noCell.innerText = String(i + 1);
  });
}

/** True when a history row belongs to the active History date filter (today when cleared). */
function scanTableRowMatchesActiveDay(tr) {
  if (!tr || !tr.cells || tr.cells.length < 2) return false;
  if (tr.style.display === "none") return false;
  const rowDay = tr.dataset.scanDate || parseDisplayDateToIsoKey(tr.cells[1]?.innerText);
  const dayKey = getActiveHistoryDayKey();
  return !!rowDay && rowDay === dayKey;
}

/** Duplicate checks use only completed rows for the active history day (matches visible table). */
function rebuildScannedSetsFromTable() {
  scannedUnits.clear();
  document.querySelectorAll("#scanTable tr").forEach(row => {
    if (!scanTableRowMatchesActiveDay(row)) return;
    const cells = row.cells;
    if (!cells || cells.length < 8) return;
    const chassis = (cells[5]?.innerText || "").trim();
    const engine = (cells[6]?.innerText || "").trim();
    const key = (cells[7]?.innerText || "").trim();
    if (isUsableScanId(chassis) && isUsableScanId(engine) && isUsableScanId(key)) {
      scannedUnits.add(unitScanFingerprint(chassis, engine, key));
    }
  });
}

function rejectDuplicateScan(message) {
  duplicateLock = true;
  setStatus(message, "status-red blink");
  pendingChassis = "";
  pendingModel = "";
  pendingEngine = "";
  pendingKey = "";
}

/** Heading + number turn red whenever accumulated downtime &gt; 0 (not only live DOWN TIME). */
function syncDowntimeAccumulatedHighlight() {
  const card = document.getElementById("downtimeCard");
  const textEl = document.getElementById("downtime");
  if (!card || !textEl) return;
  const sec = parseMmSsToSeconds(String(textEl.innerText || "").trim());
  card.classList.toggle("downtime-has-value", sec > 0);
}

function refreshDowntimeCardFromTable() {
  const table = document.getElementById("scanTable");
  const total = table && table.rows.length > 0
    ? sumBookedDowntimeFromScanTable()
    : 0;
  downtimeSeconds = total;
  document.getElementById("downtime").innerText = format(total);
  renderDowntimeDebugPanel();
  syncDowntimeAccumulatedHighlight();
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
      "background:#000000",
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
    const included = isRowStatusDownTime(status);
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

  maybeResetDashboardForNewCalendarDay();
}

/** Operator PC only: full dashboard reset when local calendar date rolls (midnight). */
function maybeResetDashboardForNewCalendarDay() {
  if (isMonitor) return;
  if (!initialLiveStateHydrated) return;
  const today = toIsoDateLocal(new Date());
  let stored = null;
  try {
    stored = localStorage.getItem(DASHBOARD_CALENDAR_DAY_KEY);
  } catch (_) {}

  if (stored === today) return;

  if (stored === null) {
    try {
      localStorage.setItem(DASHBOARD_CALENDAR_DAY_KEY, today);
    } catch (_) {}
    return;
  }

  try {
    localStorage.removeItem(SHIFT_WINDOW_STATE_KEY);
    localStorage.removeItem(SHIFT_PERIOD_KEY);
  } catch (_) {}

  resetProduction(false);
  try {
    localStorage.setItem(DASHBOARD_CALENDAR_DAY_KEY, today);
  } catch (_) {}
}

function getLocalMinuteOfDay(d = new Date()) {
  return (d.getHours() * 60) + d.getMinutes();
}

function isWithinShiftWindow(d = new Date()) {
  if (!SETTINGS.shiftSchedule.enableAutoWindow) return true;
  const minute = getLocalMinuteOfDay(d);
  return minute >= SETTINGS.shiftSchedule.startMinute && minute < SETTINGS.shiftSchedule.endMinute;
}

/** Local wall time (ms) when the configured shift starts on the same calendar day as `d`. */
function getTodayShiftStartMs(d = new Date()) {
  const startMin = SETTINGS.shiftSchedule.startMinute;
  const hh = Math.floor(startMin / 60) % 24;
  const mm = startMin % 60;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
}

function isOvertimeActive(d = new Date()) {
  return Number.isFinite(overtimeUntilMs) && d.getTime() < overtimeUntilMs;
}

function canRunProductionNow(d = new Date()) {
  return isWithinShiftWindow(d) || isOvertimeActive(d);
}

function setOffShiftStatus() {
  const text = isOvertimeActive(new Date()) ? "OVERTIME" : "OFF SHIFT";
  const cls = isOvertimeActive(new Date()) ? "status-orange" : "status-blue";
  setStatus(text, cls);
}

/** Unique key for one scheduled shift session on a calendar day (local operator TZ). */
function getShiftPeriodKey(d = new Date()) {
  return `${toIsoDateLocal(d)}_${SETTINGS.shiftSchedule.startMinute}_${SETTINGS.shiftSchedule.endMinute}`;
}

function applyShiftScheduleTick() {
  if (isMonitor || !SETTINGS.shiftSchedule.enableAutoWindow) return;
  if (isNonProductionMode()) {
    if (timer) stopProduction(false);
    setStatus("NON PRODUCTION", "status-orange");
    updateDisplay();
    updateLiveStateOnly();
    return;
  }
  const now = new Date();
  const inWindow = isWithinShiftWindow(now);
  const overtime = isOvertimeActive(now);
  const canRun = inWindow || overtime;

  if (inWindow) {
    const periodKey = getShiftPeriodKey(now);
    let prevState = null;
    let storedPeriod = null;
    try {
      prevState = localStorage.getItem(SHIFT_WINDOW_STATE_KEY);
      storedPeriod = localStorage.getItem(SHIFT_PERIOD_KEY);
    } catch (_) {}

    const freshStorage = prevState === null && storedPeriod === null;
    const outsideWindow = prevState !== "in";
    const newCalendarShift = storedPeriod != null && storedPeriod !== periodKey;

    if (freshStorage) {
      try {
        localStorage.setItem(SHIFT_WINDOW_STATE_KEY, "in");
        localStorage.setItem(SHIFT_PERIOD_KEY, periodKey);
      } catch (_) {}
    } else if (outsideWindow || newCalendarShift) {
      resetProduction(false);
      try {
        localStorage.setItem(SHIFT_WINDOW_STATE_KEY, "in");
        localStorage.setItem(SHIFT_PERIOD_KEY, periodKey);
      } catch (_) {}
    }
  } else {
    try {
      localStorage.setItem(SHIFT_WINDOW_STATE_KEY, "out");
      localStorage.removeItem(SHIFT_PERIOD_KEY);
    } catch (_) {}
  }

  if (!canRun) {
    if (timer) {
      stopProduction(false);
    }
    setOffShiftStatus();
    updateDisplay();
    updateLiveStateOnly();
    return;
  }

  if (!timer && document.getElementById("status")?.innerText?.trim() !== "PAUSED") {
    startProduction(false);
  }
}

function updateOvertimeMenuLabel() {
  const btn = document.getElementById("overtimeMenuItem");
  if (!btn) return;
  const active = isOvertimeActive(new Date());
  const endText = active ? ` until ${new Date(overtimeUntilMs).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })}` : " OFF";
  btn.innerHTML = `<span class="menu-icon">⏱</span><span>Overtime:${endText}</span>`;
}

function parseOvertimeEndTimeInput(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t || t === "0" || t === "off") return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return NaN;
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (end.getTime() <= now.getTime()) return NaN;
  return end.getTime();
}

function minuteToTimeString(minute) {
  const hh = Math.floor(minute / 60) % 24;
  const mm = minute % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseTimeToMinute(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return NaN;
  return (hh * 60) + mm;
}

function loadShiftScheduleFromStorage() {
  try {
    const raw = localStorage.getItem(SHIFT_SCHEDULE_STORAGE_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw);
    const start = parseInt(cfg.startMinute, 10);
    const end = parseInt(cfg.endMinute, 10);
    if (Number.isFinite(start) && start >= 0 && start < 1440) SETTINGS.shiftSchedule.startMinute = start;
    if (Number.isFinite(end) && end > 0 && end <= 1440) SETTINGS.shiftSchedule.endMinute = end;
    if (typeof cfg.enableAutoWindow === "boolean") SETTINGS.shiftSchedule.enableAutoWindow = cfg.enableAutoWindow;
  } catch (_) {}
}

function saveShiftScheduleToStorage() {
  try {
    localStorage.setItem(SHIFT_SCHEDULE_STORAGE_KEY, JSON.stringify({
      startMinute: SETTINGS.shiftSchedule.startMinute,
      endMinute: SETTINGS.shiftSchedule.endMinute,
      enableAutoWindow: SETTINGS.shiftSchedule.enableAutoWindow
    }));
  } catch (_) {}
}

function applyShiftScheduleFromRemote(payload) {
  if (!payload || typeof payload !== "object") return;
  const start = parseInt(payload.startMinute, 10);
  const end = parseInt(payload.endMinute, 10);
  if (!Number.isFinite(start) || start < 0 || start >= 1440) return;
  if (!Number.isFinite(end) || end <= 0 || end > 1440 || start >= end) return;
  const enableAutoWindow = payload.enableAutoWindow === true;
  SETTINGS.shiftSchedule.startMinute = start;
  SETTINGS.shiftSchedule.endMinute = end;
  SETTINGS.shiftSchedule.enableAutoWindow = enableAutoWindow;
  saveShiftScheduleToStorage();
  updateShiftMenuLabel();
  applyShiftScheduleTick();
}

/** Main operator only: push current shift to Firebase so monitors stay in sync. */
function publishShiftScheduleToFirebase() {
  if (!firebaseShiftScheduleRef || isMonitor) return;
  firebaseShiftScheduleRef.set({
    startMinute: SETTINGS.shiftSchedule.startMinute,
    endMinute: SETTINGS.shiftSchedule.endMinute,
    enableAutoWindow: !!SETTINGS.shiftSchedule.enableAutoWindow,
    sender: syncClientId,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    console.log("Firebase shift schedule publish error:", err);
  });
}

function updateShiftMenuLabel() {
  const btn = document.getElementById("shiftScheduleMenuItem");
  if (!btn) return;
  const on = SETTINGS.shiftSchedule.enableAutoWindow;
  const text = on
    ? `${minuteToTimeString(SETTINGS.shiftSchedule.startMinute)}-${minuteToTimeString(SETTINGS.shiftSchedule.endMinute)}`
    : "MANUAL";
  btn.innerHTML = `<span class="menu-icon">🕘</span><span>Shift: ${text}</span>`;
}

function ensureShiftMenuItem() {
  const menu = document.getElementById("menuDropdown");
  if (!menu || document.getElementById("shiftScheduleMenuItem")) return;
  const main = document.getElementById("mainPageMenuItem");
  const btn = document.createElement("button");
  btn.className = "menu-item";
  btn.id = "shiftScheduleMenuItem";
  btn.type = "button";
  btn.onclick = () => openShiftScheduleFromMenu();
  if (main && main.parentNode) {
    main.parentNode.insertBefore(btn, main.nextSibling);
  } else {
    menu.appendChild(btn);
  }
  updateShiftMenuLabel();
}

function ensureShiftScheduleModal() {
  if (document.getElementById("shiftScheduleOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "shiftScheduleOverlay";
  overlay.className = "admin-login-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.onclick = function(event) {
    if (event.target === overlay) closeShiftScheduleModal();
  };
  overlay.innerHTML = `
    <div class="admin-login-dialog" role="dialog" aria-modal="true" aria-labelledby="shiftScheduleTitle" onclick="event.stopPropagation()">
      <h2 id="shiftScheduleTitle" class="admin-login-title">Production Shift Settings</h2>
      <p id="shiftScheduleError" class="admin-login-error" hidden></p>
      <form class="admin-login-form" onsubmit="event.preventDefault(); submitShiftScheduleModal();">
        <label class="admin-login-label">
          <span>Start time</span>
          <input type="time" id="shiftStartTimeInput" step="60" />
        </label>
        <label class="admin-login-label">
          <span>End time</span>
          <input type="time" id="shiftEndTimeInput" step="60" />
        </label>
        <label class="admin-login-label">
          <span><input type="checkbox" id="shiftAutoWindowToggle" checked style="margin-right:8px;">Enable auto window</span>
        </label>
        <div class="admin-login-actions">
          <button type="submit" class="admin-login-submit">Save</button>
          <button type="button" class="admin-login-cancel" onclick="closeShiftScheduleModal()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
}

function openShiftScheduleModal() {
  ensureShiftScheduleModal();
  const overlay = document.getElementById("shiftScheduleOverlay");
  const start = document.getElementById("shiftStartTimeInput");
  const end = document.getElementById("shiftEndTimeInput");
  const toggle = document.getElementById("shiftAutoWindowToggle");
  const err = document.getElementById("shiftScheduleError");
  if (!overlay || !start || !end || !toggle) return;
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  start.value = minuteToTimeString(SETTINGS.shiftSchedule.startMinute);
  end.value = minuteToTimeString(SETTINGS.shiftSchedule.endMinute);
  toggle.checked = !!SETTINGS.shiftSchedule.enableAutoWindow;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => start.focus());
}

function closeShiftScheduleModal() {
  const overlay = document.getElementById("shiftScheduleOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

function openShiftScheduleFromMenu() {
  toggleMenuDropdown(false);
  openShiftScheduleModal();
}

function submitShiftScheduleModal() {
  const startIn = document.getElementById("shiftStartTimeInput");
  const endIn = document.getElementById("shiftEndTimeInput");
  const toggle = document.getElementById("shiftAutoWindowToggle");
  const err = document.getElementById("shiftScheduleError");
  if (!startIn || !endIn || !toggle) return;
  const start = parseTimeToMinute(startIn.value);
  const end = parseTimeToMinute(endIn.value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    if (err) {
      err.textContent = "Invalid shift time. End time must be after start time.";
      err.hidden = false;
    }
    return;
  }
  SETTINGS.shiftSchedule.startMinute = start;
  SETTINGS.shiftSchedule.endMinute = end;
  SETTINGS.shiftSchedule.enableAutoWindow = !!toggle.checked;
  saveShiftScheduleToStorage();
  publishShiftScheduleToFirebase();
  updateShiftMenuLabel();
  closeShiftScheduleModal();
  applyShiftScheduleTick();
}

function bindClockShiftShortcut() {
  const clockEl = document.getElementById("clock");
  if (!clockEl || clockEl.dataset.shiftShortcutBound === "1") return;
  clockEl.dataset.shiftShortcutBound = "1";
  clockEl.title = "Double-click to edit shift";
  clockEl.addEventListener("dblclick", () => {
    openShiftScheduleModal();
  });
}

function bindRamadanRevealShortcut() {
  const icon = document.querySelector(".menu-brand-icon");
  const ramadan = document.getElementById("ramadanToggle");
  if (!icon || !ramadan || icon.dataset.ramadanRevealBound === "1") return;
  icon.dataset.ramadanRevealBound = "1";
  icon.style.cursor = "pointer";
  icon.title = "Double-click to show or hide Ramadhan";
  icon.addEventListener("dblclick", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    ramadan.classList.toggle("menu-ramadan-hidden");
  });
}

function ensureOvertimeModal() {
  if (document.getElementById("overtimeOverlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "overtimeOverlay";
  overlay.className = "admin-login-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.onclick = function(event) {
    if (event.target === overlay) closeOvertimeModal();
  };
  overlay.innerHTML = `
    <div class="admin-login-dialog" role="dialog" aria-modal="true" aria-labelledby="overtimeTitle" onclick="event.stopPropagation()">
      <h2 id="overtimeTitle" class="admin-login-title">Set Overtime End Time</h2>
      <p id="overtimeError" class="admin-login-error" hidden></p>
      <form class="admin-login-form" onsubmit="event.preventDefault(); submitOvertimeModal();">
        <label class="admin-login-label">
          <span>End time (24-hour)</span>
          <input type="time" id="overtimeEndTimeInput" step="60" />
        </label>
        <div class="admin-login-actions">
          <button type="submit" class="admin-login-submit">Save</button>
          <button type="button" class="admin-login-cancel" onclick="disableOvertimeFromModal()">Disable</button>
          <button type="button" class="admin-login-cancel" onclick="closeOvertimeModal()">Cancel</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
}

function openOvertimeModal() {
  ensureOvertimeModal();
  const overlay = document.getElementById("overtimeOverlay");
  const input = document.getElementById("overtimeEndTimeInput");
  const err = document.getElementById("overtimeError");
  if (!overlay || !input) return;
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  if (isOvertimeActive(new Date())) {
    input.value = new Date(overtimeUntilMs).toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", hour12: false });
  } else {
    input.value = "";
  }
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => input.focus());
}

function closeOvertimeModal() {
  const overlay = document.getElementById("overtimeOverlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
}

function showOvertimeError(message) {
  const err = document.getElementById("overtimeError");
  if (!err) return;
  err.textContent = message;
  err.hidden = false;
}

function disableOvertimeFromModal() {
  overtimeUntilMs = null;
  updateOvertimeMenuLabel();
  closeOvertimeModal();
  applyShiftScheduleTick();
}

function submitOvertimeModal() {
  const input = document.getElementById("overtimeEndTimeInput");
  if (!input) return;
  const next = parseOvertimeEndTimeInput(input.value || "");
  if (Number.isNaN(next)) {
    showOvertimeError("Please select a future time.");
    return;
  }
  overtimeUntilMs = next;
  updateOvertimeMenuLabel();
  closeOvertimeModal();
  applyShiftScheduleTick();
}

function ensureOvertimeMenuItem() {
  const menu = document.getElementById("menuDropdown");
  if (!menu) return;
  const main = document.getElementById("mainPageMenuItem");
  const graph = document.getElementById("graphMenuItem");
  const daily = document.getElementById("dailySummaryMenuItem");
  const history = document.getElementById("historyMenuItem");
  const ramadan = document.getElementById("ramadanToggle");

  if (main && graph && graph.previousElementSibling !== main) {
    main.parentNode.insertBefore(graph, main.nextSibling);
  }
  if (graph && daily && daily.previousElementSibling !== graph) {
    graph.parentNode.insertBefore(daily, graph.nextSibling);
  }

  let btn = document.getElementById("overtimeMenuItem");
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "menu-item";
    btn.id = "overtimeMenuItem";
    btn.type = "button";
    btn.onclick = () => toggleOvertimeFromMenu();
    menu.appendChild(btn);
  }
  if (daily && btn.previousElementSibling !== daily) {
    daily.parentNode.insertBefore(btn, daily.nextSibling);
  }
  if (btn && ramadan && ramadan.previousElementSibling !== btn) {
    btn.parentNode.insertBefore(ramadan, btn.nextSibling);
  }
  if (ramadan && history && history.previousElementSibling !== ramadan) {
    ramadan.parentNode.insertBefore(history, ramadan.nextSibling);
  }
  updateOvertimeMenuLabel();
}

function toggleOvertimeFromMenu() {
  if (!isAdminRole()) return;
  toggleMenuDropdown(false);
  openOvertimeModal();
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

function getBreakWindowsForLocalDate(d) {
  const day = d.getDay();
  if (ramadanMode) {
    return day === 5 ? SETTINGS.breakTime.ramadan.friday : SETTINGS.breakTime.ramadan.weekday;
  }
  return day === 5 ? SETTINGS.breakTime.normal.friday : SETTINGS.breakTime.normal.weekday;
}

/** Seconds of scheduled break in [startMs, endMs] (local calendar, matches isBreakTime minute windows). */
function scheduledBreakOverlapSec(startMs, endMs) {
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
    const windows = getBreakWindowsForLocalDate(dayStart);
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

function isBreakTime() {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  for (const b of getBreakWindowsForLocalDate(now)) {
    if (current >= b.start && current < b.end) return true;
  }
  return false;
}

function calculateExpectedOutput() {
  if (isMonitor) return 0;

  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  if (actualCount >= plan && plan > 0) {
    return plan;
  }

  const shiftAuto = SETTINGS.shiftSchedule.enableAutoWindow;
  let timelineStartMs = null;

  if (shiftAuto) {
    const nowMs = Date.now();
    const shiftStartMs = getTodayShiftStartMs(new Date(nowMs));
    if (nowMs < shiftStartMs) {
      return 0;
    }
    timelineStartMs = shiftStartMs;
  } else {
    if (!firstScanAtMs) return 0;
    timelineStartMs = firstScanAtMs;
    if (!timer) {
      return actualCount;
    }
  }

  const nowMs = Date.now();
  const elapsedSec = Math.floor((nowMs - timelineStartMs) / 1000);
  const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;

  const breakSec = scheduledBreakOverlapSec(timelineStartMs, nowMs);
  const netTime = Math.max(0, elapsedSec - breakSec);

  let expected = Math.floor(netTime / cycleTimeSec);
  if (plan > 0) {
    expected = Math.min(expected, plan);
  }

  return expected;
}

function getTotalDowntimeSec() {
  return getBookedDowntimeSec();
}

function applyActualEffColorClass(el, pct) {
  if (!Number.isFinite(pct)) {
    el.className = "big-number status-blue";
    return;
  }
  if (pct < PLAN_EFF_PCT) el.className = "big-number status-red";
  else el.className = "big-number status-green";
}

function getTodayActualEffPct() {
  const dayKey = toIsoDateLocal(new Date());
  if (isNonProductionDay(dayKey)) return 0;
  const planUnits = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  const planWtMins = getPlanWtMinsForDay(dayKey);
  const actualWtMins = calcActualWtMinsForDay(dayKey, planUnits);
  return calcActualEffPct(planUnits, actualCount, planWtMins, actualWtMins);
}

function syncEfficiencyCardDom() {
  const effEl = document.getElementById("efficiency");
  if (!effEl) return;
  const pct = getTodayActualEffPct();
  if (!isMonitor) {
    efficiencyPercent = pct != null ? pct : 0;
  } else if (pct != null) {
    efficiencyPercent = pct;
  }
  if (pct == null) {
    effEl.innerText = "—";
    effEl.className = "big-number status-blue";
    return;
  }
  effEl.innerText = `${pct}%`;
  applyActualEffColorClass(effEl, pct);
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
  firebaseShiftScheduleRef = firebaseDb.ref(FIREBASE_SHIFT_SCHEDULE_PATH);

  firebaseShiftScheduleRef.on("value", snapshot => {
    const v = snapshot.val();
    if (v) applyShiftScheduleFromRemote(v);
  });

  if (!isMonitor) {
    firebaseShiftScheduleRef.once("value").then(snap => {
      if (!snap.val()) publishShiftScheduleToFirebase();
    }).catch(() => {});
  }

  if (isMonitor) {
    const connectedRef = firebaseDb.ref(".info/connected");
    connectedRef.on("value", snap => setMonitorConnectionStatus(!!snap.val()));
  }

  firebaseCommandRef.on("value", snapshot => {
    const command = snapshot.val();
    if (!command || !command.action) return;
    if (command.sender === syncClientId) return;
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
    const lastMs = Number(syncedLastScanAtMs);
    const wallSec = Math.max(Math.floor((nowMs - lastMs) / 1000), 0);
    const breakSec = scheduledBreakOverlapSec(lastMs, nowMs);
    const elapsedSinceLastScanSec = Math.max(0, wallSec - breakSec);
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
    lastScanWallMs = syncedLastScanAtMs ? Number(syncedLastScanAtMs) : reconstructedBaseTime.getTime();
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
  const lotNo = state.lotNo || "";

  // Keep local variables aligned so refresh doesn't revert values.
  actualCount = actual;
  syncDowntimeSecondsFromTable();
  firstScanAtMs = state.firstScanAtMs ? Number(state.firstScanAtMs) : firstScanAtMs;

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
  syncEfficiencyCardDom();
  startLiveCountdownTicker(countdown, status, state.updatedAt);
  syncDowntimeSecondsFromTable();
  document.getElementById("downtime").innerText = format(getBookedDowntimeSec());
  syncDowntimeAccumulatedHighlight();
  // Never carry last-scan time when actual is still 0 — stale Firebase lastScanAtMs makes the
  // first real scan look like a short gap (< one cycle) so downtime does not book.
  if (actual > 0 && state.lastScanAtMs) {
    const ls = Number(state.lastScanAtMs);
    lastScanTime = new Date(ls);
    lastScanWallMs = ls;
  } else if (actual === 0) {
    lastScanTime = null;
    lastScanWallMs = null;
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
  if (!firebaseLiveStateRef) {
    initialLiveStateHydrated = true;
    maybeResetDashboardForNewCalendarDay();
    return;
  }

  firebaseLiveStateRef.once("value")
    .then(snapshot => {
      const liveState = snapshot.val();
      if (liveState) applyLiveState(liveState);
      initialLiveStateHydrated = true;
      maybeResetDashboardForNewCalendarDay();
    })
    .catch(err => {
      console.log("Firebase initial live state error:", err);
      initialLiveStateHydrated = true;
      maybeResetDashboardForNewCalendarDay();
    });
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

  if (isNonProductionMode() && (action === "start" || action === "reset")) {
    isApplyingRemoteCommand = false;
    return;
  }

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
  if (isNonProductionMode()) {
    setStatus("NON PRODUCTION", "status-orange");
    return;
  }
  if (timer) return;
  if (!canRunProductionNow(new Date()) && !isAdminRole()) {
    setOffShiftStatus();
    return;
  }

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
    const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
    const nowMs = Date.now();
    const baseMs = lastScanWallMs != null ? lastScanWallMs : (startTime ? startTime.getTime() : null);
    if (baseMs == null) {
      updateDisplay();
      return;
    }
    const wallSec = Math.floor((nowMs - baseMs) / 1000);
    const breakSec = scheduledBreakOverlapSec(baseMs, nowMs);
    const diff = Math.max(0, wallSec - breakSec);
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
  if (isMonitor) return;

  hasLocalSession = true;

  if (shouldSync) {
    publishSyncCommand("stop");
  }

  clearInterval(timer);
  timer = null;
  setStatus("PAUSED", "status-orange");
  updateDisplay();
  updateLiveStateOnly();
}

/* RESET */
function resetProduction(shouldSync = true) {
  if (isMonitor) return;
  if (isNonProductionMode()) return;

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
  lastScanWallMs = null;
  startTime = null;
  firstScanAtMs = null;
  efficiencyPercent = 0;
  pendingChassis = "";
  pendingModel = "";
  pendingEngine = "";
  pendingKey = "";
  scannedUnits.clear();
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
    if (isNonProductionMode()) {
      this.value = "";
      return;
    }
    const value = this.value.trim();

    duplicateLock = false;
    pendingChassis = value;

    this.value = "";
    document.getElementById("modelInput").focus();
  }
});

/* ===== SCAN MODEL ===== */

document.getElementById("modelInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    if (isNonProductionMode()) {
      this.value = "";
      return;
    }
    if (pendingChassis === "") return;

    const model = this.value.trim();

    duplicateLock = false;
    pendingModel = model;

    this.value = "";
    document.getElementById("engineInput").focus();
  }
});

/* ===== SCAN ENGINE NO ===== */

document.getElementById("engineInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    if (isNonProductionMode()) {
      this.value = "";
      return;
    }
    if (pendingModel === "") return;

    const value = this.value.trim();

    duplicateLock = false;
    pendingEngine = value;

    this.value = "";
    document.getElementById("keyInput").focus();
  }
});

/* ===== SCAN KEY ===== */

document.getElementById("keyInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter" && this.value.trim() !== "") {
    if (isNonProductionMode()) {
      this.value = "";
      return;
    }
    if (!canRunProductionNow(new Date()) && !isAdminRole()) {
      setOffShiftStatus();
      this.value = "";
      return;
    }
    if (pendingChassis === "" || pendingModel === "" || pendingEngine === "") return;

    const key = this.value.trim();
    const unitId = unitScanFingerprint(pendingChassis, pendingEngine, key);

    /* ===== DUPLICATE CHECK (completed units only, after all 4 scans) ===== */
    if (scannedUnits.has(unitId)) {
      rejectDuplicateScan("DUPLICATE SCAN (same chassis, engine & key already logged today)");
      this.value = "";
      return;
    }

    duplicateLock = false;

    pendingKey = key;

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

    // Baseline: previous unit end; first unit of session uses shift start vs line start (max)
    // so idle from shift open to first scan books downtime (and stale Firebase lastScan is ignored).
    let t0Ms = null;
    const firstUnit = actualCount === 0;
    if (!firstUnit && lastScanWallMs != null) {
      t0Ms = lastScanWallMs;
    } else if (firstUnit && SETTINGS.shiftSchedule.enableAutoWindow) {
      const shiftStartMs = getTodayShiftStartMs(now);
      const lineMs = startTime ? startTime.getTime() : shiftStartMs;
      t0Ms = Math.max(shiftStartMs, lineMs);
      if (now.getTime() <= t0Ms) t0Ms = null;
    } else if (firstUnit && startTime) {
      t0Ms = startTime.getTime();
      if (now.getTime() <= t0Ms) t0Ms = null;
    }

    if (t0Ms != null) {
      const t1 = now.getTime();
      const wallSec = Math.floor((t1 - t0Ms) / 1000);
      const breakSec = scheduledBreakOverlapSec(t0Ms, t1);
      const idleSecExBreak = Math.max(0, wallSec - breakSec);
      // Match Excel logic: booked downtime is only the amount beyond one cycle.
      if (idleSecExBreak > cycleTimeSec) {
        const actualDowntime = idleSecExBreak - cycleTimeSec;

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
    lastScanWallMs = now.getTime();
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
    row.dataset.scanMs = String(now.getTime());
    row.dataset.scanPlan = String(planForRow);
    renumberScanTable();
    rebuildScannedSetsFromTable();

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
  // Keep accumulated card aligned with sum of visible table downtime rows.
  syncDowntimeSecondsFromTable();
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const balance = actualCount - plan;
  const displayBalance = balance > 0 ? ("+" + balance) : balance;

  if (isNonProductionMode()) {
    const delayEl = document.getElementById("delay");
    document.getElementById("expected").innerText = "0";
    document.getElementById("actual").innerText = actualCount;
    document.getElementById("plan").innerText = plan;
    document.getElementById("countdown").innerText = format(countdownValue);
    refreshDowntimeCardFromTable();
    const balanceEl = document.getElementById("balance");
    if (balance < 0) balanceEl.className = "big-number status-red";
    else if (balance > 0) balanceEl.className = "big-number status-green";
    else balanceEl.className = "big-number status-blue";
    balanceEl.innerText = displayBalance;
    delayEl.className = "big-number status-blue";
    delayEl.innerText = "0";
    setStatus("NON PRODUCTION", "status-orange");
    syncEfficiencyCardDom();
    const downtimeCard = document.getElementById("downtimeCard");
    const downtimeText = document.getElementById("downtime");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
    syncDowntimeAccumulatedHighlight();
    return;
  }

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
  if (
    pendingChassis === "" &&
    pendingModel === "" &&
    pendingEngine === "" &&
    pendingKey === ""
  ) {
    duplicateLock = false;
  }
  if (isNonProductionMode()) {
    setStatus("NON PRODUCTION", "status-orange");
  } else if (isBreakTime()) {
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

  syncEfficiencyCardDom();

  const downtimeCard = document.getElementById("downtimeCard");
  const downtimeText = document.getElementById("downtime");
  if (isDowntime) {
    downtimeCard.classList.add("downtime-alert", "blink");
    downtimeText.classList.add("status-red", "blink");
  } else {
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  }
  syncDowntimeAccumulatedHighlight();
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
background:#000000;
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

function syncFullscreenUi() {
  const fs =
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement ||
    null;
  document.body.classList.toggle("is-fullscreen", !!fs);
}

function toggleFullScreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const req =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.msRequestFullscreen;
    if (req) req.call(el);
  } else {
    const exit =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.msExitFullscreen;
    if (exit) exit.call(document);
  }
}

document.addEventListener("fullscreenchange", syncFullscreenUi);
document.addEventListener("webkitfullscreenchange", syncFullscreenUi);
document.addEventListener("MSFullscreenChange", syncFullscreenUi);
syncFullscreenUi();

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
    if (!isAdminRole()) return;
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
    refreshDowntimeCardFromTable();
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
  if (!isAdminRole()) {
    if (typeof forceOpen === "boolean" && !forceOpen) {
      menu.classList.remove("open");
      document.body.classList.remove("menu-open");
    }
    return;
  }
  updateViewToggleMenuItem();
  if (typeof forceOpen === "boolean") {
    menu.classList.toggle("open", forceOpen);
    document.body.classList.toggle("menu-open", forceOpen);
    return;
  }
  const nextOpen = !menu.classList.contains("open");
  menu.classList.toggle("open", nextOpen);
  document.body.classList.toggle("menu-open", nextOpen);
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
  if (!isAdminRole()) return;
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
  syncGraphWtControl();
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

function formatBarChartValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10).replace(/\.0$/, "");
}

/** Green / purple actual trend lines: stroke draw + dots timed along the path. */
function animateTrendLines(container) {
  if (!container) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const run = () => {
    const lines = container.querySelectorAll("path.trend-line-actual, path.trend-line");
    lines.forEach((path, lineIdx) => {
      let len = 0;
      try {
        len = path.getTotalLength();
      } catch (_) {
        len = 0;
      }
      if (!Number.isFinite(len) || len <= 0) {
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
        path.style.animation = "none";
        return;
      }

      const durationSec = Math.min(1.75, Math.max(0.9, len / 320));
      const baseDelayMs = lineIdx * 90;

      if (reduceMotion) {
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
        path.style.animation = "none";
      } else {
        path.style.strokeDasharray = `${len}`;
        path.style.strokeDashoffset = `${len}`;
        path.style.animation = "none";
        void path.getBoundingClientRect();
        path.style.animation = `trendLineDraw ${durationSec}s var(--ease-smooth) ${baseDelayMs}ms forwards`;
      }

      const svg = path.closest("svg");
      if (!svg) return;
      const dots = [...svg.querySelectorAll("circle.trend-dot")];
      const n = dots.length;
      dots.forEach((dot, i) => {
        const along = n <= 1 ? 1 : i / (n - 1);
        const dotDelay = Math.round(baseDelayMs + durationSec * 1000 * along * 0.92);
        if (reduceMotion) {
          dot.style.animation = "none";
          dot.style.opacity = "1";
          return;
        }
        dot.style.opacity = "0";
        dot.style.animation = "none";
        void dot.getBoundingClientRect();
        dot.style.animation = `trendDotPop .4s var(--ease-soft) ${dotDelay}ms forwards`;
      });
    });

    container.querySelectorAll("path.trend-area-fill").forEach((area, i) => {
      if (reduceMotion) {
        area.style.opacity = "1";
        area.style.animation = "none";
        return;
      }
      const delay = 180 + i * 100;
      area.style.opacity = "0";
      area.style.animation = "none";
      void area.getBoundingClientRect();
      area.style.animation = `trendAreaFade 0.85s var(--ease-smooth) ${delay}ms forwards`;
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

/** Smooth HTML tooltip for Production Trend target / actual hover. */
function initPlanActualChartTooltips(container) {
  if (!container) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  container.querySelectorAll("svg.summary-chart-plan-actual").forEach(svg => {
    const host = svg.closest(".summary-graph-card");
    if (!host) return;

    host.classList.add("trend-chart-host");

    let tip = host.querySelector(".trend-chart-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "trend-chart-tooltip";
      tip.setAttribute("role", "tooltip");
      tip.innerHTML = `
        <span class="trend-chart-tooltip-kind"></span>
        <span class="trend-chart-tooltip-value"></span>
      `;
      host.appendChild(tip);
    }

    let activeEl = null;
    let hideTimer = null;

    const positionTip = el => {
      const kindEl = tip.querySelector(".trend-chart-tooltip-kind");
      const valueEl = tip.querySelector(".trend-chart-tooltip-value");
      if (kindEl) kindEl.textContent = el.getAttribute("data-tip-kind") || "";
      if (valueEl) {
        const label = el.getAttribute("data-tip-label") || "";
        const value = el.getAttribute("data-tip-value") || "";
        const tipKind = (el.getAttribute("data-tip-kind") || "").toLowerCase();
        if (tipKind === "no production") {
          valueEl.textContent = label;
        } else {
          valueEl.textContent = label ? `${label}: ${value}` : value;
        }
      }

      const hostRect = host.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const centerX = elRect.left + elRect.width / 2 - hostRect.left;
      const topY = elRect.top - hostRect.top - 10;

      tip.style.left = `${centerX}px`;
      tip.style.top = `${topY}px`;

      const tipKind = (el.getAttribute("data-tip-kind") || "").toLowerCase();
      const isEffChart = svg.classList.contains("summary-chart-eff-trend");
      tip.classList.toggle("is-eff-chart", isEffChart);
      tip.classList.toggle("is-target", tipKind === "target");
      tip.classList.toggle("is-actual", tipKind === "actual");
      tip.classList.toggle("is-no-production", tipKind === "no production");
    };

    const showTip = el => {
      if (!el) return;
      clearTimeout(hideTimer);
      activeEl = el;
      positionTip(el);
      tip.hidden = false;
      requestAnimationFrame(() => tip.classList.add("is-visible"));
    };

    const hideTip = () => {
      activeEl = null;
      tip.classList.remove("is-visible");
      const delay = reduceMotion ? 0 : 220;
      hideTimer = setTimeout(() => {
        if (!activeEl) tip.hidden = true;
      }, delay);
    };

    svg.querySelectorAll("[data-chart-tip]").forEach(el => {
      el.addEventListener("mouseenter", () => showTip(el));
      el.addEventListener("focus", () => showTip(el));
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("blur", hideTip);
    });
  });
}

/** Count-up labels on bar charts after bars finish growing. */
function animateSummaryBarValues(container) {
  if (!container) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  container.querySelectorAll(".summary-bar-value[data-value]").forEach(el => {
    const target = parseFloat(el.getAttribute("data-value") || "0");
    const suffix = el.getAttribute("data-suffix") || "";
    const delay = parseInt(el.getAttribute("data-delay-ms") || "0", 10);
    const duration = parseInt(el.getAttribute("data-count-ms") || "520", 10);
    const finalText = `${formatBarChartValue(target)}${suffix}`;
    if (reduceMotion || target <= 0) {
      el.textContent = finalText;
      return;
    }
    el.textContent = `0${suffix}`;
    const startAt = performance.now() + delay;
    const tick = now => {
      if (now < startAt) {
        requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, (now - startAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = `${formatBarChartValue(target * eased)}${suffix}`;
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = finalText;
    };
    requestAnimationFrame(tick);
  });
}

function buildSummaryBarChart(title, labels, values, color, valueSuffix = "", yAxisLabel = "", animOpts = {}) {
  if (!labels.length || !values.length) {
    return `<div class="summary-graph-empty">No data</div>`;
  }
  const {
    chartClass = "",
    barStaggerMs = 90,
    valueDelayAfterBarMs = 580,
    valueCountMs = 520
  } = animOpts;
  const width = 500;
  const height = 190;
  const leftPad = 36;
  const rightPad = 12;
  const topPad = 14;
  const bottomPad = 30;
  const chartW = width - leftPad - rightPad;
  const chartH = height - topPad - bottomPad;
  const yBase = topPad + chartH;
  const maxVal = Math.max(...values, 1);
  const stepX = chartW / labels.length;
  const barW = Math.max(Math.min(stepX * 0.58, 36), 10);
  const labelStride = labels.length > 24 ? 3 : labels.length > 16 ? 2 : 1;

  const bars = labels.map((label, i) => {
    const v = values[i];
    const x = leftPad + (i * stepX) + ((stepX - barW) / 2);
    const h = Math.max((v / maxVal) * chartH, v > 0 ? 2 : 0);
    const y = topPad + (chartH - h);
    const showLabel = i % labelStride === 0 || i === labels.length - 1;
    const cx = (x + (barW / 2)).toFixed(2);
    const valueY = (Math.max(y - 5, 12)).toFixed(2);
    const barDelayMs = i * barStaggerMs;
    const valueDelayMs = barDelayMs + valueDelayAfterBarMs;
    return `
      <rect class="summary-bar" style="animation-delay:${barDelayMs}ms" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="2" fill="${color}" opacity="0.9"></rect>
      ${showLabel ? `<text class="summary-bar-axis-label" x="${cx}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#94a3b8" font-size="9">${label}</text>` : ""}
      <text class="summary-bar-value" style="animation-delay:${valueDelayMs}ms" data-delay-ms="${valueDelayMs}" data-count-ms="${valueCountMs}" data-value="${v}" data-suffix="${valueSuffix}" x="${cx}" y="${valueY}" text-anchor="middle" fill="#f8fafc" font-size="10" font-weight="700">0${valueSuffix}</text>
    `;
  }).join("");
  const yTicks = 4;
  const useDecimalYLabels = maxVal > 0 && maxVal < 15;
  const yGrid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const ratio = i / yTicks;
    const y = topPad + chartH * ratio;
    const rawVal = maxVal * (1 - ratio);
    let label;
    if (useDecimalYLabels) {
      label = String(Math.round(rawVal * 10) / 10).replace(/\.0$/, "");
    } else {
      label = String(Math.round(rawVal));
    }
    return `
      <line x1="${leftPad}" y1="${y.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(148,163,184,.16)" stroke-width="1"></line>
      <text x="${(leftPad - 6).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#94a3b8" font-size="9">${label}</text>
    `;
  }).join("");

  const titleMatch = String(title).match(/^(.*?)(\s*\((.*)\))$/);
  const titleMain = titleMatch ? titleMatch[1].trim() : String(title);
  const titleSub = titleMatch ? String(titleMatch[3] || "").trim() : "";
  return `
    <div class="trend-title-wrap trend-title-wrap-compact">
      <div class="trend-title trend-title-small">${titleMain}</div>
      ${titleSub ? `<div class="trend-subtitle">${titleSub}</div>` : ""}
    </div>
    ${yAxisLabel ? `<div class="trend-units">${yAxisLabel}</div>` : ""}
    <svg viewBox="0 0 ${width} ${height}" class="summary-chart-svg${chartClass ? ` ${chartClass}` : ""}" role="img" aria-label="${title}">
      ${yGrid}
      <line x1="${leftPad}" y1="${yBase}" x2="${width - rightPad}" y2="${yBase}" stroke="rgba(148,163,184,.45)" stroke-width="1"></line>
      <line x1="${leftPad}" y1="${topPad}" x2="${leftPad}" y2="${yBase}" stroke="rgba(148,163,184,.45)" stroke-width="1"></line>
      ${bars}
    </svg>
  `;
}

function buildSummaryLineChart(title, labels, values, color, valueSuffix = "", yAxisLabel = "") {
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
  const stepX = labels.length <= 1 ? chartW : (chartW / (labels.length - 1));
  const yBase = topPad + chartH;
  const toY = (v) => yBase - ((v / maxVal) * chartH);
  const points = values.map((v, i) => ({
    x: leftPad + (stepX * i),
    y: toY(v),
    value: v
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const circles = points.map((p, i) => `
    <circle class="trend-dot" style="animation-delay:${i * 45}ms" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3.8" fill="${color}">
      <title>${labels[i]}: ${p.value}${valueSuffix}</title>
    </circle>
  `).join("");
  const labelStride = labels.length > 24 ? 3 : labels.length > 16 ? 2 : 1;
  const xLabels = labels.map((label, i) => {
    if (i % labelStride !== 0 && i !== labels.length - 1) return "";
    return `<text x="${(leftPad + stepX * i).toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#94a3b8" font-size="9">${label}</text>`;
  }).join("");
  const yTicks = 4;
  const yGrid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const ratio = i / yTicks;
    const y = topPad + chartH * ratio;
    const val = Math.round(maxVal * (1 - ratio));
    return `
      <line x1="${leftPad}" y1="${y.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(148,163,184,.16)" stroke-width="1"></line>
      <text x="${(leftPad - 6).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#94a3b8" font-size="10">${val}</text>
    `;
  }).join("");
  const titleMatch = String(title).match(/^(.*?)(\s*\((.*)\))$/);
  const titleMain = titleMatch ? titleMatch[1].trim() : String(title);
  const titleSub = titleMatch ? String(titleMatch[3] || "").trim() : "";
  return `
    <div class="trend-title-wrap trend-title-wrap-compact">
      <div class="trend-title trend-title-small">${titleMain}</div>
      ${titleSub ? `<div class="trend-subtitle">${titleSub}</div>` : ""}
    </div>
    ${yAxisLabel ? `<div class="trend-units">${yAxisLabel}</div>` : ""}
    <svg viewBox="0 0 ${width} ${height}" class="summary-chart-svg" role="img" aria-label="${title}">
      ${yGrid}
      <path class="trend-line" d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${circles}
      ${xLabels}
    </svg>
  `;
}

function getTrendChartPeriodLabel(rangeStart, rangeEnd, period) {
  if (rangeStart === rangeEnd) return "Day";
  return period === "month" ? "Month" : "Week";
}

/** X/Y points for trend lines; single-day view centers on the chart (Today button). */
function layoutTrendSeriesPoints(values, leftPad, chartW, toY) {
  if (!values.length) return [];
  if (values.length === 1) {
    const cx = leftPad + chartW / 2;
    const v = values[0] || 0;
    return [{ x: cx, y: toY(v), value: v }];
  }
  const xStep = chartW / (values.length - 1);
  return values.map((v, i) => ({
    x: leftPad + xStep * i,
    y: toY(v || 0),
    value: v || 0
  }));
}

/** SVG path for actual line; one-day charts use a short horizontal segment so the line is visible. */
function buildTrendLinePath(points, yBase) {
  if (!points.length) return "";
  if (points.length === 1) {
    const p = points[0];
    if (!(p.value > 0)) return "";
    const halfW = 32;
    return `M ${(p.x - halfW).toFixed(2)} ${p.y.toFixed(2)} L ${(p.x + halfW).toFixed(2)} ${p.y.toFixed(2)}`;
  }
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

/** Line path with gaps on skipped day indices (e.g. non-production). */
function buildTrendLinePathWithSkips(points, dayKeys, skipDayFn, yBase) {
  if (!points.length || !dayKeys.length) return "";
  const segments = [];
  let seg = [];
  points.forEach((p, i) => {
    if (skipDayFn(dayKeys[i])) {
      if (seg.length) {
        segments.push(seg);
        seg = [];
      }
    } else {
      seg.push(p);
    }
  });
  if (seg.length) segments.push(seg);
  return segments.map(s => buildTrendLinePath(s, yBase)).filter(Boolean).join(" ");
}

/**
 * Line path that CONNECTS across skipped days (e.g. non-production).
 * We still hide bars/dots on skipped indices, but the line stays continuous.
 */
function buildTrendLinePathConnectAcrossSkips(points, dayKeys, skipDayFn, yBase) {
  if (!points.length || !dayKeys?.length) return "";
  const kept = points.filter((_, i) => !skipDayFn(dayKeys[i]));
  return buildTrendLinePath(kept, yBase);
}

/**
 * Line path that stays continuous but DROPS TO 0 on skipped days (e.g. non-production).
 * Skipped days are rendered at the baseline so the line visually drops (0 units/0%).
 */
function buildTrendLinePathDropToZeroOnSkips(points, dayKeys, skipDayFn, yBase) {
  if (!points.length || !dayKeys?.length) return "";
  const withZero = points.map((p, i) => {
    if (!skipDayFn(dayKeys[i])) return p;
    return { ...p, y: yBase, value: 0 };
  });
  return buildTrendLinePath(withZero, yBase);
}

function buildEfficiencyTrendChart(title, labels, actualValues, planValues, valueSuffix = "%", yAxisLabel = "%", dayKeys = null) {
  if (!labels.length || !actualValues.length) {
    return `<div class="summary-graph-empty">No data</div>`;
  }
  const skipNpIdx = i => dayKeys && isNonProductionDay(dayKeys[i]);
  const width = 500;
  const height = 170;
  const leftPad = 36;
  const rightPad = 12;
  const topPad = 14;
  const bottomPad = 28;
  const chartW = width - leftPad - rightPad;
  const chartH = height - topPad - bottomPad;
  const visibleActual = actualValues.filter((_, i) => !skipNpIdx(i));
  const visiblePlan = (planValues || []).filter((_, i) => !skipNpIdx(i));
  const maxVal = Math.max(1, ...visibleActual, ...visiblePlan);
  const yBase = topPad + chartH;
  const toY = (v) => yBase - ((v / maxVal) * chartH);
  const planPoints = layoutTrendSeriesPoints(
    labels.map((_, i) => planValues?.[i] || 0),
    leftPad,
    chartW,
    toY
  );
  const stepX = labels.length <= 1 ? chartW : (chartW / (labels.length - 1));

  const planBarW = Math.max(Math.min((stepX || 12) * 0.34, 16), 6);
  const planBarOffsetX = Math.min((stepX || 0) * 0.18, 9);
  const planBars = labels.map((_, i) => {
    if (skipNpIdx(i)) return "";
    const v = planValues?.[i] || 0;
    const x = (planPoints[i]?.x ?? (leftPad + stepX * i)) - (planBarW / 2) + planBarOffsetX;
    const y = toY(v);
    const h = Math.max(yBase - y, v > 0 ? 2 : 0);
    const tipLabel = dayKeys?.[i] ? formatIsoDateAsDdMmYy(dayKeys[i]) : (labels[i] || "");
    const valTxt = `${v.toFixed(1)}${valueSuffix}`;
    return `<rect class="summary-bar" data-chart-tip data-tip-kind="Target" data-tip-label="${tipLabel}" data-tip-value="${valTxt}" style="animation-delay:${i * 35}ms; cursor:pointer" x="${x.toFixed(2)}" y="${(yBase - h).toFixed(2)}" width="${planBarW.toFixed(2)}" height="${h.toFixed(2)}" rx="2" fill="#3b82f6" opacity=".9"></rect>`;
  }).join("");

  const points = layoutTrendSeriesPoints(actualValues, leftPad, chartW, toY);
  const skipNpKey = k => dayKeys ? isNonProductionDay(k) : false;
  const path = dayKeys
    ? buildTrendLinePathDropToZeroOnSkips(points, dayKeys, skipNpKey, yBase)
    : buildTrendLinePath(points, yBase);
  const visiblePts = dayKeys ? points.filter((_, i) => !skipNpIdx(i)) : points;
  const areaPath = visiblePts.length && path
    ? `${path} L ${visiblePts[visiblePts.length - 1].x.toFixed(2)} ${yBase.toFixed(2)} L ${visiblePts[0].x.toFixed(2)} ${yBase.toFixed(2)} Z`
    : "";
  const circles = points.map((p, i) => {
    const tipLabel = dayKeys?.[i] ? formatIsoDateAsDdMmYy(dayKeys[i]) : (labels[i] || "");
    const isNp = skipNpIdx(i);
    const actual = isNp ? 0 : p.value;
    const cy = isNp ? yBase : p.y;
    const valTxt = `${actual}${valueSuffix}`;
    const tipKind = isNp ? "No Production" : "Actual";
    const target = planValues?.[i] ?? 0;
    const behind = target > 0 && actual < target;
    const dotClass = isNp
      ? "trend-dot trend-dot-np"
      : (behind ? "trend-dot trend-dot-behind" : "trend-dot trend-dot-met");
    const dotFill = isNp ? "#94a3b8" : (behind ? "#ef4444" : "#a855f7");
    return `<circle class="${dotClass}" data-chart-tip data-tip-kind="${tipKind}" data-tip-label="${tipLabel}" data-tip-value="${isNp ? "" : valTxt}" style="animation-delay:${i * 45}ms; cursor:pointer" cx="${p.x.toFixed(2)}" cy="${cy.toFixed(2)}" r="3.8" fill="${dotFill}"></circle>`;
  }).join("");

  const labelStride = labels.length > 24 ? 3 : labels.length > 16 ? 2 : 1;
  const xLabels = labels.map((label, i) => {
    if (i % labelStride !== 0 && i !== labels.length - 1) return "";
    const x = points[i]?.x ?? (leftPad + stepX * i);
    return `<text x="${x.toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#94a3b8" font-size="9">${label}</text>`;
  }).join("");
  const yTicks = 4;
  const yGrid = Array.from({ length: yTicks + 1 }, (_, i) => {
    const ratio = i / yTicks;
    const y = topPad + chartH * ratio;
    const val = Math.round(maxVal * (1 - ratio));
    return `
      <line x1="${leftPad}" y1="${y.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(30,64,175,.2)" stroke-width="1"></line>
      <text x="${(leftPad - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#94a3b8" font-size="10">${val}</text>
    `;
  }).join("");
  const axisStroke = "rgba(148,163,184,.72)";
  const axisLines = `
    <line x1="${leftPad}" y1="${topPad.toFixed(2)}" x2="${leftPad}" y2="${yBase.toFixed(2)}" stroke="${axisStroke}" stroke-width="2" stroke-linecap="round"></line>
    <line x1="${leftPad}" y1="${yBase.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${yBase.toFixed(2)}" stroke="${axisStroke}" stroke-width="2" stroke-linecap="round"></line>
  `;
  const titleMatch = String(title).match(/^(.*?)(\s*\((.*)\))$/);
  const titleMain = titleMatch ? titleMatch[1].trim() : String(title);
  const titleSub = titleMatch ? String(titleMatch[3] || "").trim() : "";
  return `
    <div class="trend-header">
      <div class="trend-title-wrap trend-title-wrap-compact">
        <div class="trend-title trend-title-small">${titleMain}</div>
        ${titleSub ? `<div class="trend-subtitle">${titleSub}</div>` : ""}
      </div>
      <div class="trend-legend">
        <span class="trend-legend-item"><i class="trend-swatch" style="background:#a855f7;border-color:#a855f7"></i>Actual</span>
        <span class="trend-legend-item"><i class="trend-swatch trend-swatch-target"></i>Target</span>
      </div>
    </div>
    ${yAxisLabel ? `<div class="trend-units">${yAxisLabel}</div>` : ""}
    <svg viewBox="0 0 ${width} ${height}" class="summary-chart-svg summary-chart-plan-actual summary-chart-eff-trend" role="img" aria-label="${title}">
      <defs>
        <linearGradient id="effTrendFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="rgba(168,85,247,.34)"></stop>
          <stop offset="100%" stop-color="rgba(168,85,247,0)"></stop>
        </linearGradient>
      </defs>
      ${yGrid}
      ${axisLines}
      ${areaPath ? `<path class="trend-area-fill" d="${areaPath}" fill="url(#effTrendFill)"></path>` : ""}
      ${planBars}
      <path class="trend-line trend-line-actual" d="${path}" fill="none" stroke="#a855f7" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></path>
      ${circles}
      ${xLabels}
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

  const planRaw = String(document.getElementById("plan")?.innerText || "").trim();
  const planCard = parseInt(planRaw, 10);
  const planInput = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  const fallbackDayPlan = Number.isFinite(planCard) && planCard > 0 ? planCard : planInput;

  let plan = 0;
  periodKeys.forEach(day => {
    const resolved = resolveReportPlanForDay(day, fallbackDayPlan);
    if (Number.isFinite(resolved) && resolved > 0) {
      plan += resolved;
    } else if (Number.isFinite(planByDay[day]) && planByDay[day] > 0) {
      plan += planByDay[day];
    }
  });

  if (plan <= 0) {
    const multiplier = Math.max(periodKeys.length, 1);
    plan = Math.max(0, fallbackDayPlan * multiplier);
  }

  return { plan, actual };
}

/** True for local Saturday/Sunday (from ISO date key YYYY-MM-DD). */
function isWeekendIsoDay(dayKey) {
  const d = new Date(`${dayKey}T12:00:00`);
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

/**
 * Per-day target for Production Report KPIs, tables, and PRODUCTION TREND.
 * Today → current Daily Plan (operator can revise before/during shift).
 * Past days → plan saved on scan rows. Day has scans → compare to Daily Plan (fallback).
 * Otherwise → 0 unless legacy implicit weekday plan is enabled in SETTINGS.
 */
function computeDayTargetsForReport(dayKeys, dailyActualMap, fallbackDayPlan) {
  const legacyImplicitWeekday =
    SETTINGS.productionTrend?.implicitDailyPlanOnInactiveWeekdays === true;
  const zWeekend = SETTINGS.productionTrend?.zeroTargetOnInactiveWeekends !== false;
  const dayTarget = {};
  dayKeys.forEach(k => {
    const resolved = resolveReportPlanForDay(k, fallbackDayPlan);
    const dayActual = dailyActualMap[k] || 0;
    if (Number.isFinite(resolved) && resolved > 0) {
      dayTarget[k] = resolved;
    } else if (dayActual > 0) {
      dayTarget[k] = fallbackDayPlan;
    } else if (legacyImplicitWeekday) {
      if (isWeekendIsoDay(k) && zWeekend) {
        dayTarget[k] = 0;
      } else {
        dayTarget[k] = fallbackDayPlan;
      }
    } else {
      dayTarget[k] = 0;
    }
  });
  return dayTarget;
}

function buildPlanVsActualChart(dayKey = getActiveGraphDayKey(), period = graphPeriod) {
  const range = getActiveGraphRange();
  const rangeLabel = formatIsoRangeAsDdMmYy(range.start, range.end);
  const dayKeys = getDayKeysBetween(range.start, range.end);
  const daySet = new Set(dayKeys);
  const periodLabel = getTrendChartPeriodLabel(range.start, range.end, period);

  const dailyActualMap = {};
  const rows = document.querySelectorAll("#scanTable tr");
  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || !daySet.has(rowDay)) return;
    dailyActualMap[rowDay] = (dailyActualMap[rowDay] || 0) + 1;
  });

  let fallbackDayPlan = parseInt(String(document.getElementById("plan")?.innerText || "").trim(), 10);
  if (!Number.isFinite(fallbackDayPlan) || fallbackDayPlan <= 0) {
    fallbackDayPlan = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  }
  const dayTarget = computeDayTargetsForReport(dayKeys, dailyActualMap, fallbackDayPlan);
  const skipNpDay = k => isNonProductionDay(k);
  const totalPlan = dayKeys.reduce((sum, key) => sum + (skipNpDay(key) ? 0 : (dayTarget[key] || 0)), 0);

  // Use per-day values (not cumulative) for both Actual and Target.
  const actualSeries = dayKeys.map(k => dailyActualMap[k] || 0);
  const targetSeries = dayKeys.map(k => dayTarget[k] || 0);

  const totalActual = actualSeries.reduce((sum, v, i) => sum + (skipNpDay(dayKeys[i]) ? 0 : v), 0);
  const diff = totalActual - totalPlan;
  const diffNote = totalPlan > 0
    ? (diff === 0 ? "On target" : diff > 0 ? `Ahead by ${diff}` : `Behind by ${Math.abs(diff)}`)
    : "";

  if (totalPlan <= 0 && totalActual <= 0) {
    return `
      <div class="summary-graph-card-title">Plan vs Actual</div>
      <div class="summary-graph-empty">No daily plan or actual output yet</div>`;
  }

  const width = 500;
  const height = 170;
  const leftPad = 36;
  const rightPad = 12;
  const topPad = 14;
  const bottomPad = 28;
  const chartW = width - leftPad - rightPad;
  const chartH = height - topPad - bottomPad;
  const seriesMax = Math.max(
    0,
    ...actualSeries.filter((_, i) => !skipNpDay(dayKeys[i])),
    ...targetSeries.filter((_, i) => !skipNpDay(dayKeys[i]))
  );
  let yTickStep;
  let maxVal;
  if (seriesMax <= 0) {
    yTickStep = 5;
    maxVal = 10;
  } else if (seriesMax <= 5) {
    yTickStep = 1;
    maxVal = Math.max(5, Math.ceil(seriesMax));
  } else if (seriesMax <= 12) {
    yTickStep = 2;
    maxVal = Math.ceil(seriesMax / yTickStep) * yTickStep;
  } else if (seriesMax <= 60) {
    yTickStep = 10;
    maxVal = Math.ceil(seriesMax / yTickStep) * yTickStep;
  } else if (seriesMax <= 150) {
    yTickStep = 20;
    maxVal = Math.ceil(seriesMax / yTickStep) * yTickStep;
  } else {
    yTickStep = 50;
    maxVal = Math.ceil(seriesMax / yTickStep) * yTickStep;
  }
  const dayCount = dayKeys.length;
  const xStep = dayCount <= 1 ? chartW : (chartW / (dayCount - 1));
  const yBase = topPad + chartH;
  const toY = (v) => yBase - ((v / maxVal) * chartH);
  const formatNum = (n) => Number(n || 0).toLocaleString();

  const actualPoints = layoutTrendSeriesPoints(actualSeries, leftPad, chartW, toY);
  const targetPoints = dayKeys.map((_, i) => {
    const x = dayCount <= 1 ? leftPad + chartW / 2 : leftPad + xStep * i;
    return {
      x,
      y: toY(targetSeries[i] || 0),
      value: targetSeries[i] || 0
    };
  });
  const actualPath = buildTrendLinePathDropToZeroOnSkips(actualPoints, dayKeys, skipNpDay, yBase);
  const targetBarW = Math.max(Math.min((xStep || 12) * 0.34, 16), 6);
  const targetBarOffsetX = Math.min((xStep || 0) * 0.18, 9);
  const targetBars = targetPoints.map((p, i) => {
    if (skipNpDay(dayKeys[i])) return "";
    const barH = Math.max(yBase - p.y, targetSeries[i] > 0 ? 2 : 0);
    const x = p.x - (targetBarW / 2) + targetBarOffsetX;
    const y = yBase - barH;
    const dTxt = formatIsoDateAsDdMmYy(dayKeys[i]);
    const vTxt = formatNum(targetSeries[i] || 0);
    return `<rect class="summary-bar" data-chart-tip data-tip-kind="Target" data-tip-label="${dTxt}" data-tip-value="${vTxt}" data-report-day="${dayKeys[i]}" style="animation-delay:${i * 35}ms; cursor:pointer" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${targetBarW.toFixed(2)}" height="${barH.toFixed(2)}" rx="2" fill="#3b82f6" opacity=".92" onclick="focusGraphDay('${dayKeys[i]}')"></rect>`;
  }).join("");
  const visibleActualPts = actualPoints.filter((_, i) => !skipNpDay(dayKeys[i]));
  const areaPath = visibleActualPts.length && actualPath
    ? `${actualPath} L ${visibleActualPts[visibleActualPts.length - 1].x.toFixed(2)} ${yBase.toFixed(2)} L ${visibleActualPts[0].x.toFixed(2)} ${yBase.toFixed(2)} Z`
    : "";
  const yTickValues = [];
  for (let v = 0; v <= maxVal + 1e-9; v += yTickStep) {
    yTickValues.push(Math.round(v * 100) / 100);
  }
  const gridLines = yTickValues.map(v => {
    const ratio = 1 - (v / maxVal);
    const y = topPad + (chartH * ratio);
    return `
      <line x1="${leftPad}" y1="${y.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(30,64,175,.2)" stroke-width="1"></line>
      <text x="${(leftPad - 8).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#94a3b8" font-size="10">${formatNum(v)}</text>
    `;
  }).join("");
  const axisStroke = "rgba(148,163,184,.72)";
  const axisLines = `
    <line x1="${leftPad}" y1="${topPad.toFixed(2)}" x2="${leftPad}" y2="${yBase.toFixed(2)}" stroke="${axisStroke}" stroke-width="2" stroke-linecap="round"></line>
    <line x1="${leftPad}" y1="${yBase.toFixed(2)}" x2="${(width - rightPad).toFixed(2)}" y2="${yBase.toFixed(2)}" stroke="${axisStroke}" stroke-width="2" stroke-linecap="round"></line>
  `;
  const labelStride = dayKeys.length > 24 ? 3 : dayKeys.length > 16 ? 2 : 1;
  const xLabels = dayKeys.map((k, i) => {
    if (i % labelStride !== 0 && i !== dayKeys.length - 1) return "";
    const d = new Date(`${k}T00:00:00`);
    const label = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const x = dayCount <= 1 ? leftPad + chartW / 2 : leftPad + xStep * i;
    return `<text x="${x.toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#94a3b8" font-size="9">${label}</text>`;
  }).join("");
  const actualDots = actualPoints.map((p, i) => {
    const dTxt = formatIsoDateAsDdMmYy(dayKeys[i]);
    const isNp = skipNpDay(dayKeys[i]);
    const actual = isNp ? 0 : (actualSeries[i] || 0);
    const vTxt = formatNum(actual);
    const tipKind = isNp ? "No Production" : "Actual";
    const target = targetSeries[i] || 0;
    const behind = target > 0 && actual < target;
    const dotClass = isNp
      ? "trend-dot trend-dot-np"
      : (behind ? "trend-dot trend-dot-behind" : "trend-dot trend-dot-met");
    const dotFill = isNp ? "#94a3b8" : (behind ? "#ef4444" : "#4ade80");
    const cy = isNp ? yBase : p.y;
    return `<circle class="${dotClass}" data-chart-tip data-tip-kind="${tipKind}" data-tip-label="${dTxt}" data-tip-value="${isNp ? "" : vTxt}" data-report-day="${dayKeys[i]}" style="animation-delay:${i * 45}ms; cursor:pointer" cx="${p.x.toFixed(2)}" cy="${cy.toFixed(2)}" r="4.2" fill="${dotFill}" onclick="focusGraphDay('${dayKeys[i]}')"></circle>`;
  }).join("");

  return `
      <div class="trend-header">
        <div class="trend-title-wrap trend-title-wrap-compact">
          <div class="trend-title trend-title-small">PRODUCTION TREND</div>
          <div class="trend-subtitle">${periodLabel}: ${rangeLabel}</div>
        </div>
        <div class="trend-legend-stack">
          <div class="trend-legend">
            <span class="trend-legend-item"><i class="trend-swatch trend-swatch-actual"></i>Actual</span>
            <span class="trend-legend-item"><i class="trend-swatch trend-swatch-target"></i>Target</span>
          </div>
          ${diffNote ? `<div class="plan-actual-diff">${diffNote}</div>` : ""}
        </div>
      </div>
      <div class="trend-units">Units</div>
      <svg viewBox="0 0 ${width} ${height}" class="summary-chart-svg summary-chart-plan-actual" role="img" aria-label="Production trend chart">
        <defs>
          <linearGradient id="actualTrendFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(74,222,128,.35)"></stop>
            <stop offset="100%" stop-color="rgba(74,222,128,0)"></stop>
          </linearGradient>
        </defs>
        ${gridLines}
        ${axisLines}
        ${areaPath ? `<path class="trend-area-fill" d="${areaPath}" fill="url(#actualTrendFill)"></path>` : ""}
        ${targetBars}
        <path class="trend-line trend-line-actual" d="${actualPath}" fill="none" stroke="#4ade80" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></path>
        ${actualDots}
        ${xLabels}
      </svg>
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

/** Today uses live Daily Plan; past days use plan frozen on scan rows. */
function resolveReportPlanForDay(dayKey, fallbackDayPlan) {
  const today = toIsoDateLocal(new Date());
  if (dayKey === today && Number.isFinite(fallbackDayPlan) && fallbackDayPlan > 0) {
    return fallbackDayPlan;
  }
  return getHistoricalPlanForDay(dayKey);
}

/** Keep today's history rows aligned when operator revises Daily Plan mid-shift. */
function syncTodayScanPlanOnRows(plan) {
  if (!Number.isFinite(plan) || plan <= 0) return;
  const today = toIsoDateLocal(new Date());
  const planStr = String(plan);
  document.querySelectorAll("#scanTable tr").forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (rowDay === today) row.dataset.scanPlan = planStr;
  });
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
    const dt = new Date(`${k}T00:00:00`);
    return dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  });
  const outputVals = periodKeys.map(k => outputByBucket[k] || 0);
  const downtimeMins = periodKeys.map(k => {
    const sec = downtimeByBucket[k] || 0;
    if (sec <= 0) return 0;
    return Math.max(1, Math.round(sec / 60));
  });
  return { labels, outputVals, downtimeMins, bucketName: "Day" };
}

function parseDayTimeTextToMs(dayKey, timeText) {
  const [yy, mm, dd] = String(dayKey).split("-").map(v => parseInt(v, 10));
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  const t = String(timeText || "").trim().toLowerCase();
  const m = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3] || "0", 10);
  const ampm = String(m[4] || "").toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return new Date(yy, mm - 1, dd, h, min, sec, 0).getTime();
}

function getTargetAchievedMsForDay(dayKey, targetUnits) {
  if (!Number.isFinite(targetUnits) || targetUnits <= 0) return null;
  const rows = document.querySelectorAll("#scanTable tr");
  const times = [];
  rows.forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (rowDay !== dayKey) return;
    const scanMsRaw = parseInt(String(row.dataset.scanMs || "").trim(), 10);
    if (Number.isFinite(scanMsRaw) && scanMsRaw > 0) {
      times.push(scanMsRaw);
      return;
    }
    const parsedMs = parseDayTimeTextToMs(rowDay, cells[2]?.innerText || "");
    if (Number.isFinite(parsedMs)) times.push(parsedMs);
  });
  if (times.length < targetUnits) return null;
  times.sort((a, b) => a - b); // earliest -> latest
  return times[targetUnits - 1] || null;
}

function calcActualWtMinsForDay(dayKey, targetUnits = 0) {
  const shiftStartMin = Number(SETTINGS.shiftSchedule.startMinute);
  const shiftEndMin = Number(SETTINGS.shiftSchedule.endMinute);
  if (!Number.isFinite(shiftStartMin) || !Number.isFinite(shiftEndMin) || shiftEndMin <= shiftStartMin) return null;

  const [yy, mm, dd] = String(dayKey).split("-").map(v => parseInt(v, 10));
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;

  const dayStartMs = new Date(yy, mm - 1, dd, 0, 0, 0, 0).getTime();
  const shiftStartMs = dayStartMs + (shiftStartMin * 60 * 1000);
  const shiftEndMs = dayStartMs + (shiftEndMin * 60 * 1000);
  const todayKey = toIsoDateLocal(new Date());
  const achievedMs = getTargetAchievedMsForDay(dayKey, targetUnits);

  if (dayKey < todayKey) {
    // Past day: full configured shift window minus scheduled breaks
    const endMs = Number.isFinite(achievedMs) ? Math.min(shiftEndMs, Math.max(achievedMs, shiftStartMs)) : shiftEndMs;
    const spanSec = Math.max(0, (endMs - shiftStartMs) / 1000);
    const breakSec = scheduledBreakOverlapSec(shiftStartMs, endMs);
    return Math.max(0, (spanSec - breakSec) / 60);
  }
  if (dayKey > todayKey) return 0;

  // Today: elapsed up to now, capped at shift end
  const nowMs = Date.now();
  const naturalEndMs = Math.min(Math.max(nowMs, shiftStartMs), shiftEndMs);
  const endMs = Number.isFinite(achievedMs) ? Math.min(naturalEndMs, Math.max(achievedMs, shiftStartMs)) : naturalEndMs;
  const spanTodaySec = Math.max(0, (endMs - shiftStartMs) / 1000);
  const breakTodaySec = scheduledBreakOverlapSec(shiftStartMs, endMs);
  return Math.max(0, (spanTodaySec - breakTodaySec) / 60);
}

function getPlanWtMinsForDay(dayKey) {
  const d = new Date(`${dayKey}T12:00:00`);
  if (Number.isFinite(d.getTime()) && d.getDay() === 5) {
    return GRAPH_WT_PRESET_MINS.friday;
  }
  const presetKey = graphWtPreset === "nonproduction" ? "normal" : graphWtPreset;
  return GRAPH_WT_PRESET_MINS[presetKey] || GRAPH_WT_PRESET_MINS.normal;
}

/** Plan EFF baseline; Actual EFF stays at 98% when on/above plan within plan W/T, drops only if actual W/T exceeds plan. */
const PLAN_EFF_PCT = 98;

function calcActualEffPct(planUnits, actualUnits, planWtMins, actualWtMins) {
  if (!Number.isFinite(planUnits) || planUnits <= 0) return null;
  if (actualWtMins == null || !Number.isFinite(actualWtMins) || actualWtMins <= 0) return null;
  if (!Number.isFinite(planWtMins) || planWtMins <= 0) return null;

  const unitsRatio = Math.max(0, actualUnits / planUnits);

  if (actualWtMins > planWtMins) {
    const wtFactor = planWtMins / actualWtMins;
    let eff = PLAN_EFF_PCT * wtFactor;
    if (unitsRatio < 1) eff *= unitsRatio;
    return Number(Math.max(0, eff).toFixed(1));
  }

  if (unitsRatio >= 1) return PLAN_EFF_PCT;
  return Number(Math.max(0, unitsRatio * PLAN_EFF_PCT).toFixed(1));
}

function buildEffWtCardsHtmlForDay(dayKey, dayProduced, dayTarget, periodLabel, rangeLabel) {
  const planEffPct = PLAN_EFF_PCT;
  const planWtMins = getPlanWtMinsForDay(dayKey);
  const nonProdDay = dayKey && isNonProductionDay(dayKey);

  const planUnits = dayTarget?.[dayKey] || 0;
  const actualUnits = dayProduced?.[dayKey] || 0;
  const actualWtMins = nonProdDay ? 0 : calcActualWtMinsForDay(dayKey, planUnits);

  const actualEffPct = nonProdDay ? 0 : calcActualEffPct(planUnits, actualUnits, planWtMins, actualWtMins);
  const actualEffClass = nonProdDay
    ? "neg"
    : actualEffPct == null
      ? ""
      : actualEffPct < planEffPct
        ? "neg"
        : "pos";

  const titleDay = dayKey ? formatIsoDateAsDdMmYy(dayKey) : `${periodLabel}: ${rangeLabel}`;
  return `
    <div class="summary-graph-card-title">EFF / W/T CARDS (${titleDay})</div>
    <div class="report-eff-wt-grid">
      <div class="report-eff-wt-card">
        <span>Plan EFF</span>
        <strong>${planEffPct}%</strong>
      </div>
      <div class="report-eff-wt-card">
        <span>Actual EFF</span>
        <strong class="${actualEffClass}">${actualEffPct == null ? "—" : `${actualEffPct}%`}</strong>
      </div>
      <div class="report-eff-wt-card">
        <span>Plan W/T (MINS)</span>
        <strong>${planWtMins.toFixed(1)}</strong>
      </div>
      <div class="report-eff-wt-card">
        <span>Actual W/T (MINS)</span>
        <strong>${actualWtMins == null ? "—" : actualWtMins.toFixed(1)}</strong>
      </div>
    </div>
  `;
}

function updateGraphWtCardsFromFocus() {
  const wrapEl = document.getElementById("graphEffWtCardsWrap");
  if (!wrapEl || !graphReportCache) return;
  const scopeDayKey = graphFocusedDayKey || graphReportCache.anchorDay;
  wrapEl.innerHTML = buildEffWtCardsHtmlForDay(
    scopeDayKey,
    graphReportCache.dayProduced,
    graphReportCache.dayTarget,
    graphReportCache.periodLabel,
    graphReportCache.rangeLabel
  );
}

function focusGraphDay(dayKey) {
  graphFocusedDayKey = dayKey;
  updateGraphWtCardsFromFocus();
}

function renderGraphCharts() {
  const graphBody = document.getElementById("graphChartsBody");
  if (!graphBody) return;
  try {
  const activeDay = getActiveGraphDayKey();
  const range = getActiveGraphRange();
  const rangeLabel = formatIsoRangeAsDdMmYy(range.start, range.end);
  const { labels, downtimeMins } = collectHourlyGraphData(activeDay, graphPeriod);
  const periodLabel = getTrendChartPeriodLabel(range.start, range.end, graphPeriod);
  const periodKeys = getDayKeysBetween(range.start, range.end);
  if (graphFocusedDayKey && !periodKeys.includes(graphFocusedDayKey)) {
    graphFocusedDayKey = null;
  }
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
  let fallbackDayPlan = parseInt(String(document.getElementById("plan")?.innerText || "").trim(), 10);
  if (!Number.isFinite(fallbackDayPlan) || fallbackDayPlan <= 0) {
    fallbackDayPlan = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  }
  const dayTarget = computeDayTargetsForReport(periodKeys, dayProduced, fallbackDayPlan);
  graphReportCache = {
    anchorDay: activeDay,
    periodKeys,
    dayProduced,
    dayTarget,
    periodLabel: getTrendChartPeriodLabel(range.start, range.end, graphPeriod),
    rangeLabel: formatIsoRangeAsDdMmYy(range.start, range.end)
  };
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
  const downtimeChart = buildSummaryBarChart(
    `DOWNTIME TREND (${periodLabel}: ${rangeLabel})`,
    labels,
    downtimeMins,
    "#ef4444",
    "",
    "Minutes",
    {
      chartClass: "summary-chart-downtime",
      barStaggerMs: 35,
      valueDelayAfterBarMs: 220,
      valueCountMs: 260
    }
  );
  const scopeDayKey = graphFocusedDayKey || activeDay;
  const wtCards = buildEffWtCardsHtmlForDay(scopeDayKey, dayProduced, dayTarget, periodLabel, rangeLabel);
  const effTrendKeys = periodKeys;
  const oeeLabels = effTrendKeys.map(k => {
    const d = new Date(`${k}T00:00:00`);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  });
  const oeeValues = effTrendKeys.map(k => {
    if (isNonProductionDay(k)) return 0;
    const target = dayTarget[k] || 0;
    const produced = dayProduced[k] || 0;
    const planWtMins = getPlanWtMinsForDay(k);
    const actualWtMins = calcActualWtMinsForDay(k, target);
    return calcActualEffPct(target, produced, planWtMins, actualWtMins) ?? 0;
  });
  const planEffValues = effTrendKeys.map(k => {
    if (isNonProductionDay(k)) return 0;
    return (dayTarget[k] || 0) > 0 ? PLAN_EFF_PCT : 0;
  });
  const oeeChart = buildEfficiencyTrendChart(
    `EFFICIENCY TREND (${periodLabel}: ${rangeLabel})`,
    oeeLabels,
    oeeValues,
    planEffValues,
    "%",
    "%",
    effTrendKeys
  );
  graphBody.innerHTML = `
    <div class="report-kpi-grid">
      <div class="report-kpi"><span>Total Produced</span><strong class="pos">${totalProduced}</strong><em>units</em></div>
      <div class="report-kpi"><span>Total Target</span><strong>${totalTarget}</strong><em>units</em></div>
      <div class="report-kpi"><span>Production Balance</span><strong class="${(totalProduced-totalTarget) < 0 ? "neg" : "pos"}">${(totalProduced-totalTarget) > 0 ? "+" : ""}${totalProduced-totalTarget}</strong><em>units</em></div>
      <div class="report-kpi"><span>Total Downtime</span><strong class="neg">${totalDowntimeMin}</strong><em>min</em></div>
      <div class="report-kpi"><span>Average Rate</span><strong>${avgRate.toFixed(1)}</strong><em>units/hr</em></div>
    </div>
    <div class="report-chart-grid">
      <div class="summary-graph-card">${planActualChart}</div>
      <div class="summary-graph-card">${downtimeChart}</div>
    </div>
    <div class="report-bottom-grid">
      <div class="summary-graph-card report-eff-wt-wrap" id="graphEffWtCardsWrap">${wtCards}</div>
      <div class="summary-graph-card">${oeeChart}</div>
    </div>
  `;
  animateSummaryBarValues(graphBody);
  animateTrendLines(graphBody);
  initPlanActualChartTooltips(graphBody);
  } catch (err) {
    console.error("renderGraphCharts failed:", err);
    const detail = String(err?.message || err || "Unknown error");
    graphBody.innerHTML = `
      <div class="summary-graph-card">
        <div class="summary-graph-card-title">Production Report</div>
        <div class="summary-graph-empty">Failed to render report data: ${detail}</div>
      </div>
    `;
  }
}

function showGraphPageFromMenu() {
  toggleMenuDropdown(false);
  showGraphPage();
}

function showGraphPage() {
  if (!isAdminRole()) {
    showMainPage();
    return;
  }
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
      <div class="graph-period-toggle" role="group" aria-label="Graph period">
        <button type="button" id="graphPeriodWeekBtn" class="graph-period-btn">Week</button>
        <button type="button" id="graphPeriodMonthBtn" class="graph-period-btn">Month</button>
      </div>
      <div class="graph-range-box">
        <span class="graph-range-label">DATE RANGE</span>
        <div class="graph-range-inputs">
          <input type="text" class="app-date-input" id="graphRangeStart" title="Graph range start date" placeholder="dd/mm/yyyy" readonly>
          <span class="graph-range-sep">-</span>
          <input type="text" class="app-date-input" id="graphRangeEnd" title="Graph range end date" placeholder="dd/mm/yyyy" readonly>
          <button type="button" id="graphRangeTodayBtn" class="graph-today-btn">Today</button>
        </div>
      </div>
    </div>
    <div class="report-body" id="graphChartsBody">
    </div>
  `;
  syncGraphRangePickerUi();
  syncGraphPeriodButtonsUi();
  initGraphRangeDatePickers();
  const graphRangeStart = document.getElementById("graphRangeStart");
  const graphRangeEnd = document.getElementById("graphRangeEnd");
  const graphRangeTodayBtn = document.getElementById("graphRangeTodayBtn");
  const graphPeriodWeekBtn = document.getElementById("graphPeriodWeekBtn");
  const graphPeriodMonthBtn = document.getElementById("graphPeriodMonthBtn");
  if (graphRangeTodayBtn) graphRangeTodayBtn.addEventListener("click", onGraphRangeTodayClick);
  if (graphPeriodWeekBtn) graphPeriodWeekBtn.addEventListener("click", () => onGraphPeriodChange("week"));
  if (graphPeriodMonthBtn) graphPeriodMonthBtn.addEventListener("click", () => onGraphPeriodChange("month"));
  try {
    renderGraphCharts();
  } catch (err) {
    console.error("showGraphPage render failed:", err);
  }

  document.body.classList.remove("summary-mode");
  document.body.classList.remove("history-mode");
  const summaryPage = document.getElementById("summaryPage");
  if (summaryPage) summaryPage.classList.remove("open");
  const historyPanel = document.getElementById("historyPanel");
  if (historyPanel) historyPanel.classList.remove("open");
  document.body.classList.add("graph-mode");
  syncGraphWtControl();
  graphPage.classList.add("open");
  triggerEnterAnimation(graphPage);
  updateViewToggleMenuItem();
}

function showSummaryPage() {
  if (!isAdminRole()) {
    showMainPage();
    return;
  }
  toggleMenuDropdown(false);
  const activeDay = getActiveSummaryDayKey();
  const planCard = parseInt(document.getElementById("plan").innerText, 10) || 0;
  const planInput = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const fallbackDayPlan = planCard > 0 ? planCard : planInput;
  let plan = resolveReportPlanForDay(activeDay, fallbackDayPlan);
  if (!Number.isFinite(plan) || plan < 0) plan = fallbackDayPlan;

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
  const efficiency = plan > 0 ? `${Math.min(100, Math.max(0, Math.round((actual / plan) * 100)))}%` : "—";

  let summaryPage = document.getElementById("summaryPage");
  if (!summaryPage) {
    summaryPage = document.createElement("div");
    summaryPage.id = "summaryPage";
    summaryPage.className = "summary-page";
    document.body.appendChild(summaryPage);
  }

  summaryPage.innerHTML = `
    <div class="summary-title-row">
      <div class="summary-head">Daily Summary</div>
      <div class="summary-filter-row">
        <label for="summaryDayFilter">Date</label>
        <input type="text" class="app-date-input" id="summaryDayFilter" title="Select date for daily summary" placeholder="dd/mm/yyyy" readonly>
        <button type="button" id="summaryDayTodayBtn" class="summary-today-btn">Today</button>
      </div>
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
  if (summaryDayFilter) initSingleDayDatePicker(summaryDayFilter, onSummaryDayFilterChange);
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

  const roleDd = document.getElementById("roleDropdown");
  const roleWrap = event.target.closest(".header-role-wrap");
  if (roleDd && roleDd.classList.contains("open") && !roleWrap) {
    toggleRoleDropdown(false);
  }

  const wtDd = document.getElementById("graphWtDropdown");
  const wtWrap = event.target.closest(".header-wt-dd-wrap");
  if (wtDd && wtDd.classList.contains("open") && !wtWrap) {
    toggleGraphWtDropdown(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    const loginOpen = document.getElementById("adminLoginOverlay")?.classList.contains("open");
    if (loginOpen) {
      closeAdminLoginModal();
      return;
    }
    toggleRoleDropdown(false);
    toggleGraphWtDropdown(false);
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
  if (isNonProductionMode()) {
    expected = 0;
  }
  let delay = actual - expected;
  if (isNonProductionMode()) {
    delay = 0;
  }

  const efficiency = efficiencyPercent;

  const balance = actual - plan;
  const status = document.getElementById("status").innerText.trim();
  const lotNo = document.getElementById("lotInput").value || "";
  const bookedDowntime = getBookedDowntimeSec();

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

  publishLiveStateToFirebase({
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
    lastScanAtMs: lastScanWallMs != null ? lastScanWallMs : null
  });
}

function sendToSheet(chassis, model, engine, key, lot, status, downtimeEvent) {
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  const actual = actualCount;
  const downtimeSec = downtimeEvent ? parseMmSsToSeconds(downtimeEvent) : 0;

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
      downtimeEvent: downtimeEvent,
      // Seconds avoids Sheets auto-formatting "04:27" as a clock time (4:27 AM).
      downtimeEventSeconds: downtimeSec
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

  // In some sheet layouts there are multiple "downtime" columns
  // (event + cumulative). Prefer the smallest positive duration-like
  // value because event downtime must not exceed cumulative totals.
  const orderedIdxs = [];
  if (primaryIdx >= 0) orderedIdxs.push(primaryIdx);
  candidateIdxs.forEach(i => {
    if (i < 0) return;
    if (!orderedIdxs.includes(i)) orderedIdxs.push(i);
  });

  let bestRaw = "";
  let bestSec = Number.POSITIVE_INFINITY;
  for (const i of orderedIdxs) {
    const raw = row[i];
    if (raw == null || String(raw).trim() === "") continue;
    if (!looksLikeDurationToken(raw)) continue;
    const sec = parseMmSsToSeconds(String(raw));
    if (sec > 0 && sec < bestSec) {
      bestSec = sec;
      bestRaw = raw;
    }
  }
  const pickSmallestFromRow = () => {
    let rowBestRaw = "";
    let rowBestSec = Number.POSITIVE_INFINITY;
    row.forEach(raw => {
      if (raw == null || String(raw).trim() === "") return;
      if (!looksLikeDurationToken(raw)) return;
      const sec = parseMmSsToSeconds(String(raw));
      if (sec > 0 && sec < rowBestSec) {
        rowBestSec = sec;
        rowBestRaw = raw;
      }
    });
    return { rowBestRaw, rowBestSec };
  };

  // If a smaller valid token exists elsewhere in the row, prefer it.
  // This covers sheet layouts where event downtime header is unusual.
  const { rowBestRaw, rowBestSec } = pickSmallestFromRow();
  if (rowBestRaw !== "" && rowBestSec < bestSec) return rowBestRaw;
  if (bestRaw !== "") return bestRaw;

  // If parsing can't determine duration tokens, still fallback to first non-empty.
  for (const i of orderedIdxs) {
    const raw = row[i];
    if (raw == null || String(raw).trim() === "") continue;
    return raw;
  }

  // Last fallback only when headers are unusable.
  // Keep "smallest duration-looking token" behavior for legacy payloads.
  bestRaw = rowBestRaw;
  if (bestRaw !== "") return bestRaw;

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
      const idxKey = getIdx("key no", "key no.", "key");
      const idxStatusByHeader = getIdx("status", "state");
      if (idxKey >= 0 && (idxKey === idxEngine || idxKey === idxChassis || idxKey === idxModel)) {
        console.warn("Google Sheet: Key column header matches the wrong column. Fix sheet headers.");
      }
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
          const rowIsDownTime = isRowStatusDownTime(statusText);

          if (statusText === "SCANNED") statusCell.className = "status-green";
          if (rowIsDownTime) statusCell.className = "status-red";

          const downtimeCell = newRow.insertCell(9);

          if (rowIsDownTime) {
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
          newRow.dataset.scanMs = Number.isFinite(fullDateTime.getTime()) ? String(fullDateTime.getTime()) : "";
          const rawPlan = idxPlan >= 0 ? row[idxPlan] : "";
          const planVal = parseInt(String(rawPlan ?? "").trim(), 10);
          newRow.dataset.scanPlan = Number.isFinite(planVal) && planVal > 0 ? String(planVal) : "";
        });
        renumberScanTable();
        rebuildScannedSetsFromTable();
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
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  syncTodayScanPlanOnRows(plan);
  hasLocalSession = true;
  updateDisplay();
  updateLiveStateOnly();
  if (document.getElementById("graphChartsBody")) renderGraphCharts();
});

document.getElementById("lotInput").addEventListener("input", () => {
  hasLocalSession = true;
  updateLiveStateOnly();
});

const historyDayFilterEl = document.getElementById("historyDayFilter");
const historyDayTodayBtn = document.getElementById("historyDayTodayBtn");
if (historyDayFilterEl) initSingleDayDatePicker(historyDayFilterEl, onHistoryDayFilterChange);
if (historyDayTodayBtn) {
  historyDayTodayBtn.addEventListener("click", onHistoryDayTodayClick);
}

window.onload = async function() {
  // 🔐 MUST WAIT ACCESS CHECK
  const allowed = await checkAccess();
  if (!allowed) return;

  loadGraphWtPresetFromStorage();
  applyAppRoleUi();
  loadShiftScheduleFromStorage();
  ensureShiftScheduleModal();
  bindClockShiftShortcut();
  bindRamadanRevealShortcut();
  ensureOvertimeMenuItem();
  ensureOvertimeModal();
  updateOvertimeMenuLabel();

  syncDowntimeDayPickerUi();

  updateDateTime();
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(updateDateTime, 1000);

  if (isMonitor) {
    document.body.classList.add("monitor-mode");
    if (isAdminRole()) applyOperatorStyleMonitorDashboard();
    else applyLegacyMonitorDashboardLayout();
  }

  initFirebaseSync();
  loadInitialLiveState();

  if (isMonitor) {
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
    document.getElementById("lotInput").readOnly = true;

    // Dashboard cards/status: Firebase realtime listener source of truth
    // (attached in initFirebaseSync). Avoid duplicate polling reads.
    loadMonitorStateFromFirebase();

    // Scan table rows: Google Sheet source of truth.
    loadLiveData();
    if (liveDataPollInterval) clearInterval(liveDataPollInterval);
    liveDataPollInterval = setInterval(loadLiveData, 3000);
    if (liveStatePollInterval) {
      clearInterval(liveStatePollInterval);
      liveStatePollInterval = null;
    }
    updateMonitorDataNotice();
    syncGraphWtControl();
  } else {
    syncGraphWtControl();
    // Reload scan history from Sheet after refresh (main screen).
    loadLiveData();
    if (liveDataPollInterval) clearInterval(liveDataPollInterval);
    liveDataPollInterval = setInterval(loadLiveData, 3000);
    if (liveStatePollInterval) clearInterval(liveStatePollInterval);
    liveStatePollInterval = setInterval(updateLiveStateOnly, 2000);
    applyShiftScheduleTick();
    if (shiftScheduleInterval) clearInterval(shiftScheduleInterval);
    shiftScheduleInterval = setInterval(applyShiftScheduleTick, 30000);
  }
  updateViewToggleMenuItem();
};
