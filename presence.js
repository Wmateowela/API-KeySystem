const WINDOW_MS = 120000;
function activeRecords(value, now = Date.now()) {
  return Object.entries(value || {}).filter(([, p]) => p && p.online !== false && Number(p.lastSeen) > now - WINDOW_MS && Number(p.lastSeen) <= now + 60000);
}
function countDevices(records, now = Date.now()) {
  return new Set(activeRecords(records, now).map(([node, p]) => String(p.visitorId || node))).size;
}
module.exports = { WINDOW_MS, activeRecords, countDevices };
