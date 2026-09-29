const { isLinkedToGoogleAccount } = require('./google-key-lookup');

const emailOf = value => String(value || '').trim().toLowerCase();
const unique = values => [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const reservationFor = email => `email:${emailOf(email)}`;

function effectiveKeyExpiry(key) {
  const keyExpiry = Number(key?.expiresAt) || 0;
  const subscriptionExpiry = Number(key?.subscriptionExpiresAt) || 0;
  const finite = [keyExpiry, subscriptionExpiry].filter(value => value > 0);
  return finite.length ? Math.min(...finite) : 0;
}

function assignmentPatch(key, email, uid = '', now = Date.now()) {
  const cleanEmail = emailOf(email);
  if (!key?.adminCreated) throw error('Assign an Admin-created key from the Keys tab.');
  if (key.revoked) throw error('This key has been revoked.', 409);
  const expiry = effectiveKeyExpiry(key);
  if (expiry && expiry <= now) throw error('This key or its subscription has expired.', 409);
  const maxUsers = Math.max(1, parseInt(key.maxUsers, 10) || 1);
  const boundEmail = emailOf(key.boundEmail);
  if (boundEmail && boundEmail !== cleanEmail) throw error('This key is assigned to another email. Create a new key or use an email-optional key.', 409);
  if (maxUsers === 1 && key.googleEmail && emailOf(key.googleEmail) !== cleanEmail) throw error('This key belongs to another Google account.', 409);

  const reservation = reservationFor(cleanEmail);
  const members = Array.isArray(key.accountUsers) ? [...key.accountUsers] : [];
  const knownUid = uid || members.find(member => emailOf(member?.email) === cleanEmail)?.uid || '';
  if (maxUsers === 1 && key.googleUid && key.googleUid !== knownUid) throw error('This key belongs to another Google account.', 409);
  const usedBy = unique(key.usedBy);
  const usedIps = unique(key.usedIps);
  if (key.ipCheck) {
    if (!usedIps.includes(reservation)) {
      if (usedIps.length >= maxUsers) throw error(`This key has reached its sharing limit (Max ${maxUsers} networks).`, 409);
      usedIps.push(reservation);
    }
  } else {
    const occupant = knownUid || reservation;
    const occupied = new Set([...usedBy, ...members.map(member => member?.uid).filter(Boolean)]);
    if (!occupied.has(occupant) && occupied.size >= maxUsers) throw error(`This key has reached its sharing limit (Max ${maxUsers} users).`, 409);
    if (!usedBy.includes(occupant)) usedBy.push(occupant);
  }
  if (knownUid && !members.some(member => member?.uid === knownUid || emailOf(member?.email) === cleanEmail)) {
    members.push({ uid: knownUid, email: cleanEmail, linkedAt: now });
  }
  return {
    boundEmail: maxUsers === 1 ? cleanEmail : '',
    assignedEmails: unique([...(key.assignedEmails || []), cleanEmail].map(emailOf)),
    excludedEmails: unique((key.excludedEmails || []).map(emailOf).filter(value => value !== cleanEmail)),
    accountUsers: members,
    usedBy,
    usedUsers: usedBy.length,
    usedIps,
    ...(maxUsers === 1 ? { googleEmail: cleanEmail, ...(knownUid ? { googleUid: knownUid } : {}) } : {}),
    authProvider: 'google'
  };
}

function detachmentPatch(key, email, uid = '', now = Date.now()) {
  const cleanEmail = emailOf(email);
  const reservation = reservationFor(cleanEmail);
  const maxUsers = Math.max(1, parseInt(key.maxUsers, 10) || 1);
  const members = Array.isArray(key.accountUsers) ? key.accountUsers : [];
  const memberUids = members.filter(member => emailOf(member?.email) === cleanEmail).map(member => member?.uid).filter(Boolean);
  const accountUids = new Set([uid, ...memberUids].filter(Boolean));
  const usedBy = unique(key.usedBy).filter(value => value !== reservation && !accountUids.has(value));
  const patch = {
    assignedEmails: unique((key.assignedEmails || []).map(emailOf).filter(value => value !== cleanEmail)),
    excludedEmails: unique([...(key.excludedEmails || []).map(emailOf), cleanEmail]),
    accountUsers: members.filter(member => emailOf(member?.email) !== cleanEmail && !accountUids.has(member?.uid)),
    usedBy,
    usedUsers: usedBy.length,
    usedIps: unique(key.usedIps).filter(value => value !== reservation),
    ...(emailOf(key.boundEmail) === cleanEmail ? { boundEmail: '' } : {}),
    ...(emailOf(key.googleEmail) === cleanEmail ? { googleEmail: '', googleUid: '' } : {}),
    ...(accountUids.has(key.googleUid) ? { googleUid: '' } : {})
  };
  if (maxUsers === 1) Object.assign(patch, { revoked: true, revokedAt: now, supersededReason: 'admin_account_access_replaced' });
  return patch;
}

function linkedKeysForAccount(keys, email, uid = '') {
  return [...keys].filter(key => key && key.key && isLinkedToGoogleAccount(key, uid || 'pending-admin-assignment', email, true));
}

module.exports = { emailOf, effectiveKeyExpiry, assignmentPatch, detachmentPatch, linkedKeysForAccount };
