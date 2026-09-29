const crypto = require('crypto');
async function saveDailySubmission(db, identity, submission) {
    const quotaRef = db.collection('privateSupportQuotas').doc(crypto.createHash('sha256').update(identity).digest('hex'));
    return db.runTransaction(async tx => {
        const quota = await tx.get(quotaRef);
        if (quota.exists && Date.now() < quota.data().nextAllowedAt) return false;
        tx.set(db.collection('supportRequests').doc(submission.id), submission);
        tx.set(quotaRef, { nextAllowedAt: Date.now() + 86400000 });
        return true;
    });
}
function latestSubmissions(requests) {
    return [...requests].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
}
function removableOldSubmissionIds(requests, limit = 5) {
    const sorted = [...requests].sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0));
    const keep = new Set(sorted.slice(0, 1).map(item => item.id));
    for (const item of sorted.filter(item => item.data.pinned)) {
        if (keep.size >= limit) break;
        keep.add(item.id);
    }
    for (const item of sorted) {
        if (keep.size >= limit) break;
        keep.add(item.id);
    }
    return sorted.filter(item => !keep.has(item.id)).map(item => item.id);
}
module.exports = { saveDailySubmission, latestSubmissions, removableOldSubmissionIds };
