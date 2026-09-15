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
let graphRangePickerSyncing = false;
let masterSettingsPublishTimer = null;
let graphPageShellReady = false;
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
let firebaseAppearanceRef = null;
/** Firebase server clock minus local clock — keeps countdown aligned across PCs. */
let serverTimeOffsetMs = 0;
let monitorCountdownRender = null;
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
    if (v === "management") return "management";
    if (v === "master" || v === "admin") {
      if (sessionStorage.getItem(APP_ADMIN_SESSION_KEY) !== "1") {
        sessionStorage.setItem(APP_ROLE_STORAGE_KEY, "operator");
        return "operator";
      }
      return "master";
    }
    return "operator";
  } catch {
    return "operator";
  }
}

function getRoleLabel(role) {
  if (role === "master") return "Master Control";
  if (role === "management") return "Management";
  return "Operator";
}

function isMasterRole() {
  return getAppRole() === "master";
}

function isManagementRole() {
  return getAppRole() === "management";
}

function isAdminRole() {
  return isMasterRole();
}

function canViewReports() {
  const role = getAppRole();
  return role === "management" || role === "master";
}

function canOperateLine() {
  return getAppRole() === "operator" || isMasterRole();
}

function canAdjustWorkingHour() {
  return true;
}

function setAppRole(role) {
  if (role === "master" || role === "admin") return;
  try {
    sessionStorage.removeItem(APP_ADMIN_SESSION_KEY);
    sessionStorage.setItem(APP_ROLE_STORAGE_KEY, role === "management" ? "management" : "operator");
  } catch (_) {}
  applyAppRoleUi();
}

function grantAdminAfterLogin() {
  try {
    sessionStorage.setItem(APP_ADMIN_SESSION_KEY, "1");
    sessionStorage.setItem(APP_ROLE_STORAGE_KEY, "master");
  } catch (_) {}
  applyAppRoleUi();
}

function applyMainPcEditLock() {
  const master = isMasterRole();
  const canOperate = canOperateLine();
  ["cycleTarget", "dailyPlanTarget", "lotInput"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.readOnly = !master;
    el.classList.toggle("settings-locked", !master);
  });
  document.querySelectorAll(".main-pc-actions button").forEach(btn => {
    btn.disabled = isMonitor ? !master : !canOperate;
  });
  if (isMonitor || isNonProductionMode()) {
    setScanInputsEnabled(false);
  } else {
    setScanInputsEnabled(canOperate);
  }
  const wtWrap = document.querySelector(".header-wt-dd-wrap");
  if (wtWrap) wtWrap.classList.toggle("wt-locked", !canAdjustWorkingHour());
  const wtTrigger = document.getElementById("graphWtTrigger");
  if (wtTrigger) {
    const allowWt = canAdjustWorkingHour();
    wtTrigger.disabled = !allowWt;
    wtTrigger.setAttribute("aria-disabled", allowWt ? "false" : "true");
  }
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
  const role = getAppRole();
  const master = role === "master";
  const wasFullscreen = !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement
  );
  document.body.classList.toggle("role-admin", master);
  document.body.classList.toggle("role-master", master);
  document.body.classList.toggle("role-management", role === "management");
  document.body.classList.toggle("role-operator", role === "operator");
  const label = document.getElementById("roleLabel");
  if (label) label.textContent = getRoleLabel(role);
  document.querySelectorAll(".header-role-option").forEach(btn => {
    const btnRole = btn.getAttribute("data-role");
    const sel = btnRole === role || (master && btnRole === "admin");
    btn.setAttribute("aria-selected", sel ? "true" : "false");
    btn.classList.toggle("selected", sel);
  });
  if (role === "operator") {
    toggleMenuDropdown(false);
    toggleRoleDropdown(false);
    if (
      document.body.classList.contains("summary-mode") ||
      document.body.classList.contains("graph-mode") ||
      document.body.classList.contains("history-mode") ||
      document.body.classList.contains("appearance-mode")
    ) {
      showMainPage();
    }
  } else if (role === "management" && document.body.classList.contains("appearance-mode")) {
    showMainPage();
  }
  if (isMonitor && document.body.classList.contains("monitor-mode")) {
    applyMonitorLayoutForCurrentRole();
  }
  syncRoleDropdownAria();
  syncGraphWtControl();
  applyMainPcEditLock();
  restoreFullscreenIfNeeded(wasFullscreen);
  syncOperatorDashboardChrome();
}

function isAppFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement
  );
}

function restoreFullscreenIfNeeded(wasFullscreen) {
  if (!wasFullscreen || isAppFullscreen()) return;
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (!req) return;
  try {
    const result = req.call(el);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (_) {}
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
  if (role === "master" || role === "admin") {
    if (isMasterRole()) return;
    showAdminLoginModal();
    return;
  }
  if (role === "management") {
    setAppRole("management");
    return;
  }
  setAppRole("operator");
}

function isNonProductionMode() {
  return graphWtPreset === "nonproduction";
}

function isNonProductionLiveState(state, status) {
  const st = String(status || (state && state.status) || "").trim().toUpperCase();
  if (st === "NON PRODUCTION") return true;
  if (state && normalizeGraphWtPreset(state.graphWtPreset) === "nonproduction") return true;
  return isNonProductionMode();
}

function getConfiguredDailyPlan() {
  return parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
}

/** Dashboard / live-card target. Non-production days have no output target. */
function getDashboardPlan() {
  return isNonProductionMode() ? 0 : getConfiguredDailyPlan();
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

function getNonProductionDaysArray() {
  return [...loadNonProductionDaysSet()];
}

/** Cycle / plan / lot / WT from Master Control — main PC and monitor both write these. */
function publishMasterSettingsFromInputs() {
  if (!isMasterRole() || !firebaseLiveStateRef) return;
  clearTimeout(masterSettingsPublishTimer);
  masterSettingsPublishTimer = setTimeout(() => {
    const configuredPlan = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
    const cycleTimeMin = parseFloat(document.getElementById("cycleTarget")?.value) || SETTINGS.defaultCycle;
    const lotNo = document.getElementById("lotInput")?.value || "";
    const plan = getDashboardPlan();
    firebaseLiveStateRef.update({
      plan,
      dailyPlan: configuredPlan,
      cycleTimeMin,
      lotNo,
      ramadanMode,
      graphWtPreset,
      nonProductionDays: getNonProductionDaysArray(),
      settings: {
        dailyPlan: configuredPlan,
        cycleTimeMin
      },
      sender: syncClientId,
      updatedAt: firebase.database.ServerValue.TIMESTAMP
    }).catch(err => {
      console.log("Firebase master settings publish error:", err);
    });
  }, 250);
}

/** Main PC publishes graph filters; monitors mirror so Production Trend matches everywhere. */
function publishGraphSettingsToFirebase() {
  if (!firebaseLiveStateRef) return;
  if (!canAdjustWorkingHour()) return;
  firebaseLiveStateRef.update({
    graphWtPreset: graphWtPreset,
    nonProductionDays: getNonProductionDaysArray(),
    sender: syncClientId,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    console.log("Firebase graph settings publish error:", err);
  });
}

function applyGraphSettingsFromRemote(state) {
  if (!state || !isMonitor) return;
  if (state.sender && state.sender === syncClientId) return;
  let changed = false;
  if (state.graphWtPreset) {
    const next = normalizeGraphWtPreset(state.graphWtPreset);
    if (graphWtPreset !== next) {
      graphWtPreset = next;
      changed = true;
    }
  }
  if (Array.isArray(state.nonProductionDays)) {
    const valid = state.nonProductionDays.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
    const current = [...loadNonProductionDaysSet()].sort().join(",");
    const incoming = [...valid].sort().join(",");
    if (current !== incoming) {
      saveNonProductionDaysSet(new Set(valid));
      changed = true;
    }
  }
  applyGraphWtControlUi();
  if (changed && document.body.classList.contains("graph-mode")) {
    renderGraphCharts();
  }
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

/** One pass over the scan table for report charts (avoids 30+ full-table scans on Month). */
function collectScanTableStats(dayKeys) {
  const keySet = dayKeys?.length ? new Set(dayKeys) : null;
  const dayProduced = {};
  const dayDowntimeSec = {};
  const dayDowntimeSecAny = {};
  const dayPlan = {};
  const dayScanTimes = {};
  (dayKeys || []).forEach(k => {
    dayProduced[k] = 0;
    dayDowntimeSec[k] = 0;
    dayDowntimeSecAny[k] = 0;
    dayScanTimes[k] = [];
  });
  const rows = document.getElementById("scanTable")?.rows;
  if (!rows) return { dayProduced, dayDowntimeSec, dayDowntimeSecAny, dayPlan, dayScanTimes };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.cells;
    if (!cells || cells.length === 0) continue;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || (keySet && !keySet.has(rowDay))) continue;
    dayProduced[rowDay] = (dayProduced[rowDay] || 0) + 1;
    const dtSec = parseMmSsToSeconds(cells[9]?.innerText || "");
    if (dtSec > 0) {
      dayDowntimeSecAny[rowDay] = (dayDowntimeSecAny[rowDay] || 0) + dtSec;
      const statusText = String(cells[8]?.innerText || "").replace(/\s+/g, " ").trim().toUpperCase();
      if (statusText === "DOWN TIME" || statusText === "DOWNTIME") {
        dayDowntimeSec[rowDay] = (dayDowntimeSec[rowDay] || 0) + dtSec;
      }
    }
    if (!Number.isFinite(dayPlan[rowDay])) {
      const planVal = parseInt((row.dataset.scanPlan || "").trim(), 10);
      if (Number.isFinite(planVal) && planVal > 0) dayPlan[rowDay] = planVal;
    }
    let scanMs = parseInt(String(row.dataset.scanMs || "").trim(), 10);
    if (!Number.isFinite(scanMs) || scanMs <= 0) {
      scanMs = parseDayTimeTextToMs(rowDay, cells[2]?.innerText || "");
    }
    if (Number.isFinite(scanMs) && scanMs > 0) {
      if (!dayScanTimes[rowDay]) dayScanTimes[rowDay] = [];
      dayScanTimes[rowDay].push(scanMs);
    }
  }
  return { dayProduced, dayDowntimeSec, dayDowntimeSecAny, dayPlan, dayScanTimes };
}

/** Count scan rows in the dashboard table for one calendar day. */
function countScanRowsForDay(dayKey) {
  if (!dayKey) return 0;
  let count = 0;
  document.querySelectorAll("#scanTable tr").forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (rowDay === dayKey) count += 1;
  });
  return count;
}

