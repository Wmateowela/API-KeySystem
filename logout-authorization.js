const { isLinkedToGoogleAccount } = require('./google-key-lookup');

// A shared key's activeSessionId is not an account session. Clearing it when
// one member signs out could disconnect every other member of that key.
function mayDisconnectKeySession(keyData, verifiedUser) {
    if (!keyData || !verifiedUser?.uid || (parseInt(keyData.maxUsers, 10) || 1) > 1) return false;

    const uid = verifiedUser.uid;
    if (keyData.googleUid && keyData.googleUid !== uid) return false;
    if (keyData.boundEmail && (!verifiedUser.email_verified ||
        String(keyData.boundEmail).trim().toLowerCase() !== String(verifiedUser.email || '').trim().toLowerCase())) return false;

    return isLinkedToGoogleAccount(keyData, uid, verifiedUser.email, verifiedUser.email_verified) ||
        (Array.isArray(keyData.usedBy) && keyData.usedBy.includes(uid));
}

// The Store can receive a guest key from a different origin without a Firebase
// login on that origin. The opaque session id is the only acceptable fallback;
// knowing a key string alone must never be enough to disconnect its holder.
function mayDisconnectGuestSession(keyData, sessionId) {
    if (!keyData || (parseInt(keyData.maxUsers, 10) || 1) > 1 ||
        keyData.googleUid || keyData.googleEmail || keyData.boundEmail ||
        (Array.isArray(keyData.accountUsers) && keyData.accountUsers.length > 0)) return false;
    const submitted = String(sessionId || '').trim();
    return submitted.length >= 12 && !!keyData.activeSessionId && submitted === keyData.activeSessionId;
}

module.exports = { mayDisconnectKeySession, mayDisconnectGuestSession };
