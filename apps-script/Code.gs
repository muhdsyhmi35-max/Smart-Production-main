/**
 * Paste this into the Google Sheet: Extensions → Apps Script.
 * Put the lock branches at the TOP of your existing doGet / doPost
 * so LOCK is written before scan/state handling.
 *
 * LOCK sheet columns:
 *   A1 ID | B1 Tab ID | C1 Time
 *   A2 device id | B2 tab id | C2 last heartbeat
 */

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      return JSON.parse(e.postData.contents);
    }
  } catch (_) {}
  return {};
}

function mergeParams_(e) {
  const body = parseBody_(e);
  const query = (e && e.parameter) || {};
  return Object.assign({}, query, body);
}

function ensureLockSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("LOCK");
  if (!sh) sh = ss.insertSheet("LOCK");
  const a1 = String(sh.getRange("A1").getValue() || "").trim();
  if (!a1) {
    sh.getRange(1, 1, 1, 3).setValues([["ID", "Tab ID", "Time"]]);
  }
  return sh;
}

function readLock_() {
  const sh = ensureLockSheet_();
  const id = String(sh.getRange("A2").getValue() || "").trim();
  const tabId = String(sh.getRange("B2").getValue() || "").trim();
  return {
    lock: !!(id || tabId),
    id: id,
    deviceId: id,
    lockedBy: id,
    tabId: tabId
  };
}

function writeLock_(id, tabId) {
  const sh = ensureLockSheet_();
  sh.getRange("A1:C1").setValues([["ID", "Tab ID", "Time"]]);
  sh.getRange("A2").setValue(id || "");
  sh.getRange("B2").setValue(tabId || "");
  sh.getRange("C2").setValue(new Date());
  SpreadsheetApp.flush();
}

function clearLock_() {
  const sh = ensureLockSheet_();
  sh.getRange("A2:C2").clearContent();
  SpreadsheetApp.flush();
}

function applyLockRequest_(data) {
  const id = String(data.deviceId || data.id || "").trim();
  const tabId = String(data.tabId || "").trim();
  const cur = readLock_();
  if (cur.lock && cur.id && id && cur.id !== id) {
    return cur;
  }
  writeLock_(id, tabId);
  return readLock_();
}

function handleLockGet_(p) {
  if (String(p.checkLock || "") === "true") {
    const lock = readLock_();
    const reqId = String(p.deviceId || p.id || "").trim();
    const reqTab = String(p.tabId || "").trim();
    const same =
      (reqId && lock.id && reqId === lock.id) ||
      (reqTab && lock.tabId && reqTab === lock.tabId);
    return jsonOut_({
      lock: !!(lock.lock && !same),
      id: lock.id,
      deviceId: lock.deviceId,
      lockedBy: lock.lockedBy,
      tabId: lock.tabId
    });
  }
  if (String(p.lockRequest || "") === "true") {
    const lock = applyLockRequest_(p);
    return jsonOut_({ ok: true, lock: true, id: lock.id, deviceId: lock.deviceId, tabId: lock.tabId });
  }
  return null;
}

function handleLockPost_(p) {
  if (p.unlock === true || p.unlock === "true" || p.lockRelease === true || p.lockRelease === "true") {
    const cur = readLock_();
    const id = String(p.deviceId || p.id || "").trim();
    if (!cur.lock || !id || cur.id === id) clearLock_();
    return jsonOut_({ ok: true, lock: false });
  }
  if (p.lockRequest === true || p.lockRequest === "true") {
    const lock = applyLockRequest_(p);
    return jsonOut_({ ok: true, lock: true, id: lock.id, deviceId: lock.deviceId, tabId: lock.tabId });
  }
  return null;
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const lockRes = handleLockGet_(p);
  if (lockRes) return lockRes;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const scan = ss.getSheetByName("scan");
  const state = ss.getSheetByName("state");
  return jsonOut_({
    scan: scan ? scan.getDataRange().getValues() : [],
    state: state ? state.getDataRange().getValues() : [],
    lock: readLock_()
  });
}

function doPost(e) {
  const p = mergeParams_(e);
  const lockRes = handleLockPost_(p) || handleLockGet_(p);
  if (lockRes) return lockRes;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (p.liveOnly === true || p.liveOnly === "true") {
    let state = ss.getSheetByName("state");
    if (!state) state = ss.insertSheet("state");
    if (!String(state.getRange("A1").getValue() || "").trim()) {
      state.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
    }
    state.getRange("A2:B20").clearContent();
    const rows = Object.keys(p)
      .filter(k => k !== "liveOnly")
      .map(k => [k, p[k]]);
    if (rows.length) state.getRange(2, 1, rows.length, 2).setValues(rows);
    return jsonOut_({ ok: true, liveOnly: true });
  }

  if (p.chassis || p.engine || p.key || p.status) {
    let scan = ss.getSheetByName("scan");
    if (!scan) scan = ss.insertSheet("scan");
    if (!String(scan.getRange("A1").getValue() || "").trim()) {
      scan.appendRow([
        "Date", "Lot", "Model", "Chassis", "Engine", "Key No",
        "Status", "Daily Plan", "Actual", "Downtime Event"
      ]);
    }
    scan.appendRow([
      new Date(),
      p.lot || "",
      p.model || "",
      p.chassis || "",
      p.engine || "",
      p.key || "",
      p.status || "",
      p.plan || "",
      p.actual || "",
      p.downtimeEvent || ""
    ]);
    return jsonOut_({ ok: true });
  }

  return jsonOut_({ ok: false, error: "unhandled" });
}
