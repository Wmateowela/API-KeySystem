require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
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
const memoryInvalidKeys = new Map();     // key -> timestamp (negative cache to prevent 404 DB spam)
const onlineUsers = new Map();          // userId -> lastSeen (ms)

let announcementsLastLoaded = 0;
const ANNOUNCEMENTS_CACHE_TTL = 10 * 60 * 1000; // 10 mins
let keysLastLoaded = 0;
let bansLastLoaded = 0;
let usedHashesLastLoaded = 0;
const STARTUP_CACHE_TTL = 15 * 60 * 1000; // 15 min guard: skip full reload if recently loaded

const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://buy-r-bl0x-default-rtdb.asia-southeast1.firebasedatabase.app/';

// Provider key-duration & status config (admin-managed).
const DEFAULT_PROVIDER_DURATIONS = {
    linkvertise: 6,
    lootlabs: 2,
    workink: 12
};
const DEFAULT_PROVIDER_SETTINGS = {
    linkvertise: {
        duration: 6,
        locked: false,
        status: 'working', // 'working' | 'under_review' | 'not_working'
        tag: 'Instant'
    },
    lootlabs: {
        duration: 2,
        locked: false,
        status: 'working',
        tag: 'Fast'
    },
    workink: {
        duration: 12,
        locked: false,
        status: 'working',
        tag: 'Best Value'
    }
};
const DEFAULT_STORE_DOMAINS = {
    primaryStoreUrl: 'https://buyrobux-store.pages.dev',
    keyGatewayUrl: 'https://pathan-keys.pages.dev',
    allowedDomains: ['https://buyrobux-store.pages.dev']
};
const memorySettings = {
    providerDurations: { ...DEFAULT_PROVIDER_DURATIONS },
    providerSettings: JSON.parse(JSON.stringify(DEFAULT_PROVIDER_SETTINGS)),
    storeConfig: null,
    storeConfigUpdatedAt: Date.now(),
    storeConfigStorageSource: 'rtdb',
    storeDomains: { ...DEFAULT_STORE_DOMAINS }
};
const PROVIDER_KEYS = ['linkvertise', 'lootlabs', 'workink'];
const MIN_PROVIDER_HOURS = 1;
const MAX_PROVIDER_HOURS = 24 * 365; // 1 year cap

function getProviderDurationMs(provider) {
    const hours = (memorySettings.providerSettings[provider] && memorySettings.providerSettings[provider].duration) || memorySettings.providerDurations[provider];
    const safeHours = (typeof hours === 'number' && hours > 0) ? hours : (DEFAULT_PROVIDER_DURATIONS[provider] || 12);
    return safeHours * 60 * 60 * 1000;
}

function getProviderDurationHours(provider) {
    const hours = (memorySettings.providerSettings[provider] && memorySettings.providerSettings[provider].duration) || memorySettings.providerDurations[provider];
    return (typeof hours === 'number' && hours > 0) ? hours : (DEFAULT_PROVIDER_DURATIONS[provider] || 12);
}

function ipToRtdbKey(ip) {
    return String(ip || '').replace(/\./g, '_').replace(/:/g, '-');
}

async function loadSettingsFromStorage() {
    // 1. Load provider durations & settings
    if (rtdb) {
        try {
            const [durSnap, setSnap] = await Promise.all([
                rtdb.ref('settings/providerDurations').once('value'),
                rtdb.ref('settings/providerSettings').once('value')
            ]);
            if (durSnap.exists()) {
                const data = durSnap.val() || {};
                PROVIDER_KEYS.forEach(p => {
                    const h = parseInt(data[p], 10);
                    if (!isNaN(h) && h > 0) {
                        memorySettings.providerDurations[p] = h;
                        if (memorySettings.providerSettings[p]) memorySettings.providerSettings[p].duration = h;
                    }
                });
            }
            if (setSnap.exists()) {
                const setVal = setSnap.val() || {};
                PROVIDER_KEYS.forEach(p => {
                    if (setVal[p] && typeof setVal[p] === 'object') {
                        memorySettings.providerSettings[p] = {
                            ...DEFAULT_PROVIDER_SETTINGS[p],
                            ...setVal[p]
                        };
                        const h = parseInt(setVal[p].duration, 10);
                        if (!isNaN(h) && h > 0) {
                            memorySettings.providerDurations[p] = h;
                        }
                    }
                });
                console.log('✅ Loaded provider settings from RTDB:', memorySettings.providerSettings);
            } else {
                console.log('✅ Loaded provider durations from RTDB:', memorySettings.providerDurations);
            }
        } catch (e) {
            console.warn('RTDB provider settings warning:', e.message);
        }
    }

    // 2. Load active storage source (RTDB vs Firestore) and store catalog config
    try {
        let activeSource = 'rtdb';
        if (rtdb) {
            try {
                const snapSource = await rtdb.ref('settings/activeStorageSource').once('value');
                if (snapSource.exists() && snapSource.val() && snapSource.val().source) {
                    activeSource = snapSource.val().source;
                }
            } catch (e) {}
        }
        if (db && activeSource === 'rtdb') {
            try {
                const fsDoc = await db.collection('settings').doc('activeStorageSource').get();
                if (fsDoc.exists && fsDoc.data() && fsDoc.data().source) {
                    activeSource = fsDoc.data().source;
                }
            } catch (e) {}
        }
        memorySettings.storeConfigStorageSource = activeSource;

        // 3. Load catalog from active source
        if (activeSource === 'firestore' && db) {
            const fsConfig = await db.collection('settings').doc('storeConfig').get();
            if (fsConfig.exists && fsConfig.data()) {
                memorySettings.storeConfig = fsConfig.data();
                memorySettings.storeConfigUpdatedAt = memorySettings.storeConfig.updatedAt || Date.now();
                console.log('✅ Loaded Store Catalog Config from Firestore');
            }
        } else if (rtdb) {
            const snapConfig = await rtdb.ref('settings/storeConfig').once('value');
            if (snapConfig.exists() && snapConfig.val()) {
                memorySettings.storeConfig = snapConfig.val();
                memorySettings.storeConfigUpdatedAt = memorySettings.storeConfig.updatedAt || Date.now();
                console.log('✅ Loaded Store Catalog Config from RTDB');
            }
        }
        // 4. Load store domains
        if (rtdb) {
            try {
                const snapDomains = await rtdb.ref('settings/storeDomains').once('value');
                if (snapDomains.exists() && snapDomains.val()) {
                    memorySettings.storeDomains = snapDomains.val();
                    console.log('✅ Loaded Store Domains from RTDB');
                }
            } catch (e) {}
        }
    } catch (e) {
        console.warn('Store config loading error:', e.message);
    }
}

// Initialize Firebase Admin (Firestore + Realtime Database)
let db = null;
let rtdb = null;
let firestoreAvailable = false;
let rtdbAvailable = false;

// ============================================================
// STORAGE HELPERS (RAM + RTDB + FIRESTORE DUAL-STORE)
// ============================================================
async function saveKeyToStorage(key, keyData) {
    const cleanKey = (key || '').toUpperCase();
    if (!cleanKey) return;
    
    // 1. RAM Cache (Instant 0ms access)
    memoryKeys.set(cleanKey, keyData);

    // 2. Realtime Database (Primary persistent store, unlimited reads)
    if (rtdb) {
        try {
            await rtdb.ref(`keys/${cleanKey}`).set(keyData);
        } catch (rtdbErr) {
            console.warn(`[RTDB] Failed to save key ${cleanKey}:`, rtdbErr.message);
        }
    }

}

async function updateKeyInStorage(key, updates) {
    const cleanKey = (key || '').toUpperCase();
    if (!cleanKey) return;

    // 1. RAM Cache
    const existing = memoryKeys.get(cleanKey) || {};
    const merged = { ...existing, ...updates };
    memoryKeys.set(cleanKey, merged);

    // 2. RTDB
    if (rtdb) {
        try {
            await rtdb.ref(`keys/${cleanKey}`).update(updates);
        } catch (rtdbErr) {
            console.warn(`[RTDB] Failed to update key ${cleanKey}:`, rtdbErr.message);
        }
    }

}

