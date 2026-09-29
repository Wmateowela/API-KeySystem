const emailOf = value => String(value || '').trim().toLowerCase();

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
    return !key.expiresAt || key.expiresAt === 0 || key.expiresAt > now;
  }).sort((a, b) => {
    const expiry = key => !key.expiresAt || key.expiresAt === 0 ? Infinity : key.expiresAt;
    return expiry(b) - expiry(a);
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

module.exports = { isLinkedToGoogleAccount, findActiveGoogleKeys, findUsableGoogleKeys, accountKeySlot };
