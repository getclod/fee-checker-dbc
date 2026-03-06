const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', '..', 'setting.json');

function readJsonFileSafe(p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
        return null;
    }
}

function normalizeUrl(u, fallback) {
    const s = String(u || '').trim();
    return s || fallback;
}

function loadSettings() {
    const raw = readJsonFileSafe(SETTINGS_PATH) || {};

    let rpcUrls = [];
    if (Array.isArray(raw.RPC_URLS) && raw.RPC_URLS.length > 0) {
        rpcUrls = raw.RPC_URLS.map(u => normalizeUrl(u, '')).filter(u => u);
    } else if (raw.RPC_URL) {
        rpcUrls = [normalizeUrl(raw.RPC_URL, '')].filter(u => u);
    }

    return {
        RPC_URL: rpcUrls[0] || '',
        RPC_URLS: rpcUrls,
        RPC_ORIGIN: normalizeUrl(raw.RPC_ORIGIN || process.env.RPC_ORIGIN, 'http://localhost'),
        JUPITER_API_KEY: String(raw.JUPITER_API_KEY || '').trim(),
        HELIUS_WS_URL: String(raw.HELIUS_WS_URL || '').trim(),
    };
}

module.exports = { loadSettings };