async function deleteKeyFromStorage(key) {
    const cleanKey = (key || '').toUpperCase();
    if (!cleanKey) return;

    // 1. RAM Cache
    memoryKeys.delete(cleanKey);

    // 2. RTDB
    if (rtdb) {
        try {
            await rtdb.ref(`keys/${cleanKey}`).remove();
        } catch (rtdbErr) {
            console.warn(`[RTDB] Failed to delete key ${cleanKey}:`, rtdbErr.message);
        }
    }

}

async function getKeyFromStorage(key) {
    const cleanKey = (key || '').toUpperCase();
    if (!cleanKey) return null;
    let data = memoryKeys.get(cleanKey);
    if (data) return data;
    if (rtdb) {
        try {
            const snap = await rtdb.ref(`keys/${cleanKey}`).once('value');
            if (snap.exists()) {
                data = snap.val();
                if (data) {
                    memoryKeys.set(cleanKey, data);
                    return data;
                }
            }
        } catch (e) {}
    }
    return null;
}

// Helpers to pre-warm cache on startup / wake from sleep
async function loadKeysFromStorage(force = false) {
    const now = Date.now();
    if (!force && keysLastLoaded && (now - keysLastLoaded) < STARTUP_CACHE_TTL && memoryKeys.size > 0) return;

    let loadedRtdb = 0;
    let loadedFirestore = 0;

    // 1. Load from Realtime Database
    if (rtdb) {
        try {
            const snap = await rtdb.ref('keys').once('value');
            const val = snap.val();
            if (val && typeof val === 'object') {
                Object.keys(val).forEach(k => {
                    const data = val[k];
                    if (data && (data.key || k)) {
                        const keyName = (data.key || k).toUpperCase();
                        memoryKeys.set(keyName, { key: keyName, ...data });
                        loadedRtdb++;
                    }
                });
            }
        } catch (e) {
            console.warn("Could not load keys from RTDB:", e.message);
        }
    }

    // 2. Load from Firestore collection 'keys'
    if (db) {
        try {
            const snap = await db.collection('keys').get();
            snap.forEach(docSnap => {
                const data = docSnap.data();
                const keyName = (data && data.key ? data.key : docSnap.id).toUpperCase();
                if (!memoryKeys.has(keyName)) {
                    memoryKeys.set(keyName, { key: keyName, ...data });
                    loadedFirestore++;
                }
            });
        } catch (e) {
            console.warn("Could not load keys from Firestore:", e.message);
        }
    }

    keysLastLoaded = Date.now();
    console.log(`✅ Loaded keys into memory: ${loadedRtdb} from RTDB, ${loadedFirestore} from Firestore. Total in memory: ${memoryKeys.size}`);
}

function setupRTDBListeners() {
    if (!rtdb) return;
    try {
        rtdb.ref('keys').on('child_added', (snap) => {
            const data = snap.val();
            if (data && data.key) {
                memoryKeys.set(data.key.toUpperCase(), data);
            }
        });
        rtdb.ref('keys').on('child_changed', (snap) => {
            const data = snap.val();
            if (data && data.key) {
                memoryKeys.set(data.key.toUpperCase(), data);
            }
        });
        rtdb.ref('keys').on('child_removed', (snap) => {
            const data = snap.val();
            const keyName = (data && data.key) ? data.key.toUpperCase() : (snap.key || '').toUpperCase();
            if (keyName) memoryKeys.delete(keyName);
        });
        console.log("✅ Realtime Database (RTDB) live sync listener active.");
    } catch (e) {
        console.warn("RTDB listener setup warning:", e.message);
    }
}

async function loadBansFromFirestore(force = false) {
    const now = Date.now();
    if (!force && bansLastLoaded && (now - bansLastLoaded) < STARTUP_CACHE_TTL && memoryBans.size > 0) return;

    if (rtdb) {
        try {
            const snap = await rtdb.ref('bans').once('value');
            if (snap.exists()) {
                const dataObj = snap.val() || {};
                let loaded = 0;
                Object.values(dataObj).forEach(data => {
                    if (data && data.active && (!data.banUntil || data.banUntil > now)) {
                        memoryBans.set(data.ip, data);
                        loaded++;
                    }
                });
                bansLastLoaded = Date.now();
                console.log(`✅ Loaded ${loaded} active bans from RTDB into memory cache.`);
                return;
            }
        } catch (e) {
            console.warn("RTDB load bans warning:", e.message);
        }
    }
}

async function loadAnnouncementsFromFirestore(force = false) {
    const now = Date.now();
    if (!force && (now - announcementsLastLoaded) < ANNOUNCEMENTS_CACHE_TTL && memoryAnnouncements.size > 0) {
        return Array.from(memoryAnnouncements.values());
    }

    if (rtdb) {
        try {
            const snap = await rtdb.ref('announcements').once('value');
            if (snap.exists()) {
                memoryAnnouncements.clear();
                const dataObj = snap.val() || {};
                Object.keys(dataObj).forEach(id => {
                    const item = dataObj[id];
                    if (item) memoryAnnouncements.set(id, { id, ...item });
                });
                announcementsLastLoaded = now;
                console.log(`✅ Loaded ${memoryAnnouncements.size} announcements from RTDB into memory cache.`);
                return Array.from(memoryAnnouncements.values());
            }
        } catch (e) {
            console.warn("RTDB load announcements warning:", e.message);
        }
    }
    return Array.from(memoryAnnouncements.values());
}

async function loadUsedHashesFromFirestore(force = false) {
    const now = Date.now();
    if (!force && usedHashesLastLoaded && (now - usedHashesLastLoaded) < STARTUP_CACHE_TTL && memoryUsedHashes.size > 0) return;

    if (rtdb) {
        try {
            const snap = await rtdb.ref('usedHashes').once('value');
            if (snap.exists()) {
                const dataObj = snap.val() || {};
                let loaded = 0;
                Object.keys(dataObj).forEach(h => {
                    memoryUsedHashes.set(h, dataObj[h] || { time: Date.now() });
                    loaded++;
                });
                usedHashesLastLoaded = Date.now();
                console.log(`✅ Loaded ${loaded} used hashes from RTDB into memory cache.`);
                return;
            }
        } catch (e) {
            console.warn("RTDB load used hashes warning:", e.message);
        }
    }
}

