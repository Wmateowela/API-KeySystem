require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Local in-memory caches for lightning-fast lookups & 0-read operations
const memoryKeys = new Map();
const memoryUsedHashes = new Map();
const memoryLootlabsPending = new Map(); // postbackValue -> { userId, time, redeemed, ip, country }
const memoryWorkinkPending = new Map();  // postbackValue -> { userId, time, redeemed, ip, country }
const memoryBans = new Map();           // ip -> { ip, reason, banUntil, bannedAt, active }
const memoryAnnouncements = new Map();  // id -> announcementDoc
const memorySupportRequests = new Map(); // id -> supportDoc
const memoryInvalidKeys = new Map();     // key -> timestamp (negative cache to prevent 404 DB spam)
const onlineUsers = new Map();          // userId -> lastSeen (ms)

let announcementsLastLoaded = 0;
const ANNOUNCEMENTS_CACHE_TTL = 10 * 60 * 1000; // 10 mins
let supportLastLoaded = 0;
const SUPPORT_CACHE_TTL = 10 * 60 * 1000; // 10 mins
let keysLastLoaded = 0;
let bansLastLoaded = 0;
let usedHashesLastLoaded = 0;
const STARTUP_CACHE_TTL = 15 * 60 * 1000; // 15 min guard: skip full reload if recently loaded

// Provider key-duration config (admin-managed). Values are in hours.
const DEFAULT_PROVIDER_DURATIONS = {
    linkvertise: 6,
    lootlabs: 2,
    workink: 12
};
const memorySettings = {
    providerDurations: { ...DEFAULT_PROVIDER_DURATIONS }
};
const PROVIDER_KEYS = ['linkvertise', 'lootlabs', 'workink'];
const MIN_PROVIDER_HOURS = 1;
const MAX_PROVIDER_HOURS = 24 * 365; // 1 year cap

function getProviderDurationMs(provider) {
    const hours = memorySettings.providerDurations[provider];
    const safeHours = (typeof hours === 'number' && hours > 0) ? hours : (DEFAULT_PROVIDER_DURATIONS[provider] || 12);
    return safeHours * 60 * 60 * 1000;
}

function getProviderDurationHours(provider) {
    const hours = memorySettings.providerDurations[provider];
    return (typeof hours === 'number' && hours > 0) ? hours : (DEFAULT_PROVIDER_DURATIONS[provider] || 12);
}

async function loadSettingsFromFirestore() {
    if (!db) return;
    try {
        const doc = await db.collection('settings').doc('providerDurations').get();
        if (doc.exists) {
            const data = doc.data() || {};
            PROVIDER_KEYS.forEach(p => {
                const h = parseInt(data[p], 10);
                if (!isNaN(h) && h > 0) memorySettings.providerDurations[p] = h;
            });
            console.log('✅ Loaded provider durations from Firestore:', memorySettings.providerDurations);
        }
    } catch (e) {
        console.warn('Could not load provider durations:', e.message);
    }
}

// Initialize Firebase Admin
let db = null;
let firestoreAvailable = false;

// Helpers to pre-warm cache from Firestore on startup / wake from sleep
async function loadKeysFromFirestore(force = false) {
    if (!db) return;
    const now = Date.now();
    if (!force && keysLastLoaded && (now - keysLastLoaded) < STARTUP_CACHE_TTL && memoryKeys.size > 0) return;
    try {
        const snapshot = await db.collection('keys').get();
        let loaded = 0;
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data && data.key) {
                memoryKeys.set(data.key.toUpperCase(), data);
                loaded++;
            }
        });
        keysLastLoaded = Date.now();
        console.log(`✅ Loaded ${loaded} keys from Firestore into memory cache.`);
    } catch (e) {
        console.warn("Could not pre-load keys from Firestore:", e.message);
    }
}

async function loadBansFromFirestore(force = false) {
    if (!db) return;
    const now = Date.now();
    if (!force && bansLastLoaded && (now - bansLastLoaded) < STARTUP_CACHE_TTL && memoryBans.size > 0) return;
    try {
        const snapshot = await db.collection('bans').get();
        let loaded = 0;
        const nowTime = Date.now();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data && data.active && (!data.banUntil || data.banUntil > nowTime)) {
                memoryBans.set(data.ip || decodeURIComponent(doc.id), data);
                loaded++;
            }
        });
        bansLastLoaded = Date.now();
        console.log(`✅ Loaded ${loaded} active bans from Firestore into memory cache.`);
    } catch (e) {
        console.warn("Could not pre-load bans from Firestore:", e.message);
    }
}

async function loadAnnouncementsFromFirestore(force = false) {
    if (!db) return Array.from(memoryAnnouncements.values());
    const now = Date.now();
    if (!force && (now - announcementsLastLoaded) < ANNOUNCEMENTS_CACHE_TTL && memoryAnnouncements.size > 0) {
        return Array.from(memoryAnnouncements.values());
    }
    try {
        const snapshot = await db.collection('announcements').get();
        memoryAnnouncements.clear();
        snapshot.forEach(doc => {
            memoryAnnouncements.set(doc.id, { id: doc.id, ...doc.data() });
        });
        announcementsLastLoaded = now;
        console.log(`✅ Loaded ${memoryAnnouncements.size} announcements from Firestore into memory cache.`);
    } catch (e) {
        console.warn("Could not load announcements from Firestore:", e.message);
    }
    return Array.from(memoryAnnouncements.values());
}

async function loadUsedHashesFromFirestore(force = false) {
    if (!db) return;
    const now = Date.now();
    if (!force && usedHashesLastLoaded && (now - usedHashesLastLoaded) < STARTUP_CACHE_TTL && memoryUsedHashes.size > 0) return;
    try {
        const snapshot = await db.collection('usedHashes').get();
        let loaded = 0;
        snapshot.forEach(doc => {
            memoryUsedHashes.set(doc.id, doc.data() || { time: Date.now() });
            loaded++;
        });
        usedHashesLastLoaded = Date.now();
        console.log(`✅ Loaded ${loaded} used hashes from Firestore into memory cache.`);
    } catch (e) {
        console.warn("Could not pre-load used hashes from Firestore:", e.message);
    }
}

async function loadSupportFromFirestore(force = false) {
    if (!db) return Array.from(memorySupportRequests.values());
    const now = Date.now();
    if (!force && (now - supportLastLoaded) < SUPPORT_CACHE_TTL && memorySupportRequests.size > 0) {
        return Array.from(memorySupportRequests.values());
    }
    try {
        const snap = await db.collection('supportRequests').get();
        memorySupportRequests.clear();
        snap.forEach(d => memorySupportRequests.set(d.id, { id: d.id, ...d.data() }));
        supportLastLoaded = now;
        console.log(`✅ Loaded ${memorySupportRequests.size} support requests from Firestore into memory cache.`);
    } catch (e) {
        console.warn("Could not load support requests from Firestore:", e.message);
    }
    return Array.from(memorySupportRequests.values());
}

try {
    let credential = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const parsed = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string' 
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
                : process.env.FIREBASE_SERVICE_ACCOUNT;
            credential = cert(parsed);
        } catch (e) {
            console.warn("Could not parse FIREBASE_SERVICE_ACCOUNT env:", e.message);
        }
    }
    
    if (!credential) {
        const configuredKeyPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH;
        const keyPath = configuredKeyPath
            ? (path.isAbsolute(configuredKeyPath) ? configuredKeyPath : path.resolve(__dirname, configuredKeyPath))
            : path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(keyPath)) {
            const serviceAccount = require(keyPath);
            credential = cert(serviceAccount);
        }
    }

    if (credential) {
        initializeApp({ credential });
        db = getFirestore();
        // Test if Firestore is actually reachable
        db.collection('keys').limit(1).get()
            .then(() => {
                firestoreAvailable = true;
                console.log("✅ Firebase Admin initialized successfully.");
                loadKeysFromFirestore();
                loadSettingsFromFirestore();
                loadBansFromFirestore();
                loadAnnouncementsFromFirestore(true);
                loadUsedHashesFromFirestore();
            })
            .catch((e) => {
                console.warn("⚠️ Firebase Admin initialized but Firestore unreachable:", e.message);
                console.log("⚡ Falling back to in-memory store for admin operations.");
                firestoreAvailable = false;
            });
    } else {
        console.log("⚡ Running with internal key management engine.");
    }
} catch (error) {
    console.warn("ℹ️ Running in resilient mode with internal key management:", error.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Default Tokens
const LINKVERTISE_TOKEN = process.env.LINKVERTISE_TOKEN || '05bea4d469e02f8573931ff654597345edb6092d8c418ffc588c91de1678325a';
const LINKVERTISE_TARGET_LINK = process.env.LINKVERTISE_TARGET_LINK || 'https://direct-link.net/1276098/1A4zh2pEaHCB';

// LootLabs Configuration
const LOOTLABS_API_TOKEN = process.env.LOOTLABS_API_TOKEN || '162b3c3519ec02bfbd0fc20ff5d6cd1fb10954357e0be1eeee7f00929c2d17e9';
const LOOTLABS_TARGET_LINK = process.env.LOOTLABS_TARGET_LINK || 'https://buy-robl0x.netlify.app/key.html';
const LOOTLABS_TIER_ID = parseInt(process.env.LOOTLABS_TIER_ID || '2', 10);
const LOOTLABS_NUM_TASKS = parseInt(process.env.LOOTLABS_NUM_TASKS || '5', 10);
const LOOTLABS_THEME = parseInt(process.env.LOOTLABS_THEME || '1', 10);
const LOOTLABS_POSTBACK_SECRET = process.env.LOOTLABS_POSTBACK_SECRET || 'buyroblox_lootlabs_secret_2026';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin1234';

// Work.ink Configuration
const WORKINK_API_TOKEN = process.env.WORKINK_API_TOKEN || '264a4745-074d-4071-99ca-b7f4a34f1f37';
const WORKINK_TARGET_LINK = process.env.WORKINK_TARGET_LINK || 'https://work.ink/2Dqp/unlock-the-12h-key';
const WORKINK_LOCAL_LINK = process.env.WORKINK_LOCAL_LINK || 'https://work.ink/2Dqp/key-bylocal-side';
const WORKINK_POSTBACK_SECRET = process.env.WORKINK_POSTBACK_SECRET || 'buyroblox_workink_secret_2026';
const WORKINK_MIN_COMPLETE_SECS = parseInt(process.env.WORKINK_MIN_COMPLETE_SECS || '15', 10);

// Frontend base URL (for postback redirects)
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://buy-robl0x.netlify.app';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10kb' })); // Limit body size to prevent abuse

// 🔒 Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// ============================================================
// RATE LIMITING (in-memory, per IP)
// ============================================================
const rateLimitMap = new Map();
const RATE_LIMITS = {
    claim:        { windowMs: 60 * 1000,     max: 5  }, // 5 claims per minute per IP
    verify:       { windowMs: 60 * 1000,     max: 30 }, // 30 verifies per minute per IP
    admin:        { windowMs: 60 * 1000,     max: 60 }, // 60 admin calls per minute
    lootlabsPost: { windowMs: 60 * 1000,     max: 60 }  // 60 postback/poll requests/min for fast polling
};

function rateLimit(category) {
    return (req, res, next) => {
        const cfg = RATE_LIMITS[category];
        if (!cfg) return next();

        const ip = (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
        const key = `${category}:${ip}`;
        const now = Date.now();

        let entry = rateLimitMap.get(key);
        if (!entry || (now - entry.start) > cfg.windowMs) {
            entry = { start: now, count: 0 };
        }
        entry.count++;
        rateLimitMap.set(key, entry);

        if (entry.count > cfg.max) {
            return res.status(429).json({
                error: 'Too many requests. Please slow down.',
                retryAfter: Math.ceil((cfg.windowMs - (now - entry.start)) / 1000)
            });
        }
        next();
    };
}

// Periodically clean up old rate limit entries
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
        const cat = key.split(':')[0];
        const cfg = RATE_LIMITS[cat];
        if (cfg && (now - entry.start) > cfg.windowMs * 2) {
            rateLimitMap.delete(key);
        }
    }
}, 5 * 60 * 1000);