/** Build day → scan count from the table (optional day-key filter). */
function buildDailyActualMapFromScanTable(dayKeys) {
  const keySet = dayKeys?.length ? new Set(dayKeys) : null;
  const map = {};
  document.querySelectorAll("#scanTable tr").forEach(row => {
    const cells = row.querySelectorAll("td");
    if (!cells.length) return;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (!rowDay || (keySet && !keySet.has(rowDay))) return;
    map[rowDay] = (map[rowDay] || 0) + 1;
  });
  return map;
}

/**
 * Reports / graphs: Google Sheet rows override non-production marks.
 * A day only counts as non-production when marked AND it has no scan data.
 */
function isReportNonProductionDay(dayKey, dailyActualMap) {
  if (!dayKey) return isNonProductionMode() && countScanRowsForDay(toIsoDateLocal(new Date())) === 0;
  const produced = dailyActualMap
    ? (dailyActualMap[dayKey] || 0)
    : countScanRowsForDay(dayKey);
  if (produced > 0) return false;
  return isNonProductionDay(dayKey);
}

/** Remove stale non-production marks when the sheet already has rows for that day. */
function reconcileNonProductionMarksFromSheet() {
  const npSet = loadNonProductionDaysSet();
  let changed = false;
  npSet.forEach(dayKey => {
    if (countScanRowsForDay(dayKey) > 0) {
      npSet.delete(dayKey);
      changed = true;
    }
  });
  if (changed) {
    saveNonProductionDaysSet(npSet);
    if (!isMonitor) publishGraphSettingsToFirebase();
  }
  return changed;
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
  // Monitors follow main PC graph settings via Firebase — not this browser's localStorage.
  if (!isMonitor) {
    try {
      const stored = localStorage.getItem(GRAPH_WT_PRESET_STORAGE_KEY);
      if (stored) graphWtPreset = normalizeGraphWtPreset(stored);
    } catch (_) {}
  }
  if (graphWtPreset === "friday") graphWtPreset = "normal";
  if (!isMonitor) syncNonProductionDayMarkForToday();
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
  countdownValue = 0;
  isDowntime = false;
  duplicateLock = false;
  pendingChassis = "";
  pendingModel = "";
  pendingEngine = "";
  pendingKey = "";
  setScanInputsEnabled(false);
  setStatus("NON PRODUCTION", "status-blue");
  updateDisplay();
  updateLiveStateOnly();
}

function applyGraphWtPresetEffects(prevPreset) {
  if (isMonitor) {
    applyGraphWtControlUi();
    publishGraphSettingsToFirebase();
    return;
  }
  if (isNonProductionMode()) {
    applyNonProductionMode();
    return;
  }
  document.body.classList.remove("non-production-mode");
  applyMainPcEditLock();
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
  if (!canAdjustWorkingHour()) return;
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
  applyMainPcEditLock();
}

