require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Local fallback store for 100% uptime reliability
const memoryKeys = new Map();
const memoryUsedHashes = new Map();
const memoryLootlabsPending = new Map(); // postbackValue -> { userId, time, redeemed }

// Initialize Firebase Admin
let db = null;
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
        console.log("✅ Firebase Admin initialized successfully.");
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
const LOOTLABS_TARGET_LINK = process.env.LOOTLABS_TARGET_LINK || 'https://buy-r-bl0x.web.app/key.html';
const LOOTLABS_TIER_ID = parseInt(process.env.LOOTLABS_TIER_ID || '1', 10);
const LOOTLABS_NUM_TASKS = parseInt(process.env.LOOTLABS_NUM_TASKS || '3', 10);
const LOOTLABS_THEME = parseInt(process.env.LOOTLABS_THEME || '1', 10);
const LOOTLABS_POSTBACK_SECRET = process.env.LOOTLABS_POSTBACK_SECRET || 'buyroblox_lootlabs_secret_2026';

// Frontend base URL (for postback redirects)
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://buy-r-bl0x.web.app';

// Middleware
app.use(cors());
app.use(express.json());

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
                theme: LOOTLABS_THEME
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

// LootLabs Postback - LootLabs server sends GET request here when user completes the locker.
// Configure this URL in your LootLabs panel postback settings:
//   https://api-keysystem.onrender.com/api/lootlabs-postback?postbackValue={postbackValue}
app.get('/api/lootlabs-postback', async (req, res) => {
    const { postbackValue, secret } = req.query;

    if (!postbackValue) {
        return res.status(400).send("Missing postbackValue");
    }
    if (secret && secret !== LOOTLABS_POSTBACK_SECRET) {
        return res.status(403).send("Invalid secret");
    }

    try {
        let pending = memoryLootlabsPending.get(postbackValue);
        if (!pending && db) {
            try {
                const doc = await db.collection('lootlabsPending').doc(postbackValue).get();
                if (doc.exists) {
                    pending = doc.data();
                }
            } catch (e) {}
        }

        if (!pending) {
            console.warn(`[LootLabs Postback] Unknown postbackValue: ${postbackValue}`);
            return res.status(404).send("Unknown postbackValue");
        }

        if (pending.redeemed) {
            console.log(`[LootLabs Postback] Already redeemed: ${postbackValue}`);
            return res.status(200).send("ALREADY_REDEEMED");
        }

        const userId = pending.userId;
        if (!userId) {
            return res.status(400).send("Missing userId in pending entry");
        }

        // Mark redeemed
        pending.redeemed = true;
        memoryLootlabsPending.set(postbackValue, pending);
        if (db) {
            try {
                await db.collection('lootlabsPending').doc(postbackValue).update({ redeemed: true, redeemedAt: FieldValue.serverTimestamp() });
            } catch (e) {}
        }

        // Issue key
        const keyString = [1,2,3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
        const now = Date.now();
        const expiresAt = now + (12 * 60 * 60 * 1000);
        const newKeyDoc = {
            key: keyString,
            userId: userId,
            createdAt: now,
            expiresAt: expiresAt,
            revoked: false,
            lootlabsPostback: postbackValue
        };
        memoryKeys.set(keyString, newKeyDoc);
        if (db) {
            try {
                await db.collection('keys').doc(keyString).set(newKeyDoc);
            } catch (e) {}
        }

        console.log(`[LootLabs Postback] Key issued ${keyString} for user ${userId}`);

        // Respond 200 OK so LootLabs marks the postback as delivered
        // We also push the key to the user's pending claim entry so frontend can pick it up
        if (db) {
            try {
                await db.collection('lootlabsClaimed').doc(userId).set({
                    key: keyString,
                    expiresAt: expiresAt,
                    issuedAt: FieldValue.serverTimestamp()
                });
            } catch (e) {}
        }
        // Also stash in memory for quick frontend lookup
        memoryLootlabsPending.set(`__claimed_${userId}`, { key: keyString, expiresAt, time: Date.now() });

        return res.status(200).send("OK");
    } catch (err) {
        console.error("LootLabs postback error:", err);
        return res.status(500).send("Server error");
    }
});

// Frontend polls / claims a LootLabs-issued key after being redirected back
app.post('/api/claim-lootlabs-key', async (req, res) => {
    const { userId, postbackValue } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }

    try {
        // First: check the in-memory latest claimed key for this user
        const memClaimed = memoryLootlabsPending.get(`__claimed_${userId}`);
        if (memClaimed && memClaimed.expiresAt > Date.now()) {
            return res.json({ success: true, key: memClaimed.key, expiresAt: memClaimed.expiresAt });
        }

        // Second: check Firestore
        if (db) {
            try {
                const doc = await db.collection('lootlabsClaimed').doc(userId).get();
                if (doc.exists) {
                    const data = doc.data();
                    if (data.expiresAt && data.expiresAt > Date.now()) {
                        return res.json({ success: true, key: data.key, expiresAt: data.expiresAt });
                    }
                }
            } catch (e) {}
        }

        // Also: scan memoryKeys for any key tied to this user via lootlabsPostback matching postbackValue
        if (postbackValue) {
            for (const [k, v] of memoryKeys.entries()) {
                if (v.userId === userId && v.lootlabsPostback === postbackValue && v.expiresAt > Date.now()) {
                    return res.json({ success: true, key: k, expiresAt: v.expiresAt });
                }
            }
        }

        return res.status(404).json({ success: false, error: "No LootLabs key found yet. Please complete all tasks and try again." });
    } catch (err) {
        console.error("LootLabs claim error:", err);
        return res.status(500).json({ success: false, error: "Server error: " + err.message });
    }
});