// Helper: get client IP
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// Helper: get country from IP (async)
async function getCountry(ip) {
    if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') return 'Local';
    try {
        const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`);
        if (!res.ok) return 'Unknown';
        const data = await res.json();
        return data.country || 'Unknown';
    } catch (e) {
        return 'Unknown';
    }
}

// ---------------- BAN HELPERS ----------------
function normalizeIp(ip) {
    if (!ip) return '';
    // x-forwarded-for may contain a list
    return String(ip).split(',')[0].trim();
}

// Returns ban record if this IP is currently banned, else null
async function isIpBanned(rawIp) {
    const ip = normalizeIp(rawIp);
    if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1') return null;

    const checkExpiry = (ban) => {
        if (!ban || !ban.active) return null;
        if (ban.banUntil && ban.banUntil > 0 && ban.banUntil <= Date.now()) return null; // expired
        return ban;
    };

    // 1. Memory
    const memBan = checkExpiry(memoryBans.get(ip));
    if (memBan) return memBan;

    // 2. Firestore
    if (db) {
        try {
            const doc = await db.collection('bans').doc(encodeURIComponent(ip)).get();
            if (doc.exists) {
                const ban = { ip, ...doc.data() };
                memoryBans.set(ip, ban);
                return checkExpiry(ban);
            }
        } catch (e) { /* ignore */ }
    }
    return null;
}

async function saveBan(ip, durationMs, reason, bannedBy) {
    const cleanIp = normalizeIp(ip);
    const now = Date.now();
    const banUntil = durationMs && durationMs > 0 ? now + durationMs : 0; // 0 = permanent
    const ban = {
        ip: cleanIp,
        reason: reason || '',
        bannedAt: now,
        banUntil,
        active: true,
        bannedBy: bannedBy || 'admin'
    };
    memoryBans.set(cleanIp, ban);
    if (db) {
        try {
            await db.collection('bans').doc(encodeURIComponent(cleanIp)).set(ban);
        } catch (e) {
            console.warn("Firestore ban save failed:", e.message);
        }
    }
    return ban;
}

async function clearBan(ip) {
    const cleanIp = normalizeIp(ip);
    memoryBans.delete(cleanIp);
    if (db) {
        try {
            await db.collection('bans').doc(encodeURIComponent(cleanIp)).delete();
        } catch (e) { /* ignore */ }
    }
}

// ---------------- ONLINE TRACKING ----------------
const ONLINE_WINDOW_MS = 70 * 1000; // considered online if seen within 70s
function markOnline(userId, ip) {
    if (!userId) return;
    onlineUsers.set(userId, Date.now());
    if (ip) {
        const key = `ip:${normalizeIp(ip)}`;
        onlineUsers.set(key, Date.now());
    }
}
function isUserOnline(userId) {
    if (!userId) return false;
    const t = onlineUsers.get(userId);
    return !!t && (Date.now() - t) < ONLINE_WINDOW_MS;
}
function getOnlineUserIds() {
    const now = Date.now();
    const ids = [];
    for (const [k, t] of onlineUsers.entries()) {
        if (k.startsWith('ip:')) continue;
        if (now - t < ONLINE_WINDOW_MS) ids.push(k);
    }
    return ids;
}

// ---------------- BAN ENFORCEMENT MIDDLEWARE ----------------
// These routes are blocked when the caller's IP is banned.
const BAN_PROTECTED_PATHS = new Set([
    '/api/verify-key',
    '/api/claim-key',
    '/api/claim-lootlabs-key',
    '/api/create-lootlabs-locker',
    '/api/claim-workink-key',
    '/api/create-workink-task',
    '/api/get-link'
]);
app.use(async (req, res, next) => {
    if (req.method === 'POST' && BAN_PROTECTED_PATHS.has(req.path)) {
        const ban = await isIpBanned(getClientIp(req));
        if (ban) {
            return res.status(403).json({
                success: false,
                valid: false,
                banned: true,
                reason: ban.reason || 'Violation of terms',
                banUntil: ban.banUntil || 0,
                error: 'Your access has been banned.'
            });
        }
    }
    next();
});

// Public: check if the current visitor is banned
app.get('/api/check-ban', async (req, res) => {
    const ban = await isIpBanned(getClientIp(req));
    if (ban) {
        return res.json({ banned: true, reason: ban.reason || '', banUntil: ban.banUntil || 0 });
    }
    res.json({ banned: false });
});

// Heartbeat: frontend pings this to appear "online" (real tracking)
app.post('/api/heartbeat', rateLimit('verify'), (req, res) => {
    const { userId } = req.body || {};
    if (!userId || typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid userId' });
    }
    markOnline(userId, getClientIp(req));
    res.json({ success: true });
});

// Health Check Endpoint (Render & Frontend Health Probe)
app.get(['/', '/health', '/api/health'], (req, res) => {
    res.json({
        status: "ok",
        service: "buy-roblox-apikey-backend",
        timestamp: new Date().toISOString(),
        firebaseReady: !!db,
        activeKeys: memoryKeys.size
    });
});

// Return target linkvertise url for frontend to navigate to
app.get('/api/get-link', (req, res) => {
    res.json({ url: LINKVERTISE_TARGET_LINK });
});

// Return target lootlabs url for frontend to navigate to
app.get('/api/get-lootlabs-link', (req, res) => {
    res.json({ url: LOOTLABS_TARGET_LINK });
});

// Return target workink url for frontend to navigate to
app.get('/api/get-workink-link', (req, res) => {
    res.json({ url: WORKINK_TARGET_LINK });
});

// Public: provider key durations (hours) for the key page cards
app.get('/api/provider-config', (req, res) => {
    res.json({
        success: true,
        durations: {
            linkvertise: getProviderDurationHours('linkvertise'),
            lootlabs: getProviderDurationHours('lootlabs'),
            workink: getProviderDurationHours('workink')
        }
    });
});

// Admin: get provider durations
app.get('/api/admin/provider-config', verifyAdmin, rateLimit('admin'), (req, res) => {
    res.json({
        success: true,
        durations: {
            linkvertise: getProviderDurationHours('linkvertise'),
            lootlabs: getProviderDurationHours('lootlabs'),
            workink: getProviderDurationHours('workink')
        }
    });
});

// Admin: update provider durations (hours)
app.post('/api/admin/provider-config', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const body = req.body || {};
        const updated = {};
        for (const p of PROVIDER_KEYS) {
            if (body[p] === undefined) continue;
            const h = parseInt(body[p], 10);
            if (isNaN(h) || h < MIN_PROVIDER_HOURS || h > MAX_PROVIDER_HOURS) {
                return res.status(400).json({ success: false, error: `Invalid ${p} duration. Use ${MIN_PROVIDER_HOURS}-${MAX_PROVIDER_HOURS} hours.` });
            }
            memorySettings.providerDurations[p] = h;
            updated[p] = h;
        }
        if (Object.keys(updated).length === 0) {
            return res.status(400).json({ success: false, error: 'No valid durations provided.' });
        }
        if (db) {
            try {
                await db.collection('settings').doc('providerDurations').set(memorySettings.providerDurations, { merge: true });
            } catch (e) {
                console.warn('Could not persist provider durations:', e.message);
            }
        }
        res.json({ success: true, durations: { ...memorySettings.providerDurations } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Browser GET helper for claim-key
app.get('/api/claim-key', (req, res) => {
    res.json({ 
        success: false, 
        message: "This endpoint requires a POST request with { hash, userId } from the frontend application." 
    });
});

// ============================================================
// LOOTLABS INTEGRATION
// ============================================================

// Create a LootLabs content locker for the current user
app.post('/api/create-lootlabs-locker', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }

    // Unique postbackValue that will be returned in postback GET request
    const postbackValue = crypto.randomBytes(16).toString('hex');
    const userIp = getClientIp(req);
    const userCountry = await getCountry(userIp);

    // Store pending entry with user's real browser IP & country
    memoryLootlabsPending.set(postbackValue, {
        userId,
        time: Date.now(),
        redeemed: false,
        ip: userIp,
        country: userCountry
    });
    if (db) {
        try {
            await db.collection('lootlabsPending').doc(postbackValue).set({
                userId,
                createdAt: FieldValue.serverTimestamp(),
                timestamp: Date.now(),
                redeemed: false,
                ip: userIp,
                country: userCountry
            });
        } catch (e) {}
    }

    // Destination URL LootLabs will redirect user to after completion
    // We pass the postbackValue in the URL fragment so it survives redirects
    const requestedUrl = (req.body && typeof req.body.destinationUrl === 'string' && req.body.destinationUrl.trim()) ? req.body.destinationUrl.trim() : null;
    const destinationUrl = requestedUrl ? `${requestedUrl}#lootlabs_done=${postbackValue}` : `${FRONTEND_BASE_URL}/key.html#lootlabs_done=${postbackValue}`;

    try {
        const llResponse = await fetch('https://creators.lootlabs.gg/api/public/content_locker', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${LOOTLABS_API_TOKEN}`
            },
            body: JSON.stringify({
                title: 'Buy Roblox Key Verification',
                url: destinationUrl,
                tier_id: LOOTLABS_TIER_ID,
                number_of_tasks: LOOTLABS_NUM_TASKS,
                theme: LOOTLABS_THEME,
                // Pass our postbackValue so LootLabs can echo it back in the postback
                // (LootLabs appends it as ?postbackValue= to the postback URL configured in dashboard)
                postback: postbackValue
            })
        });

        const llData = await llResponse.json().catch(() => ({}));
        console.log("[LootLabs create-locker]", llResponse.status, JSON.stringify(llData).slice(0, 300));

        // LootLabs returns message as an array (sometimes single object) — handle both
        let locker = null;
        if (Array.isArray(llData.message) && llData.message.length > 0) {
            locker = llData.message[0];
        } else if (llData.message && typeof llData.message === 'object') {
            locker = llData.message;
        }

        if (llResponse.ok && locker && (locker.loot_url || locker.short)) {
            const lootUrl = locker.loot_url || `https://lootdest.org/s?${locker.short}`;
            return res.json({
                success: true,
                lockerUrl: lootUrl,
                postbackValue
            });
        }

        const errMsg = (llData && llData.message) ? (typeof llData.message === 'string' ? llData.message : JSON.stringify(llData.message)) : "Failed to create LootLabs locker.";
        return res.status(500).json({ success: false, error: errMsg });
    } catch (err) {
        console.error("LootLabs create error:", err.message);
        return res.status(500).json({ success: false, error: "LootLabs API error: " + err.message });
    }
});

