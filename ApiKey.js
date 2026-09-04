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

// Browser GET helper for claim-key
app.get('/api/claim-key', (req, res) => {
    res.json({ 
        success: false, 
        message: "This endpoint requires a POST request with { hash, userId } from the frontend application." 
    });
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
