'use strict';

const { Readable } = require('stream');

const ROUTE_HOP_HEADER = 'x-rblx-api-route-hop';
const LOCAL_CONFIG_PATH = '/api/server-config';

function cleanOrigin(value) {
    try {
        return new URL(String(value || '').trim()).origin.toLowerCase();
    } catch (e) {
        return '';
    }
}

function requestOrigin(req, configuredOrigin = '') {
    const configured = cleanOrigin(configuredOrigin);
    if (configured) return configured;

    const host = String(req.get('host') || '').trim();
    if (!host) return '';
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'https';
    return cleanOrigin(`${protocol}://${host}`);
}

function shouldForwardApiRequest({ path, currentOrigin, activeOrigin, routeHop = 0 }) {
    if (!String(path || '').startsWith('/api/')) return false;
    if (String(path || '').replace(/\/+$/, '') === LOCAL_CONFIG_PATH) return false;
    if (!currentOrigin || !activeOrigin || currentOrigin === activeOrigin) return false;
    return Number(routeHop || 0) < 1;
}

function forwardedRequestBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.body == null) return undefined;
    const contentType = String(req.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/x-www-form-urlencoded')) {
        return new URLSearchParams(req.body).toString();
    }
    if (contentType.includes('application/json') || typeof req.body === 'object') {
        return JSON.stringify(req.body);
    }
    return String(req.body);
}

function forwardedRequestHeaders(req, routeHop) {
    const headers = {};
    const safeHeaders = [
        'accept',
        'authorization',
        'content-type',
        'if-none-match',
        'origin',
        'user-agent',
        'x-firebase-appcheck',
        'x-request-id'
    ];
    for (const name of safeHeaders) {
        const value = req.get(name);
        if (value) headers[name] = value;
    }
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    if (clientIp) headers['x-forwarded-for'] = clientIp;
    headers[ROUTE_HOP_HEADER] = String(routeHop + 1);
    return headers;
}

function copyResponseHeaders(upstream, res) {
    const safeHeaders = [
        'cache-control',
        'content-disposition',
        'content-type',
        'etag',
        'last-modified',
        'location',
        'retry-after',
        'www-authenticate'
    ];
    for (const name of safeHeaders) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
    }
}

function installActiveApiRouting({
    app,
    getActiveApiUrl,
    normalizeActiveUrl = value => String(value || '').replace(/\/+$/, ''),
    serviceOrigin = '',
    fetchImpl = globalThis.fetch,
    logger = console
}) {
    if (!app || typeof app.use !== 'function') throw new TypeError('Express app is required.');
    if (typeof getActiveApiUrl !== 'function') throw new TypeError('getActiveApiUrl is required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch implementation is required.');

    app.use(async (req, res, next) => {
        const normalizedPath = String(req.path || '').replace(/\/+$/, '');
        if (!req.path.startsWith('/api/') || normalizedPath === LOCAL_CONFIG_PATH) return next();

        const routeHop = Number.parseInt(req.get(ROUTE_HOP_HEADER) || '0', 10) || 0;
        let activeBase = '';
        try {
            activeBase = normalizeActiveUrl(await getActiveApiUrl());
        } catch (error) {
            logger.warn?.('[API Routing] Could not resolve the active API server:', error.message);
            return next();
        }

        const activeOrigin = cleanOrigin(activeBase);
        const currentOrigin = requestOrigin(req, serviceOrigin);
        if (!shouldForwardApiRequest({ path: req.path, currentOrigin, activeOrigin, routeHop })) {
            if (routeHop >= 1 && req.path.startsWith('/api/') && currentOrigin !== activeOrigin) {
                return res.status(508).json({ success: false, error: 'API routing loop prevented.' });
            }
            return next();
        }

        const targetUrl = `${activeBase.replace(/\/+$/, '')}${req.originalUrl}`;
        try {
            const upstream = await fetchImpl(targetUrl, {
                method: req.method,
                headers: forwardedRequestHeaders(req, routeHop),
                body: forwardedRequestBody(req),
                redirect: 'manual'
            });

            res.status(upstream.status);
            copyResponseHeaders(upstream, res);
            res.setHeader('X-Roblox-Active-API', activeOrigin);

            if (!upstream.body || req.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
                return res.end();
            }

            const stream = Readable.fromWeb(upstream.body);
            stream.on('error', error => {
                logger.error?.('[API Routing] Upstream response failed:', error.message);
                if (!res.headersSent) res.status(502);
                res.end();
            });
            stream.pipe(res);
        } catch (error) {
            logger.error?.('[API Routing] Active API forwarding failed:', error.message);
            if (!res.headersSent) {
                return res.status(502).json({ success: false, error: 'Active API server is temporarily unavailable.' });
            }
            return res.end();
        }
    });
}

module.exports = {
    ROUTE_HOP_HEADER,
    cleanOrigin,
    requestOrigin,
    shouldForwardApiRequest,
    installActiveApiRouting
};