// Shared: process a verified LootLabs postback and issue the key.
// Used by BOTH the real postback endpoint AND the dev-only simulate endpoint.
async function redeemLootlabsPostback(postbackValue, req) {
    let pending = memoryLootlabsPending.get(postbackValue);
    let matchedDocId = postbackValue;

    if (!pending && db) {
        try {
            const doc = await db.collection('lootlabsPending').doc(postbackValue).get();
            if (doc.exists) {
                pending = doc.data();
                matchedDocId = postbackValue;
            }
        } catch (e) {}
    }

    // Memory fallback if not found by exact key
    if (!pending) {
        for (const [key, val] of memoryLootlabsPending.entries()) {
            if (key.startsWith('__')) continue;
            if (!val.redeemed && val.time > Date.now() - (15 * 60 * 1000)) {
                pending = val;
                matchedDocId = key;
                break;
            }
        }
    }

    if (!pending) {
        return { status: 404, message: "Unknown postbackValue" };
    }
    if (pending.redeemed) {
        return { status: 200, message: "ALREADY_REDEEMED" };
    }

    const userId = pending.userId;
    if (!userId) {
        return { status: 400, message: "Missing userId in pending entry" };
    }

    // Mark redeemed FIRST (prevents any double issue)
    pending.redeemed = true;
    memoryLootlabsPending.set(matchedDocId, pending);
    if (db) {
        try {
            await db.collection('lootlabsPending').doc(matchedDocId).update({ redeemed: true, redeemedAt: FieldValue.serverTimestamp() });
        } catch (e) {}
    }

    const issued = await issueLootlabsKey(userId, matchedDocId, req, pending);
    console.log(`[LootLabs Postback] Key issued ${issued.key} for user ${userId}`);
    return { status: 200, message: "OK", key: issued.key, expiresAt: issued.expiresAt, userId };
}

// LootLabs Postback - LootLabs server sends GET request here when user completes the locker.
// Configure this URL in your LootLabs panel postback settings:
//   https://api-keysystem.onrender.com/api/lootlabs-postback?postbackValue={UNIQUE_ID}&clickId={CLICK_ID}&secret=buyroblox_lootlabs_secret_2026
const recentLootlabsPostbacks = []; // last 20 postback attempts (for debugging)
app.get('/api/lootlabs-postback', async (req, res) => {
    // Log EVERY postback attempt for debugging
    const logEntry = {
        time: new Date().toISOString(),
        query: req.query,
        ip: getClientIp(req)
    };
    recentLootlabsPostbacks.push(logEntry);
    if (recentLootlabsPostbacks.length > 20) recentLootlabsPostbacks.shift();
    console.log(`[LootLabs Postback RECEIVED] query=${JSON.stringify(req.query)} ip=${logEntry.ip}`);

    // Accept postbackValue from any possible param name LootLabs might send
    const postbackValue = req.query.postbackValue || 
                          req.query.unique_id || 
                          req.query.uniqueId || 
                          req.query.UNIQUE_ID || 
                          req.query.postback || 
                          req.query.pbv || 
                          req.query.clickId || 
                          req.query.click_id || 
                          req.query.CLICK_ID || 
                          req.query.id;
    const { secret } = req.query;

    if (!postbackValue) {
        console.warn(`[LootLabs Postback] No postbackValue in query. Got: ${JSON.stringify(req.query)}`);
        return res.status(400).send("Missing postbackValue");
    }

    // Strict mode: require secret. Set STRICT_LOOTLABS_POSTBACK=false in env to disable.
    const strictMode = process.env.STRICT_LOOTLABS_POSTBACK !== 'false';
    if (strictMode && LOOTLABS_POSTBACK_SECRET) {
        if (!secret || secret !== LOOTLABS_POSTBACK_SECRET) {
            console.warn(`[LootLabs Postback] Invalid/missing secret. Got secret: ${secret ? 'present' : 'MISSING'}.`);
            return res.status(403).send("Invalid secret");
        }
    }

    try {
        const result = await redeemLootlabsPostback(postbackValue, req);
        return res.status(result.status).send(result.message);
    } catch (err) {
        console.error("LootLabs postback error:", err);
        return res.status(500).send("Server error");
    }
});

// DEBUG: View recent postback attempts (dev only)
app.get('/api/debug/recent-postbacks', (req, res) => {
    const isCloudHost = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.DYNO || process.env.NODE_ENV === 'production');
    const isDev = process.env.ENABLE_LOCAL_KEY_GEN === 'true' && !isCloudHost;
    if (!isDev) {
        return res.status(404).json({ error: "Not available in production" });
    }
    res.json({ count: recentLootlabsPostbacks.length, postbacks: recentLootlabsPostbacks });
});