function onGraphWtOptionClick(event, preset) {
  event.stopPropagation();
  toggleGraphWtDropdown(false);
  if (!canAdjustWorkingHour()) return;
  const p = normalizeGraphWtPreset(preset);
  if (graphWtPreset === p) return;
  const prev = graphWtPreset;
  graphWtPreset = p;
  saveGraphWtPresetToStorage();
  syncNonProductionDayMarkForToday();
  applyGraphWtControlUi();
  applyGraphWtPresetEffects(prev);
  publishGraphSettingsToFirebase();
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
const FIREBASE_APPEARANCE_PATH = "production/appearance";
const APPEARANCE_STORAGE_KEY = "TF2_APPEARANCE";
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

function applyMonitorLayoutForCurrentRole() {
  if (!isMonitor) return;
  if (canViewReports()) applyOperatorStyleMonitorDashboard();
  else applyLegacyMonitorDashboardLayout();
  setMonitorConnectionStatus(monitorFirebaseNetConnected);
}

function ensureMonitorConnectionWrap() {
  let wrap = document.getElementById("monitorConnectionWrap");
  if (wrap) return wrap;
  wrap = document.createElement("div");
  wrap.id = "monitorConnectionWrap";
  wrap.innerHTML = `
      <div class="monitor-only-text">MONITOR ONLY</div>
      <div id="monitorConnectionStatus" class="monitor-connection-badge">LIVE</div>
    `;
  return wrap;
}

/** Admin / management monitor: operator-style 4+4 dashboard cards + CONNECTION STATUS / LINE STATUS bottom row (inputs hidden by monitor-mode). */
function applyOperatorStyleMonitorDashboard() {
  if (!isMonitor) return;

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

  const wrap = ensureMonitorConnectionWrap();
  wrap.className = "monitor-status-wrap monitor-inline-connection";
  wrap.hidden = false;
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

  const wrap = ensureMonitorConnectionWrap();
  wrap.className = "monitor-status-wrap monitor-legacy-connection";
  wrap.hidden = false;
  const scanGrid = monitorCard.querySelector(".scan-grid");
  if (scanGrid) scanGrid.appendChild(wrap);
  else monitorCard.appendChild(wrap);
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
    if (isoDate) fp.setDate(isoDate, false, "Y-m-d");
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
      if (graphRangePickerSyncing) return;
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

  const range = getActiveGraphRange();
  graphRangePickerSyncing = true;
  initDatePicker(endEl, {
    defaultDate: range.end,
    onChange() {
      onGraphRangeFilterChange();
    }
  });
  initDatePicker(startEl, {
    defaultDate: range.start,
    onChange() {
      onGraphRangeFilterChange();
    }
  });
  graphRangePickerSyncing = false;
  syncGraphRangePickerUi();
}

function initSingleDayDatePicker(el, onChange) {
  return initDatePicker(el, { onChange });
}

function syncGraphRangePickerUi() {
  const startEl = document.getElementById("graphRangeStart");
  const endEl = document.getElementById("graphRangeEnd");
  const range = getActiveGraphRange();
  const startFp = startEl ? datePickerRegistry.get(startEl) : null;
  const endFp = endEl ? datePickerRegistry.get(endEl) : null;
  graphRangePickerSyncing = true;
  if (startFp) startFp.set("maxDate", null);
  if (endFp) endFp.set("minDate", null);
  setDatePickerValue(startEl, range.start);
  setDatePickerValue(endEl, range.end);
  if (startFp && range.end) startFp.set("maxDate", range.end);
  if (endFp && range.start) endFp.set("minDate", range.start);
  graphRangePickerSyncing = false;
}

function onGraphRangeFilterChange() {
  if (graphRangePickerSyncing) return;
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
  graphFilterDate = graphRangeEndDate;
  graphRangePickerSyncing = true;
  const startFp = datePickerRegistry.get(startEl);
  const endFp = datePickerRegistry.get(endEl);
  if (startFp) startFp.set("maxDate", graphRangeEndDate);
  if (endFp) endFp.set("minDate", graphRangeStartDate);
  graphRangePickerSyncing = false;
  renderGraphCharts();
}

function onGraphRangeTodayClick() {
  const today = toIsoDateLocal(new Date());
  graphFilterDate = null;
  applyGraphPeriodRange(today, graphPeriod, false);
  syncGraphRangePickerUi();
  renderGraphCharts();
}

function onGraphPeriodChange(period) {
  graphPeriod = (period === "week" || period === "month") ? period : "week";
  applyGraphPeriodRange(toIsoDateLocal(new Date()), graphPeriod, false);
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

function getScanDayKeyFromRow(row) {
  if (!row) return null;
  const cells = row.cells || row.querySelectorAll("td");
  const rowDay = row.dataset?.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
  return /^\d{4}-\d{2}-\d{2}$/.test(rowDay || "") ? rowDay : null;
}

function getLatestScanDayKey() {
  let latest = null;
  document.querySelectorAll("#scanTable tr").forEach(row => {
    const rowDay = getScanDayKeyFromRow(row);
    if (!rowDay) return;
    if (!latest || rowDay > latest) latest = rowDay;
  });
  return latest;
}

function countScansInDayKeys(dayKeys) {
  const set = new Set(dayKeys || []);
  if (!set.size) return 0;
  let n = 0;
  document.querySelectorAll("#scanTable tr").forEach(row => {
    const rowDay = getScanDayKeyFromRow(row);
    if (rowDay && set.has(rowDay)) n++;
  });
  return n;
}

/** Prefer a week/month that actually has scans so Week/Month don't open blank. */
function resolvePeriodAnchorIso(preferredAnchor, period) {
  const fallback = preferredAnchor || toIsoDateLocal(new Date());
  const keys = getPeriodDayKeys(fallback, period);
  if (countScansInDayKeys(keys) > 0) return fallback;
  const latest = getLatestScanDayKey();
  return latest || fallback;
}

function applyGraphPeriodRange(anchorIso, period, snapToData) {
  const anchor = snapToData
    ? resolvePeriodAnchorIso(anchorIso, period)
    : (anchorIso || toIsoDateLocal(new Date()));
  graphFilterDate = anchor;
  const periodKeys = getPeriodDayKeys(anchor, period);
  if (periodKeys.length) {
    graphRangeStartDate = periodKeys[0];
    graphRangeEndDate = periodKeys[periodKeys.length - 1];
  }
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
    setStatus("NON PRODUCTION", "status-blue");
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
  if (payload.sender && payload.sender === syncClientId) return;
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

/** Main or Master Control on a monitor: push current shift so every PC stays in sync. */
function publishShiftScheduleToFirebase() {
  if (!firebaseShiftScheduleRef) return;
  if (isMonitor && !isMasterRole()) return;
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
  if (!isMasterRole()) return;
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

/* ================= THEME & BRAND ================= */

const DEFAULT_APPEARANCE = {
  themeId: "midnight",
  title: "TF 2 PRODUCTION MONITORING SYSTEM",
  subtitle: "Real-time overview of production",
  menuLine1: "PRODUCTION",
  menuLine2: "MONITORING SYSTEM",
  footer: "© 2026 Production System",
  logoEmoji: "🏭",
  logoData: "",
  accent: ""
};

const APPEARANCE_EMOJIS = ["🏭", "🚗", "🔧", "⚙️", "🏢", "🛠️", "📦", "🚜", "⚡", "🛢️"];

const THEME_PRESETS = {
  midnight: {
    label: "Midnight Factory",
    light: false,
    swatch: ["#000000", "#0b1220", "#38bdf8", "#22c55e"],
    vars: {
      "--bg": "#000000",
      "--panel": "#000000",
      "--text": "#e2e8f0",
      "--text-muted": "#94a3b8",
      "--text-soft": "#cbd5e1",
      "--border": "rgba(148,163,184,0.18)",
      "--border-strong": "rgba(71,85,105,.45)",
      "--blue": "#38bdf8",
      "--accent": "#38bdf8",
      "--accent-soft": "#93c5fd",
      "--green": "#22c55e",
      "--red": "#ef4444",
      "--orange": "#f97316",
      "--card-bg": "linear-gradient(180deg, rgba(8,13,25,0.96), rgba(6,10,20,0.98))",
      "--card-glow": "rgba(56,189,248,0.08)",
      "--input-bg": "rgba(2,6,23,0.72)",
      "--header-fg": "#dbeafe",
      "--table-bg": "#020617",
      "--table-th": "#0f172a"
    }
  },
  navy: {
    label: "Steel Navy",
    light: false,
    swatch: ["#020617", "#0f172a", "#60a5fa", "#38bdf8"],
    vars: {
      "--bg": "#020617",
      "--panel": "#07111f",
      "--text": "#e2e8f0",
      "--text-muted": "#94a3b8",
      "--text-soft": "#cbd5e1",
      "--border": "rgba(96,165,250,0.22)",
      "--border-strong": "rgba(59,130,246,.4)",
      "--blue": "#60a5fa",
      "--accent": "#60a5fa",
      "--accent-soft": "#93c5fd",
      "--green": "#22c55e",
      "--red": "#ef4444",
      "--orange": "#f59e0b",
      "--card-bg": "linear-gradient(180deg, rgba(15,23,42,0.96), rgba(8,15,30,0.98))",
      "--card-glow": "rgba(96,165,250,0.14)",
      "--input-bg": "rgba(15,23,42,0.85)",
      "--header-fg": "#dbeafe",
      "--table-bg": "#020617",
      "--table-th": "#0f172a"
    }
  },
  forest: {
    label: "Forest Line",
    light: false,
    swatch: ["#04110c", "#0b1f16", "#34d399", "#86efac"],
    vars: {
      "--bg": "#04110c",
      "--panel": "#071a12",
      "--text": "#ecfdf5",
      "--text-muted": "#86efac",
      "--text-soft": "#d1fae5",
      "--border": "rgba(52,211,153,0.22)",
      "--border-strong": "rgba(16,185,129,.4)",
      "--blue": "#34d399",
      "--accent": "#34d399",
      "--accent-soft": "#6ee7b7",
      "--green": "#22c55e",
      "--red": "#f87171",
      "--orange": "#fbbf24",
      "--card-bg": "linear-gradient(180deg, rgba(6,32,22,0.96), rgba(4,18,12,0.98))",
      "--card-glow": "rgba(52,211,153,0.14)",
      "--input-bg": "rgba(6,24,16,0.85)",
      "--header-fg": "#d1fae5",
      "--table-bg": "#03140d",
      "--table-th": "#0b2418"
    }
  },
  amber: {
    label: "Amber Plant",
    light: false,
    swatch: ["#120a03", "#2a1706", "#fbbf24", "#fb923c"],
    vars: {
      "--bg": "#120a03",
      "--panel": "#1a0f05",
      "--text": "#fff7ed",
      "--text-muted": "#fdba74",
      "--text-soft": "#fed7aa",
      "--border": "rgba(251,191,36,0.22)",
      "--border-strong": "rgba(245,158,11,.42)",
      "--blue": "#fbbf24",
      "--accent": "#fbbf24",
      "--accent-soft": "#fde68a",
      "--green": "#4ade80",
      "--red": "#f87171",
      "--orange": "#fb923c",
      "--card-bg": "linear-gradient(180deg, rgba(42,23,6,0.96), rgba(18,10,3,0.98))",
      "--card-glow": "rgba(251,191,36,0.16)",
      "--input-bg": "rgba(30,16,4,0.85)",
      "--header-fg": "#ffedd5",
      "--table-bg": "#120a03",
      "--table-th": "#271504"
    }
  },
  crimson: {
    label: "Crimson Shift",
    light: false,
    swatch: ["#140406", "#2a0b10", "#fb7185", "#f43f5e"],
    vars: {
      "--bg": "#140406",
      "--panel": "#1c070b",
      "--text": "#ffe4e6",
      "--text-muted": "#fda4af",
      "--text-soft": "#fecdd3",
      "--border": "rgba(251,113,133,0.24)",
      "--border-strong": "rgba(244,63,94,.42)",
      "--blue": "#fb7185",
      "--accent": "#fb7185",
      "--accent-soft": "#fda4af",
      "--green": "#4ade80",
      "--red": "#ef4444",
      "--orange": "#fb923c",
      "--card-bg": "linear-gradient(180deg, rgba(42,11,16,0.96), rgba(20,4,6,0.98))",
      "--card-glow": "rgba(251,113,133,0.16)",
      "--input-bg": "rgba(30,8,12,0.85)",
      "--header-fg": "#ffe4e6",
      "--table-bg": "#140406",
      "--table-th": "#2a0b10"
    }
  },
  violet: {
    label: "Violet Night",
    light: false,
    swatch: ["#0b0614", "#1e1033", "#a78bfa", "#c084fc"],
    vars: {
      "--bg": "#0b0614",
      "--panel": "#12091f",
      "--text": "#f5f3ff",
      "--text-muted": "#c4b5fd",
      "--text-soft": "#ddd6fe",
      "--border": "rgba(167,139,250,0.24)",
      "--border-strong": "rgba(139,92,246,.42)",
      "--blue": "#a78bfa",
      "--accent": "#a78bfa",
      "--accent-soft": "#c4b5fd",
      "--green": "#34d399",
      "--red": "#f87171",
      "--orange": "#fb923c",
      "--card-bg": "linear-gradient(180deg, rgba(30,16,51,0.96), rgba(11,6,20,0.98))",
      "--card-glow": "rgba(167,139,250,0.16)",
      "--input-bg": "rgba(22,12,38,0.85)",
      "--header-fg": "#ede9fe",
      "--table-bg": "#0b0614",
      "--table-th": "#1e1033"
    }
  },
  daylight: {
    label: "Day Shift",
    light: true,
    swatch: ["#e8eef5", "#ffffff", "#2563eb", "#0f172a"],
    vars: {
      "--bg": "#e8eef5",
      "--panel": "#ffffff",
      "--text": "#0f172a",
      "--text-muted": "#64748b",
      "--text-soft": "#334155",
      "--border": "rgba(15,23,42,0.12)",
      "--border-strong": "rgba(15,23,42,0.18)",
      "--blue": "#2563eb",
      "--accent": "#2563eb",
      "--accent-soft": "#1d4ed8",
      "--green": "#16a34a",
      "--red": "#dc2626",
      "--orange": "#ea580c",
      "--card-bg": "linear-gradient(180deg, #ffffff, #f8fafc)",
      "--card-glow": "rgba(37,99,235,0.12)",
      "--input-bg": "#f8fafc",
      "--header-fg": "#0f172a",
      "--table-bg": "#ffffff",
      "--table-th": "#e2e8f0"
    }
  }
};

let APPEARANCE = { ...DEFAULT_APPEARANCE };
let appearanceSaveTimer = null;
let appearancePublishTimer = null;
let appearanceApplyingRemote = false;

function clipAppearanceText(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isHexColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || ""));
}

function isSafeLogoData(value) {
  return typeof value === "string" &&
    value.length > 32 &&
    value.length < 180000 &&
    /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(value);
}

function normalizeAppearance(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const themeId = THEME_PRESETS[src.themeId] ? src.themeId : DEFAULT_APPEARANCE.themeId;
  const logoEmoji = clipAppearanceText(src.logoEmoji, 8) || DEFAULT_APPEARANCE.logoEmoji;
  return {
    themeId,
    title: clipAppearanceText(src.title, 80) || DEFAULT_APPEARANCE.title,
    subtitle: clipAppearanceText(src.subtitle, 120) || DEFAULT_APPEARANCE.subtitle,
    menuLine1: clipAppearanceText(src.menuLine1, 28) || DEFAULT_APPEARANCE.menuLine1,
    menuLine2: clipAppearanceText(src.menuLine2, 32) || DEFAULT_APPEARANCE.menuLine2,
    footer: clipAppearanceText(src.footer, 60) || DEFAULT_APPEARANCE.footer,
    logoEmoji,
    logoData: isSafeLogoData(src.logoData) ? src.logoData : "",
    accent: isHexColor(src.accent) ? src.accent.toLowerCase() : ""
  };
}

function loadAppearanceFromStorage() {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) {
      APPEARANCE = { ...DEFAULT_APPEARANCE };
      return;
    }
    APPEARANCE = normalizeAppearance(JSON.parse(raw));
  } catch (_) {
    APPEARANCE = { ...DEFAULT_APPEARANCE };
  }
}

function saveAppearanceToStorage() {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(APPEARANCE));
  } catch (_) {}
}

function scheduleAppearancePersist() {
  if (appearanceApplyingRemote) return;
  clearTimeout(appearanceSaveTimer);
  appearanceSaveTimer = setTimeout(() => {
    saveAppearanceToStorage();
  }, 250);
  clearTimeout(appearancePublishTimer);
  appearancePublishTimer = setTimeout(() => {
    publishAppearanceToFirebase();
  }, 700);
}

function publishAppearanceToFirebase() {
  if (!firebaseAppearanceRef || appearanceApplyingRemote) return;
  if (isMonitor && !isMasterRole()) return;
  const payload = {
    themeId: APPEARANCE.themeId,
    title: APPEARANCE.title,
    subtitle: APPEARANCE.subtitle,
    menuLine1: APPEARANCE.menuLine1,
    menuLine2: APPEARANCE.menuLine2,
    footer: APPEARANCE.footer,
    logoEmoji: APPEARANCE.logoEmoji,
    accent: APPEARANCE.accent,
    sender: syncClientId,
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  };
  if (APPEARANCE.logoData && APPEARANCE.logoData.length < 90000) {
    payload.logoData = APPEARANCE.logoData;
  }
  firebaseAppearanceRef.set(payload).catch(err => {
    console.log("Firebase appearance publish error:", err);
  });
}

function applyAppearanceFromRemote(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.sender && payload.sender === syncClientId) return;
  const next = normalizeAppearance(payload);
  if (!payload.logoData && APPEARANCE.logoData) next.logoData = APPEARANCE.logoData;
  appearanceApplyingRemote = true;
  APPEARANCE = next;
  saveAppearanceToStorage();
  applyAppearance();
  const page = document.getElementById("appearancePage");
  if (page && page.dataset.bound === "1") syncAppearanceForm(page);
  appearanceApplyingRemote = false;
}

