require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

// Initialize Firebase Admin
let db;
try {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            credential = cert(parsed);
        } catch (e) {
            console.error("Could not parse FIREBASE_SERVICE_ACCOUNT JSON env variable:", e.message);
        }
    }
    
    if (!credential) {
        const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH || './serviceAccountKey.json';
        const serviceAccount = require(keyPath);
        credential = cert(serviceAccount);
    }

    initializeApp({ credential });
    db = getFirestore();
    console.log("✅ Firebase Admin initialized successfully.");
} catch (error) {
    console.warn("⚠️ Warning: Could not initialize Firebase Admin. Ensure serviceAccountKey.json is present and valid.");
    console.error(error.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health Check Endpoint (Render & Frontend Health Probe)
app.get(['/', '/health', '/api/health'], (req, res) => {
    res.json({
        status: "ok",
        service: "buy-roblox-apikey-backend",
        timestamp: new Date().toISOString(),
        firebaseReady: !!db
    });
});

// Return target linkvertise url for frontend to navigate to
app.get('/api/get-link', (req, res) => {
    const link = process.env.LINKVERTISE_TARGET_LINK || 'https://direct-link.net/1276098/1A4zh2pEaHCB';
    res.json({ url: link });
});

// Endpoint to verify Linkvertise hash and generate 12-hour key
app.post('/api/claim-key', async (req, res) => {
    const { hash, userId } = req.body;
    
    if (!hash || !userId) {
        return res.status(400).json({ success: false, error: "Missing hash or userId." });
    }

    if (!db) {
        return res.status(500).json({ success: false, error: "Database service not initialized." });
    }

    try {
        // 1. Check if hash was already used to prevent replay attacks
        const hashRef = db.collection('usedHashes').doc(hash);
        const hashDoc = await hashRef.get();
        if (hashDoc.exists) {
            return res.status(403).json({ success: false, error: "This completion hash has already been used." });
        }

        // 2. Verify hash with Linkvertise Anti-Bypassing API
        const lvToken = process.env.LINKVERTISE_TOKEN;
        if (!lvToken) {
            return res.status(500).json({ success: false, error: "Server missing Linkvertise token." });
        }

        const lvResponse = await fetch('https://publisher.linkvertise.com/api/v1/anti_bypassing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: lvToken, hash: hash })
        });
        
        const lvData = await lvResponse.json().catch(() => ({}));
        
        if (!lvResponse.ok || lvData.success === false) {
            return res.status(403).json({ success: false, error: "Invalid or expired Linkvertise hash." });
        }

        // 3. Hash is valid! Consume it.
        await hashRef.set({ usedAt: FieldValue.serverTimestamp(), userId });

        // 4. Generate unique 12-hour key
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

        await db.collection('keys').doc(keyString).set(newKeyDoc);

        return res.json({ success: true, key: keyString, expiresAt });

    } catch (error) {
        console.error("Claim key error:", error);
        return res.status(500).json({ success: false, error: "Internal server error during claim." });
    }
});

// Endpoint to verify user key
app.post('/api/verify-key', async (req, res) => {
    const { key, userId } = req.body;
    
    if (!key || !userId) {
        return res.status(400).json({ valid: false, error: "Missing key or userId." });
    }

    if (!db) {
        return res.status(500).json({ valid: false, error: "Database service not initialized." });
    }

    try {
        const keyRef = db.collection('keys').doc(key);
        const keyDoc = await keyRef.get();

        if (!keyDoc.exists) {
            return res.status(404).json({ valid: false, error: "Key not found." });
        }

        const data = keyDoc.data();

        // Check ownership
        if (data.userId !== userId) {
            return res.status(403).json({ valid: false, error: "This key belongs to another user." });
        }

        // Check if revoked
        if (data.revoked) {
            return res.status(403).json({ valid: false, error: "This key has been revoked." });
        }

        // Check expiry
        if (Date.now() > data.expiresAt) {
            return res.status(403).json({ valid: false, error: "Key is expired. Please complete Linkvertise again." });
        }

        return res.json({ valid: true, expiresAt: data.expiresAt });

    } catch (error) {
        console.error("Verify key error:", error);
        return res.status(500).json({ valid: false, error: "Internal server error during verify." });
    }
});

// Start Express API server
app.listen(PORT, () => {
    console.log(`🚀 ApiKey system running successfully on port ${PORT}`);
});