try {
    let credential = null;
    
    // 1. Check FIREBASE_SERVICE_ACCOUNT environment variable (Recommended for Render / Cloud Hosting)
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const parsed = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string' 
                ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
                : process.env.FIREBASE_SERVICE_ACCOUNT;
            if (parsed.private_key) {
                parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
            }
            credential = cert(parsed);
            console.log("✅ Using FIREBASE_SERVICE_ACCOUNT from env.");
        } catch (e) {
            console.warn("Could not parse FIREBASE_SERVICE_ACCOUNT env:", e.message);
        }
    }

    // 2. Check individual FIREBASE_PRIVATE_KEY and FIREBASE_CLIENT_EMAIL env variables
    if (!credential && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        try {
            credential = cert({
                projectId: process.env.FIREBASE_PROJECT_ID || 'buy-r-bl0x',
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            });
            console.log("✅ Using FIREBASE_PRIVATE_KEY & FIREBASE_CLIENT_EMAIL env variables.");
        } catch (e) {
            console.warn("Could not create credential from individual env variables:", e.message);
        }
    }
    
    // 3. Check local serviceAccountKey.json file (Local development)
    if (!credential) {
        const configuredKeyPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH;
        const keyPath = configuredKeyPath
            ? (path.isAbsolute(configuredKeyPath) ? configuredKeyPath : path.resolve(__dirname, configuredKeyPath))
            : path.join(__dirname, 'serviceAccountKey.json');
        if (fs.existsSync(keyPath)) {
            try {
                const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
                if (Object.keys(serviceAccount).length > 0) {
                    if (serviceAccount.private_key) {
                        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
                    }
                    credential = cert(serviceAccount);
                    console.log("✅ Using local serviceAccountKey.json file.");
                }
            } catch(e) {
                console.warn("Ignored invalid serviceAccountKey.json:", e.message);
            }
        }
    }

    if (credential) {
        if (getApps().length === 0) {
            initializeApp({ 
                credential,
                databaseURL: FIREBASE_DATABASE_URL
            });
        }
        db = getFirestore();
        rtdb = getDatabase();
        rtdbAvailable = true;
        console.log("✅ Firebase Admin (Firestore + Realtime Database) initialized.");

        // Start loading data
        loadKeysFromStorage();
        setupRTDBListeners();
        loadSettingsFromStorage();
        loadBansFromFirestore();
        loadAnnouncementsFromFirestore(true);
        loadUsedHashesFromFirestore();
    } else {
        console.warn("❌ CREDENTIAL IS NULL. Please set FIREBASE_SERVICE_ACCOUNT env var or add serviceAccountKey.json.");
        console.log("⚡ Running with internal key management engine.");
    }
} catch (error) {
    console.warn("ℹ️ Running in resilient mode with internal key management:", error.message);
    console.warn("Detailed error stack:", error.stack);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Default Tokens
const LINKVERTISE_TOKEN = process.env.LINKVERTISE_TOKEN || '05bea4d469e02f8573931ff654597345edb6092d8c418ffc588c91de1678325a';
const LINKVERTISE_TARGET_LINK = process.env.LINKVERTISE_TARGET_LINK || 'https://direct-link.net/1276098/1A4zh2pEaHCB';
const LINKVERTISE_EXTEND_LINK = process.env.LINKVERTISE_EXTEND_LINK || 'https://link-target.net/1276098/0mXZLsuM8nZp';

// LootLabs Configuration
const LOOTLABS_API_TOKEN = process.env.LOOTLABS_API_TOKEN || '162b3c3519ec02bfbd0fc20ff5d6cd1fb10954357e0be1eeee7f00929c2d17e9';
const LOOTLABS_TARGET_LINK = process.env.LOOTLABS_TARGET_LINK || 'https://pathan-keys.pages.dev/';
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
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://robox-6nc.pages.dev';

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

    // 2. RTDB
    if (rtdb) {
        try {
            const snap = await rtdb.ref(`bans/${ipToRtdbKey(ip)}`).once('value');
            if (snap.exists()) {
                const ban = snap.val();
                memoryBans.set(ip, ban);
                return checkExpiry(ban);
            }
        } catch (e) {}
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
    if (rtdb) {
        try {
            await rtdb.ref(`bans/${ipToRtdbKey(cleanIp)}`).set(ban);
        } catch (e) {
            console.warn("RTDB ban save failed:", e.message);
        }
    }
    return ban;
}

async function clearBan(ip) {
    const cleanIp = normalizeIp(ip);
    memoryBans.delete(cleanIp);
    if (rtdb) {
        try {
            await rtdb.ref(`bans/${ipToRtdbKey(cleanIp)}`).remove();
        } catch (e) {}
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
    '/api/extend-key',
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

// Return target linkvertise extend key url
app.get('/api/get-extend-link', (req, res) => {
    res.json({ url: LINKVERTISE_EXTEND_LINK });
});

// Return target lootlabs url for frontend to navigate to
app.get('/api/get-lootlabs-link', (req, res) => {
    res.json({ url: LOOTLABS_TARGET_LINK });
});

// Return target workink url for frontend to navigate to
app.get('/api/get-workink-link', (req, res) => {
    res.json({ url: WORKINK_TARGET_LINK });
});

// Public: provider key durations (hours) & status for the key page cards
app.get('/api/provider-config', (req, res) => {
    res.json({
        success: true,
        durations: {
            linkvertise: getProviderDurationHours('linkvertise'),
            lootlabs: getProviderDurationHours('lootlabs'),
            workink: getProviderDurationHours('workink')
        },
        providers: memorySettings.providerSettings
    });
});

// Admin: get provider durations & full config
app.get('/api/admin/provider-config', verifyAdmin, rateLimit('admin'), (req, res) => {
    res.json({
        success: true,
        durations: {
            linkvertise: getProviderDurationHours('linkvertise'),
            lootlabs: getProviderDurationHours('lootlabs'),
            workink: getProviderDurationHours('workink')
        },
        providers: memorySettings.providerSettings
    });
});

// Admin: update provider durations & status (hours, locked, status, tag)
app.post('/api/admin/provider-config', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const body = req.body || {};
        let changed = false;

        // If 'providers' object was sent
        if (body.providers && typeof body.providers === 'object') {
            for (const p of PROVIDER_KEYS) {
                const pData = body.providers[p];
                if (!pData || typeof pData !== 'object') continue;
                
                if (pData.duration !== undefined) {
                    const h = parseInt(pData.duration, 10);
                    if (!isNaN(h) && h >= MIN_PROVIDER_HOURS && h <= MAX_PROVIDER_HOURS) {
                        memorySettings.providerDurations[p] = h;
                        memorySettings.providerSettings[p].duration = h;
                        changed = true;
                    }
                }
                if (pData.locked !== undefined) {
                    memorySettings.providerSettings[p].locked = !!pData.locked;
                    changed = true;
                }
                if (pData.status !== undefined) {
                    const st = String(pData.status).toLowerCase().trim();
                    if (['working', 'under_review', 'not_working'].includes(st)) {
                        memorySettings.providerSettings[p].status = st;
                        changed = true;
                    }
                }
                if (pData.tag !== undefined) {
                    memorySettings.providerSettings[p].tag = String(pData.tag).slice(0, 30);
                    changed = true;
                }
            }
        }

        // Direct duration keys fallback (e.g. { linkvertise: 6, lootlabs: 2 })
        for (const p of PROVIDER_KEYS) {
            if (body[p] === undefined) continue;
            const h = parseInt(body[p], 10);
            if (!isNaN(h) && h >= MIN_PROVIDER_HOURS && h <= MAX_PROVIDER_HOURS) {
                memorySettings.providerDurations[p] = h;
                memorySettings.providerSettings[p].duration = h;
                changed = true;
            }
        }

        if (!changed) {
            return res.status(400).json({ success: false, error: 'No valid provider settings provided.' });
        }

        if (rtdb) {
            try {
                await Promise.all([
                    rtdb.ref('settings/providerDurations').set(memorySettings.providerDurations),
                    rtdb.ref('settings/providerSettings').set(memorySettings.providerSettings)
                ]);
            } catch (e) {
                console.warn('Could not persist provider settings to RTDB:', e.message);
            }
        }

        res.json({
            success: true,
            durations: { ...memorySettings.providerDurations },
            providers: memorySettings.providerSettings
        });
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
    const pendingData = {
        userId,
        time: Date.now(),
        redeemed: false,
        ip: userIp,
        country: userCountry
    };
    memoryLootlabsPending.set(postbackValue, pendingData);
    if (rtdb) {
        rtdb.ref(`lootlabsPending/${postbackValue}`).set(pendingData).catch(() => {});
    }

    // Destination URL LootLabs will redirect user to after completion
    // Supports direct local redirects or forwarding via local_return parameter
    const requestedUrl = (req.body && typeof req.body.destinationUrl === 'string' && req.body.destinationUrl.trim()) ? req.body.destinationUrl.trim() : null;
    const localReturnUrl = (req.body && typeof req.body.localReturnUrl === 'string' && req.body.localReturnUrl.trim()) ? req.body.localReturnUrl.trim() : null;

    let targetBase = requestedUrl || `${FRONTEND_BASE_URL}/key.html`;
    if (localReturnUrl && !targetBase.includes('localhost') && !targetBase.includes('127.0.0.1')) {
        targetBase += (targetBase.includes('?') ? '&' : '?') + `local_return=${encodeURIComponent(localReturnUrl)}`;
    }
    const destinationUrl = `${targetBase}#lootlabs_done=${postbackValue}`;

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
    if (!postbackValue || typeof postbackValue !== 'string' || postbackValue.trim().length === 0) {
        return { status: 400, message: "Invalid postbackValue" };
    }

    const cleanPostback = postbackValue.trim();
    let pending = memoryLootlabsPending.get(cleanPostback);
    let matchedDocId = cleanPostback;

    if (!pending && rtdb) {
        try {
            const snap = await rtdb.ref(`lootlabsPending/${cleanPostback}`).once('value');
            if (snap.exists()) {
                pending = snap.val();
                matchedDocId = cleanPostback;
            }
        } catch (e) {}
    }

    if (!pending) {
        console.warn(`[LootLabs Postback] Unknown postbackValue received: "${cleanPostback}"`);
        return { status: 404, message: "Unknown postbackValue" };
    }
    if (pending.redeemed && pending.key) {
        return { status: 200, message: "ALREADY_REDEEMED", key: pending.key, expiresAt: pending.expiresAt, userId: pending.userId };
    }

    const userId = pending.userId;
    if (!userId) {
        return { status: 400, message: "Missing userId in pending entry" };
    }

    // Mark redeemed FIRST (prevents any double issue)
    pending.redeemed = true;
    memoryLootlabsPending.set(matchedDocId, pending);

    const issued = await issueLootlabsKey(userId, matchedDocId, req, pending);
    pending.key = issued.key;
    pending.expiresAt = issued.expiresAt;
    memoryLootlabsPending.set(matchedDocId, pending);

    if (rtdb) {
        rtdb.ref(`lootlabsPending/${matchedDocId}`).update({ 
            redeemed: true, 
            key: issued.key, 
            expiresAt: issued.expiresAt, 
            redeemedAt: Date.now() 
        }).catch(() => {});
    }

    console.log(`[LootLabs Postback Verified] Key ${issued.key} issued for user ${userId} (postback: ${matchedDocId})`);
    return { status: 200, message: "OK", key: issued.key, expiresAt: issued.expiresAt, userId };
}

// LootLabs Postback - LootLabs server sends GET request here when user completes the locker.
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

    // Accept postbackValue parameter
    const postbackValue = req.query.postbackValue || 
                          req.query.postback || 
                          req.query.pbv || 
                          req.query.unique_id || 
                          req.query.uniqueId || 
                          req.query.UNIQUE_ID;
    const { secret } = req.query;

    if (!postbackValue) {
        console.warn(`[LootLabs Postback] No postbackValue in query. Got: ${JSON.stringify(req.query)}`);
        return res.status(400).send("Missing postbackValue");
    }

    // Strict mode: verify secret strictly if configured
    if (LOOTLABS_POSTBACK_SECRET) {
        if (!secret || secret !== LOOTLABS_POSTBACK_SECRET) {
            console.warn(`[LootLabs Postback] Rejected: Invalid or missing secret.`);
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
        providerUsage: { lootlabs: now },
        ip: ip,
        country: country,
        maxUsers: 1,
        usedUsers: 1,
        usedBy: [userId],
        note: 'Generated via LootLabs',
        lootlabsPostback: postbackValue || null
    };
    // Save to RAM + RTDB + Firestore
    await saveKeyToStorage(keyString, newKeyDoc);

    const claimDoc = {
        key: keyString,
        expiresAt: expiresAt,
        issuedAt: now
    };
    if (rtdb) {
        rtdb.ref(`lootlabsClaimed/${userId}`).set(claimDoc).catch(() => {});
    }
    memoryLootlabsPending.set(`__claimed_${userId}`, { key: keyString, expiresAt, time: now });
    console.log(`[Key Issued] ${keyString} for ${userId} via LootLabs`);
    return { key: keyString, expiresAt };
}

// Frontend polls / claims a LootLabs-issued key after being redirected back
app.post('/api/claim-lootlabs-key', rateLimit('lootlabsPost'), async (req, res) => {
    const { userId, postbackValue } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }
    if (!postbackValue || typeof postbackValue !== 'string' || postbackValue.trim().length === 0) {
        return res.status(400).json({ success: false, error: "Missing or invalid postbackValue." });
    }

    const cleanPostback = postbackValue.trim();

    // 🔒 Input validation
    if (typeof userId !== 'string' || userId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
        return res.status(400).json({ success: false, error: "Invalid userId format." });
    }
    if (cleanPostback.length > 128) {
        return res.status(400).json({ success: false, error: "Invalid postbackValue." });
    }

    try {
        // 1. Check in-memory pending entry for THIS specific postbackValue
        let pending = memoryLootlabsPending.get(cleanPostback);

        // 2. Check RTDB pending entry for THIS specific postbackValue
        if (!pending && rtdb) {
            try {
                const snap = await rtdb.ref(`lootlabsPending/${cleanPostback}`).once('value');
                if (snap.exists()) {
                    pending = snap.val();
                }
            } catch (e) {}
        }

        // 3. Scan memory keys for exact matching postbackValue
        if (!pending) {
            for (const [k, v] of memoryKeys.entries()) {
                if (v.userId === userId && v.lootlabsPostback === cleanPostback && v.expiresAt > Date.now()) {
                    return res.json({ success: true, key: k, expiresAt: v.expiresAt });
                }
            }
        }

        if (pending) {
            if (pending.userId && pending.userId !== userId) {
                return res.status(403).json({ success: false, error: "Session does not match current user." });
            }
            if (pending.redeemed && pending.key && pending.expiresAt > Date.now()) {
                return res.json({ success: true, key: pending.key, expiresAt: pending.expiresAt });
            }
            // Locker exists, but LootLabs server postback has NOT arrived yet!
            return res.status(404).json({ success: false, error: "Waiting for LootLabs confirmation. Please finish all tasks on LootLabs." });
        }

        return res.status(404).json({ success: false, error: "No verified LootLabs session found. Please complete the tasks." });
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

    const pendingData = {
        userId,
        time: Date.now(),
        redeemed: false,
        ip: userIp,
        country: userCountry
    };
    memoryWorkinkPending.set(postbackValue, pendingData);
    if (rtdb) {
        rtdb.ref(`workinkPending/${postbackValue}`).set(pendingData).catch(() => {});
    }

    const requestedUrl = (req.body && typeof req.body.destinationUrl === 'string' && req.body.destinationUrl.trim()) ? req.body.destinationUrl.trim() : null;
    const localReturnUrl = (req.body && typeof req.body.localReturnUrl === 'string' && req.body.localReturnUrl.trim()) ? req.body.localReturnUrl.trim() : null;

    let targetBase = requestedUrl || `${FRONTEND_BASE_URL}/key.html`;
    if (localReturnUrl && !targetBase.includes('localhost') && !targetBase.includes('127.0.0.1')) {
        targetBase += (targetBase.includes('?') ? '&' : '?') + `local_return=${encodeURIComponent(localReturnUrl)}`;
    }
    const destinationUrl = `${targetBase}#workink_done=${postbackValue}`;

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

    if (!pending && rtdb) {
        try {
            const snap = await rtdb.ref(`workinkPending/${postbackValue}`).once('value');
            if (snap.exists()) {
                pending = snap.val();
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
    if (rtdb) {
        rtdb.ref(`workinkPending/${matchedDocId}`).update({ redeemed: true, redeemedAt: Date.now() }).catch(() => {});
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

    if (WORKINK_POSTBACK_SECRET && secret && secret !== WORKINK_POSTBACK_SECRET) {
        console.warn(`[Work.ink Postback] Invalid secret provided.`);
        return res.status(403).send("Invalid secret");
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
        providerUsage: { workink: now },
        ip: ip,
        country: country,
        maxUsers: 1,
        usedUsers: 1,
        usedBy: [userId],
        note: 'Generated via Work.ink',
        workinkPostback: postbackValue || null
    };
    // Save to RAM + RTDB + Firestore
    await saveKeyToStorage(keyString, newKeyDoc);

    const claimDoc = {
        key: keyString,
        expiresAt: expiresAt,
        issuedAt: now
    };
    if (rtdb) {
        rtdb.ref(`workinkClaimed/${userId}`).set(claimDoc).catch(() => {});
    }
    memoryWorkinkPending.set(`__claimed_${userId}`, { key: keyString, expiresAt, time: now });
    console.log(`[Key Issued] ${keyString} for ${userId} via Work.ink`);
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
        // 1. Already issued via server postback? Scan memory keys
        for (const [k, v] of memoryKeys.entries()) {
            if (v.userId === userId && v.workinkPostback === postbackValue && v.expiresAt > Date.now()) {
                return res.json({ success: true, key: k, expiresAt: v.expiresAt });
            }
        }

        // 2. Check RTDB workinkPending node for this postbackValue
        if (rtdb) {
            try {
                const pSnap = await rtdb.ref(`workinkPending/${postbackValue}`).once('value');
                if (pSnap.exists()) {
                    const data = pSnap.val();
                    if (data && data.redeemed && data.key && data.expiresAt > Date.now()) {
                        return res.json({ success: true, key: data.key, expiresAt: data.expiresAt });
                    }
                }
            } catch (e) {}
        }

        // 3. Verify with Work.ink Key System API:
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

        // 4. Not verified yet and no valid key found
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

        // 1. Check if hash was already used (Memory & RTDB)
        if (memoryUsedHashes.has(hash)) {
            return res.status(403).json({ success: false, error: "This completion hash has already been used. Please get a new key." });
        }

        if (rtdb) {
            try {
                const snap = await rtdb.ref(`usedHashes/${hash}`).once('value');
                if (snap.exists()) {
                    memoryUsedHashes.set(hash, snap.val() || { time: Date.now() });
                    return res.status(403).json({ success: false, error: "This completion hash has already been used. Please get a new key." });
                }
            } catch (rtdbErr) {}
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
        const usedEntry = { userId, time: Date.now() };
        memoryUsedHashes.set(hash, usedEntry);
        if (rtdb) {
            rtdb.ref(`usedHashes/${hash}`).set(usedEntry).catch(() => {});
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
            providerUsage: { linkvertise: now },
            ip: ip,
            country: country,
            maxUsers: 1,
            usedUsers: 1,
            usedBy: [userId],
            note: 'Generated via Linkvertise',
            linkvertiseHash: hash
        };

        // Save to RAM + RTDB + Firestore
        await saveKeyToStorage(keyString, newKeyDoc);

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

        // If not in memory, check RTDB
        if (!keyData) {
            keyData = await getKeyFromStorage(cleanKey);
            if (!keyData) {
                memoryInvalidKeys.set(cleanKey, Date.now()); // Cache negative result for 10 mins
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
                    await updateKeyInStorage(cleanKey, { usedIps, usedBy, usedUsers: usedBy.length });
                }
            } else if (usedBy.includes(userId)) {
                // User already recognized
            } else {
                if (usedBy.length >= maxUsers) {
                    return res.status(403).json({ valid: false, error: `This key has reached its sharing limit (Max ${maxUsers} users).` });
                }
                // Register user
                usedBy.push(userId);
                await updateKeyInStorage(cleanKey, { usedBy, usedUsers: usedBy.length });
            }
        } else {
            // Normal gateway key: bind or allow valid holder
            if (userId && (!keyData.userId || keyData.userId === 'anonymous')) {
                await updateKeyInStorage(cleanKey, { userId });
            }
        }

        // Session & Concurrency Tracking (Single active device / session per key)
        const sessionId = req.body.sessionId ? String(req.body.sessionId).trim() : null;
        const updates = { lastSeen: Date.now() };
        if (sessionId) {
            updates.activeSessionId = sessionId;
        }
        await updateKeyInStorage(cleanKey, updates);

        const providerUsage = keyData.providerUsage || (keyData.provider ? { [keyData.provider]: keyData.createdAt || Date.now() } : {});

        return res.json({ 
            valid: true, 
            expiresAt: keyData.expiresAt || 0,
            provider: keyData.provider || null,
            providerUsage,
            activeSessionId: sessionId || keyData.activeSessionId || null
        });

    } catch (error) {
        console.error("Verify key error:", error);
        return res.status(500).json({ valid: false, error: "Server verify error: " + error.message });
    }
});

// Endpoint to logout / disconnect an active key session
app.post('/api/logout-key', async (req, res) => {
    try {
        const { key } = req.body || {};
        if (key) {
            const cleanKey = String(key).trim().toUpperCase();
            let keyData = memoryKeys.get(cleanKey);
            if (!keyData) keyData = await getKeyFromStorage(cleanKey);
            if (keyData) {
                await updateKeyInStorage(cleanKey, { activeSessionId: null, lastLoggedOut: Date.now() });
            }
        }
        return res.json({ success: true });
    } catch (e) {
        return res.json({ success: false, error: e.message });
    }
});

// Endpoint to fetch key cooldowns and remaining time for frontend UI
app.get('/api/key-cooldowns', async (req, res) => {
    try {
        const key = req.query.key;
        if (!key) return res.status(400).json({ success: false, error: "Missing key parameter." });
        const cleanKey = String(key).trim().toUpperCase();

        let keyData = memoryKeys.get(cleanKey);
        if (!keyData) keyData = await getKeyFromStorage(cleanKey);
        if (!keyData) return res.status(404).json({ success: false, error: "Key not found." });

        const providerUsage = keyData.providerUsage || (keyData.provider ? { [keyData.provider]: keyData.createdAt || Date.now() } : {});

        // Calculate daily extension limits (max 3 per 24 hours)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();
        const extensionTimestamps = (Array.isArray(keyData.extensionTimestamps) ? keyData.extensionTimestamps : []).filter(t => (now - t) < ONE_DAY_MS);
        const maxDaily = 3;
        const dailyCount = extensionTimestamps.length;
        const dailyRemaining = Math.max(0, maxDaily - dailyCount);

        return res.json({
            success: true,
            expiresAt: keyData.expiresAt || 0,
            providerUsage,
            dailyCount,
            dailyRemaining,
            maxDaily,
            dailyLimitReached: dailyCount >= maxDaily,
            durations: {
                linkvertise: getProviderDurationHours('linkvertise'),
                lootlabs: getProviderDurationHours('lootlabs'),
                workink: getProviderDurationHours('workink')
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Endpoint to extend key access duration (+6h Linkvertise, +2h LootLabs, +12h Workink)
app.post('/api/extend-key', rateLimit('claim'), async (req, res) => {
    const { key, userId, provider, hash, postbackValue } = req.body || {};

    if (!key || !userId || !provider) {
        return res.status(400).json({ success: false, error: "Missing key, userId, or provider." });
    }

    const cleanKey = String(key).trim().toUpperCase();
    const cleanProvider = String(provider).trim().toLowerCase();

    if (!PROVIDER_KEYS.includes(cleanProvider)) {
        return res.status(400).json({ success: false, error: `Invalid provider: ${cleanProvider}` });
    }

    try {
        let keyData = memoryKeys.get(cleanKey);
        if (!keyData) {
            keyData = await getKeyFromStorage(cleanKey);
        }

        if (!keyData) {
            return res.status(404).json({ success: false, error: "Access key not found. Please re-enter a valid key." });
        }

        if (keyData.revoked) {
            return res.status(403).json({ success: false, error: "This key has been revoked." });
        }

        if (!keyData.adminCreated && userId && (!keyData.userId || keyData.userId === 'anonymous')) {
            await updateKeyInStorage(cleanKey, { userId });
        }

        // 🔒 Daily Limit Enforcement: Maximum 3 extensions per day (24 hours)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();
        const extensionTimestamps = (Array.isArray(keyData.extensionTimestamps) ? keyData.extensionTimestamps : []).filter(t => (now - t) < ONE_DAY_MS);
        const maxDaily = 3;

        if (extensionTimestamps.length >= maxDaily) {
            return res.status(403).json({
                success: false,
                error: "Daily limit reached: You can only extend your key 3 times per day. Please come back tomorrow.",
                dailyLimitReached: true,
                dailyCount: extensionTimestamps.length,
                maxDaily,
                dailyRemaining: 0
            });
        }

        // Completion Verification
        if (cleanProvider === 'linkvertise') {
            if (!hash) {
                return res.status(400).json({ success: false, error: "Missing Linkvertise completion hash." });
            }
            if (memoryUsedHashes.has(hash)) {
                return res.status(403).json({ success: false, error: "This completion hash has already been used." });
            }
            if (rtdb) {
                const snap = await rtdb.ref(`usedHashes/${hash}`).once('value');
                if (snap.exists()) {
                    return res.status(403).json({ success: false, error: "This completion hash has already been used." });
                }
            }

            let isValidHash = false;
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
                if (lvResponse.ok && (lvData.success === true || lvData.status === true || lvData.status === 200 || lvData.valid === true || lvData.user_id)) {
                    isValidHash = true;
                }
            } catch (e) {
                console.warn("Linkvertise verification error in extend-key:", e.message);
            }

            if (!isValidHash) {
                return res.status(403).json({ success: false, error: "Linkvertise completion hash verification failed." });
            }

            // Mark hash as used
            const usedEntry = { userId, time: Date.now(), extendKey: cleanKey };
            memoryUsedHashes.set(hash, usedEntry);
            if (rtdb) rtdb.ref(`usedHashes/${hash}`).set(usedEntry).catch(() => {});

        } else if (cleanProvider === 'lootlabs') {
            if (!postbackValue) {
                return res.status(400).json({ success: false, error: "Missing LootLabs postback confirmation." });
            }
            let pending = memoryLootlabsPending.get(postbackValue);
            if (!pending && rtdb) {
                try {
                    const snap = await rtdb.ref(`lootlabsPending/${postbackValue}`).once('value');
                    if (snap.exists()) pending = snap.val();
                } catch (e) {}
            }
            if (!pending) {
                return res.status(404).json({ success: false, error: "LootLabs postback not confirmed yet. Please complete all tasks." });
            }
            if (pending.extendRedeemed) {
                return res.status(403).json({ success: false, error: "This LootLabs completion has already been redeemed." });
            }
            if (!pending.redeemed) {
                return res.status(400).json({ success: false, error: "LootLabs tasks have not been completed yet. Please finish the locker in LootLabs." });
            }
            pending.extendRedeemed = true;
            pending.redeemed = true;
            memoryLootlabsPending.set(postbackValue, pending);
            if (rtdb) rtdb.ref(`lootlabsPending/${postbackValue}`).update({ redeemed: true, extendRedeemed: true, redeemedAt: Date.now() }).catch(() => {});

        } else if (cleanProvider === 'workink') {
            if (!postbackValue) {
                return res.status(400).json({ success: false, error: "Missing Work.ink postback confirmation." });
            }
            let pending = memoryWorkinkPending.get(postbackValue);
            if (!pending && rtdb) {
                try {
                    const snap = await rtdb.ref(`workinkPending/${postbackValue}`).once('value');
                    if (snap.exists()) pending = snap.val();
                } catch (e) {}
            }
            if (!pending) {
                return res.status(404).json({ success: false, error: "Work.ink postback not confirmed yet. Please complete all tasks." });
            }
            if (pending.extendRedeemed) {
                return res.status(403).json({ success: false, error: "This Work.ink completion has already been redeemed." });
            }
            if (!pending.redeemed) {
                return res.status(400).json({ success: false, error: "Work.ink tasks have not been completed yet. Please finish the locker in Work.ink." });
            }
            pending.extendRedeemed = true;
            pending.redeemed = true;
            memoryWorkinkPending.set(postbackValue, pending);
            if (rtdb) rtdb.ref(`workinkPending/${postbackValue}`).update({ redeemed: true, extendRedeemed: true, redeemedAt: Date.now() }).catch(() => {});
        }

        // Apply Duration Extension
        const providerHours = getProviderDurationHours(cleanProvider);
        const addedMs = getProviderDurationMs(cleanProvider);
        const currentExpires = (keyData.expiresAt && keyData.expiresAt > Date.now()) ? keyData.expiresAt : Date.now();
        const newExpiresAt = currentExpires + addedMs;

        if (!keyData.providerUsage) keyData.providerUsage = {};
        keyData.providerUsage[cleanProvider] = Date.now();

        // Add to daily extension history
        extensionTimestamps.push(now);

        const updates = {
            expiresAt: newExpiresAt,
            providerUsage: keyData.providerUsage,
            extensionTimestamps: extensionTimestamps,
            lastExtendedAt: Date.now(),
            lastExtendedProvider: cleanProvider
        };

        keyData.extensionTimestamps = extensionTimestamps;
        keyData.expiresAt = newExpiresAt;

        await updateKeyInStorage(cleanKey, updates);

        if (db) {
            try {
                await db.collection('keys').doc(cleanKey).set(updates, { merge: true });
            } catch (e) {}
        }

        console.log(`🎉 [Key Extended] ${cleanKey} extended +${providerHours}h via ${cleanProvider}. Daily used: ${extensionTimestamps.length}/${maxDaily}. New expiresAt: ${newExpiresAt}`);

        return res.json({
            success: true,
            key: cleanKey,
            newExpiresAt,
            addedHours: providerHours,
            dailyCount: extensionTimestamps.length,
            dailyRemaining: Math.max(0, maxDaily - extensionTimestamps.length),
            maxDaily: maxDaily,
            providerUsage: keyData.providerUsage
        });

    } catch (error) {
        console.error("Extend key error:", error);
        return res.status(500).json({ success: false, error: "Internal server error: " + error.message });
    }
});

// ============================================================
// ADMIN ROUTES (Protected)
// ============================================================
// Whitelist of allowed admin emails - loaded from env for security.
// Set ADMIN_EMAILS env var in Render/local .env as comma-separated list.
// Falls back to a safe default list if not set.
const ADMIN_EMAILS_ENV = process.env.ADMIN_EMAILS || 'js7384333@gmail.com,js8495444@gmail.com,atifjanibrand@gmail.com,nmcpathan@gmail.com';
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
        if (memoryKeys.size === 0) {
            await loadKeysFromStorage(true);
        }
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
        if (memoryKeys.size === 0) {
            await loadKeysFromStorage(true);
        }
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
            const existing = await getKeyFromStorage(keyString);
            if (existing) {
                return res.status(409).json({ error: 'A key with this value already exists.' });
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

        await saveKeyToStorage(keyString, newKey);
        res.json({ success: true, key: keyString, expiresAt, tier: cleanTier, ipCheck: !!ipCheck });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/revoke-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        let data = await getKeyFromStorage(key);
        if (!data) return res.status(404).json({ error: 'Key not found' });

        await updateKeyInStorage(key, { revoked: true, revokedAt: Date.now() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/delete-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        let data = await getKeyFromStorage(key);
        if (!data) return res.status(404).json({ error: 'Key not found' });

        await deleteKeyFromStorage(key);
        res.json({ success: true, key, source: 'rtdb+firestore+memory' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// BAN: revoke a key AND ban its associated IP (with optional timer)
app.post('/api/admin/ban-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        const { durationMs, reason } = req.body || {};
        let data = await getKeyFromStorage(key);
        if (!data) return res.status(404).json({ error: 'Key not found' });

        // Revoke the key across RAM + RTDB + Firestore
        await updateKeyInStorage(key, { revoked: true, revokedAt: Date.now() });

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

        let data = await getKeyFromStorage(key);
        if (!data) return res.status(404).json({ error: 'Key not found' });

        // Lifetime keys (expiresAt === 0) cannot be reduced; allow positive to convert to timed? Keep simple: skip.
        let newExpiresAt = data.expiresAt;
        if (!data.expiresAt || data.expiresAt === 0) {
            if (changeMs <= 0) return res.status(400).json({ error: 'Cannot reduce a lifetime key.' });
            newExpiresAt = Date.now() + changeMs;
        } else {
            // If already expired, base is "now"; otherwise base is current expiry (so +/- applied to remaining time)
            const baseTime = (data.expiresAt > Date.now()) ? data.expiresAt : Date.now();
            newExpiresAt = baseTime + changeMs;
        }

        const updates = { expiresAt: newExpiresAt };
        if (changeMs > 0) updates.revoked = false;

        await updateKeyInStorage(key, updates);
        res.json({ success: true, expiresAt: newExpiresAt, changeMs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/purge-expired', verifyAdmin, async (req, res) => {
    try {
        const now = Date.now();
        const force = !!(req.body && req.body.force);
        // Default: remove keys expired for more than 2 days (48 hours).
        // force=true (manual click): remove ALL currently expired keys immediately.
        const cutoff = force ? now : (now - 2 * 24 * 3600000);
        let deletedCount = 0;

        const toDelete = [];
        for (const [key, data] of memoryKeys.entries()) {
            if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                toDelete.push(key);
            }
        }

        if (toDelete.length > 0) {
            // 1. Delete from RTDB
            if (rtdb) {
                const rtdbUpdates = {};
                toDelete.forEach(k => {
                    rtdbUpdates[`keys/${k}`] = null;
                });
                try {
                    await rtdb.ref().update(rtdbUpdates);
                } catch (e) {
                    console.warn("RTDB purge error:", e.message);
                }
            }

            toDelete.forEach(k => memoryKeys.delete(k));
            deletedCount = toDelete.length;
        }

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
        const id = `ann_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const data = {
            id,
            heading,
            content,
            startAt: new Date(startAt).toISOString(),
            endAt: new Date(endAt).toISOString(),
            theme: theme || 'info',
            active: true,
            createdAt: new Date().toISOString(),
            createdBy: 'admin'
        };
        memoryAnnouncements.set(id, data);

        if (rtdb) {
            try {
                await rtdb.ref(`announcements/${id}`).set(data);
            } catch (e) {
                console.warn("RTDB announcement save error:", e.message);
            }
        }
        return res.json({ success: true, id, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const { heading, content, startAt, endAt, theme } = req.body;
        const updates = {};
        if (heading) updates.heading = heading;
        if (content) updates.content = content;
        if (startAt) updates.startAt = new Date(startAt).toISOString();
        if (endAt) updates.endAt = new Date(endAt).toISOString();
        if (theme) updates.theme = theme;

        const existing = memoryAnnouncements.get(id) || {};
        const merged = { ...existing, ...updates };
        memoryAnnouncements.set(id, merged);

        if (rtdb) {
            try {
                await rtdb.ref(`announcements/${id}`).update(updates);
            } catch (e) {}
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        memoryAnnouncements.delete(id);

        if (rtdb) {
            try {
                await rtdb.ref(`announcements/${id}`).remove();
            } catch (e) {}
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/announcements/:id/toggle', verifyAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        let current = true;
        const inMem = memoryAnnouncements.get(id);
        if (inMem) {
            current = inMem.active;
        }
        const newActive = !current;
        if (inMem) inMem.active = newActive;

        if (rtdb) {
            try {
                await rtdb.ref(`announcements/${id}`).update({ active: newActive });
            } catch (e) {}
        }
        res.json({ success: true, active: newActive });
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

// Public: submit a bug report or feature suggestion (stored 100% in Firestore only)
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
        const day = todayKey();
        const norm = text.toLowerCase().replace(/\s+/g, ' ');

        const supportId = 'sup_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

        const doc = {
            id: supportId,
            userId,
            type: kind,
            message: text,
            normalizedMessage: norm,
            email: emailClean,
            status: 'pending',
            unique: true,
            keyIssued: false,
            issuedKey: null,
            createdAt: Date.now(),
            createdAtIso: new Date().toISOString(),
            dayKey: day
        };

        // 100% Firestore store for support reports/suggestions
        if (db) {
            await db.collection('supportRequests').doc(supportId).set(doc);
        } else {
            console.warn('[Support] Firestore not initialized, support request not persisted.');
        }

        let note = '';
        if (kind === 'suggestion') {
            note = 'Thanks! Your suggestion has been submitted. If approved, you will get a FREE 24-hour key.';
            note += emailClean
                ? ' We will contact you at ' + emailClean + ' if approved.'
                : ' Add your email next time so we can send you the reward key if approved.';
        } else {
            note = 'Thanks for the bug report! Our team will review it soon.';
            if (emailClean) note += ' We will contact you at ' + emailClean + ' if needed.';
        }

        res.json({ success: true, id: supportId, unique: true, message: note });
    } catch (e) {
        console.error('Support submit error:', e.message);
        res.status(500).json({ success: false, error: 'Server error. Please try again.' });
    }
});

// Public: view my own submissions (direct from Firestore)
app.get('/api/support/mine', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId || !/^[a-zA-Z0-9_-]+$/.test(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
        
        if (!db) return res.json({ requests: [] });
        const snap = await db.collection('supportRequests').where('userId', '==', userId).get();
        const requests = [];
        snap.forEach(docSnap => {
            requests.push(docSnap.data());
        });
        requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ requests: requests.slice(0, 50) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: list all support requests (direct from Firestore)
app.get('/api/admin/support', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        if (!db) return res.json({ requests: [] });
        const snap = await db.collection('supportRequests').get();
        const requests = [];
        snap.forEach(docSnap => {
            requests.push(docSnap.data());
        });
        requests.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        res.json({ requests });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: approve / reject a request (approve issues a FREE 24h key to that user)
app.post('/api/admin/support/:id/action', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const supportId = req.params.id;
        const { action } = req.body || {};
        if (!db) return res.status(503).json({ error: 'Firestore database not connected.' });

        const docRef = db.collection('supportRequests').doc(supportId);
        const docSnap = await docRef.get();
        if (!docSnap.exists) return res.status(404).json({ error: 'Request not found' });
        const data = docSnap.data();

        if (action === 'reject') {
            const updates = { status: 'rejected', resolvedAt: Date.now() };
            await docRef.update(updates);
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
            await saveKeyToStorage(keyString, newKey);
            const updates = { status: 'approved', keyIssued: true, issuedKey: keyString, issuedExpiresAt: expiresAt, resolvedAt: now };
            await docRef.update(updates);
            return res.json({ success: true, status: 'approved', key: keyString, expiresAt });
        }

        return res.status(400).json({ error: 'Invalid action. Use approve or reject.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Background Auto-Purge job: runs every 6 hours to clean expired keys > 2 days (48h) (RTDB + Firestore)
setInterval(async () => {
    try {
        const now = Date.now();
        const twoDays = 2 * 24 * 3600000;
        const cutoff = now - twoDays;

        const toDelete = [];
        for (const [key, data] of memoryKeys.entries()) {
            if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                toDelete.push(key);
            }
        }

        if (toDelete.length > 0) {
            // 1. Delete from RTDB
            if (rtdb) {
                const rtdbUpdates = {};
                toDelete.forEach(k => {
                    rtdbUpdates[`keys/${k}`] = null;
                });
                try {
                    await rtdb.ref().update(rtdbUpdates);
                } catch (e) {
                    console.warn("[Auto-Purge RTDB Error]:", e.message);
                }
            }
            console.log(`[Auto-Purge Job] Removed ${toDelete.length} keys expired more than 2 days ago from RTDB.`);
        }

        toDelete.forEach(k => memoryKeys.delete(k));
    } catch (err) {
        console.warn("[Auto-Purge Job Error]:", err.message);
    }
}, 6 * 60 * 60 * 1000);

// ============================================================
// STORE / CATALOG CONFIGURATION (RTDB-backed)
// ============================================================
const DEFAULT_STORE_CONFIG = {
    avatarItems: [
        {
            id: "gold-crown-ozymandias",
            name: "Gold Crown of Ozymandias",
            creator: "Roblox",
            verified: true,
            tagline: "Custom Player Tag",
            badgeText: "2 days left",
            imageUrl: "https://images.rbxcdn.com/192a7bd92c19b511.gif",
            overlayImageUrl: "",
            bannerImageUrl: "",
            bannerBgColor: "#e9ebed",
            bannerCropX: 50,
            bannerCropY: 50,
            bannerScale: 100,
            bannerFit: "cover",
            bannerHeight: 230,
            bannerWidth: 100,
            bannerAlign: "center",
            bannerOverlayColor: "#000000",
            bannerOverlayOpacity: 0,
            bannerFilterHue: 0,
            imageOffsetX: 0,
            imageOffsetY: 0,
            imageScale: 100,
            imageAlign: "center",
            titleColor: "#191b1d",
            subtitleColor: "#4b5563",
            titleFontSize: 24,
            subtitleFontSize: 12,
            textOffsetX: 0,
            textOffsetY: 0,
            textAlign: "left",
            borderRadius: 16,
            robux: 24000,
            originalRobux: 22500,
            bonusText: "+ 1,500 more",
            priceUsd: "$199.99",
            tiers: [
                { id: "t1", robux: 24000, originalRobux: 22500, bonusText: "+ 1,500 more", priceUsd: "$199.99", enabled: true },
                { id: "t2", robux: 11000, originalRobux: 10000, bonusText: "+ 1,000 more", priceUsd: "$99.99", enabled: true },
                { id: "t3", robux: 5250, originalRobux: 4500, bonusText: "+ 750 more", priceUsd: "$49.99", enabled: true },
                { id: "t4", robux: 3625, originalRobux: 3150, bonusText: "+ 475 more", priceUsd: "$34.99", enabled: true },
                { id: "t5", robux: 2000, originalRobux: 1700, bonusText: "+ 300 more", priceUsd: "$19.99", enabled: true }
            ],
            enabled: true
        }
    ],
    packages: [
        { id: "pkg-11000", robux: 11000, originalRobux: 10000, priceUsd: "$99.99", bonusText: "", featured: false, forYou: false, enabled: true },
        { id: "pkg-5250", robux: 5250, originalRobux: 4500, priceUsd: "$49.99", bonusText: "", featured: false, forYou: false, enabled: true },
        { id: "pkg-3625", robux: 3625, originalRobux: 3150, priceUsd: "$34.99", bonusText: "", featured: false, forYou: false, enabled: true },
        { id: "pkg-2000", robux: 2000, originalRobux: 1700, priceUsd: "$19.99", bonusText: "", featured: false, forYou: false, enabled: true },
        { id: "pkg-1500", robux: 1500, originalRobux: 1200, priceUsd: "$14.99", bonusText: "", featured: false, forYou: false, enabled: true },
        { id: "pkg-1000", robux: 1000, originalRobux: 800, priceUsd: "$9.99", bonusText: "+ 200 more", featured: true, forYou: true, enabled: true },
        { id: "pkg-500", robux: 500, originalRobux: 400, priceUsd: "$4.99", bonusText: "", featured: false, forYou: false, enabled: true }
    ],
    sectionTitles: {
        avatarSection: "Limited-time avatar items",
        packagesSection: "Robux packages"
    },
    updatedAt: Date.now()
};

// Public: Get current store catalog configuration with zero-bandwidth 304/notModified check
app.get('/api/store-config', async (req, res) => {
    try {
        const clientVersion = req.query.v ? parseInt(req.query.v, 10) : null;
        const currentUpdated = memorySettings.storeConfigUpdatedAt || Date.now();
        const activeSource = memorySettings.storeConfigStorageSource || 'rtdb';

        // Zero-bandwidth check: if client already has latest version, return notModified
        if (clientVersion && clientVersion === currentUpdated) {
            return res.json({ 
                success: true, 
                notModified: true, 
                storageSource: activeSource,
                updatedAt: currentUpdated
            });
        }

        const config = memorySettings.storeConfig || DEFAULT_STORE_CONFIG;
        return res.json({ 
            success: true, 
            config, 
            updatedAt: currentUpdated,
            storageSource: activeSource 
        });
    } catch (e) {
        console.error('[Store Config GET Error]:', e.message);
        return res.json({ 
            success: true, 
            config: DEFAULT_STORE_CONFIG, 
            updatedAt: Date.now(), 
            storageSource: 'rtdb' 
        });
    }
});

// Admin: Save updated store catalog configuration and select storage source (RTDB or Firestore)
app.post('/api/store-config', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const body = req.body || {};
        const config = body.config ? body.config : body;
        const storageSource = (body.storageSource === 'firestore' || body.storageSource === 'rtdb') 
            ? body.storageSource 
            : (memorySettings.storeConfigStorageSource || 'rtdb');

        if (!config || typeof config !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid store config data.' });
        }
        config.updatedAt = Date.now();

        // Update in-memory cache for instant zero-lag serving
        memorySettings.storeConfig = config;
        memorySettings.storeConfigUpdatedAt = config.updatedAt;
        memorySettings.storeConfigStorageSource = storageSource;

        // Persist to selected database
        if (storageSource === 'firestore') {
            if (db) {
                await db.collection('settings').doc('storeConfig').set(config);
                await db.collection('settings').doc('activeStorageSource').set({ source: 'firestore', updatedAt: Date.now() });
            }
            if (rtdb) {
                // Record active source in RTDB too for sync
                rtdb.ref('settings/activeStorageSource').set({ source: 'firestore', updatedAt: Date.now() }).catch(() => {});
            }
            console.log('✅ Store Catalog Config saved to FIRESTORE');
        } else {
            // Realtime Database
            if (rtdb) {
                await rtdb.ref('settings/storeConfig').set(config);
                await rtdb.ref('settings/activeStorageSource').set({ source: 'rtdb', updatedAt: Date.now() });
            }
            if (db) {
                db.collection('settings').doc('activeStorageSource').set({ source: 'rtdb', updatedAt: Date.now() }).catch(() => {});
            }
            console.log('✅ Store Catalog Config saved to RTDB');
        }

        return res.json({ 
            success: true, 
            config, 
            storageSource, 
            updatedAt: config.updatedAt 
        });
    } catch (e) {
        console.error('[Store Config POST Error]:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Store Domains: Get active store domains and gateway config
app.get('/api/store-domains', async (req, res) => {
    try {
        const domains = memorySettings.storeDomains || DEFAULT_STORE_DOMAINS;
        return res.json({ success: true, domains });
    } catch (e) {
        return res.json({ success: true, domains: DEFAULT_STORE_DOMAINS });
    }
});

// Admin: Save and broadcast updated store domains
app.post('/api/admin/store-domains', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const body = req.body || {};
        const primaryStoreUrl = String(body.primaryStoreUrl || '').trim();
        const keyGatewayUrl = String(body.keyGatewayUrl || '').trim();
        const allowedDomains = Array.isArray(body.allowedDomains) 
            ? body.allowedDomains.map(d => String(d).trim()).filter(Boolean)
            : (primaryStoreUrl ? [primaryStoreUrl] : []);

        const payload = {
            primaryStoreUrl: primaryStoreUrl || DEFAULT_STORE_DOMAINS.primaryStoreUrl,
            keyGatewayUrl: keyGatewayUrl || DEFAULT_STORE_DOMAINS.keyGatewayUrl,
            allowedDomains: allowedDomains.length > 0 ? allowedDomains : [primaryStoreUrl || DEFAULT_STORE_DOMAINS.primaryStoreUrl],
            updatedAt: Date.now()
        };

        memorySettings.storeDomains = payload;

        if (rtdb) {
            await rtdb.ref('settings/storeDomains').set(payload).catch(err => {
                console.warn('RTDB storeDomains save warning:', err.message);
            });
        }
        if (db) {
            await db.collection('settings').doc('storeDomains').set(payload).catch(() => {});
        }
        console.log('✅ Store Domains saved successfully via Admin API:', payload);

        return res.json({ success: true, domains: payload });
    } catch (e) {
        console.error('[Store Domains POST Error]:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// ====================
// Server Cloud Configuration Endpoint
// ====================
const DEFAULT_SERVER_CONFIG = {
    selectedStoreId: 'render-b',
    selectedApiKeyId: 'render-c',
    activeStoreUrl: 'https://roblox-backend-1jck.onrender.com',
    activeApiKeyUrl: 'https://api-keysystem-bbbf.onrender.com',
    customStoreUrl: '',
    customApiKeyUrl: '',
    updatedAt: Date.now()
};

let memoryServerConfig = { ...DEFAULT_SERVER_CONFIG };
let serverConfigRtdbCache = { cfg: null, fetchedAt: 0 };
const SERVER_CONFIG_RTDB_TTL_MS = 15000;

async function getLiveServerConfig() {
    if (rtdb && (Date.now() - serverConfigRtdbCache.fetchedAt) > SERVER_CONFIG_RTDB_TTL_MS) {
        try {
            const snap = await rtdb.ref('settings/serverConfig').once('value');
            if (snap.exists()) {
                serverConfigRtdbCache = {
                    cfg: { ...DEFAULT_SERVER_CONFIG, ...snap.val() },
                    fetchedAt: Date.now()
                };
                memoryServerConfig = serverConfigRtdbCache.cfg;
            }
        } catch (e) {
            console.warn('Live server config RTDB read failed, using cached memory config:', e.message);
        }
    }
    return serverConfigRtdbCache.cfg || memoryServerConfig;
}

app.get('/api/server-config', async (req, res) => {
    res.json({ success: true, config: await getLiveServerConfig() });
});

app.get('/api/admin/server-config', verifyAdmin, rateLimit('admin'), async (req, res) => {
    res.json({ success: true, config: await getLiveServerConfig() });
});

app.post('/api/admin/server-config', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const body = req.body || {};
        const config = body.config || body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid server configuration.' });
        }
        config.updatedAt = Date.now();
        memoryServerConfig = { ...DEFAULT_SERVER_CONFIG, ...config };
        serverConfigRtdbCache = { cfg: memoryServerConfig, fetchedAt: Date.now() };

        if (rtdb) {
            await rtdb.ref('settings/serverConfig').set(memoryServerConfig);
        }
        if (db) {
            await db.collection('settings').doc('serverConfig').set(memoryServerConfig).catch(() => {});
        }
        console.log('✅ Server Cloud Configuration updated and saved');
        return res.json({ success: true, config: memoryServerConfig });
    } catch(e) {
        console.error('[Server Config Error]:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// Start Express API server
app.listen(PORT, () => {
    console.log(`🚀 ApiKey system running successfully on port ${PORT}`);
});