function applyAppearance() {
  const cfg = normalizeAppearance(APPEARANCE);
  APPEARANCE = cfg;
  const theme = THEME_PRESETS[cfg.themeId] || THEME_PRESETS.midnight;
  const root = document.documentElement;
  root.setAttribute("data-theme", cfg.themeId);
  root.classList.toggle("theme-light", !!theme.light);
  Object.entries(theme.vars).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  if (cfg.accent) {
    root.style.setProperty("--blue", cfg.accent);
    root.style.setProperty("--accent", cfg.accent);
    root.style.setProperty("--accent-soft", cfg.accent);
    root.style.setProperty("--card-glow", cfg.accent + "29");
  }
  document.title = cfg.title;
  const titleEl = document.getElementById("headerTitle");
  const subEl = document.getElementById("headerSubtitle");
  const line1 = document.getElementById("menuBrandLine1");
  const line2 = document.getElementById("menuBrandLine2");
  const footer = document.getElementById("menuFooterBrand");
  if (titleEl) titleEl.textContent = cfg.title;
  if (subEl) subEl.textContent = cfg.subtitle;
  if (line1) line1.textContent = cfg.menuLine1;
  if (line2) line2.textContent = cfg.menuLine2;
  if (footer) footer.textContent = cfg.footer;
  const icon = document.getElementById("menuBrandIcon");
  if (icon) {
    if (cfg.logoData) {
      icon.classList.add("has-logo");
      icon.innerHTML = "";
      const img = document.createElement("img");
      img.alt = "";
      img.src = cfg.logoData;
      icon.appendChild(img);
    } else {
      icon.classList.remove("has-logo");
      icon.textContent = cfg.logoEmoji;
    }
  }
  const headerLogo = document.getElementById("headerBrandLogo");
  if (headerLogo) {
    if (cfg.logoData) {
      headerLogo.src = cfg.logoData;
      headerLogo.hidden = false;
    } else {
      headerLogo.removeAttribute("src");
      headerLogo.hidden = true;
    }
  }
}

function closeAppearancePage() {
  document.body.classList.remove("appearance-mode");
  const page = document.getElementById("appearancePage");
  if (page) page.classList.remove("open");
}

function showAppearancePageFromMenu() {
  toggleMenuDropdown(false);
  showAppearancePage();
}

function appearancePageMarkup() {
  const themeButtons = Object.entries(THEME_PRESETS).map(([id, theme]) => {
    const swatches = theme.swatch.map(c => `<span style="background:${c}"></span>`).join("");
    return `
      <button type="button" class="theme-preset-btn" data-theme-id="${id}">
        <span class="theme-swatch">${swatches}</span>
        <span class="theme-preset-name">${theme.label}</span>
      </button>`;
  }).join("");
  const emojis = APPEARANCE_EMOJIS.map(e =>
    `<button type="button" class="appearance-emoji-btn" data-emoji="${e}" title="Use ${e}">${e}</button>`
  ).join("");
  return `
    <div class="summary-head">Theme & Brand</div>
    <p class="appearance-lead">Edit the plant name, logo, and color theme. Changes apply immediately and save on this PC.</p>
    <div class="appearance-grid">
      <section class="appearance-card">
        <h3>Brand</h3>
        <div class="appearance-fields">
          <label class="span-2">Site title
            <input type="text" id="appearanceTitle" maxlength="80" autocomplete="off">
          </label>
          <label class="span-2">Subtitle
            <input type="text" id="appearanceSubtitle" maxlength="120" autocomplete="off">
          </label>
          <label>Menu line 1
            <input type="text" id="appearanceMenu1" maxlength="28" autocomplete="off">
          </label>
          <label>Menu line 2
            <input type="text" id="appearanceMenu2" maxlength="32" autocomplete="off">
          </label>
          <label class="span-2">Footer
            <input type="text" id="appearanceFooter" maxlength="60" autocomplete="off">
          </label>
        </div>
        <div class="appearance-logo-row">
          <span>Logo icon</span>
          <div class="appearance-emoji-row" id="appearanceEmojiRow">${emojis}</div>
          <div class="appearance-logo-actions">
            <label class="appearance-file-btn">Upload logo
              <input type="file" id="appearanceLogoFile" accept="image/*" hidden>
            </label>
            <button type="button" class="appearance-clear-logo" id="appearanceClearLogo">Clear logo image</button>
          </div>
          <p class="appearance-note" id="appearanceLogoNote">Upload a square PNG or JPG. It is resized automatically.</p>
          <p class="appearance-error" id="appearanceLogoError" hidden></p>
        </div>
      </section>
      <section class="appearance-card">
        <h3>Theme</h3>
        <div class="theme-preset-grid" id="appearanceThemeGrid">${themeButtons}</div>
        <div class="appearance-accent-row">
          <label>Custom accent
            <input type="color" id="appearanceAccentColor" value="#38bdf8">
          </label>
          <label>Hex
            <input type="text" class="appearance-accent-hex" id="appearanceAccentHex" maxlength="7" placeholder="#38bdf8" autocomplete="off">
          </label>
          <button type="button" class="appearance-clear-logo" id="appearanceAccentReset">Use theme default</button>
        </div>
        <p class="appearance-note">Choose a preset, or override the accent color for buttons and highlights.</p>
      </section>
    </div>
    <button type="button" class="appearance-reset" id="appearanceResetBtn">Reset to TF 2 defaults</button>
  `;
}

function syncAppearanceForm(page) {
  if (!page) return;
  const setVal = (id, value) => {
    const el = page.querySelector("#" + id);
    if (el && document.activeElement !== el) el.value = value;
  };
  setVal("appearanceTitle", APPEARANCE.title);
  setVal("appearanceSubtitle", APPEARANCE.subtitle);
  setVal("appearanceMenu1", APPEARANCE.menuLine1);
  setVal("appearanceMenu2", APPEARANCE.menuLine2);
  setVal("appearanceFooter", APPEARANCE.footer);
  const accent = APPEARANCE.accent || (THEME_PRESETS[APPEARANCE.themeId] || THEME_PRESETS.midnight).vars["--accent"];
  setVal("appearanceAccentHex", accent);
  const color = page.querySelector("#appearanceAccentColor");
  if (color && document.activeElement !== color) color.value = accent;
  page.querySelectorAll(".theme-preset-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.getAttribute("data-theme-id") === APPEARANCE.themeId);
  });
  page.querySelectorAll(".appearance-emoji-btn").forEach(btn => {
    btn.classList.toggle("selected", !APPEARANCE.logoData && btn.getAttribute("data-emoji") === APPEARANCE.logoEmoji);
  });
}

function readAppearanceForm(page) {
  if (!page) return;
  APPEARANCE = normalizeAppearance({
    ...APPEARANCE,
    title: page.querySelector("#appearanceTitle")?.value,
    subtitle: page.querySelector("#appearanceSubtitle")?.value,
    menuLine1: page.querySelector("#appearanceMenu1")?.value,
    menuLine2: page.querySelector("#appearanceMenu2")?.value,
    footer: page.querySelector("#appearanceFooter")?.value
  });
}

function commitAppearanceFromForm(page) {
  readAppearanceForm(page);
  applyAppearance();
  scheduleAppearancePersist();
  syncAppearanceForm(page);
}

function resizeLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      reject(new Error("Please choose an image file."));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error("Image must be under 2 MB."));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 128;
      const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round((img.width || 1) * scale));
      const h = Math.max(1, Math.round((img.height || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    img.src = url;
  });
}

function bindAppearancePage(page) {
  const onField = () => commitAppearanceFromForm(page);
  ["appearanceTitle", "appearanceSubtitle", "appearanceMenu1", "appearanceMenu2", "appearanceFooter"].forEach(id => {
    page.querySelector("#" + id)?.addEventListener("input", onField);
  });
  page.querySelectorAll(".theme-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      APPEARANCE.themeId = btn.getAttribute("data-theme-id") || "midnight";
      applyAppearance();
      scheduleAppearancePersist();
      syncAppearanceForm(page);
    });
  });
  page.querySelectorAll(".appearance-emoji-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      APPEARANCE.logoEmoji = btn.getAttribute("data-emoji") || "🏭";
      APPEARANCE.logoData = "";
      applyAppearance();
      scheduleAppearancePersist();
      syncAppearanceForm(page);
    });
  });
  const fileInput = page.querySelector("#appearanceLogoFile");
  const errEl = page.querySelector("#appearanceLogoError");
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
    try {
      APPEARANCE.logoData = await resizeLogoFile(file);
      applyAppearance();
      scheduleAppearancePersist();
      syncAppearanceForm(page);
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message || "Could not use that image.";
        errEl.hidden = false;
      }
    }
  });
  page.querySelector("#appearanceClearLogo")?.addEventListener("click", () => {
    APPEARANCE.logoData = "";
    applyAppearance();
    scheduleAppearancePersist();
    syncAppearanceForm(page);
  });
  const applyAccent = (hex) => {
    APPEARANCE.accent = isHexColor(hex) ? hex.toLowerCase() : APPEARANCE.accent;
    applyAppearance();
    scheduleAppearancePersist();
    syncAppearanceForm(page);
  };
  page.querySelector("#appearanceAccentColor")?.addEventListener("input", ev => {
    applyAccent(ev.target.value);
  });
  page.querySelector("#appearanceAccentHex")?.addEventListener("input", ev => {
    const hex = String(ev.target.value || "").trim();
    if (isHexColor(hex)) applyAccent(hex);
  });
  page.querySelector("#appearanceAccentReset")?.addEventListener("click", () => {
    APPEARANCE.accent = "";
    applyAppearance();
    scheduleAppearancePersist();
    syncAppearanceForm(page);
  });
  page.querySelector("#appearanceResetBtn")?.addEventListener("click", () => {
    APPEARANCE = { ...DEFAULT_APPEARANCE };
    applyAppearance();
    scheduleAppearancePersist();
    syncAppearanceForm(page);
  });
}

function showAppearancePage() {
  if (!isAdminRole()) {
    showMainPage();
    return;
  }
  let page = document.getElementById("appearancePage");
  if (!page) {
    page = document.createElement("div");
    page.id = "appearancePage";
    page.className = "graph-page appearance-page";
    document.body.appendChild(page);
  }
  if (page.dataset.bound !== "1") {
    page.innerHTML = appearancePageMarkup();
    bindAppearancePage(page);
    page.dataset.bound = "1";
  }
  syncAppearanceForm(page);

  document.body.classList.remove("summary-mode");
  document.body.classList.remove("graph-mode");
  document.body.classList.remove("history-mode");
  const summaryPage = document.getElementById("summaryPage");
  if (summaryPage) summaryPage.classList.remove("open");
  const graphPage = document.getElementById("graphPage");
  if (graphPage) graphPage.classList.remove("open");
  const historyPanel = document.getElementById("historyPanel");
  if (historyPanel) historyPanel.classList.remove("open");
  document.body.classList.add("appearance-mode");
  page.classList.add("open");
  triggerEnterAnimation(page);
  updateViewToggleMenuItem();
}

