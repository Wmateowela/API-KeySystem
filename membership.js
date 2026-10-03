const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { isLinkedToGoogleAccount } = require('./google-key-lookup');
const { effectiveKeyExpiry, assignmentPatch, detachmentPatch, linkedKeysForAccount } = require('./role-access');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const emailOf = value => String(value || '').trim().toLowerCase();
const defaults = {
  demoEnabled: true, demoMinutes: 20,
  roles: [
    { id: 'basic', name: 'Basic', autoGift: false, stayAwake: false, customSettings: false },
    { id: 'plus', name: 'Plus', autoGift: true, stayAwake: true, customSettings: true },
    { id: 'vip', name: 'VIP', autoGift: true, stayAwake: true, customSettings: true }
  ],
  plans: [
    { id: 'free', name: 'Free', role: 'basic', price: 'Free', features: ['Store access with a valid key', 'Google profile and synced submissions', 'One Auto Gift demo'], tag: '', glow: false, url: 'https://discord.gg/6zEkP9jdM' },
    { id: 'plus', name: 'Plus', role: 'plus', price: 'Contact us', features: ['Auto Gift during your subscription', 'Custom bot timings and amounts', 'Stay Awake'], tag: 'Upgrade', glow: true, url: 'https://discord.gg/6zEkP9jdM' }
  ], payments: []
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function safeUrl(value) {
  const url = new URL(String(value));
  if (!['https:', 'http:'].includes(url.protocol)) throw fail('Use an HTTP or HTTPS URL.');
  return url.href;
}
function validateConfig(input) {
  if (!Array.isArray(input.roles) || !input.roles.length || input.roles.length > 30) throw fail('Provide 1–30 roles.');
  const ids = new Set();
  const roles = input.roles.map(r => {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(r.id) || ids.has(r.id)) throw fail('Role IDs must be unique lowercase names.');
    ids.add(r.id);
    return { id: r.id, name: String(r.name || r.id).slice(0, 50), autoGift: !!r.autoGift, stayAwake: !!r.stayAwake, customSettings: !!r.customSettings };
  });
  if (!ids.has('basic')) throw fail('Keep the Basic role.');
  const minutes = Number(input.demoMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525600) throw fail('Demo duration must be 1–525600 minutes.');
  const plans = (input.plans || []).slice(0, 20).map((p, i) => {
    if (!ids.has(p.role)) throw fail('Each plan needs an existing role.');
    const icon = String(p.icon || '').trim();
    if (icon && !/^fa-[a-z0-9-]+$/.test(icon)) throw fail('Plan icon must be a Font Awesome icon name, such as fa-crown.');
    return { id: String(p.id || 'plan_' + i).slice(0, 40), name: String(p.name || '').slice(0, 60), role: p.role, price: String(p.price || '').slice(0, 60), originalPrice: String(p.originalPrice || '').slice(0, 60), recommendation: String(p.recommendation || '').slice(0, 100), icon, features: (Array.isArray(p.features) ? p.features : []).slice(0, 15).map(f => String(f).slice(0, 180)), tag: String(p.tag || '').slice(0, 50), glow: !!p.glow, url: safeUrl(p.url || 'https://discord.gg/6zEkP9jdM') };
  });
  const payments = (input.payments || []).slice(0, 15).map(p => ({ name: String(p.name || '').slice(0, 50), imageUrl: p.imageUrl ? safeUrl(p.imageUrl) : '' }));
  return { roles, plans, payments, demoEnabled: input.demoEnabled !== false, demoMinutes: minutes };
}
function installMembership({ app, db, verifyAdmin, verifyUserToken, getKeyFromStorage, updateKeyInStorage, listKeysFromStorage = async () => [], mutateKeyInStorage = async (name, change) => { const current = await getKeyFromStorage(name); if (!current) throw fail('Key not found.', 404); const patch = change(current); await updateKeyInStorage(name, patch, { strict: true }); return { ...current, ...patch }; } }) {
  const database = () => { if (!db) throw fail('Account storage is unavailable. Please try again.', 503); return db; };
  const configRef = () => database().collection('privateMembership').doc('config');
  async function config() {
    if (configCache && Date.now() - configLoadedAt < CONFIG_TTL_MS) return configCache;
    const s = await configRef().get();
    configCache = s.exists ? { ...defaults, ...s.data() } : structuredClone(defaults);
    configLoadedAt = Date.now();
    return configCache;
  }
  const accountRef = email => database().collection('privateMembershipAccounts').doc(hash(emailOf(email)));
  async function assignedKeyForEmail(email) {
    if (!email) return '';
    const norm = emailOf(email);
    const cachedHit = assignedKeyCache.get(norm);
    const hitNow = Date.now();
    if (cachedHit && cachedHit.expiresAt > hitNow) return cachedHit.value;
    const snap = await accountRef(email).get();
    const value = snap.exists ? String(snap.data().assignedKey || '').trim().toUpperCase() : '';
    if (assignedKeyCache.size >= ASSIGNED_KEY_CACHE_MAX) assignedKeyCache.delete(assignedKeyCache.keys().next().value);
    assignedKeyCache.set(norm, { value, expiresAt: hitNow + ASSIGNED_KEY_TTL_MS });
    return value;
  }
  const demoMinutesFor = (account, cfg) => {
    const override = Number(account?.demoMinutesOverride);
    return Number.isInteger(override) && override >= 1 && override <= 525600 ? override : cfg.demoMinutes;
  };
  const route = handler => async (req, res) => { try { await handler(req, res); } catch (e) { res.status(e.status || 500).json({ success: false, error: e.message }); } };

  // ---------------------------------------------------------------
  // Firestore quota guards. Every store page checks access on a ticker
  // (plus on tab focus), so reading the config/account document — and worse,
  // writing the account document — on each check emptied the Spark free
  // quota within hours. Results are memoised per account and the account
  // document is written only when something actually changed.
  // ---------------------------------------------------------------
  const CONFIG_TTL_MS = 10 * 60 * 1000;
  const ACCESS_TTL_MS = 15 * 60 * 1000;
  const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;
  const ACCESS_CACHE_MAX = 500;
  // Every open Store tab re-checks its Google key on a 30s poll, and each of
  // those calls used to read this account document straight from Firestore.
  // That single read was most of the free-tier read burn. Admin changes always
  // go through invalidateAccess()/invalidateConfig(), so the memo is dropped
  // immediately when a key is assigned, replaced or removed; the TTL only
  // covers edits made outside this backend (e.g. the Firebase console).
  const ASSIGNED_KEY_TTL_MS = 2 * 60 * 1000;
  const ASSIGNED_KEY_CACHE_MAX = 500;
  let configCache = null;
  let configLoadedAt = 0;
  const accessCache = new Map();
  const assignedKeyCache = new Map();

  function invalidateConfig() {
    configCache = null;
    configLoadedAt = 0;
    accessCache.clear();
    assignedKeyCache.clear();
  }
  function invalidateAccess(email) {
    if (!email) { accessCache.clear(); assignedKeyCache.clear(); return; }
    assignedKeyCache.delete(emailOf(email));
    const needle = `|${emailOf(email)}|`;
    for (const key of [...accessCache.keys()]) {
      if (key.includes(needle)) accessCache.delete(key);
    }
  }
  function rememberAccess(cacheKey, value) {
    if (accessCache.size >= ACCESS_CACHE_MAX) accessCache.delete(accessCache.keys().next().value);
    accessCache.set(cacheKey, { value, expiresAt: Date.now() + ACCESS_TTL_MS });
  }
  // Keys live in RTDB while account grants live in Firestore. There is no
  // cross-database transaction, so record the exact fields each key mutation
  // changed and compensate in reverse order if a later step fails. Never
  // overwrite a concurrent change made after our write.
  function keyChangeJournal() {
    const changes = [];
    return {
      async change(name, mutate) {
        let before, patch;
        const after = await mutateKeyInStorage(name, current => {
          before = structuredClone(current);
          patch = mutate(current);
          return patch;
        });
        changes.push({ name, before, patch, after });
        return after;
      },
      async rollback() {
        const errors = [];
        for (const entry of changes.reverse()) {
          try {
            await mutateKeyInStorage(entry.name, current => {
              const restore = {};
              for (const field of Object.keys(entry.patch || {})) {
                if (isDeepStrictEqual(current[field], entry.after[field])) {
                  restore[field] = Object.hasOwn(entry.before, field) ? entry.before[field] : null;
                } else {
                  errors.push(`${entry.name}.${field} changed concurrently`);
                }
              }
              return restore;
            });
          } catch (e) { errors.push(`${entry.name}: ${e.message}`); }
        }
        return errors;
      }
    };
  }
  async function identity(req) {
    const user = await verifyUserToken(req, true).catch(() => { throw fail('Sign in again to continue.', 401); });
    return { user, email: user.email && user.email_verified && user.firebase?.sign_in_provider !== 'anonymous' ? emailOf(user.email) : '' };
  }
  // Reads the account document. The old code re-wrote it on every poll, which
  // alone emptied the Spark free-tier write quota on a 100+ user site.
  async function readAccount(user, email, now) {
    const ref = accountRef(email);
    const snap = await ref.get();
    if (snap.exists) {
      const account = snap.data();
      const stale = now - Number(account.lastSeen || 0) >= LAST_SEEN_THROTTLE_MS;
      const identityChanged = account.uid !== user.uid || account.name !== (user.name || '');
      if (stale || identityChanged) {
        account.uid = user.uid; account.name = user.name || ''; account.lastSeen = now;
        ref.set({ uid: user.uid, name: user.name || '', lastSeen: now }, { merge: true }).catch(() => {});
      }
      return account;
    }
    const account = { email, role: 'basic', demoStartedAt: null, demoExpiresAt: null, subscriptionExpiresAt: 0, uid: user.uid, name: user.name || '', lastSeen: now };
    ref.set(account, { merge: true }).catch(() => {});
    return account;
  }
  // Only "start the demo" mutates the document, so it keeps the transaction.
  async function startDemoAccount(user, email, cfg, now) {
    const ref = accountRef(email);
    const a = await database().runTransaction(async tx => {
      const snap = await tx.get(ref);
      const doc = snap.exists ? snap.data() : { email, role: 'basic', demoStartedAt: null, demoExpiresAt: null, subscriptionExpiresAt: 0 };
      doc.uid = user.uid; doc.name = user.name || ''; doc.lastSeen = now;
      const paidRole = cfg.roles.find(r => r.id === doc.role && !['basic', 'none'].includes(r.id));
      const paid = paidRole && (!doc.subscriptionExpiresAt || doc.subscriptionExpiresAt > now);
      if (!paid && cfg.demoEnabled && doc.demoEnabled !== false && doc.demoStartedAt == null) {
        doc.demoStartedAt = now;
        doc.demoExpiresAt = now + demoMinutesFor(doc, cfg) * 60000;
      }
      tx.set(ref, doc);
      return doc;
    });
    invalidateAccess(email);
    return a;
  }
  async function entitlement(req, start = false, bypassCache = false) {
    const { user, email } = await identity(req);
    const now = Date.now();
    const keyName = String(req.body?.key || '').trim().toUpperCase();
    const cacheKey = `${user.uid}|${email}|${keyName}`;
    // Only the Firestore-backed part (config + account) is memoised. Key data
    // still comes from the live RTDB/memory map on every call, so revoking a
    // key takes effect immediately instead of waiting for the cache to age out.
    let snapshot = null;
    if (!start && !bypassCache) {
      const hit = accessCache.get(cacheKey);
      if (hit && hit.expiresAt > now) snapshot = hit.value;
    }
    let cfg, account = null;
    if (snapshot) {
      cfg = snapshot.cfg;
      account = snapshot.account;
    } else {
      cfg = await config();
      if (email) account = start ? await startDemoAccount(user, email, cfg, now) : await readAccount(user, email, now);
      if (!start) rememberAccess(cacheKey, { cfg, account });
    }
    const assignedKey = account?.assignedKey ? await getKeyFromStorage(account.assignedKey) : null;
    const assignedExpiry = assignedKey ? effectiveKeyExpiry(assignedKey) : 0;
    const validAssignedKey = !account?.assignedKey || (assignedKey && !assignedKey.revoked && (!assignedExpiry || assignedExpiry > now) && assignedKey.tier === account.role && isLinkedToGoogleAccount(assignedKey, user.uid, email, true));
    let role = cfg.roles.find(r => r.id === account?.role && !['basic', 'none'].includes(r.id) && (!account.subscriptionExpiresAt || account.subscriptionExpiresAt > now) && validAssignedKey);
    let expiresAt = role ? (assignedExpiry && account.subscriptionExpiresAt ? Math.min(assignedExpiry, account.subscriptionExpiresAt) : assignedExpiry || account.subscriptionExpiresAt) : 0;
    let source = role ? 'subscription' : 'locked';
    if (keyName) {
      const key = await getKeyFromStorage(keyName);
      const member = key && (!email || !(key.excludedEmails || []).some(value => emailOf(value) === email)) && (key.userId === user.uid || key.googleUid === user.uid || (key.usedBy || []).includes(user.uid) || (key.accountUsers || []).some(a => a.uid === user.uid));
      const keyRole = key && cfg.roles.find(r => r.id === key.tier && !['basic', 'none'].includes(r.id));
      const keyExpiry = key && Math.min(key.expiresAt || Infinity, key.subscriptionExpiresAt || Infinity);
      if (member && !key.revoked && keyExpiry > now && keyRole && (!key.boundEmail || key.boundEmail === email) && (!role || (!role.autoGift && keyRole.autoGift))) {
        role = keyRole; expiresAt = Number.isFinite(keyExpiry) ? keyExpiry : 0; source = 'key';
      }
    }
    let canStartDemo = false;
    const demoDisabledReason = !email ? null : !cfg.demoEnabled ? 'global' : account?.demoEnabled === false ? 'account' : null;
    let demoStatus = !email ? 'signin' : demoDisabledReason ? 'disabled' : account?.demoStartedAt == null ? 'available' : account.demoExpiresAt > now ? 'active' : 'ended';
    if (!role && account && cfg.demoEnabled && account.demoEnabled !== false) {
      canStartDemo = account.demoStartedAt == null;
      if (account.demoStartedAt != null && account.demoExpiresAt > now) {
        role = { id: 'basic', name: 'Free Demo', autoGift: true, stayAwake: true, customSettings: true };
        expiresAt = account.demoExpiresAt || 0; source = 'demo';
      }
    }
    return { serverNow: now, email, role: role?.id || 'basic', roleName: role?.name || 'Basic', source, expiresAt, canStartDemo, demoStatus, demoDisabledReason, demoMinutes: demoMinutesFor(account, cfg), permissions: { autoGift: !!role?.autoGift, stayAwake: !!role?.stayAwake, customSettings: !!role?.customSettings }, allowed: !!role?.autoGift };
  }
  app.get('/api/membership/plans', route(async (req, res) => { const c = await config(); res.json({ plans: c.plans, payments: c.payments, demoMinutes: c.demoMinutes, demoEnabled: c.demoEnabled }); }));
  app.post('/api/membership/access', route(async (req, res) => res.json(await entitlement(req, false))));
  app.post('/api/membership/activate-demo', route(async (req, res) => {
    const access = await entitlement(req, true);
    if (!access.allowed) throw fail('Demo is unavailable or has ended for this account.', 403);
    res.json(access);
  }));
  app.post('/api/membership/cycle', route(async (req, res) => {
    const access = await entitlement(req, false, true);
    if (!access.allowed) throw fail('Auto Gift is locked. Upgrade to unlock.', 403);
    res.json(access);
  }));
  app.get('/api/admin/membership/config', verifyAdmin, route(async (req, res) => res.json(await config())));
  app.put('/api/admin/membership/config', verifyAdmin, route(async (req, res) => { const value = validateConfig(req.body); await configRef().set(value); invalidateConfig(); res.json(value); }));
  app.get('/api/admin/membership/account', verifyAdmin, route(async (req, res) => {
    const email = emailOf(req.query.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email.');
    const snap = await accountRef(email).get();
    res.json(snap.exists ? snap.data() : { email, role: 'basic', demoEnabled: true, demoStartedAt: null, demoExpiresAt: null, subscriptionExpiresAt: 0 });
  }));
  app.put('/api/admin/membership/account', verifyAdmin, route(async (req, res) => {
    const email = emailOf(req.body.email), c = await config();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !c.roles.some(r => r.id === req.body.role)) throw fail('Valid email and role required.');
    const expires = Number(req.body.subscriptionExpiresAt);
    if (!Number.isFinite(expires) || expires < 0) throw fail('Invalid subscription expiry.');
    const currentSnap = await accountRef(email).get();
    const current = currentSnap.exists ? currentSnap.data() : null;
    const updates = { email, role: req.body.role, subscriptionExpiresAt: expires, demoEnabled: req.body.demoEnabled !== false, adminManaged: true, accessUpdatedAt: Date.now(), accessOperationId: crypto.randomUUID() };
    const previousKey = current?.assignedKey && current.role !== req.body.role ? await getKeyFromStorage(current.assignedKey) : null;
    if (current?.assignedKey && current.role !== req.body.role) updates.assignedKey = '';
    if (req.body.demoMinutesRemaining !== undefined && req.body.demoMinutesRemaining !== '') {
      const minutes = Number(req.body.demoMinutesRemaining);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 525600) throw fail('Invalid demo minutes.');
      updates.demoStartedAt = Date.now(); updates.demoExpiresAt = Date.now() + minutes * 60000;
    }
    const journal = keyChangeJournal();
    try {
      if (previousKey) await journal.change(previousKey.key, fresh => isLinkedToGoogleAccount(fresh, current.uid || 'pending-admin-assignment', email, true) ? detachmentPatch(fresh, email, current.uid || '') : {});
      await accountRef(email).set(updates, { merge: true });
    } catch (e) {
      try {
        const check = await accountRef(email).get();
        if (check.exists && check.data().accessOperationId === updates.accessOperationId) { invalidateAccess(email); return res.json({ success: true }); }
      } catch (_) {}
      const rollbackErrors = await journal.rollback();
      if (rollbackErrors.length) throw fail(`Account update failed and rollback needs review: ${rollbackErrors.join('; ')}. Original error: ${e.message}`, 503);
      throw e;
    }
    invalidateAccess(email);
    res.json({ success: true });
  }));
  app.get('/api/admin/membership/accounts', verifyAdmin, route(async (req, res) => {
    // This is the admin-managed subset, not every Google login. Do not cap it
    // silently: the saved-email box must include every account Admin added.
    const snap = await database().collection('privateMembershipAccounts').where('adminManaged', '==', true).get();
    const accounts = await Promise.all(snap.docs.map(async doc => {
      const account = doc.data();
      const key = account.assignedKey ? await getKeyFromStorage(account.assignedKey) : null;
      return { email: account.email || '', role: account.role || 'basic', subscriptionExpiresAt: account.subscriptionExpiresAt || 0, assignedKey: account.assignedKey || '', keyExpiresAt: key ? effectiveKeyExpiry(key) : 0, keyRevoked: !!key?.revoked, keyMissing: !!account.assignedKey && !key, accessUpdatedAt: account.accessUpdatedAt || 0 };
    }));
    accounts.sort((a, b) => b.accessUpdatedAt - a.accessUpdatedAt);
    res.json({ accounts });
  }));
  app.post('/api/admin/membership/assign-key', verifyAdmin, route(async (req, res) => {
    const email = emailOf(req.body?.email);
    const keyName = String(req.body?.key || '').trim().toUpperCase();
    const role = String(req.body?.role || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid Google email.');
    if (!/^[A-Z0-9-]{6,64}$/.test(keyName)) throw fail('Enter a valid Admin key.');
    const cfg = await config();
    if (!cfg.roles.some(item => item.id === role && !['basic', 'none'].includes(item.id))) throw fail('Choose a paid role from Roles & Plans.');
    const allKeys = await listKeysFromStorage();
    const key = allKeys.find(item => item.key === keyName);
    if (!key) throw fail('Key not found.', 404);
    if (key.tier !== role) throw fail(`This key has the ${key.tier || 'none'} role. Create or choose a ${role} key; a shared key's role cannot be changed for only one account.`, 409);
    const oldSnap = await accountRef(email).get();
    const oldAccount = oldSnap.exists ? oldSnap.data() : { email };
    const now = Date.now();
    const uid = String(oldAccount.uid || '').trim();
    const linkedOldKeys = linkedKeysForAccount(allKeys, email, uid).filter(item => item.key !== keyName && !item.revoked);
    // Reserve the new key before detaching old links so a failed assignment
    // never removes the account's currently working access.
    const journal = keyChangeJournal();
    let assignedKey, expiry, account;
    try {
      assignedKey = await journal.change(keyName, fresh => {
        if (fresh.tier !== role) throw fail(`This key has the ${fresh.tier || 'none'} role. Create or choose a ${role} key.`, 409);
        return assignmentPatch(fresh, email, uid, now);
      });
      for (const oldKey of linkedOldKeys) {
        await journal.change(oldKey.key, fresh => isLinkedToGoogleAccount(fresh, uid || 'pending-admin-assignment', email, true) ? detachmentPatch(fresh, email, uid, now) : {});
      }
      expiry = effectiveKeyExpiry(assignedKey);
      account = { email, role, subscriptionExpiresAt: expiry, assignedKey: keyName, adminManaged: true, accessUpdatedAt: now, accessOperationId: crypto.randomUUID() };
      await accountRef(email).set(account, { merge: true });
    } catch (e) {
      // Firestore can acknowledge a write late. Check for an applied grant
      // before undoing its key links; otherwise the account could be stranded.
      if (account) {
        try {
          const check = await accountRef(email).get();
          if (check.exists && check.data().accessOperationId === account.accessOperationId) {
            invalidateAccess(email);
            res.json({ success: true, account: { ...oldAccount, ...account }, key: keyName, keyExpiresAt: expiry, replacedKeys: linkedOldKeys.map(item => item.key) });
            return;
          }
        } catch (_) {}
      }
      const rollbackErrors = await journal.rollback();
      if (rollbackErrors.length) throw fail(`Assignment failed and rollback needs review: ${rollbackErrors.join('; ')}. Original error: ${e.message}`, 503);
      throw e;
    }
    invalidateAccess(email);
    res.json({ success: true, account: { ...oldAccount, ...account }, key: keyName, keyExpiresAt: expiry, replacedKeys: linkedOldKeys.map(item => item.key) });
  }));
  app.delete('/api/admin/membership/account', verifyAdmin, route(async (req, res) => {
    const email = emailOf(req.query?.email || req.body?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid Google email.');
    const ref = accountRef(email);
    const snap = await ref.get();
    if (!snap.exists || !snap.data().adminManaged) throw fail('Account access was not found.', 404);
    const account = snap.data();
    const now = Date.now();
    const linkedKey = account.assignedKey ? await getKeyFromStorage(account.assignedKey) : null;
    const journal = keyChangeJournal();
    const removalOperationId = crypto.randomUUID();
    try {
      if (linkedKey) await journal.change(linkedKey.key, fresh => isLinkedToGoogleAccount(fresh, account.uid || 'pending-admin-assignment', email, true) ? detachmentPatch(fresh, email, account.uid || '', now) : {});
      await ref.set({ role: 'basic', subscriptionExpiresAt: 0, assignedKey: '', adminManaged: false, accessRemovedAt: now, accessOperationId: removalOperationId }, { merge: true });
    } catch (e) {
      try {
        const check = await ref.get();
        if (check.exists && check.data().accessOperationId === removalOperationId) { invalidateAccess(email); return res.json({ success: true, email, removedKey: linkedKey?.key || '' }); }
      } catch (_) {}
      const rollbackErrors = await journal.rollback();
      if (rollbackErrors.length) throw fail(`Removal failed and rollback needs review: ${rollbackErrors.join('; ')}. Original error: ${e.message}`, 503);
      throw e;
    }
    invalidateAccess(email);
    res.json({ success: true, email, removedKey: linkedKey?.key || '' });
  }));
  app.post('/api/admin/membership/reset-demo', verifyAdmin, route(async (req, res) => {
    const email = emailOf(req.body?.email);
    const minutes = Number(req.body?.minutes);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid Google email.');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw fail('Demo duration must be 1–525600 whole minutes.');
    const cfg = await config();
    if (!cfg.demoEnabled) throw fail('Free demos are globally disabled. Enable "Allow free demo" in Plans & Demo and save before resetting an account.', 409);
    await accountRef(email).set({ email, demoEnabled: true, demoStartedAt: null, demoExpiresAt: null, demoMinutesOverride: minutes }, { merge: true });
    invalidateAccess(email);
    res.json({ success: true, email, demoMinutes: minutes, demoStatus: 'available' });
  }));
  app.put('/api/admin/membership/key', verifyAdmin, route(async (req, res) => {
    const key = String(req.body.key || '').trim().toUpperCase();
    if (!await getKeyFromStorage(key)) throw fail('Key not found.', 404);
    const expiry = Number(req.body.subscriptionExpiresAt);
    if (!Number.isFinite(expiry) || expiry < 0) throw fail('Invalid subscription expiry.');
    await updateKeyInStorage(key, { subscriptionExpiresAt: expiry });
    accessCache.clear();
    res.json({ success: true });
  }));
  return { config, entitlement, assignedKeyForEmail };
}
module.exports = { installMembership, validateConfig, defaults };