// LOCAL ONLY: Directly generate a LootLabs key without postback (for testing)
app.post('/api/generate-lootlabs-key-local', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, error: "Missing userId." });
    }

    try {
        // Generate key
        const keyString = [1,2,3].map(() => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-');
        const now = Date.now();
        const expiresAt = now + (12 * 60 * 60 * 1000);
        const newKeyDoc = {
            key: keyString,
            userId: userId,
            createdAt: now,
            expiresAt: expiresAt,
            revoked: false,
            lootlabsLocal: true
        };
        memoryKeys.set(keyString, newKeyDoc);
        if (db) {
            try {
                await db.collection('keys').doc(keyString).set(newKeyDoc);
            } catch (e) {}
        }

        console.log(`[LootLabs Local] Key issued ${keyString} for user ${userId}`);
        return res.json({ success: true, key: keyString, expiresAt });
    } catch (err) {
        console.error("LootLabs local generate error:", err);
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
app.post('/api/claim-key', async (req, res) => {
    const { hash, userId } = req.body;
    
    if (!hash || !userId) {
        return res.status(400).json({ success: false, error: "Missing completion hash or userId." });
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

        const newKeyDoc = {
            key: keyString,
            userId: userId,
            createdAt: now,
            expiresAt: expiresAt,
            revoked: false,
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
app.post('/api/verify-key', async (req, res) => {
    const { key, userId } = req.body;
    
    if (!key || !userId) {
        return res.status(400).json({ valid: false, error: "Missing key or userId." });
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

        // Check ownership
        if (keyData.userId && keyData.userId !== userId) {
            return res.status(403).json({ valid: false, error: "This key belongs to another session." });
        }

        // Check if revoked
        if (keyData.revoked) {
            return res.status(403).json({ valid: false, error: "This key has been revoked." });
        }

        // Check 12-hour expiry
        if (Date.now() > keyData.expiresAt) {
            return res.status(403).json({ valid: false, error: "Key is expired. Please get a new 12-hour key." });
        }

        return res.json({ valid: true, expiresAt: keyData.expiresAt });

    } catch (error) {
        console.error("Verify key error:", error);
        return res.status(500).json({ valid: false, error: "Server verify error: " + error.message });
    }
});

// Start Express API server
app.listen(PORT, () => {
    console.log(`🚀 ApiKey system running successfully on port ${PORT}`);
});
