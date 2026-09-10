require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Local fallback store for 100% uptime reliability
const memoryKeys = new Map();
const memoryUsedHashes = new Map();
const memoryLootlabsPending = new Map(); // postbackValue -> { userId, time, redeemed }

// Initialize Firebase Admin
let db = null;
let firestoreAvailable = false;

// Helper to pre-warm cache from Firestore on startup / wake from sleep
async function loadKeysFromFirestore() {
    if (!db) return;
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
        console.log(`✅ Loaded ${loaded} keys from Firestore into memory cache.`);
    } catch (e) {
        console.warn("Could not pre-load keys from Firestore:", e.message);
    }
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
    lootlabsPost: { windowMs: 60 * 1000,     max: 25 }  // 25 postback/poll requests/min (frontend polls while waiting)
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

    // Store pending entry
    memoryLootlabsPending.set(postbackValue, {
        userId,
        time: Date.now(),
        redeemed: false
    });
    if (db) {
        try {
            await db.collection('lootlabsPending').doc(postbackValue).set({
                userId,
                createdAt: FieldValue.serverTimestamp(),
                timestamp: Date.now(),
                redeemed: false
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
    if (!pending && db) {
        try {
            const doc = await db.collection('lootlabsPending').doc(postbackValue).get();
            if (doc.exists) pending = doc.data();
        } catch (e) {}
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
    memoryLootlabsPending.set(postbackValue, pending);
    if (db) {
        try {
            await db.collection('lootlabsPending').doc(postbackValue).update({ redeemed: true, redeemedAt: FieldValue.serverTimestamp() });
        } catch (e) {}
    }

    const issued = await issueLootlabsKey(userId, postbackValue, req);
    console.log(`[LootLabs Postback] Key issued ${issued.key} for user ${userId}`);
    return { status: 200, message: "OK", key: issued.key, expiresAt: issued.expiresAt, userId };
}

// LootLabs Postback - LootLabs server sends GET request here when user completes the locker.
// Configure this URL in your LootLabs panel postback settings:
//   https://api-keysystem.onrender.com/api/lootlabs-postback?postbackValue={postbackValue}&secret=buyroblox_lootlabs_secret_2026
// If LootLabs dashboard doesn't allow custom params, set STRICT_LOOTLABS_POSTBACK=false
// (less secure, but more compatible).
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

    // Accept postbackValue from any of these common param names
    const postbackValue = req.query.postbackValue || req.query.postback || req.query.pbv || req.query.id;
    const { secret } = req.query;

    if (!postbackValue) {
        console.warn(`[LootLabs Postback] No postbackValue in query. Got: ${JSON.stringify(req.query)}`);
        return res.status(400).send("Missing postbackValue");
    }

    // Strict mode: require secret. Set STRICT_LOOTLABS_POSTBACK=false in env to disable.
    const strictMode = process.env.STRICT_LOOTLABS_POSTBACK !== 'false';
    if (strictMode && LOOTLABS_POSTBACK_SECRET) {
        if (!secret || secret !== LOOTLABS_POSTBACK_SECRET) {
            console.warn(`[LootLabs Postback] Invalid/missing secret. Got secret: ${secret ? 'present' : 'MISSING'}. Tip: add &secret=... to your LootLabs postback URL, or set STRICT_LOOTLABS_POSTBACK=false in env.`);
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
async function issueLootlabsKey(userId, postbackValue, req) {
    const keyString = [1, 2, 3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
    const now = Date.now();
    const expiresAt = now + (12 * 60 * 60 * 1000);
    const ip = getClientIp(req);
    const country = await getCountry(ip);
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

        // 2. Check Firestore claimed collection
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

        // 3. Scan memory keys for a key tied to this user + postbackValue
        if (postbackValue) {
            for (const [k, v] of memoryKeys.entries()) {
                if (v.userId === userId && v.lootlabsPostback === postbackValue && v.expiresAt > Date.now()) {
                    return res.json({ success: true, key: k, expiresAt: v.expiresAt });
                }
            }
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
        const expiresAt = now + (12 * 60 * 60 * 1000); // 12 hours from now
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
        let keyData = memoryKeys.get(cleanKey);

        // If not in memory, check Firestore
        if (!keyData && db) {
            try {
                const keyDoc = await db.collection('keys').doc(cleanKey).get();
                if (keyDoc.exists) {
                    keyData = keyDoc.data();
                    memoryKeys.set(cleanKey, keyData); // Cache in memory
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

            if (usedBy.includes(userId)) {
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
        let allKeys = [];
        if (db) {
            try {
                const snapshot = await db.collection('keys').get();
                snapshot.forEach(doc => allKeys.push(doc.data()));
            } catch (e) {
                allKeys = Array.from(memoryKeys.values());
            }
        } else {
            allKeys = Array.from(memoryKeys.values());
        }

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
        const adminCount = allKeys.filter(k => k.provider === 'admin' || k.adminCreated).length;

        res.json({ totalKeys, activeKeys, expiredKeys, uniqueUsers, linkvertiseCount, lootlabsCount, adminCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/keys', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const search = (req.query.search || '').toLowerCase();
        let keys = [];

        if (db) {
            try {
                const snapshot = await db.collection('keys').get();
                snapshot.forEach(doc => {
                    const data = doc.data();
                    keys.push(data);
                    memoryKeys.set(data.key.toUpperCase(), data);
                });
            } catch (e) {
                keys = Array.from(memoryKeys.values());
            }
        } else {
            keys = Array.from(memoryKeys.values());
        }

        if (search) {
            keys = keys.filter(k => 
                (k.key && k.key.toLowerCase().includes(search)) || 
                (k.userId && k.userId.toLowerCase().includes(search)) ||
                (k.note && k.note.toLowerCase().includes(search)) ||
                (k.country && k.country.toLowerCase().includes(search)) ||
                (k.ip && k.ip.toLowerCase().includes(search))
            );
        }

        keys.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        const enriched = keys.map(k => {
            const provider = k.provider || (k.linkvertiseHash ? 'linkvertise' : (k.lootlabsPostback || k.lootlabsLocal ? 'lootlabs' : (k.adminCreated ? 'admin' : 'unknown')));
            return {
                key: k.key,
                provider: provider,
                userId: k.userId || '-',
                ip: k.ip || '-',
                country: k.country || '-',
                expiresAt: k.expiresAt || 0,
                revoked: k.revoked || false,
                createdAt: k.createdAt || 0,
                maxUsers: k.maxUsers || 1,
                usedUsers: Array.isArray(k.usedBy) ? k.usedBy.length : (k.usedUsers || 0),
                usedBy: k.usedBy || [],
                note: k.note || ''
            };
        });

        res.json({ keys: enriched });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/create-key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const { prefix, duration, maxUsers, note } = req.body;
        const keyString = (prefix || '') + [1,2,3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
        const now = Date.now();
        const durationNum = parseInt(duration, 10);
        const expiresAt = (durationNum === 0 || isNaN(durationNum)) ? 0 : now + durationNum;
        const ip = getClientIp(req);
        const country = await getCountry(ip);

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
        res.json({ success: true, key: keyString, expiresAt });
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

app.post('/api/admin/extend-key/:key', verifyAdmin, rateLimit('admin'), async (req, res) => {
    try {
        const key = req.params.key.toUpperCase();
        const { hours } = req.body;
        if (!hours || hours <= 0) return res.status(400).json({ error: 'Invalid hours' });
        
        let data = memoryKeys.get(key);
        if (!data && db) {
            const doc = await db.collection('keys').doc(key).get();
            if (doc.exists) data = doc.data();
        }

        if (!data) return res.status(404).json({ error: 'Key not found' });
        
        // If already expired, extend from now; otherwise extend from expiresAt
        const baseTime = (data.expiresAt && data.expiresAt > Date.now()) ? data.expiresAt : Date.now();
        data.expiresAt = baseTime + (hours * 3600000);
        data.revoked = false; // unrevoke if extended

        memoryKeys.set(key, data);
        if (db) {
            try {
                await db.collection('keys').doc(key).update({ expiresAt: data.expiresAt, revoked: false });
            } catch (fsErr) {
                console.warn("Firestore extend write failed:", fsErr.message);
            }
        }
        res.json({ success: true, expiresAt: data.expiresAt });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/purge-expired', verifyAdmin, async (req, res) => {
    try {
        const now = Date.now();
        const sevenDays = 7 * 24 * 3600000;
        const cutoff = now - sevenDays;
        let deletedCount = 0;

        if (db) {
            try {
                const snapshot = await db.collection('keys').get();
                const batch = db.batch();
                snapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                        batch.delete(doc.ref);
                        deletedCount++;
                    }
                });
                if (deletedCount > 0) {
                    await batch.commit();
                }
            } catch (e) {
                console.warn("Firestore purge error:", e.message);
            }
        }

        for (const [key, data] of memoryKeys) {
            if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                memoryKeys.delete(key);
                if (!db) deletedCount++;
            }
        }

        res.json({ success: true, deleted: deletedCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// ANNOUNCEMENTS
// ============================================================
app.get('/api/admin/announcements', verifyAdmin, async (req, res) => {
    try {
        if (!firestoreAvailable) {
            return res.status(503).json({ error: 'Firestore unavailable - cannot load announcements' });
        }
        const snapshot = await db.collection('announcements').get();
        const announcements = [];
        snapshot.forEach(doc => {
            announcements.push({ id: doc.id, ...doc.data() });
        });
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
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/announcements/:id', verifyAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
        await db.collection('announcements').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/announcements/:id/toggle', verifyAdmin, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Firestore unavailable' });
        const doc = await db.collection('announcements').doc(req.params.id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Announcement not found' });
        const current = doc.data().active;
        await db.collection('announcements').doc(req.params.id).update({ active: !current });
        res.json({ success: true, active: !current });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Public endpoint for frontend to fetch active announcements
app.get('/api/announcements/active', async (req, res) => {
    try {
        if (!db) return res.json({ announcements: [] });
        const nowIso = new Date().toISOString();
        const snapshot = await db.collection('announcements').where('active', '==', true).get();
        const announcements = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.startAt <= nowIso && data.endAt >= nowIso) {
                announcements.push({ id: doc.id, ...data });
            }
        });
        res.json({ announcements });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Background Auto-Purge job: runs every 6 hours to clean expired keys > 7 days
setInterval(async () => {
    try {
        const now = Date.now();
        const sevenDays = 7 * 24 * 3600000;
        const cutoff = now - sevenDays;

        if (db) {
            const snapshot = await db.collection('keys').get();
            const batch = db.batch();
            let count = 0;
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                    batch.delete(doc.ref);
                    count++;
                }
            });
            if (count > 0) {
                await batch.commit();
                console.log(`🧹 [Auto-Purge Job] Removed ${count} keys older than 7 days.`);
            }
        }

        for (const [key, data] of memoryKeys) {
            if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < cutoff) {
                memoryKeys.delete(key);
            }
        }
    } catch (err) {
        console.warn("[Auto-Purge Job Error]:", err.message);
    }
}, 6 * 60 * 60 * 1000);

// Start Express API server
app.listen(PORT, () => {
    console.log(`🚀 ApiKey system running successfully on port ${PORT}`);
});