function ensureAppearanceMenuItem() {
  const menu = document.getElementById("menuDropdown");
  const btn = document.getElementById("appearanceMenuItem");
  const footer = menu?.querySelector(".menu-dropdown-footer");
  if (!menu || !btn || !footer) return;
  if (btn.nextElementSibling !== footer) {
    menu.insertBefore(btn, footer);
  }
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

function syncedNowMs() {
  return Date.now() + serverTimeOffsetMs;
}

/** RUNNING countdown from last scan (or session start), excluding scheduled breaks — shared by main + monitors. */
function computeRunningCountdownSec(cycleTimeSec, nowMs = syncedNowMs(), snapshotCountdown, snapshotUpdatedAtMs, anchorScanMs) {
  const baseMs =
    anchorScanMs != null && Number.isFinite(Number(anchorScanMs))
      ? Number(anchorScanMs)
      : lastScanWallMs != null
        ? lastScanWallMs
        : startTime
          ? startTime.getTime()
          : null;
  if (baseMs != null) {
    const wallSec = Math.floor((nowMs - baseMs) / 1000);
    const breakSec = scheduledBreakOverlapSec(baseMs, nowMs);
    const productiveSec = Math.max(0, wallSec - breakSec);
    return Math.max(cycleTimeSec - productiveSec, 0);
  }
  if (snapshotCountdown != null && snapshotUpdatedAtMs != null) {
    const syncedAt = Number(snapshotUpdatedAtMs) || nowMs;
    const wallSec = Math.floor((nowMs - syncedAt) / 1000);
    const breakSec = scheduledBreakOverlapSec(syncedAt, nowMs);
    const productiveSec = Math.max(0, wallSec - breakSec);
    return Math.max((parseInt(snapshotCountdown, 10) || 0) - productiveSec, 0);
  }
  return Math.max(parseInt(snapshotCountdown, 10) || 0, 0);
}

/** Monitor RUNNING: tick down from the main PC's last published countdown + updatedAt. */
function computeMonitorCountdownFromMainPublish(publishedCountdown, publishedUpdatedAtMs, nowMs = syncedNowMs()) {
  const syncedAt = Number(publishedUpdatedAtMs) || nowMs;
  const wallSec = Math.floor((nowMs - syncedAt) / 1000);
  const breakSec = scheduledBreakOverlapSec(syncedAt, nowMs);
  const productiveSec = Math.max(0, wallSec - breakSec);
  return Math.max((parseInt(publishedCountdown, 10) || 0) - productiveSec, 0);
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
  if (isNonProductionMode()) return 0;

  const plan = getDashboardPlan();
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
  const statusText = document.getElementById("status")?.innerText?.trim().toUpperCase();
  if (isNonProductionMode() || statusText === "NON PRODUCTION") return null;
  if (isReportNonProductionDay(dayKey)) return null;
  const planUnits = getDashboardPlan();
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
  firebaseAppearanceRef = firebaseDb.ref(FIREBASE_APPEARANCE_PATH);

  firebaseDb.ref(".info/serverTimeOffset").on("value", snap => {
    const offset = snap.val();
    serverTimeOffsetMs = typeof offset === "number" && Number.isFinite(offset) ? offset : 0;
    if (isMonitor && typeof monitorCountdownRender === "function") {
      monitorCountdownRender();
    }
  });

  firebaseShiftScheduleRef.on("value", snapshot => {
    const v = snapshot.val();
    if (v) applyShiftScheduleFromRemote(v);
  });

  firebaseAppearanceRef.on("value", snapshot => {
    const v = snapshot.val();
    if (v) applyAppearanceFromRemote(v);
  });

  if (!isMonitor) {
    firebaseShiftScheduleRef.once("value").then(snap => {
      if (!snap.val()) publishShiftScheduleToFirebase();
    }).catch(() => {});
    firebaseAppearanceRef.once("value").then(snap => {
      if (!snap.val()) publishAppearanceToFirebase();
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
  } else {
    firebaseLiveStateRef.on("value", snapshot => {
      const liveState = snapshot.val();
      if (!liveState || liveState.sender === syncClientId) return;
      applyRemoteMasterSettings(liveState);
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
  monitorCountdownRender = null;
}

function startLiveCountdownTicker(baseCountdown, status, updatedAt, anchorScanMs) {
  stopLiveCountdownTicker();

  const countdownEl = document.getElementById("countdown");
  if (!countdownEl) return;

  // Main operator screen uses its own production timer logic.
  if (!isMonitor) {
    countdownValue = baseCountdown;
    countdownEl.innerText = format(baseCountdown);
    syncOperatorDashboardChrome();
    return;
  }

  if (status === "NON PRODUCTION") {
    countdownValue = 0;
    countdownEl.innerText = format(0);
    syncOperatorDashboardChrome();
    return;
  }

  if (status !== "RUNNING") {
    countdownValue = baseCountdown;
    countdownEl.innerText = format(baseCountdown);
    syncOperatorDashboardChrome();
    return;
  }

  const snapshotUpdatedAt = Number(updatedAt) || syncedNowMs();

  const render = () => {
    // Main PC is source of truth — mirror its published countdown snapshot only.
    const adjusted = computeMonitorCountdownFromMainPublish(
      baseCountdown,
      snapshotUpdatedAt
    );
    countdownValue = adjusted;
    countdownEl.innerText = format(adjusted);
    syncOperatorDashboardChrome();
  };

  monitorCountdownRender = render;
  render();
  liveCountdownInterval = setInterval(render, 1000);
}

function restoreProductionTimerFromLiveState(status, countdown, expected, syncedFirstScanAtMs, syncedUpdatedAt, syncedLastScanAtMs) {
  if (isMonitor) return;
  if (status !== "RUNNING" && status !== "DOWN TIME") return;
  if (timer) return;

  const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  const nowMs = syncedNowMs();
  let adjustedCountdown = parseInt(countdown, 10) || 0;
  let elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);

  if (syncedLastScanAtMs) {
    adjustedCountdown = computeRunningCountdownSec(
      cycleTimeSec,
      nowMs,
      null,
      null,
      Number(syncedLastScanAtMs)
    );
    elapsedInCycle = Math.max(cycleTimeSec - adjustedCountdown, 0);
  } else {
    const syncedAtMs = Number(syncedUpdatedAt) || nowMs;
    const syncedCountdown = parseInt(countdown, 10) || 0;
    adjustedCountdown = computeRunningCountdownSec(cycleTimeSec, nowMs, syncedCountdown, syncedAtMs);
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

  if (typeof state.ramadanMode === "boolean") {
    ramadanMode = state.ramadanMode;
  }

  if (isMonitor) {
    applyGraphSettingsFromRemote(state);
  }

  const plan = parseInt(state.plan, 10) || 0;
  const currentDailyPlan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || SETTINGS.defaultPlan;
  const currentCycleTime = parseFloat(document.getElementById("cycleTarget").value) || SETTINGS.defaultCycle;
  let status = state.status || "READY";
  const np = isNonProductionLiveState(state, status);
  let effectivePlan;
  let cycleTimeMin;

  if (isMonitor) {
    // Monitor: boxes mirror Firebase only (no local defaults masking stale reads).
    const { daily, cycle } = readPlanAndCycleFromFirebase(state);
    effectivePlan = daily != null && daily > 0 ? daily : 0;
    cycleTimeMin = cycle != null && cycle > 0 ? cycle : SETTINGS.defaultCycle;
  } else {
    effectivePlan = resolvePositiveNumber(state.dailyPlan, plan, currentDailyPlan);
    cycleTimeMin = resolvePositiveNumber(state.cycleTimeMin, state.cycleTarget, currentCycleTime);
  }
  const displayPlan = np ? 0 : effectivePlan;
  let actual = parseInt(state.actual, 10) || 0;
  let balance = parseInt(state.balance, 10) || 0;
  let countdown = parseInt(state.countdown, 10) || 0;
  let expected = parseInt(state.expected, 10) || 0;
  let delay = parseInt(state.delay, 10) || 0;
  if (np) {
    expected = 0;
    delay = 0;
    countdown = 0;
  }
  const lotNo = state.lotNo || "";
  const firebaseTotalDowntime = parseInt(state.totalDowntime, 10);
  const hasFirebaseTotalDowntime = Number.isFinite(firebaseTotalDowntime) && firebaseTotalDowntime >= 0;

  // Keep local variables aligned so refresh doesn't revert values.
  actualCount = actual;
  if (isMonitor) {
    const today = toIsoDateLocal(new Date());
    if (reconcileActualCountFromSheet(today)) {
      actual = actualCount;
    }
  }
  if (np) {
    balance = actual - displayPlan;
  } else if (isMonitor) {
    balance = actual - effectivePlan;
  }
  if (isMonitor && hasFirebaseTotalDowntime) {
    downtimeSeconds = firebaseTotalDowntime;
  } else {
    syncDowntimeSecondsFromTable();
  }
  firstScanAtMs = state.firstScanAtMs ? Number(state.firstScanAtMs) : firstScanAtMs;

  if (isMonitor) {
    const planInput = document.getElementById("dailyPlanTarget");
    const cycleInput = document.getElementById("cycleTarget");
    if (planInput && document.activeElement !== planInput) {
      planInput.value = np ? "0" : (effectivePlan > 0 ? String(effectivePlan) : "");
    }
    if (cycleInput && document.activeElement !== cycleInput) {
      cycleInput.value = cycleTimeMin > 0 ? String(cycleTimeMin) : "";
    }
    document.getElementById("plan").innerText = np ? "0" : (effectivePlan > 0 ? String(effectivePlan) : "-");
    if (effectivePlan > 0) syncTodayScanPlanOnRows(effectivePlan);
  } else {
    document.getElementById("plan").innerText = displayPlan;
    document.getElementById("dailyPlanTarget").value = String(effectivePlan);
    document.getElementById("cycleTarget").value = String(cycleTimeMin);
  }
  const lotInput = document.getElementById("lotInput");
  if (lotInput && document.activeElement !== lotInput) {
    lotInput.value = lotNo;
  }
  document.getElementById("actual").innerText = actual;
  document.getElementById("expected").innerText = expected;

  if (isMonitor && !np && effectivePlan > 0 && actual < effectivePlan && status === "TARGET ACHIEVED") {
    status = actual > 0 ? "PAUSED" : "READY";
  }

  // Set last-scan anchor before countdown ticker (every monitor must use Firebase lastScanAtMs).
  let anchorScanMs = null;
  if (actual > 0 && state.lastScanAtMs) {
    anchorScanMs = Number(state.lastScanAtMs);
    lastScanTime = new Date(anchorScanMs);
    lastScanWallMs = anchorScanMs;
  } else if (actual === 0) {
    lastScanTime = null;
    lastScanWallMs = null;
  }

  startLiveCountdownTicker(countdown, status, state.updatedAt, anchorScanMs);
  const downtimeSecToDisplay =
    isMonitor && hasFirebaseTotalDowntime
      ? firebaseTotalDowntime
      : getBookedDowntimeSec();
  downtimeSeconds = downtimeSecToDisplay;
  document.getElementById("downtime").innerText = format(downtimeSecToDisplay);
  syncDowntimeAccumulatedHighlight();
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
  } else if (status === "NON PRODUCTION" || np) {
    setStatus("NON PRODUCTION", "status-blue");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  } else {
    setStatus(status, "status-blue");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
  }

  syncEfficiencyCardDom();
  syncOperatorDashboardChrome();

  if (isMonitor) {
    monitorLiveStateReceived = true;
    monitorLiveStateError = null;
    applyGraphSettingsFromRemote(state);
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

function applyRemoteMasterSettings(state) {
  if (!state || isMonitor) return;
  if (state.sender && state.sender === syncClientId) return;
  const cycleEl = document.getElementById("cycleTarget");
  const planEl = document.getElementById("dailyPlanTarget");
  const lotEl = document.getElementById("lotInput");
  const { daily, cycle } = readPlanAndCycleFromFirebase(state);
  if (cycleEl && document.activeElement !== cycleEl && cycle != null && cycle > 0) {
    cycleEl.value = String(cycle);
  }
  if (planEl && document.activeElement !== planEl && daily != null && daily >= 0) {
    planEl.value = String(daily);
    if (daily > 0) syncTodayScanPlanOnRows(daily);
  }
  if (lotEl && document.activeElement !== lotEl && typeof state.lotNo === "string") {
    lotEl.value = state.lotNo;
  }
  if (typeof state.ramadanMode === "boolean" && state.ramadanMode !== ramadanMode) {
    ramadanMode = state.ramadanMode;
    const btn = document.getElementById("ramadanToggle");
    if (btn) {
      btn.innerText = ramadanMode ? "🌙 Ramadhan : ON" : "🌙 Ramadhan : OFF";
      btn.style.background = "";
    }
  }
  if (state.graphWtPreset) {
    const next = normalizeGraphWtPreset(state.graphWtPreset);
    if (graphWtPreset !== next) {
      const prev = graphWtPreset;
      graphWtPreset = next;
      saveGraphWtPresetToStorage();
      syncNonProductionDayMarkForToday();
      applyGraphWtControlUi();
      applyGraphWtPresetEffects(prev);
    }
  }
  if (Array.isArray(state.nonProductionDays)) {
    const valid = state.nonProductionDays.filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
    const current = [...loadNonProductionDaysSet()].sort().join(",");
    const incoming = [...valid].sort().join(",");
    if (current !== incoming) {
      saveNonProductionDaysSet(new Set(valid));
      if (document.body.classList.contains("graph-mode")) renderGraphCharts();
    }
  }
  updateDisplay();
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
  if (isMonitor) {
    if (!isMasterRole() || isApplyingRemoteCommand) return;
    if (isNonProductionMode()) return;
    if (shouldSync) publishSyncCommand("start");
    return;
  }
  if (!canOperateLine()) return;
  if (isNonProductionMode()) {
    setStatus("NON PRODUCTION", "status-blue");
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
    countdownValue = computeRunningCountdownSec(cycleTimeSec);

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
  if (isMonitor) {
    if (!isMasterRole() || isApplyingRemoteCommand) return;
    if (shouldSync) publishSyncCommand("stop");
    return;
  }
  if (!canOperateLine()) return;

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
  if (isMonitor) {
    if (!isMasterRole() || isApplyingRemoteCommand) return;
    if (isNonProductionMode()) return;
    if (shouldSync) publishSyncCommand("reset");
    return;
  }
  if (!canOperateLine()) return;
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
    if (!canOperateLine() || isNonProductionMode()) {
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
    if (!canOperateLine() || isNonProductionMode()) {
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
    if (!canOperateLine() || isNonProductionMode()) {
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
    if (!canOperateLine() || isNonProductionMode()) {
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

const OP_COUNTDOWN_RING_C = 2 * Math.PI * 82;

function syncOperatorDashboardChrome() {
  const cycleMin = parseFloat(document.getElementById("cycleTarget")?.value) || SETTINGS.defaultCycle;
  const cycleEl = document.getElementById("opCycleTimeDisplay");
  if (cycleEl) {
    const shown = Number.isFinite(cycleMin) ? String(Math.round(cycleMin * 10) / 10).replace(/\.0$/, "") : "—";
    cycleEl.textContent = shown;
  }
  const circle = document.getElementById("countdownRingProgress");
  if (circle) {
    const cycleSec = Math.max((Number(cycleMin) || 1) * 60, 1);
    const remain = Math.max(0, Math.min(Number(countdownValue) || 0, cycleSec));
    const ratio = remain / cycleSec;
    circle.style.strokeDasharray = String(OP_COUNTDOWN_RING_C);
    circle.style.strokeDashoffset = String(OP_COUNTDOWN_RING_C * (1 - ratio));
  }
  const balCard = document.querySelector(".card-balance");
  const balEl = document.getElementById("balance");
  if (balCard && balEl) {
    const n = parseInt(String(balEl.innerText).replace(/[^\-0-9]/g, ""), 10);
    const val = Number.isFinite(n) ? n : 0;
    balCard.classList.toggle("is-behind", val < 0);
    balCard.classList.toggle("is-ahead", val > 0);
    balCard.classList.toggle("is-even", val === 0);
  }
}

function updateDisplay() {
  if (isMonitor) return;
  // Keep accumulated card aligned with sum of visible table downtime rows.
  syncDowntimeSecondsFromTable();
  const plan = getDashboardPlan();
  const balance = actualCount - plan;
  const displayBalance = balance > 0 ? ("+" + balance) : balance;

  if (isNonProductionMode()) {
    const delayEl = document.getElementById("delay");
    document.getElementById("expected").innerText = "0";
    document.getElementById("actual").innerText = actualCount;
    document.getElementById("plan").innerText = plan;
    countdownValue = 0;
    document.getElementById("countdown").innerText = format(0);
    refreshDowntimeCardFromTable();
    const balanceEl = document.getElementById("balance");
    if (balance < 0) balanceEl.className = "big-number status-red";
    else if (balance > 0) balanceEl.className = "big-number status-green";
    else balanceEl.className = "big-number status-blue";
    balanceEl.innerText = displayBalance;
    delayEl.className = "big-number status-blue";
    delayEl.innerText = "0";
    setStatus("NON PRODUCTION", "status-blue");
    syncEfficiencyCardDom();
    const downtimeCard = document.getElementById("downtimeCard");
    const downtimeText = document.getElementById("downtime");
    downtimeCard.classList.remove("downtime-alert", "blink");
    downtimeText.classList.remove("status-red", "blink");
    syncDowntimeAccumulatedHighlight();
    syncOperatorDashboardChrome();
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
    setStatus("NON PRODUCTION", "status-blue");
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
  syncOperatorDashboardChrome();
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
    if (!canViewReports()) return;
    document.body.classList.remove("summary-mode");
    const summaryPage = document.getElementById("summaryPage");
    if (summaryPage) summaryPage.classList.remove("open");
    document.body.classList.remove("graph-mode");
    const graphPage = document.getElementById("graphPage");
    if (graphPage) graphPage.classList.remove("open");
    closeAppearancePage();
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
  if (!canViewReports()) {
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
  const appearance = document.getElementById("appearanceMenuItem");
  [main, summary, graph, history, appearance].forEach(el => {
    if (el) el.classList.remove("active");
  });

  if (document.body.classList.contains("summary-mode")) {
    if (summary) summary.classList.add("active");
  } else if (document.body.classList.contains("graph-mode")) {
    if (graph) graph.classList.add("active");
  } else if (document.body.classList.contains("history-mode")) {
    if (history) history.classList.add("active");
  } else if (document.body.classList.contains("appearance-mode")) {
    if (appearance) appearance.classList.add("active");
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
  closeAppearancePage();
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

/** Even x-axis ticks from first to last day so month charts don't bunch or leave a gap at the end. */
function getChartXLabelIndexSet(count) {
  const shown = new Set();
  if (count <= 0) return shown;
  if (count <= 12) {
    for (let i = 0; i < count; i++) shown.add(i);
    return shown;
  }
  const target = count > 24 ? 8 : 7;
  const last = count - 1;
  const steps = Math.max(target - 1, 1);
  for (let k = 0; k <= steps; k++) {
    shown.add(Math.round((k * last) / steps));
  }
  return shown;
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
  const xLabelSet = getChartXLabelIndexSet(labels.length);

  const bars = labels.map((label, i) => {
    const v = values[i];
    const x = leftPad + (i * stepX) + ((stepX - barW) / 2);
    const h = Math.max((v / maxVal) * chartH, v > 0 ? 2 : 0);
    const y = topPad + (chartH - h);
    const showLabel = xLabelSet.has(i);
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
  const xLabelSet = getChartXLabelIndexSet(labels.length);
  const xLabels = labels.map((label, i) => {
    if (!xLabelSet.has(i)) return "";
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

function buildEfficiencyTrendChart(title, labels, actualValues, planValues, valueSuffix = "%", yAxisLabel = "%", dayKeys = null, reportActualByDay = null) {
  if (!labels.length || !actualValues.length) {
    return `<div class="summary-graph-empty">No data</div>`;
  }
  const skipNpIdx = i => dayKeys && isReportNonProductionDay(dayKeys[i], reportActualByDay);
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
  const skipNpKey = k => dayKeys ? isReportNonProductionDay(k, reportActualByDay) : false;
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

  const xLabelSet = getChartXLabelIndexSet(labels.length);
  const xLabels = labels.map((label, i) => {
    if (!xLabelSet.has(i)) return "";
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
function computeDayTargetsForReport(dayKeys, dailyActualMap, fallbackDayPlan, dayPlanMap) {
  const legacyImplicitWeekday =
    SETTINGS.productionTrend?.implicitDailyPlanOnInactiveWeekdays === true;
  const zWeekend = SETTINGS.productionTrend?.zeroTargetOnInactiveWeekends !== false;
  const dayTarget = {};
  dayKeys.forEach(k => {
    const historical = dayPlanMap ? dayPlanMap[k] : undefined;
    const dayActual = dailyActualMap[k] || 0;
    const resolved = resolveReportPlanForDay(k, fallbackDayPlan, historical, dayActual, !!dayPlanMap);
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

function buildPlanVsActualChart(dayKey = getActiveGraphDayKey(), period = graphPeriod, precomputed) {
  const range = getActiveGraphRange();
  const rangeLabel = formatIsoRangeAsDdMmYy(range.start, range.end);
  const dayKeys = precomputed?.dayKeys || getDayKeysBetween(range.start, range.end);
  const periodLabel = getTrendChartPeriodLabel(range.start, range.end, period);

  const dailyActualMap = precomputed?.dayProduced || (() => {
    const daySet = new Set(dayKeys);
    const map = {};
    const rows = document.getElementById("scanTable")?.rows;
    if (!rows) return map;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cells = row.cells;
      if (!cells || !cells.length) continue;
      const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
      if (!rowDay || !daySet.has(rowDay)) continue;
      map[rowDay] = (map[rowDay] || 0) + 1;
    }
    return map;
  })();

  let fallbackDayPlan = parseInt(String(document.getElementById("plan")?.innerText || "").trim(), 10);
  if (!Number.isFinite(fallbackDayPlan) || fallbackDayPlan <= 0) {
    fallbackDayPlan = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  }
  const dayTarget = precomputed?.dayTarget || computeDayTargetsForReport(dayKeys, dailyActualMap, fallbackDayPlan);
  const skipNpDay = k => isReportNonProductionDay(k, dailyActualMap);
  const totalPlan = dayKeys.reduce((sum, key) => sum + (skipNpDay(key) ? 0 : (dayTarget[key] || 0)), 0);

  // Use per-day values (not cumulative) for both Actual and Target.
  const actualSeries = dayKeys.map(k => dailyActualMap[k] || 0);
  const targetSeries = dayKeys.map(k => dayTarget[k] || 0);

  const totalActual = actualSeries.reduce((sum, v, i) => sum + (skipNpDay(dayKeys[i]) ? 0 : v), 0);
  const diff = totalActual - totalPlan;
  const diffNote = totalPlan > 0
    ? (diff === 0 ? "On target" : diff > 0 ? `Ahead by ${diff}` : `Behind by ${Math.abs(diff)}`)
    : (totalActual > 0 ? `Produced ${totalActual}` : "No output this period");

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
  const xLabelSet = getChartXLabelIndexSet(dayKeys.length);
  const xLabels = dayKeys.map((k, i) => {
    if (!xLabelSet.has(i)) return "";
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
function resolveReportPlanForDay(dayKey, fallbackDayPlan, historicalPlan, dayActualCount, fromScanCache) {
  const today = toIsoDateLocal(new Date());
  if (dayKey === today && Number.isFinite(fallbackDayPlan) && fallbackDayPlan > 0) {
    return fallbackDayPlan;
  }
  const historical = fromScanCache
    ? (Number.isFinite(historicalPlan) ? historicalPlan : null)
    : (Number.isFinite(historicalPlan) ? historicalPlan : getHistoricalPlanForDay(dayKey));
  if (Number.isFinite(historical) && historical > 0) return historical;
  const count = fromScanCache
    ? (Number.isFinite(dayActualCount) ? dayActualCount : 0)
    : (Number.isFinite(dayActualCount) ? dayActualCount : countScanRowsForDay(dayKey));
  if (count > 0 && Number.isFinite(fallbackDayPlan) && fallbackDayPlan > 0) {
    return fallbackDayPlan;
  }
  return historical;
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

function getTargetAchievedMsFromTimes(times, targetUnits) {
  if (!Number.isFinite(targetUnits) || targetUnits <= 0 || !times || times.length < targetUnits) return null;
  const sorted = times.length > 1 ? times.slice().sort((a, b) => a - b) : times;
  return sorted[targetUnits - 1] || null;
}

function getTargetAchievedMsForDay(dayKey, targetUnits) {
  if (!Number.isFinite(targetUnits) || targetUnits <= 0) return null;
  const times = [];
  const rows = document.getElementById("scanTable")?.rows;
  if (!rows) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.cells;
    if (!cells || !cells.length) continue;
    const rowDay = row.dataset.scanDate || parseDisplayDateToIsoKey(cells[1]?.innerText);
    if (rowDay !== dayKey) continue;
    const scanMsRaw = parseInt(String(row.dataset.scanMs || "").trim(), 10);
    if (Number.isFinite(scanMsRaw) && scanMsRaw > 0) {
      times.push(scanMsRaw);
      continue;
    }
    const parsedMs = parseDayTimeTextToMs(rowDay, cells[2]?.innerText || "");
    if (Number.isFinite(parsedMs)) times.push(parsedMs);
  }
  return getTargetAchievedMsFromTimes(times, targetUnits);
}

function calcActualWtMinsForDay(dayKey, targetUnits = 0, achievedMsOpt) {
  const shiftStartMin = Number(SETTINGS.shiftSchedule.startMinute);
  const shiftEndMin = Number(SETTINGS.shiftSchedule.endMinute);
  if (!Number.isFinite(shiftStartMin) || !Number.isFinite(shiftEndMin) || shiftEndMin <= shiftStartMin) return null;

  const [yy, mm, dd] = String(dayKey).split("-").map(v => parseInt(v, 10));
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;

  const dayStartMs = new Date(yy, mm - 1, dd, 0, 0, 0, 0).getTime();
  const shiftStartMs = dayStartMs + (shiftStartMin * 60 * 1000);
  const shiftEndMs = dayStartMs + (shiftEndMin * 60 * 1000);
  const todayKey = toIsoDateLocal(new Date());
  const achievedMs = achievedMsOpt !== undefined
    ? achievedMsOpt
    : getTargetAchievedMsForDay(dayKey, targetUnits);

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

function buildEffWtCardsHtmlForDay(dayKey, dayProduced, dayTarget, periodLabel, rangeLabel, achievedMs) {
  const planEffPct = PLAN_EFF_PCT;
  const planWtMins = getPlanWtMinsForDay(dayKey);
  const nonProdDay = dayKey && isReportNonProductionDay(dayKey, dayProduced);

  const planUnits = dayTarget?.[dayKey] || 0;
  const actualUnits = dayProduced?.[dayKey] || 0;
  const actualWtMins = nonProdDay ? 0 : calcActualWtMinsForDay(dayKey, planUnits, achievedMs);

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
  const periodLabel = getTrendChartPeriodLabel(range.start, range.end, graphPeriod);
  const periodKeys = getDayKeysBetween(range.start, range.end);
  if (graphFocusedDayKey && !periodKeys.includes(graphFocusedDayKey)) {
    graphFocusedDayKey = null;
  }
  const stats = collectScanTableStats(periodKeys);
  const dayProduced = stats.dayProduced;
  const dayDowntimeSec = stats.dayDowntimeSec;
  let labels;
  let downtimeMins;
  if (graphPeriod === "day" && periodKeys.length === 1) {
    ({ labels, downtimeMins } = collectHourlyGraphData(activeDay, graphPeriod));
  } else {
    labels = periodKeys.map(k => {
      const dt = new Date(`${k}T00:00:00`);
      if (graphPeriod === "week") {
        const dName = dt.toLocaleDateString(undefined, { weekday: "short" });
        return `${dName} ${k.slice(8, 10)}`;
      }
      return dt.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    });
    downtimeMins = periodKeys.map(k => {
      const sec = stats.dayDowntimeSecAny[k] || 0;
      if (sec <= 0) return 0;
      return Math.max(1, Math.round(sec / 60));
    });
  }
  let fallbackDayPlan = parseInt(String(document.getElementById("plan")?.innerText || "").trim(), 10);
  if (!Number.isFinite(fallbackDayPlan) || fallbackDayPlan <= 0) {
    fallbackDayPlan = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  }
  const dayTarget = computeDayTargetsForReport(periodKeys, dayProduced, fallbackDayPlan, stats.dayPlan);
  graphReportCache = {
    anchorDay: activeDay,
    periodKeys,
    dayProduced,
    dayTarget,
    periodLabel,
    rangeLabel
  };
  const totalProduced = periodKeys.reduce((s, k) => s + (dayProduced[k] || 0), 0);
  const totalTarget = periodKeys.reduce((s, k) => s + (dayTarget[k] || 0), 0);
  const totalDowntimeMin = Math.max(0, Math.round(periodKeys.reduce((s, k) => s + (dayDowntimeSec[k] || 0), 0) / 60));
  const avgRate = totalProduced > 0 ? (totalProduced / Math.max(periodKeys.length * 8, 1)) : 0;
  const planActualChart = buildPlanVsActualChart(activeDay, graphPeriod, {
    dayKeys: periodKeys,
    dayProduced,
    dayTarget
  });
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
  const scopeTarget = dayTarget[scopeDayKey] || 0;
  const scopeAchievedMs = getTargetAchievedMsFromTimes(stats.dayScanTimes[scopeDayKey] || [], scopeTarget);
  const wtCards = buildEffWtCardsHtmlForDay(scopeDayKey, dayProduced, dayTarget, periodLabel, rangeLabel, scopeAchievedMs);
  const oeeLabels = periodKeys.map(k => {
    const d = new Date(`${k}T00:00:00`);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  });
  const oeeValues = periodKeys.map(k => {
    if (isReportNonProductionDay(k, dayProduced)) return 0;
    const target = dayTarget[k] || 0;
    const produced = dayProduced[k] || 0;
    const planWtMins = getPlanWtMinsForDay(k);
    const times = stats.dayScanTimes[k] || [];
    const achievedMs = getTargetAchievedMsFromTimes(times, target);
    const actualWtMins = calcActualWtMinsForDay(k, target, achievedMs);
    return calcActualEffPct(target, produced, planWtMins, actualWtMins) ?? 0;
  });
  const planEffValues = periodKeys.map(k => {
    if (isReportNonProductionDay(k, dayProduced)) return 0;
    return (dayTarget[k] || 0) > 0 ? PLAN_EFF_PCT : 0;
  });
  const oeeChart = buildEfficiencyTrendChart(
    `EFFICIENCY TREND (${periodLabel}: ${rangeLabel})`,
    oeeLabels,
    oeeValues,
    planEffValues,
    "%",
    "%",
    periodKeys,
    dayProduced
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
  if (!canViewReports()) {
    showMainPage();
    return;
  }
  let graphPage = document.getElementById("graphPage");
  if (!graphPage) {
    graphPage = document.createElement("div");
    graphPage.id = "graphPage";
    graphPage.className = "graph-page";
    document.body.appendChild(graphPage);
    graphPageShellReady = false;
  }

  if (!graphPageShellReady || !document.getElementById("graphChartsBody")) {
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
      <div class="report-body" id="graphChartsBody"></div>
    `;
    const graphRangeTodayBtn = document.getElementById("graphRangeTodayBtn");
    const graphPeriodWeekBtn = document.getElementById("graphPeriodWeekBtn");
    const graphPeriodMonthBtn = document.getElementById("graphPeriodMonthBtn");
    if (graphRangeTodayBtn) graphRangeTodayBtn.addEventListener("click", onGraphRangeTodayClick);
    if (graphPeriodWeekBtn) graphPeriodWeekBtn.addEventListener("click", () => onGraphPeriodChange("week"));
    if (graphPeriodMonthBtn) graphPeriodMonthBtn.addEventListener("click", () => onGraphPeriodChange("month"));
    graphPageShellReady = true;
  }
  if (!graphRangeStartDate || !graphRangeEndDate) {
    applyGraphPeriodRange(toIsoDateLocal(new Date()), graphPeriod, false);
  }
  const graphRangeStartEl = document.getElementById("graphRangeStart");
  if (!graphRangeStartEl || !datePickerRegistry.get(graphRangeStartEl)) {
    initGraphRangeDatePickers();
  } else {
    syncGraphRangePickerUi();
  }
  syncGraphPeriodButtonsUi();
  try {
    renderGraphCharts();
  } catch (err) {
    console.error("showGraphPage render failed:", err);
  }

  document.body.classList.remove("summary-mode");
  document.body.classList.remove("history-mode");
  closeAppearancePage();
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
  if (!canViewReports()) {
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
  closeAppearancePage();
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
  if (!isMasterRole()) return;
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
  if (isMonitor) {
    publishMasterSettingsFromInputs();
    return;
  }
  // Persist Ramadhan mode so the backend clock matches the operator's break windows.
  if (hasLocalSession) updateLiveStateOnly();
}

function updateLiveStateOnly() {
  if (isMonitor) return;
  if (!hasLocalSession) return;

  const configuredPlan = getConfiguredDailyPlan();
  const plan = getDashboardPlan();
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

  // Publish the same countdown the operator screen is showing (main drives all monitors).
  if (timer && (status === "RUNNING" || status === "DOWN TIME")) {
    const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
    countdownValue = computeRunningCountdownSec(cycleTimeSec);
  }
  if (isNonProductionMode() || status === "NON PRODUCTION") {
    countdownValue = 0;
  }

  fetch(API_URL, {
    method: "POST",
    mode: "no-cors",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      liveOnly: true,
      plan: plan,
      dailyPlan: configuredPlan,
      cycleTimeMin: cycleTimeMin,
      actual: actual,
      balance: balance,
      status: status,
      ramadanMode: ramadanMode,
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
    dailyPlan: configuredPlan,
    cycleTimeMin: cycleTimeMin,
    actual: actual,
    balance: balance,
    lotNo: lotNo,
    status: status,
    ramadanMode: ramadanMode,
    countdown: countdownValue,
    bookedDowntime: bookedDowntime,
    totalDowntime: bookedDowntime,
    downtimeDay: getActiveDowntimeDayKey(),
    expected: expected,
    delay: delay,
    efficiency: efficiency,
    firstScanAtMs: firstScanAtMs,
    lastScanAtMs: lastScanWallMs != null ? lastScanWallMs : null,
    graphWtPreset: graphWtPreset,
    nonProductionDays: getNonProductionDaysArray()
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

function getCompletedUnitStatsFromScanTableForDay(dayKey) {
  const table = document.getElementById("scanTable");
  if (!table) return { count: 0, firstScanMs: null, lastScanMs: null };

  let count = 0;
  let firstScanMs = null;
  let lastScanMs = null;

  Array.from(table.rows).forEach(tr => {
    const rowDay = tr.dataset.scanDate || parseDisplayDateToIsoKey(tr.cells[1]?.innerText);
    if (!rowDay || rowDay !== dayKey) return;

    const statusCell = tr.cells[8];
    const statusText = statusCell ? String(statusCell.innerText || "").replace(/\s+/g, " ").trim().toUpperCase() : "";
    const isCompleted =
      statusText === "SCANNED" ||
      statusText === "DOWN TIME" ||
      statusText === "DOWNTIME";
    if (!isCompleted) return;

    const scanMs = Number(tr.dataset.scanMs);
    if (!Number.isFinite(scanMs)) return;

    count++;
    firstScanMs = firstScanMs == null ? scanMs : Math.min(firstScanMs, scanMs);
    lastScanMs = lastScanMs == null ? scanMs : Math.max(lastScanMs, scanMs);
  });

  return { count, firstScanMs, lastScanMs };
}

/**
 * Google Sheet row count is the source of truth for logged units.
 * Live actualCount can be higher when a scan succeeded locally but never reached the sheet.
 */
function reconcileActualCountFromSheet(dayKey) {
  const stats = getCompletedUnitStatsFromScanTableForDay(dayKey);
  if (stats.count <= 0) return false;
  if (stats.count === actualCount) return false;

  if (stats.count > actualCount) {
    // Sheet ahead of live counter — only apply when clearly newer (avoid mid-scan flicker).
    if (!Number.isFinite(stats.lastScanMs)) return false;
    const skewMs = 30000;
    if (lastScanWallMs != null && stats.lastScanMs <= lastScanWallMs + skewMs) return false;
    if (!isMonitor && timer) return false;
  }

  actualCount = stats.count;
  if (Number.isFinite(stats.firstScanMs)) firstScanAtMs = stats.firstScanMs;
  if (Number.isFinite(stats.lastScanMs)) {
    lastScanWallMs = stats.lastScanMs;
    lastScanTime = new Date(lastScanWallMs);
  }
  return true;
}

function applyReconciledActualToDashboard() {
  const planCard = parseInt(document.getElementById("plan")?.innerText || "0", 10) || 0;
  const planInput = parseInt(document.getElementById("dailyPlanTarget")?.value || "0", 10) || 0;
  const plan = planCard > 0 ? planCard : planInput;
  const balance = actualCount - plan;
  const displayBalance = balance > 0 ? ("+" + balance) : balance;

  document.getElementById("actual").innerText = actualCount;

  const balanceEl = document.getElementById("balance");
  if (balanceEl) {
    if (balance < 0) balanceEl.className = "big-number status-red";
    else if (balance > 0) balanceEl.className = "big-number status-green";
    else balanceEl.className = "big-number status-blue";
    balanceEl.innerText = displayBalance;
  }

  if (isMonitor) {
    const statusText = document.getElementById("status")?.innerText?.trim() || "";
    if (plan > 0 && actualCount >= plan) {
      setStatus("TARGET ACHIEVED", "status-green");
    } else if (statusText === "TARGET ACHIEVED" && actualCount < plan) {
      setStatus(actualCount > 0 ? "PAUSED" : "READY", actualCount > 0 ? "status-orange" : "status-blue");
    }
    syncEfficiencyCardDom();
    return;
  }

  hasLocalSession = true;
  updateDisplay();
  updateLiveStateOnly();
}

function maybeReconcileLocalActualFromSheet() {
  if (!isMonitor && !initialLiveStateHydrated) return;

  const dayKey = toIsoDateLocal(new Date());
  if (!reconcileActualCountFromSheet(dayKey)) return;

  const statusText = document.getElementById("status")?.innerText?.trim();
  const cycleTimeSec = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  if (!isMonitor && (statusText === "RUNNING" || statusText === "DOWN TIME" || statusText === "BREAK TIME")) {
    countdownValue = computeRunningCountdownSec(cycleTimeSec);
    isDowntime = countdownValue === 0;
  }

  applyReconciledActualToDashboard();
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
        maybeReconcileLocalActualFromSheet();
        reconcileNonProductionMarksFromSheet();
        if (document.body.classList.contains("graph-mode")) {
          renderGraphCharts();
        }
        if (document.body.classList.contains("summary-mode")) {
          showSummaryPage();
        }
      }
      // Always keep accumulated downtime card synced to rendered rows,
      // even when table data payload is unchanged (e.g. timer stopped/target achieved).
      refreshDowntimeCardFromTable();
      maybeReconcileLocalActualFromSheet();
    })
    .catch(err => console.log("Monitor load error:", err));
}

/* ===== INITIALIZE SYSTEM ===== */

document.getElementById("cycleTarget").value = SETTINGS.defaultCycle;
document.getElementById("dailyPlanTarget").value = SETTINGS.defaultPlan;

document.getElementById("cycleTarget").addEventListener("input", () => {
  if (!isMasterRole()) return;
  if (!timer) {
    countdownValue = (parseFloat(document.getElementById("cycleTarget").value) || 1) * 60;
  }
  hasLocalSession = true;
  updateDisplay();
  if (isMonitor) publishMasterSettingsFromInputs();
  else updateLiveStateOnly();
});

document.getElementById("dailyPlanTarget").addEventListener("input", () => {
  if (!isMasterRole()) return;
  const plan = parseInt(document.getElementById("dailyPlanTarget").value, 10) || 0;
  syncTodayScanPlanOnRows(plan);
  hasLocalSession = true;
  updateDisplay();
  if (isMonitor) publishMasterSettingsFromInputs();
  else updateLiveStateOnly();
  if (document.getElementById("graphChartsBody")) renderGraphCharts();
});

document.getElementById("lotInput").addEventListener("input", () => {
  if (!isMasterRole()) return;
  hasLocalSession = true;
  if (isMonitor) publishMasterSettingsFromInputs();
  else updateLiveStateOnly();
});

const historyDayFilterEl = document.getElementById("historyDayFilter");
const historyDayTodayBtn = document.getElementById("historyDayTodayBtn");
if (historyDayFilterEl) initSingleDayDatePicker(historyDayFilterEl, onHistoryDayFilterChange);
if (historyDayTodayBtn) {
  historyDayTodayBtn.addEventListener("click", onHistoryDayTodayClick);
}

loadAppearanceFromStorage();
applyAppearance();

window.onload = async function() {
  // 🔐 MUST WAIT ACCESS CHECK
  const allowed = await checkAccess();
  if (!allowed) return;

  loadGraphWtPresetFromStorage();
  loadAppearanceFromStorage();
  applyAppearance();
  applyAppRoleUi();
  loadShiftScheduleFromStorage();
  ensureShiftScheduleModal();
  bindClockShiftShortcut();
  bindRamadanRevealShortcut();
  ensureOvertimeMenuItem();
  ensureOvertimeModal();
  updateOvertimeMenuLabel();
  ensureAppearanceMenuItem();

  syncDowntimeDayPickerUi();

  updateDateTime();
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(updateDateTime, 1000);

  if (isMonitor) {
    document.body.classList.add("monitor-mode");
    if (canViewReports()) applyOperatorStyleMonitorDashboard();
    else applyLegacyMonitorDashboardLayout();
  }

  initFirebaseSync();
  loadInitialLiveState();
  if (!isMonitor) publishGraphSettingsToFirebase();

  if (isMonitor) {
    const chassisInput = document.getElementById("chassisInput");
    const modelInput = document.getElementById("modelInput");
    const engineInput = document.getElementById("engineInput");
    const keyInput = document.getElementById("keyInput");
    if (chassisInput) chassisInput.style.display = "none";
    if (modelInput) modelInput.style.display = "none";
    if (engineInput) engineInput.style.display = "none";
    if (keyInput) keyInput.style.display = "none";

    applyMainPcEditLock();

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
    liveStatePollInterval = setInterval(updateLiveStateOnly, 1000);
    applyShiftScheduleTick();
    if (shiftScheduleInterval) clearInterval(shiftScheduleInterval);
    shiftScheduleInterval = setInterval(applyShiftScheduleTick, 30000);
  }
  updateViewToggleMenuItem();
};
