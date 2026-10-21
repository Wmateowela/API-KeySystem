const emailOf = value => String(value || '').trim().toLowerCase();
const TIMED_PROVIDERS = new Set(['linkvertise', 'lootlabs', 'workink']);

function isTimedProviderKey(key) {
  const provider = String(key?.provider || '').trim().toLowerCase();
  return TIMED_PROVIDERS.has(provider) || !!key?.lootlabsPostback || !!key?.lootlabsLocal ||
    !!key?.linkvertiseHash || !!key?.workinkPostback;
}

function effectiveAccessExpiry(key) {
  const rawExpiry = key?.expiresAt;
  const numericExpiry = Number(rawExpiry);
  if (isTimedProviderKey(key)) {
    return Number.isFinite(numericExpiry) && numericExpiry > 0 ? numericExpiry : NaN;
  }
  if (rawExpiry === null || rawExpiry === undefined || rawExpiry === '' || numericExpiry === 0) return Infinity;
  return Number.isFinite(numericExpiry) && numericExpiry > 0 ? numericExpiry : NaN;
}

function isLinkedToGoogleAccount(key, uid, email, emailVerified = false) {
  if (!key || !uid) return false;
  const cleanEmail = emailOf(email);
  if (cleanEmail && Array.isArray(key.excludedEmails) && key.excludedEmails.some(value => emailOf(value) === cleanEmail)) return false;
  const boundEmail = emailOf(key.boundEmail);
  if (boundEmail && (!emailVerified || boundEmail !== cleanEmail)) return false;

  const members = Array.isArray(key.accountUsers) ? key.accountUsers : [];
  const uidLinked = key.googleUid === uid || key.userId === uid || members.some(member => member?.uid === uid);
  const maxUsers = Math.max(1, parseInt(key.maxUsers, 10) || 1);
  if (maxUsers === 1 && key.googleUid && key.googleUid !== uid) return false;
  if (uidLinked) return true;
  if (!emailVerified || !cleanEmail) return false;

  const memberEmail = members.some(member => emailOf(member?.email) === cleanEmail);
  const legacyEmail = (key.authProvider === 'google' || key.googleUser) &&
    [key.email, key.userEmail].some(value => emailOf(value) === cleanEmail);
  // An admin-assigned email is an explicit entitlement even before the user
  // first enters that key. Never infer ownership from an unverified email.
  const assignedEmail = !!key.adminCreated && boundEmail === cleanEmail;
  const listedEmail = Array.isArray(key.assignedEmails) && key.assignedEmails.some(value => emailOf(value) === cleanEmail);
  return emailOf(key.googleEmail) === cleanEmail || memberEmail || legacyEmail || assignedEmail || listedEmail;
}

function findActiveGoogleKeys(keys, uid, email, emailVerified, now = Date.now()) {
  return [...keys].filter(key => {
    if (!key || key.revoked || !isLinkedToGoogleAccount(key, uid, email, emailVerified)) return false;
    const expiry = effectiveAccessExpiry(key);
    return expiry === Infinity || (Number.isFinite(expiry) && expiry > now);
  }).sort((a, b) => {
    return effectiveAccessExpiry(b) - effectiveAccessExpiry(a);
  });
}

// A linked account is not necessarily able to enter an admin key: an older
// guest identity may still occupy its last slot. Only a verified transition
// from that exact anonymous identity may transfer the slot to Google.
function accountKeySlot(key, uid, ip = '', previousGuestUid = '', email = '') {
  if (!key?.adminCreated) return { allowed: true };
  const maxUsers = Math.max(1, parseInt(key.maxUsers, 10) || 1);
  const reservation = emailOf(email) ? `email:${emailOf(email)}` : '';
  if (key.ipCheck) {
    const usedIps = [...new Set(Array.isArray(key.usedIps) ? key.usedIps : [])];
    if (reservation && usedIps.includes(reservation)) {
      const transferred = [...new Set(usedIps.map(value => value === reservation ? ip : value))];
      return { allowed: transferred.length <= maxUsers, usedIps: transferred };
    }
    return { allowed: usedIps.includes(ip) || usedIps.length < maxUsers };
  }
  const usedBy = [...new Set(Array.isArray(key.usedBy) ? key.usedBy.filter(Boolean) : [])];
  const memberUids = (Array.isArray(key.accountUsers) ? key.accountUsers : []).map(member => member?.uid).filter(Boolean);
  const withinLimit = ids => new Set([...ids, ...memberUids]).size <= maxUsers;
  if (usedBy.includes(uid)) return { allowed: withinLimit(usedBy), usedBy };
  if (reservation && usedBy.includes(reservation)) {
    const transferred = [...new Set(usedBy.map(id => id === reservation ? uid : id))];
    return { allowed: withinLimit(transferred), usedBy: transferred };
  }
  if (previousGuestUid && usedBy.includes(previousGuestUid)) {
    const transferred = [...new Set(usedBy.map(id => id === previousGuestUid ? uid : id))];
    return { allowed: withinLimit(transferred), usedBy: transferred };
  }
  const claimed = [...usedBy, uid];
  if (withinLimit(claimed)) return { allowed: true, usedBy: claimed };
  return { allowed: false };
}

function findUsableGoogleKeys(keys, uid, email, emailVerified, ip = '', previousGuestUid = '', now = Date.now()) {
  return findActiveGoogleKeys(keys, uid, email, emailVerified, now)
    .filter(key => accountKeySlot(key, uid, ip, previousGuestUid, email).allowed);
}

module.exports = { isLinkedToGoogleAccount, findActiveGoogleKeys, findUsableGoogleKeys, accountKeySlot, isTimedProviderKey, effectiveAccessExpiry };