// DEV ONLY: simulate a LootLabs postback for local testing.
// This uses the SAME secure code path as the real postback, so no bypass is introduced.
// Automatically disabled on production/cloud hosts.
app.post('/api/dev/simulate-lootlabs-complete', async (req, res) => {
    const isCloudHost = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.DYNO || process.env.NODE_ENV === 'production');
    const isDev = process.env.ENABLE_LOCAL_KEY_GEN === 'true' && !isCloudHost;
    if (!isDev) {
        return res.status(404).json({ success: false, error: "Endpoint not available." });
    }

    const { postbackValue } = req.body;
    if (!postbackValue || typeof postbackValue !== 'string') {
        return res.status(400).json({ success: false, error: "Missing postbackValue." });
    }

    try {
        const result = await redeemLootlabsPostback(postbackValue, req);
        return res.status(result.status).json({ success: result.status === 200, message: result.message, key: result.key, expiresAt: result.expiresAt });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Helper: issue a fresh LootLabs key for a user (shared by postback + claim)
async function issueLootlabsKey(userId, postbackValue, req, pending = null) {
    const keyString = [1, 2, 3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
    const now = Date.now();
    const expiresAt = now + getProviderDurationMs('lootlabs');
    
    // Prefer the real user's IP and Country captured when they created the locker,
    // instead of LootLabs postback server's US datacenter IP.
    let ip = (pending && pending.ip && pending.ip !== 'unknown') ? pending.ip : getClientIp(req);
    let country = (pending && pending.country && pending.country !== 'Unknown') ? pending.country : await getCountry(ip);

    const newKeyDoc = {
        key: keyString,
        userId: userId,
        createdAt: now,
        expiresAt: expiresAt,
        revoked: false,
        provider: 'lootlabs',
        ip: ip,
        country: country,
        maxUsers: 1,
        usedUsers: 1,
        usedBy: [userId],
        note: 'Generated via LootLabs',
        lootlabsPostback: postbackValue || null
    };
    // Always set in memory first (instant access)
    memoryKeys.set(keyString, newKeyDoc);
    // Persist to Firestore (so it survives server restart)
    let firestoreOk = true;
    if (db) {
        try {
            await db.collection('keys').doc(keyString).set(newKeyDoc);
        } catch (e) {
            console.error(`[Firestore] Failed to persist key ${keyString}:`, e.message);
            firestoreOk = false;
        }
        try {
            await db.collection('lootlabsClaimed').doc(userId).set({
                key: keyString,
                expiresAt: expiresAt,
                issuedAt: FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error(`[Firestore] Failed to persist claim for ${userId}:`, e.message);
        }
    } else {
        console.warn('[Firestore] db not initialized - key only in memory');
        firestoreOk = false;
    }
    memoryLootlabsPending.set(`__claimed_${userId}`, { key: keyString, expiresAt, time: now });
    console.log(`[Key Issued] ${keyString} for ${userId} (firestore: ${firestoreOk})`);
    return { key: keyString, expiresAt };
}

// Frontend polls / claims a LootLabs-issued key after being redirected back
app.post('/api/claim-lootlabs-key', rateLimit('lootlabsPost'), async (req, res) => {
    const { userId, postbackValue } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }

    // 🔒 Input validation
    if (typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
        return res.status(400).json({ success: false, error: "Invalid userId format." });
    }
    if (postbackValue !== undefined && (typeof postbackValue !== 'string' || postbackValue.length > 128)) {
        return res.status(400).json({ success: false, error: "Invalid postbackValue." });
    }

    try {
        // 1. Check in-memory latest claimed key for this user
        const memClaimed = memoryLootlabsPending.get(`__claimed_${userId}`);
        if (memClaimed && memClaimed.expiresAt > Date.now()) {
            return res.json({ success: true, key: memClaimed.key, expiresAt: memClaimed.expiresAt });
        }

        // 2. Scan memory keys for a key tied to this user + postbackValue
        if (postbackValue) {
            for (const [k, v] of memoryKeys.entries()) {
                if (v.userId === userId && v.lootlabsPostback === postbackValue && v.expiresAt > Date.now()) {
                    return res.json({ success: true, key: k, expiresAt: v.expiresAt });
                }
            }
        }

        // 3. Fallback: Check Firestore claimed collection only if not found in memory
        if (db) {
            try {
                const doc = await db.collection('lootlabsClaimed').doc(userId).get();
                if (doc.exists) {
                    const data = doc.data();
                    if (data.expiresAt && data.expiresAt > Date.now()) {
                        memoryLootlabsPending.set(`__claimed_${userId}`, { key: data.key, expiresAt: data.expiresAt, time: Date.now() });
                        return res.json({ success: true, key: data.key, expiresAt: data.expiresAt });
                    }
                }
            } catch (e) {}
        }

        // 4. NO client-side fallback. Keys are issued ONLY by the verified
        //    LootLabs postback. This prevents any bypass. For local testing,
        //    use the dev-only simulate endpoint below.
        return res.status(404).json({ success: false, error: "No LootLabs key found yet. Please complete all tasks and try again." });
    } catch (err) {
        console.error("LootLabs claim error:", err);
        return res.status(500).json({ success: false, error: "Server error: " + err.message });
    }
});

// ============================================================
// WORK.INK INTEGRATION
// ============================================================

// Create a Work.ink task for the current user
app.post('/api/create-workink-task', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }

    const postbackValue = crypto.randomBytes(16).toString('hex');
    const userIp = getClientIp(req);
    const userCountry = await getCountry(userIp);

    memoryWorkinkPending.set(postbackValue, {
        userId,
        time: Date.now(),
        redeemed: false,
        ip: userIp,
        country: userCountry
    });
    if (db) {
        try {
            await db.collection('workinkPending').doc(postbackValue).set({
                userId,
                createdAt: FieldValue.serverTimestamp(),
                timestamp: Date.now(),
                redeemed: false,
                ip: userIp,
                country: userCountry
            });
        } catch (e) {}
    }

    const requestedUrl = (req.body && typeof req.body.destinationUrl === 'string' && req.body.destinationUrl.trim()) ? req.body.destinationUrl.trim() : null;
    const destinationUrl = requestedUrl ? `${requestedUrl}#workink_done=${postbackValue}` : `${FRONTEND_BASE_URL}/key.html#workink_done=${postbackValue}`;

    try {
        const wiResponse = await fetch('https://api.work.ink/v1/links', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${WORKINK_API_TOKEN}`
            },
            body: JSON.stringify({
                destination: destinationUrl,
                title: 'Buy Roblox Key Verification',
                postback: postbackValue
            })
        });

        const wiData = await wiResponse.json().catch(() => ({}));
        console.log("[Work.ink create-task]", wiResponse.status, JSON.stringify(wiData).slice(0, 300));

        const taskUrl = wiData.url || wiData.link || wiData.short_url || (wiData.data && (wiData.data.url || wiData.data.link || wiData.data.short_url));

        if (wiResponse.ok && taskUrl) {
            return res.json({
                success: true,
                taskUrl: taskUrl,
                postbackValue
            });
        }

        // Fallback: use configured direct link or default
        const directUrl = (WORKINK_TARGET_LINK && WORKINK_TARGET_LINK !== 'https://work.ink/') ? WORKINK_TARGET_LINK : `https://work.ink/`;
        return res.json({
            success: true,
            taskUrl: directUrl,
            postbackValue
        });
    } catch (err) {
        console.error("Work.ink create error:", err.message);
        const directUrl = (WORKINK_TARGET_LINK && WORKINK_TARGET_LINK !== 'https://work.ink/') ? WORKINK_TARGET_LINK : `https://work.ink/`;
        return res.json({
            success: true,
            taskUrl: directUrl,
            postbackValue
        });
    }
});

// Shared: process a verified Work.ink postback and issue the key.
async function redeemWorkinkPostback(postbackValue, req) {
    let pending = memoryWorkinkPending.get(postbackValue);
    let matchedDocId = postbackValue;

    if (!pending && db) {
        try {
            const doc = await db.collection('workinkPending').doc(postbackValue).get();
            if (doc.exists) {
                pending = doc.data();
                matchedDocId = postbackValue;
            }
        } catch (e) {}
    }

    // Memory fallback if not found by exact key
    if (!pending) {
        for (const [key, val] of memoryWorkinkPending.entries()) {
            if (key.startsWith('__')) continue;
            if (!val.redeemed && val.time > Date.now() - (15 * 60 * 1000)) {
                pending = val;
                matchedDocId = key;
                break;
            }
        }
    }

    if (!pending) {
        return { status: 404, message: "Unknown postbackValue" };
    }
    if (pending.redeemed) {
        return { status: 200, message: "ALREADY_REDEEMED" };
    }

    const userId = pending.userId;
    if (!userId) {
        return { status: 400, message: "Missing userId in pending entry" };
    }

    pending.redeemed = true;
    memoryWorkinkPending.set(matchedDocId, pending);
    if (db) {
        try {
            await db.collection('workinkPending').doc(matchedDocId).update({ redeemed: true, redeemedAt: FieldValue.serverTimestamp() });
        } catch (e) {}
    }

    const issued = await issueWorkinkKey(userId, matchedDocId, req, pending);
    console.log(`[Work.ink Postback] Key issued ${issued.key} for user ${userId}`);
    return { status: 200, message: "OK", key: issued.key, expiresAt: issued.expiresAt, userId };
}

// Work.ink Postback - Work.ink server sends GET/POST request here when user completes tasks.
app.all('/api/workink-postback', async (req, res) => {
    const params = { ...req.query, ...(req.body || {}) };
    console.log(`[Work.ink Postback RECEIVED] params=${JSON.stringify(params)} ip=${getClientIp(req)}`);

    const postbackValue = params.postbackValue ||
                          params.postback ||
                          params.unique_id ||
                          params.uniqueId ||
                          params.id ||
                          params.token ||
                          params.tx_id ||
                          params.pbv;
    const { secret } = params;

    if (!postbackValue) {
        console.warn(`[Work.ink Postback] No postbackValue in request. Got: ${JSON.stringify(params)}`);
        return res.status(400).send("Missing postbackValue");
    }

    const strictMode = process.env.STRICT_WORKINK_POSTBACK === 'true';
    if (strictMode && WORKINK_POSTBACK_SECRET) {
        if (!secret || secret !== WORKINK_POSTBACK_SECRET) {
            console.warn(`[Work.ink Postback] Invalid/missing secret.`);
            return res.status(403).send("Invalid secret");
        }
    }

    try {
        const result = await redeemWorkinkPostback(postbackValue, req);
        return res.status(result.status).send(result.message);
    } catch (err) {
        console.error("Work.ink postback error:", err);
        return res.status(500).send("Server error");
    }
});

// DEV ONLY: simulate a Work.ink postback for local testing.
app.post('/api/dev/simulate-workink-complete', async (req, res) => {
    const isCloudHost = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.DYNO || process.env.NODE_ENV === 'production');
    const isDev = process.env.ENABLE_LOCAL_KEY_GEN === 'true' && !isCloudHost;
    if (!isDev) {
        return res.status(404).json({ success: false, error: "Endpoint not available." });
    }

    const { postbackValue } = req.body;
    if (!postbackValue || typeof postbackValue !== 'string') {
        return res.status(400).json({ success: false, error: "Missing postbackValue." });
    }

    try {
        const result = await redeemWorkinkPostback(postbackValue, req);
        return res.status(result.status).json({ success: result.status === 200, message: result.message, key: result.key, expiresAt: result.expiresAt });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Helper: issue a fresh Work.ink key for a user
async function issueWorkinkKey(userId, postbackValue, req, pending = null) {
    const keyString = [1, 2, 3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
    const now = Date.now();
    const expiresAt = now + getProviderDurationMs('workink');

    let ip = (pending && pending.ip && pending.ip !== 'unknown') ? pending.ip : getClientIp(req);
    let country = (pending && pending.country && pending.country !== 'Unknown') ? pending.country : await getCountry(ip);

    const newKeyDoc = {
        key: keyString,
        userId: userId,
        createdAt: now,
        expiresAt: expiresAt,
        revoked: false,
        provider: 'workink',
        ip: ip,
        country: country,
        maxUsers: 1,
        usedUsers: 1,
        usedBy: [userId],
        note: 'Generated via Work.ink',
        workinkPostback: postbackValue || null
    };
    memoryKeys.set(keyString, newKeyDoc);
    let firestoreOk = true;
    if (db) {
        try {
            await db.collection('keys').doc(keyString).set(newKeyDoc);
        } catch (e) {
            console.error(`[Firestore] Failed to persist key ${keyString}:`, e.message);
            firestoreOk = false;
        }
        try {
            await db.collection('workinkClaimed').doc(userId).set({
                key: keyString,
                expiresAt: expiresAt,
                issuedAt: FieldValue.serverTimestamp()
            });
        } catch (e) {
            console.error(`[Firestore] Failed to persist claim for ${userId}:`, e.message);
        }
    } else {
        console.warn('[Firestore] db not initialized - key only in memory');
        firestoreOk = false;
    }
    memoryWorkinkPending.set(`__claimed_${userId}`, { key: keyString, expiresAt, time: now });
    console.log(`[Key Issued] ${keyString} for ${userId} via Work.ink (firestore: ${firestoreOk})`);
    return { key: keyString, expiresAt };
}

// Frontend polls / claims a Work.ink-issued key after being redirected back
app.post('/api/claim-workink-key', rateLimit('lootlabsPost'), async (req, res) => {
    const { userId, postbackValue } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }

    if (typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
        return res.status(400).json({ success: false, error: "Invalid userId format." });
    }
    if (!postbackValue || typeof postbackValue !== 'string' || postbackValue.length > 128) {
        return res.status(400).json({ success: false, error: "Missing or invalid postbackValue." });
    }

    try {
        // 1. Already claimed? Return cached key
        const memClaimed = memoryWorkinkPending.get(`__claimed_${userId}`);
        if (memClaimed && memClaimed.expiresAt > Date.now()) {
            return res.json({ success: true, key: memClaimed.key, expiresAt: memClaimed.expiresAt });
        }

        // 2. Already issued via server postback? Scan memory keys (0 Firestore reads)
        for (const [k, v] of memoryKeys.entries()) {
            if (v.userId === userId && v.workinkPostback === postbackValue && v.expiresAt > Date.now()) {
                return res.json({ success: true, key: k, expiresAt: v.expiresAt });
            }
        }

        // 3. Firestore fallback only if not found in memory
        if (db) {
            try {
                const doc = await db.collection('workinkClaimed').doc(userId).get();
                if (doc.exists) {
                    const data = doc.data();
                    if (data.expiresAt && data.expiresAt > Date.now()) {
                        memoryWorkinkPending.set(`__claimed_${userId}`, { key: data.key, expiresAt: data.expiresAt, time: Date.now() });
                        return res.json({ success: true, key: data.key, expiresAt: data.expiresAt });
                    }
                }
            } catch (e) {}
        }

        // 3. Scan Firestore keys collection if not in memory (in case server restarted)
        if (db && postbackValue) {
            try {
                const snap = await db.collection('keys')
                    .where('workinkPostback', '==', postbackValue)
                    .where('userId', '==', userId)
                    .limit(1)
                    .get();
                if (!snap.empty) {
                    const doc = snap.docs[0].data();
                    if (doc.expiresAt > Date.now() && !doc.revoked) {
                        memoryKeys.set(doc.key, doc);
                        return res.json({ success: true, key: doc.key, expiresAt: doc.expiresAt });
                    }
                }
            } catch (e) {}
        }

        // 4. Verify with Work.ink Key System API:
        // When Work.ink redirects to key.html#token={TOKEN}, postbackValue is the token.
        // Check validity with Work.ink: GET https://work.ink/_api/v2/token/isValid/{token}?deleteToken=1
        if (postbackValue) {
            try {
                const wiRes = await fetch(`https://work.ink/_api/v2/token/isValid/${encodeURIComponent(postbackValue)}?deleteToken=1`);
                const wiData = await wiRes.json().catch(() => ({}));
                console.log(`[Work.ink Token Check] ${postbackValue} ->`, wiData);

                if (wiData && wiData.valid === true) {
                    const issued = await issueWorkinkKey(userId, postbackValue, req);
                    console.log(`[Work.ink Key Issued] ${issued.key} for ${userId} via verified Work.ink token`);
                    return res.json({ success: true, key: issued.key, expiresAt: issued.expiresAt });
                }
            } catch (err) {
                console.warn("[Work.ink Token Check Error]:", err.message);
            }
        }

        // 5. Not verified yet and no valid key found
        return res.status(404).json({
            success: false,
            error: "No Work.ink key found yet. Please complete all tasks and try again."
        });
    } catch (err) {
        console.error("Work.ink claim error:", err);
        return res.status(500).json({ success: false, error: "Server error: " + err.message });
    }
});

// Browser GET helper for verify-key
app.get('/api/verify-key', (req, res) => {
    res.json({ 
        valid: false, 
        message: "This endpoint requires a POST request with { key, userId } from the frontend application." 
    });
});

// Endpoint to verify Linkvertise hash and generate 12-hour key
app.post('/api/claim-key', rateLimit('claim'), async (req, res) => {
    const { hash, userId } = req.body;

    if (!hash || !userId) {
        return res.status(400).json({ success: false, error: "Missing completion hash or userId." });
    }

    // 🔒 Input validation
    if (typeof hash !== 'string' || hash.length > 256) {
        return res.status(400).json({ success: false, error: "Invalid hash format." });
    }
    if (typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
        return res.status(400).json({ success: false, error: "Invalid userId format." });
    }

    try {
        console.log(`[Claim Key] Processing hash: ${hash} for user: ${userId}`);

        // 1. Check if hash was already used (Memory & Firebase)
        if (memoryUsedHashes.has(hash)) {
            return res.status(403).json({ success: false, error: "This completion hash has already been used. Please get a new key." });
        }

        if (db) {
            try {
                const hashRef = db.collection('usedHashes').doc(hash);
                const hashDoc = await hashRef.get();
                if (hashDoc.exists) {
                    return res.status(403).json({ success: false, error: "This completion hash has already been used. Please get a new key." });
                }
            } catch (dbErr) {
                console.warn("Firestore hash check skipped:", dbErr.message);
            }
        }

        // 2. Verify hash with Linkvertise Anti-Bypassing API
        let isValidHash = false;
        let lvErrorMsg = "Invalid Linkvertise verification hash.";
        
        try {
            const lvResponse = await fetch('https://publisher.linkvertise.com/api/v1/anti_bypassing', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'BuyRoblox-KeySystem/1.0'
                },
                body: JSON.stringify({ token: LINKVERTISE_TOKEN, hash: hash })
            });

            const lvData = await lvResponse.json().catch(() => ({}));
            console.log("[Linkvertise Response]", lvResponse.status, lvData);

            if (lvResponse.ok && (lvData.success === true || lvData.status === true || lvData.status === 200 || lvData.status === 'SUCCESS' || lvData.valid === true || lvData.user_id)) {
                isValidHash = true;
            } else if (lvData.success === false && (lvResponse.status === 401 || lvResponse.status === 403)) {
                return res.status(403).json({ 
                    success: false, 
                    error: lvData.message || lvData.error || "Invalid or expired Linkvertise completion hash." 
                });
            } else {
                isValidHash = false;
                lvErrorMsg = "Verification failed. Hash is not recognized by Linkvertise.";
            }
        } catch (lvErr) {
            console.warn("Linkvertise verification network error:", lvErr.message);
            isValidHash = false;
            lvErrorMsg = "Verification Server is busy. Please try clicking Confirm again in 5 seconds.";
        }

        if (!isValidHash) {
            return res.status(403).json({ success: false, error: lvErrorMsg });
        }

        // 3. Mark hash as used
        memoryUsedHashes.set(hash, { userId, time: Date.now() });
        if (db) {
            try {
                await db.collection('usedHashes').doc(hash).set({ 
                    usedAt: FieldValue.serverTimestamp(), 
                    userId: userId,
                    timestamp: Date.now()
                });
            } catch (e) {}
        }

        // 4. Generate unique 12-hour key (e.g. 8A3F-D1E2-99C4)
        const keyString = [1,2,3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-'); 
        
        const now = Date.now();
        const expiresAt = now + getProviderDurationMs('linkvertise'); // provider-configurable
        const ip = getClientIp(req);
        const country = await getCountry(ip);

        const newKeyDoc = {
            key: keyString,
            userId: userId,
            createdAt: now,
            expiresAt: expiresAt,
            revoked: false,
            provider: 'linkvertise',
            ip: ip,
            country: country,
            maxUsers: 1,
            usedUsers: 1,
            usedBy: [userId],
            note: 'Generated via Linkvertise',
            linkvertiseHash: hash
        };

        // Save in memory store
        memoryKeys.set(keyString, newKeyDoc);

        // Sync with Firestore if available
        if (db) {
            try {
                await db.collection('keys').doc(keyString).set(newKeyDoc);
            } catch (e) {}
        }

        console.log(`✅ [Key Created] Successfully issued key ${keyString} for user ${userId}`);

        return res.json({ success: true, key: keyString, expiresAt });

    } catch (error) {
        console.error("Claim key error:", error);
        return res.status(500).json({ success: false, error: "Server processing error: " + error.message });
    }
});

// Endpoint to verify user key
app.post('/api/verify-key', rateLimit('verify'), async (req, res) => {
    const { key, userId } = req.body;

    if (!key || !userId) {
        return res.status(400).json({ valid: false, error: "Missing key or userId." });
    }

    // 🔒 Input validation
    if (typeof key !== 'string' || key.length > 64 || !/^[A-Z0-9-]+$/i.test(key)) {
        return res.status(400).json({ valid: false, error: "Invalid key format." });
    }
    if (typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
        return res.status(400).json({ valid: false, error: "Invalid userId format." });
    }

    try {
        const cleanKey = key.trim().toUpperCase();

        // 1. Negative cache: if known invalid, reject immediately (0 Firestore reads)
        const invalidSince = memoryInvalidKeys.get(cleanKey);
        if (invalidSince && (Date.now() - invalidSince) < 10 * 60 * 1000) {
            return res.status(404).json({ valid: false, error: "Key not found. Please verify you entered it correctly." });
        }

        let keyData = memoryKeys.get(cleanKey);

        // If not in memory, check Firestore
        if (!keyData && db) {
            try {
                const keyDoc = await db.collection('keys').doc(cleanKey).get();
                if (keyDoc.exists) {
                    keyData = keyDoc.data();
                    memoryKeys.set(cleanKey, keyData); // Cache in memory
                } else {
                    memoryInvalidKeys.set(cleanKey, Date.now()); // Cache negative result for 10 mins
                }
            } catch (dbErr) {
                console.warn("Firestore verify lookup skipped:", dbErr.message);
            }
        }

        if (!keyData) {
            return res.status(404).json({ valid: false, error: "Key not found. Please verify you entered it correctly." });
        }

        // Check if revoked
        if (keyData.revoked) {
            return res.status(403).json({ valid: false, error: "This key has been revoked." });
        }

        // Check expiry (expiresAt === 0 or null means lifetime key)
        const hasExpiry = keyData.expiresAt && keyData.expiresAt > 0;
        if (hasExpiry && Date.now() > keyData.expiresAt) {
            return res.status(403).json({ valid: false, error: "Key is expired. Please get a new 12-hour key." });
        }

        // Multi-user / Share Limits Check (for Admin generated keys or shared keys)
        if (keyData.adminCreated) {
            let usedBy = Array.isArray(keyData.usedBy) ? [...keyData.usedBy] : [];
            const maxUsers = parseInt(keyData.maxUsers, 10) || 1;
            const reqIp = normalizeIp(getClientIp(req));

            if (keyData.ipCheck) {
                // Sharing counted per unique IP -> people on the same home/wifi can share freely.
                let usedIps = Array.isArray(keyData.usedIps) ? [...keyData.usedIps] : [];
                if (usedIps.includes(reqIp)) {
                    // same network -> allowed
                } else if (usedIps.length >= maxUsers) {
                    return res.status(403).json({ valid: false, error: `This key has reached its sharing limit (Max ${maxUsers} networks).` });
                } else {
                    usedIps.push(reqIp);
                    if (!usedBy.includes(userId)) usedBy.push(userId);
                    keyData.usedIps = usedIps;
                    keyData.usedBy = usedBy;
                    keyData.usedUsers = usedBy.length;
                    memoryKeys.set(cleanKey, keyData);
                    if (db) {
                        try {
                            await db.collection('keys').doc(cleanKey).update({ usedIps, usedBy, usedUsers: usedBy.length });
                        } catch (e) {}
                    }
                }
            } else if (usedBy.includes(userId)) {
                // User already recognized
            } else {
                if (usedBy.length >= maxUsers) {
                    return res.status(403).json({ valid: false, error: `This key has reached its sharing limit (Max ${maxUsers} users).` });
                }
                // Register user
                usedBy.push(userId);
                keyData.usedBy = usedBy;
                keyData.usedUsers = usedBy.length;
                memoryKeys.set(cleanKey, keyData);
                if (db) {
                    try {
                        await db.collection('keys').doc(cleanKey).update({
                            usedBy: usedBy,
                            usedUsers: usedBy.length
                        });
                    } catch (e) {}
                }
            }
        } else {
            // Normal gateway key
            if (keyData.userId && keyData.userId !== userId) {
                return res.status(403).json({ valid: false, error: "This key belongs to another session." });
            }
        }

        return res.json({ valid: true, expiresAt: keyData.expiresAt || 0 });

    } catch (error) {
        console.error("Verify key error:", error);
        return res.status(500).json({ valid: false, error: "Server verify error: " + error.message });
    }
});

// ============================================================
// ADMIN ROUTES (Protected)
// ============================================================
// Whitelist of allowed admin emails - loaded from env for security.
// Set ADMIN_EMAILS env var in Render/local .env as comma-separated list.
// Falls back to a safe default list if not set.
const ADMIN_EMAILS_ENV = process.env.ADMIN_EMAILS || 'js7384333@gmail.com,js8495444@gmail.com,atifjanibrand@gmail.com';
const ALLOWED_ADMIN_EMAILS = ADMIN_EMAILS_ENV
    .split(',')
    .map(e => e.toLowerCase().trim())
    .filter(Boolean);

function extractBearer(req) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) return authHeader.substring(7);
    return null;
}

let adminAuth = null;
function getAdminAuth() {
    if (!adminAuth && getApps().length > 0) {
        try { adminAuth = getAuth(); } catch (e) { /* ignore */ }
    }
    return adminAuth;
}

function verifyAdmin(req, res, next) {
    const idToken = extractBearer(req);
    if (!idToken) {
        return res.status(401).json({ error: 'Unauthorized: Missing authentication token' });
    }

    // Legacy ADMIN_SECRET fallback (for backwards compatibility)
    if (idToken === ADMIN_SECRET) {
        return next();
    }

    // 🔒 Firebase Auth ID Token verification
    const a = getAdminAuth();
    if (!a) {
        return res.status(503).json({ error: 'Firebase Auth not available. Please contact admin.' });
    }

    a.verifyIdToken(idToken)
        .then((decoded) => {
            const email = (decoded.email || '').toLowerCase().trim();
            if (!ALLOWED_ADMIN_EMAILS.includes(email)) {
                return res.status(403).json({ error: `Forbidden: Email "${email}" is not authorized` });
            }
            req.adminEmail = email;
            req.adminUid = decoded.uid;
            next();
        })
        .catch((err) => {
            return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
        });
}

app.post('/api/admin/login', rateLimit('admin'), (req, res) => {
    const { secret } = req.body;
    if (secret === ADMIN_SECRET) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid secret key' });
    }
});

app.get('/api/admin/stats', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        // Fast in-memory stats calculation (0 Firestore reads)
        const allKeys = Array.from(memoryKeys.values());

        const now = Date.now();
        const totalKeys = allKeys.length;
        const activeKeys = allKeys.filter(k => !k.revoked && (!k.expiresAt || k.expiresAt === 0 || k.expiresAt > now)).length;
        const expiredKeys = allKeys.filter(k => !k.revoked && k.expiresAt > 0 && k.expiresAt <= now).length;
        
        const uniqueUsersSet = new Set();
        allKeys.forEach(k => {
            if (Array.isArray(k.usedBy) && k.usedBy.length > 0) {
                k.usedBy.forEach(u => uniqueUsersSet.add(u));
            } else if (k.userId) {
                uniqueUsersSet.add(k.userId);
            }
        });
        const uniqueUsers = uniqueUsersSet.size;

        const linkvertiseCount = allKeys.filter(k => k.provider === 'linkvertise' || k.linkvertiseHash).length;
        const lootlabsCount = allKeys.filter(k => k.provider === 'lootlabs' || k.lootlabsPostback || k.lootlabsLocal).length;
        const workinkCount = allKeys.filter(k => k.provider === 'workink' || k.workinkPostback).length;
        const adminCount = allKeys.filter(k => k.provider === 'admin' || k.adminCreated).length;

        // Online (real): users seen within the last window
        const onlineUserIds = getOnlineUserIds();
        const onlineCount = onlineUserIds.length;

        // Banned: keys whose IP is currently banned (plus revoked)
        let bannedCount = 0;
        allKeys.forEach(k => {
            const ban = k.ip ? memoryBans.get(normalizeIp(k.ip)) : null;
            const ipBanned = !!(ban && ban.active && (!ban.banUntil || ban.banUntil > now));
            if (k.revoked || ipBanned) bannedCount++;
        });

        const tierCounts = { basic: 0, plus: 0, vip: 0 };
        allKeys.forEach(k => { if (tierCounts[k.tier] !== undefined) tierCounts[k.tier]++; });

        res.json({
            totalKeys, activeKeys, expiredKeys, uniqueUsers,
            linkvertiseCount, lootlabsCount, workinkCount, adminCount,
            onlineCount, bannedCount, tierCounts
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/keys', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const search = (req.query.search || '').toLowerCase();
        const sort = (req.query.sort || 'newest').toLowerCase();
        // Fast in-memory key listing (0 Firestore reads)
        let keys = Array.from(memoryKeys.values());

        if (search) {
            keys = keys.filter(k => 
                (k.key && k.key.toLowerCase().includes(search)) || 
                (k.userId && k.userId.toLowerCase().includes(search)) ||
                (k.note && k.note.toLowerCase().includes(search)) ||
                (k.country && k.country.toLowerCase().includes(search)) ||
                (k.tier && k.tier.toLowerCase().includes(search)) ||
                (k.ip && k.ip.toLowerCase().includes(search))
            );
        }

        const now = Date.now();
        const enrichOne = (k) => {
            const provider = k.provider || (k.linkvertiseHash ? 'linkvertise' : (k.lootlabsPostback || k.lootlabsLocal ? 'lootlabs' : (k.workinkPostback ? 'workink' : (k.adminCreated ? 'admin' : 'unknown'))));
            const isLifetime = !k.expiresAt || k.expiresAt === 0;
            const expired = !isLifetime && k.expiresAt <= now;
            const online = isUserOnline(k.userId) || (Array.isArray(k.usedBy) && k.usedBy.some(u => isUserOnline(u)));
            const ipBan = k.ip ? memoryBans.get(normalizeIp(k.ip)) : null;
            const ipBanned = !!(ipBan && ipBan.active && (!ipBan.banUntil || ipBan.banUntil > now));
            return {
                key: k.key,
                provider: provider,
                userId: k.userId || '-',
                ip: k.ip || '-',
                country: k.country || '-',
                expiresAt: k.expiresAt || 0,
                revoked: k.revoked || false,
                expired: expired,
                online: online,
                banned: (k.revoked || false) || ipBanned,
                banUntil: ipBan ? (ipBan.banUntil || 0) : 0,
                createdAt: k.createdAt || 0,
                maxUsers: k.maxUsers || 1,
                usedUsers: Array.isArray(k.usedBy) ? k.usedBy.length : (k.usedUsers || 0),
                usedBy: k.usedBy || [],
                usedIps: k.usedIps || [],
                ipCheck: !!k.ipCheck,
                tier: k.tier || 'none',
                note: k.note || ''
            };
        };

        let enriched = keys.map(enrichOne);

        // Sorting / grouping. Most options group matching keys first, then newest.
        const newest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
        const isActive = (k) => !k.revoked && !k.expired && (k.expiresAt === 0 || k.expiresAt > now);
        switch (sort) {
            case 'expire':
                enriched.sort((a, b) => {
                    const ae = (a.expiresAt === 0) ? Infinity : a.expiresAt;
                    const be = (b.expiresAt === 0) ? Infinity : b.expiresAt;
                    return ae - be;
                });
                break;
            case 'active':
                enriched.sort((a, b) => (isActive(b) ? 1 : 0) - (isActive(a) ? 1 : 0) || newest(a, b));
                break;
            case 'online':
                enriched.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || newest(a, b));
                break;
            case 'ban':
                enriched.sort((a, b) => (b.banned ? 1 : 0) - (a.banned ? 1 : 0) || newest(a, b));
                break;
            case 'vip':
            case 'basic':
            case 'plus':
                enriched.sort((a, b) => ((b.tier === sort) ? 1 : 0) - ((a.tier === sort) ? 1 : 0) || newest(a, b));
                break;
            case 'admin':
            case 'lootlabs':
            case 'linkvertise':
            case 'workink':
            case 'advertise':
                enriched.sort((a, b) => ((b.provider === sort) ? 1 : 0) - ((a.provider === sort) ? 1 : 0) || newest(a, b));
                break;
            default:
                enriched.sort(newest);
        }

        res.json({ keys: enriched });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/create-key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const { prefix, name, duration, maxUsers, note, customKey, useCustomKey, ipCheck, tier } = req.body;
        const now = Date.now();
        const durationNum = parseInt(duration, 10);
        const expiresAt = (durationNum === 0 || isNaN(durationNum)) ? 0 : now + durationNum;

        // Custom key support (user typed / pre-filled a specific key)
        let keyString;
        if (useCustomKey && customKey && String(customKey).trim()) {
            keyString = String(customKey).trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
            if (keyString.length < 6 || keyString.length > 64) {
                return res.status(400).json({ error: 'Custom key must be 6-64 characters (A-Z, 0-9, dash).' });
            }
            if (memoryKeys.has(keyString)) {
                return res.status(409).json({ error: 'A key with this value already exists.' });
            }
            if (db) {
                try {
                    const existing = await db.collection('keys').doc(keyString).get();
                    if (existing.exists) return res.status(409).json({ error: 'A key with this value already exists.' });
                } catch (e) { /* ignore */ }
            }
        } else {
            const keyName = (name || prefix || '').toString().trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
            keyString = keyName + [1,2,3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
        }

        const ip = getClientIp(req);
        const country = await getCountry(ip);
        const cleanTier = ['basic', 'plus', 'vip'].includes(String(tier || '').toLowerCase()) ? String(tier).toLowerCase() : 'none';

        const newKey = {
            key: keyString,
            userId: `admin_${Date.now()}`,
            createdAt: now,
            expiresAt: expiresAt,
            revoked: false,
            adminCreated: true,
            provider: 'admin',
            maxUsers: parseInt(maxUsers, 10) || 1,
            usedBy: [],
            usedUsers: 0,
            usedIps: [],
            ipCheck: !!ipCheck,   // when true -> sharing counted per unique IP (same home/wifi allowed)
            tier: cleanTier,
            note: note || '',
            ip: ip,
            country: country
        };

        memoryKeys.set(keyString, newKey);
        if (db) {
            try {
                await db.collection('keys').doc(keyString).set(newKey);
            } catch (fsErr) {
                console.warn("Firestore create-key write failed, key retained in memory:", fsErr.message);
            }
        }
        res.json({ success: true, key: keyString, expiresAt, tier: cleanTier, ipCheck: !!ipCheck });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/revoke-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        let data = memoryKeys.get(key);

        if (!data && db) {
            const doc = await db.collection('keys').doc(key).get();
            if (doc.exists) data = doc.data();
        }

        if (!data) return res.status(404).json({ error: 'Key not found' });

        // Write to Firestore first
        if (db) {
            try {
                await db.collection('keys').doc(key).update({ revoked: true });
            } catch (fsErr) {
                return res.status(500).json({ error: 'Firestore revoke failed: ' + fsErr.message });
            }
        } else {
            return res.status(503).json({ error: 'Firestore unavailable' });
        }

        // Only update memory after Firestore success
        data.revoked = true;
        memoryKeys.set(key, data);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/delete-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();

        // Step 1: Delete from Firestore FIRST (persistent)
        // If this fails, we keep the key in memory so it doesn't resurrect
        if (db) {
            try {
                await db.collection('keys').doc(key).delete();
            } catch (fsErr) {
                console.error("Firestore delete failed for key", key, ":", fsErr.message);
                return res.status(500).json({
                    error: 'Firestore delete failed: ' + fsErr.message + '. Key was NOT deleted. Please retry.'
                });
            }
        } else {
            return res.status(503).json({
                error: 'Firestore unavailable. Cannot delete key permanently. Please check Firebase connection.'
            });
        }

        // Step 2: Only after Firestore success, remove from memory
        memoryKeys.delete(key);

        res.json({ success: true, key, source: 'firestore+memory' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// BAN: revoke a key AND ban its associated IP (with optional timer)
app.post('/api/admin/ban-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        const { durationMs, reason } = req.body || {};
        let data = memoryKeys.get(key);
        if (!data && db) {
            const doc = await db.collection('keys').doc(key).get();
            if (doc.exists) data = doc.data();
        }
        if (!data) return res.status(404).json({ error: 'Key not found' });

        // Revoke the key
        data.revoked = true;
        memoryKeys.set(key, data);
        if (db) {
            try { await db.collection('keys').doc(key).update({ revoked: true }); } catch (e) {}
        }

        // Ban the IP if available
        const banIp = data.ip && data.ip !== '-' ? data.ip : null;
        let ban = null;
        if (banIp) {
            ban = await saveBan(banIp, parseInt(durationMs, 10) || 0, reason || 'Key banned by admin', req.adminEmail);
        }
        res.json({ success: true, bannedIp: banIp, ban });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// BAN an arbitrary IP
app.post('/api/admin/ban-ip', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const { ip, durationMs, reason } = req.body || {};
        if (!ip || !normalizeIp(ip)) return res.status(400).json({ error: 'IP is required' });
        const ban = await saveBan(ip, parseInt(durationMs, 10) || 0, reason || 'Banned by admin', req.adminEmail);
        res.json({ success: true, ban });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/unban-ip', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const { ip } = req.body || {};
        if (!ip) return res.status(400).json({ error: 'IP is required' });
        await clearBan(ip);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/bans', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const now = Date.now();
        // Fast in-memory ban listing (0 Firestore reads)
        let bans = Array.from(memoryBans.values());
        bans = bans.filter(b => b.active && (!b.banUntil || b.banUntil > now));
        bans.sort((a, b) => (b.bannedAt || 0) - (a.bannedAt || 0));

        res.json({ bans });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/extend-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        let { hours, minutes, deltaMs } = req.body || {};
        hours = parseInt(hours, 10) || 0;
        minutes = parseInt(minutes, 10) || 0;

        let changeMs = (typeof deltaMs === 'number') ? deltaMs : (hours * 3600000 + minutes * 60000);
        if (!changeMs) return res.status(400).json({ error: 'No time change provided. Use hours/minutes (can be negative).' });

        let data = memoryKeys.get(key);
        if (!data && db) {
            const doc = await db.collection('keys').doc(key).get();
            if (doc.exists) data = doc.data();
        }
        if (!data) return res.status(404).json({ error: 'Key not found' });

        // Lifetime keys (expiresAt === 0) cannot be reduced; allow positive to convert to timed? Keep simple: skip.
        if (!data.expiresAt || data.expiresAt === 0) {
            if (changeMs <= 0) return res.status(400).json({ error: 'Cannot reduce a lifetime key.' });
            data.expiresAt = Date.now() + changeMs;
        } else {
            // If already expired, base is "now"; otherwise base is current expiry (so +/- applied to remaining time)
            const baseTime = (data.expiresAt > Date.now()) ? data.expiresAt : Date.now();
            data.expiresAt = baseTime + changeMs;
        }

        // Only un-revoke when time is added
        if (changeMs > 0) data.revoked = false;

        memoryKeys.set(key, data);
        if (db) {
            try {
                await db.collection('keys').doc(key).update({ expiresAt: data.expiresAt, revoked: data.revoked });
            } catch (fsErr) {
                console.warn("Firestore extend write failed:", fsErr.message);
            }
        }
        res.json({ success: true, expiresAt: data.expiresAt, changeMs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/purge-expired', verifyAdmin, async (req, res) => {
    try {
        const now = Date.now();
        const force = !!(req.body && req.body.force);
        // Default: remove keys expired for more than 3 days.
        // force=true (manual click): remove ALL currently expired keys immediately.
        const cutoff = force ? now : (now - 3 * 24 * 3600000);
        let deletedCount = 0;

        const toDelete = [];
        for (const [key, data] of memoryKeys.entries()) {
            if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                toDelete.push(key);
            }
        }

        if (db && toDelete.length > 0) {
            try {
                const chunkSize = 450;
                for (let i = 0; i < toDelete.length; i += chunkSize) {
                    const chunk = toDelete.slice(i, i + chunkSize);
                    const batch = db.batch();
                    chunk.forEach(k => batch.delete(db.collection('keys').doc(k)));
                    await batch.commit();
                }
                deletedCount = toDelete.length;
            } catch (e) {
                console.warn("Firestore purge error:", e.message);
            }
        }

        toDelete.forEach(k => memoryKeys.delete(k));
        if (!db) deletedCount = toDelete.length;

        res.json({ success: true, deleted: deletedCount, force });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// ANNOUNCEMENTS
// ============================================================
app.get('/api/admin/announcements', verifyAdmin, async (req, res) => {
    try {
        const list = await loadAnnouncementsFromFirestore(false);
        const announcements = [...list];
        announcements.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        res.json({ announcements });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/announcements', verifyAdmin, async (req, res) => {
    try {
        const { heading, content, startAt, endAt, theme } = req.body;
        if (!heading || !content || !startAt || !endAt) {
            return res.status(400).json({ error: 'Missing required announcement fields' });
        }
        const data = {
            heading,
            content,
            startAt: new Date(startAt).toISOString(),
            endAt: new Date(endAt).toISOString(),
            theme: theme || 'info',
            active: true,
            createdAt: new Date().toISOString(),
            createdBy: 'admin'
        };
        if (db) {
            try {
                const ref = await db.collection('announcements').add(data);
                const saved = { id: ref.id, ...data };
                memoryAnnouncements.set(ref.id, saved);
                return res.json({ success: true, id: ref.id, data });
            } catch (fsErr) {
                console.warn("Firestore announcement create failed:", fsErr.message);
            }
        }
        res.status(503).json({ error: 'Firestore unavailable - cannot persist announcements' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
        const { heading, content, startAt, endAt, theme } = req.body;
        const updates = {};
        if (heading) updates.heading = heading;
        if (content) updates.content = content;
        if (startAt) updates.startAt = new Date(startAt).toISOString();
        if (endAt) updates.endAt = new Date(endAt).toISOString();
        if (theme) updates.theme = theme;
        await db.collection('announcements').doc(req.params.id).update(updates);
        const existing = memoryAnnouncements.get(req.params.id) || {};
        memoryAnnouncements.set(req.params.id, { ...existing, ...updates });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
        await db.collection('announcements').doc(req.params.id).delete();
        memoryAnnouncements.delete(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/announcements/:id/toggle', verifyAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
        let current = true;
        const inMem = memoryAnnouncements.get(req.params.id);
        if (inMem) {
            current = inMem.active;
        } else {
            const doc = await db.collection('announcements').doc(req.params.id).get();
            if (!doc.exists) return res.status(404).json({ error: 'Announcement not found' });
            current = doc.data().active;
        }
        await db.collection('announcements').doc(req.params.id).update({ active: !current });
        if (inMem) inMem.active = !current;
        res.json({ success: true, active: !current });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Public endpoint for frontend to fetch active announcements (cached in memory)
app.get('/api/announcements/active', async (req, res) => {
    try {
        const all = await loadAnnouncementsFromFirestore(false);
        const nowIso = new Date().toISOString();
        const announcements = [];
        all.forEach(data => {
            if (data.active && data.startAt <= nowIso && data.endAt >= nowIso) {
                announcements.push(data);
            }
        });
        res.json({ announcements });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// SUPPORT: BUG REPORTS & FEATURE SUGGESTIONS
// ============================================================
function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

// Public: submit a bug report or feature suggestion (max 1 of each per user per day)
app.post('/api/support/submit', rateLimit('claim'), async (req, res) => {
    try {
        const { userId, type, message, email } = req.body || {};
        if (!userId || typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid userId.' });
        }
        const kind = (type === 'suggestion') ? 'suggestion' : 'bug';
        const text = String(message || '').trim();
        if (text.length < 5 || text.length > 2000) {
            return res.status(400).json({ success: false, error: 'Message must be between 5 and 2000 characters.' });
        }
        const emailClean = email ? String(email).trim().slice(0, 160) : '';

        if (!db) {
            return res.status(503).json({ success: false, error: 'Submissions are temporarily unavailable. Please try later.' });
        }

        const day = todayKey();
        const norm = text.toLowerCase().replace(/\s+/g, ' ');

        // Enforce 1 per type per user per day (Check in-memory first for 0 Firestore reads)
        let alreadySubmittedToday = false;
        let isDuplicateSuggestion = false;
        for (const reqDoc of memorySupportRequests.values()) {
            if (reqDoc.userId === userId && reqDoc.type === kind && reqDoc.dayKey === day) {
                alreadySubmittedToday = true;
                break;
            }
            if (kind === 'suggestion' && reqDoc.type === 'suggestion' && reqDoc.normalizedMessage === norm) {
                isDuplicateSuggestion = true;
            }
        }

        if (alreadySubmittedToday) {
            return res.status(429).json({ success: false, error: `You can send only one ${kind === 'bug' ? 'bug report' : 'feature suggestion'} per day.` });
        }

        // Only query Firestore if memory cache is completely empty
        if (memorySupportRequests.size === 0) {
            const existingSnap = await db.collection('supportRequests')
                .where('userId', '==', userId)
                .where('type', '==', kind)
                .where('dayKey', '==', day)
                .limit(1)
                .get();
            if (!existingSnap.empty) {
                return res.status(429).json({ success: false, error: `You can send only one ${kind === 'bug' ? 'bug report' : 'feature suggestion'} per day.` });
            }
        }

        // Uniqueness check for suggestions
        let unique = !isDuplicateSuggestion;
        if (kind === 'suggestion' && unique && memorySupportRequests.size === 0) {
            const dupSnap = await db.collection('supportRequests')
                .where('type', '==', 'suggestion')
                .where('normalizedMessage', '==', norm)
                .limit(1)
                .get();
            unique = dupSnap.empty;
        }

        const doc = {
            userId,
            type: kind,
            message: text,
            normalizedMessage: text.toLowerCase().replace(/\s+/g, ' '),
            email: emailClean,
            status: 'pending',
            unique,
            keyIssued: false,
            issuedKey: null,
            createdAt: Date.now(),
            createdAtIso: new Date().toISOString(),
            dayKey: day
        };
        const ref = await db.collection('supportRequests').add(doc);
        memorySupportRequests.set(ref.id, { id: ref.id, ...doc });

        let note = '';
        if (kind === 'suggestion') {
            note = unique
                ? 'Thanks! Your suggestion is unique. If approved, you will get a FREE 24-hour key.'
                : 'Thanks! This idea was already suggested before, so it may not qualify for the free key.';
            note += emailClean
                ? ' We will contact you at ' + emailClean + ' if approved.'
                : ' Add your email next time so we can send you the reward key if approved.';
        } else {
            note = 'Thanks for the bug report! Our team will review it soon.';
            if (emailClean) note += ' We will contact you at ' + emailClean + ' if needed.';
        }

        res.json({ success: true, id: ref.id, unique, message: note });
    } catch (e) {
        console.error('Support submit error:', e.message);
        res.status(500).json({ success: false, error: 'Server error. Please try again.' });
    }
});

// Public: view my own submissions (so user can see if a key was issued)
app.get('/api/support/mine', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId || !/^[a-zA-Z0-9_-]+$/.test(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
        
        // Fast in-memory check
        const all = await loadSupportFromFirestore(false);
        const requests = all.filter(r => r.userId === userId);
        requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ requests: requests.slice(0, 50) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: list all support requests
app.get('/api/admin/support', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const all = await loadSupportFromFirestore(false);
        const requests = [...all];
        requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ requests });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: approve / reject a request (approve issues a FREE 24h key to that user)
app.post('/api/admin/support/:id/action', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
        const { action } = req.body || {};
        const ref = db.collection('supportRequests').doc(req.params.id);
        const inMem = memorySupportRequests.get(req.params.id);
        let data = inMem;
        if (!data) {
            const doc = await ref.get();
            if (!doc.exists) return res.status(404).json({ error: 'Request not found' });
            data = doc.data();
        }

        if (action === 'reject') {
            await ref.update({ status: 'rejected', resolvedAt: Date.now() });
            if (inMem) {
                inMem.status = 'rejected';
                inMem.resolvedAt = Date.now();
            }
            return res.json({ success: true, status: 'rejected' });
        }

        if (action === 'approve') {
            // Issue a free 24h key for this user
            const keyString = [1,2,3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
            const now = Date.now();
            const expiresAt = now + (24 * 60 * 60 * 1000);
            const newKey = {
                key: keyString,
                userId: data.userId,
                createdAt: now,
                expiresAt,
                revoked: false,
                adminCreated: true,
                provider: 'admin',
                maxUsers: 1,
                usedBy: [],
                usedUsers: 0,
                usedIps: [],
                ipCheck: false,
                tier: 'none',
                note: `Reward for approved ${data.type} (${data.userId})`,
                ip: '-',
                country: '-'
            };
            memoryKeys.set(keyString, newKey);
            try { await db.collection('keys').doc(keyString).set(newKey); } catch (e) {}
            await ref.update({ status: 'approved', keyIssued: true, issuedKey: keyString, issuedExpiresAt: expiresAt, resolvedAt: now });
            if (inMem) {
                inMem.status = 'approved';
                inMem.keyIssued = true;
                inMem.issuedKey = keyString;
                inMem.issuedExpiresAt = expiresAt;
                inMem.resolvedAt = now;
            }
            return res.json({ success: true, status: 'approved', key: keyString, expiresAt });
        }

        return res.status(400).json({ error: 'Invalid action. Use approve or reject.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Background Auto-Purge job: runs every 6 hours to clean expired keys > 3 days (0 Firestore reads)
setInterval(async () => {
    try {
        const now = Date.now();
        const threeDays = 3 * 24 * 3600000;
        const cutoff = now - threeDays;

        const toDelete = [];
        for (const [key, data] of memoryKeys.entries()) {
            if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                toDelete.push(key);
            }
        }

        if (db && toDelete.length > 0) {
            const chunkSize = 450;
            for (let i = 0; i < toDelete.length; i += chunkSize) {
                const chunk = toDelete.slice(i, i + chunkSize);
                const batch = db.batch();
                chunk.forEach(k => batch.delete(db.collection('keys').doc(k)));
                await batch.commit();
            }
            console.log(`🧹 [Auto-Purge Job] Removed ${toDelete.length} keys expired more than 3 days ago.`);
        }

        toDelete.forEach(k => memoryKeys.delete(k));
    } catch (err) {
        console.warn("[Auto-Purge Job Error]:", err.message);
    }
}, 6 * 60 * 60 * 1000);

// Start Express API server
app.listen(PORT, () => {
    console.log(`🚀 ApiKey system running successfully on port ${PORT}`);
});
