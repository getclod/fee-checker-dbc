// configWatcher.js — Monitor wallet owners → auto-discover configs → detect deploys
// Hybrid: WebSocket for instant detection + polling backup with RPC rotation

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const CONFIGS_FILE = path.join(__dirname, '../../configs.txt');
const SEEN_FILE = path.join(__dirname, '../../.seen_sigs.json');
const DISCOVERED_FILE = path.join(__dirname, '../../.discovered_configs.json');

// ──── RPC ────────────────────────────────────────────────────────────────────

function createWatcherConnections() {
    const settings = loadSettings();
    const rpcs = [
        ...(settings.RPC_URLS || [settings.RPC_URL]),
        'https://api.mainnet-beta.solana.com',
    ];
    return rpcs.map(url => new Connection(url, { commitment: 'confirmed' }));
}

async function tryRpc(connections, fn) {
    let lastErr;
    for (const conn of connections) {
        try { return await fn(conn); } catch (e) {
            lastErr = e;
            if (e.message && (e.message.includes('403') || e.message.includes('not allowed') || e.message.includes('429'))) continue;
            throw e;
        }
    }
    throw lastErr || new Error('All RPCs failed');
}

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ──── File I/O ───────────────────────────────────────────────────────────────

function loadWatchedWallets() {
    if (!fs.existsSync(CONFIGS_FILE)) return [];
    return fs.readFileSync(CONFIGS_FILE, 'utf8').split('\n')
        .map(l => l.trim()).filter(l => l && !l.startsWith('#'))
        .map(l => { const [a, ...n] = l.split(':'); return { address: a.trim(), name: n.join(':').trim() || 'Unknown' }; })
        .filter(e => e.address.length >= 32);
}

function loadSeenSigs() {
    try { if (fs.existsSync(SEEN_FILE)) return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch (_) { }
    return {};
}

function saveSeenSigs(seen) {
    try {
        const t = {};
        for (const [k, s] of Object.entries(seen)) t[k] = s.slice(-500);
        fs.writeFileSync(SEEN_FILE, JSON.stringify(t, null, 2));
    } catch (_) { }
}

function loadDiscoveredConfigs() {
    try { if (fs.existsSync(DISCOVERED_FILE)) return JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8')); } catch (_) { }
    return {};
}

function saveDiscoveredConfigs(d) {
    try { fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(d, null, 2)); } catch (_) { }
}

// ──── Wallet scan: discover configs ──────────────────────────────────────────

async function discoverConfigs(connections, walletAddr, seenSigs, isInitial) {
    const pk = new PublicKey(walletAddr);
    const key = `wallet:${walletAddr}`;
    if (!seenSigs[key]) seenSigs[key] = [];
    const newConfigs = [];

    try {
        let allSigs = [];
        if (isInitial) {
            // Scan last 500 txs — enough to find create_config
            allSigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, { limit: 500 }));
            console.log(`[${ts()}] [WATCHER] Scan: ${allSigs.length} txs for wallet ${walletAddr.slice(0, 8)}...`);
        } else {
            allSigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, { limit: 20 }));
        }

        for (const sig of allSigs) {
            if (seenSigs[key].includes(sig.signature)) continue;
            try {
                const tx = await tryRpc(connections, c => c.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 }));
                if (tx && tx.meta && !tx.meta.err) {
                    const logs = tx.meta.logMessages || [];
                    const logsLower = logs.join(' ').toLowerCase();
                    const isCreate = logsLower.includes('create_config') || logsLower.includes('createconfig');
                    let hasDBC = false, dbcAddr = null;

                    try {
                        const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string' ? k : (k.pubkey || k)).toString());
                        for (const ix of (tx.transaction.message.instructions || [])) {
                            if (keys[ix.programIdIndex] === DBC_PROGRAM) {
                                hasDBC = true;
                                const a = ix.accounts || [];
                                if (a.length >= 1) {
                                    const c = keys[a[0]];
                                    if (c && c !== walletAddr && c !== DBC_PROGRAM) dbcAddr = c;
                                }
                            }
                        }
                    } catch (_) { }

                    const isPool = logsLower.includes('initializevirtualpool') || logsLower.includes('initialize_virtual_pool');
                    const isClaim = logsLower.includes('claim');
                    if ((isCreate || (hasDBC && !isPool && !isClaim)) && dbcAddr) {
                        newConfigs.push(dbcAddr);
                    }
                }
            } catch (_) { }
            seenSigs[key].push(sig.signature);
        }
    } catch (e) {
        console.error(`[${ts()}] [WATCHER] Wallet scan error ${walletAddr.slice(0, 8)}: ${e.message}`);
    }
    return newConfigs;
}

// ──── Pool creation parser ───────────────────────────────────────────────────

function parsePoolCreation(tx) {
    if (!tx || !tx.meta || tx.meta.err) return null;
    const logs = tx.meta.logMessages || [];
    const logsLower = logs.join(' ').toLowerCase();
    if (!logsLower.includes('initializevirtualpool') && !logsLower.includes('initialize_virtual_pool') && !logsLower.includes('evtinitializepool')) return null;

    let creator = null, baseMint = null, pool = null, configUsed = null, tokenName = '', tokenSymbol = '';
    for (const log of logs) {
        const m1 = log.match(/"creator"\s*:\s*"([^"]+)"/); if (m1) creator = m1[1];
        const m2 = log.match(/"baseMint"\s*:\s*"([^"]+)"/); if (m2) baseMint = m2[1];
        const m3 = log.match(/"pool"\s*:\s*"([^"]+)"/); if (m3) pool = m3[1];
        const m4 = log.match(/"config"\s*:\s*"([^"]+)"/); if (m4) configUsed = m4[1];
        const m5 = log.match(/"name"\s*:\s*"([^"]+)"/); if (m5) tokenName = m5[1];
        const m6 = log.match(/"symbol"\s*:\s*"([^"]+)"/); if (m6) tokenSymbol = m6[1];
    }
    try {
        const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string' ? k : (k.pubkey || k)).toString());
        for (const ix of (tx.transaction.message.instructions || [])) {
            if (keys[ix.programIdIndex] === DBC_PROGRAM) {
                const a = ix.accounts || [];
                if (a.length >= 6) {
                    if (!configUsed) configUsed = keys[a[0]];
                    if (!creator) creator = keys[a[2]];
                    if (!baseMint) baseMint = keys[a[3]];
                    if (!pool) pool = keys[a[5]];
                }
            }
        }
    } catch (_) { }
    if (!baseMint && !pool) return null;
    return { creator, baseMint, pool, configUsed, tokenName, tokenSymbol };
}

// ──── Notification format ────────────────────────────────────────────────────

function shortAddr(a) { return (!a || a.length < 14) ? (a || '?') : `${a.slice(0, 6)}...${a.slice(-4)}`; }

function formatDeployNotification(ownerName, info) {
    const L = [];
    L.push(`🚀 <b>New Token Deployed!</b>`);
    L.push(``);
    L.push(`👤 Owner: <b>${ownerName}</b>`);
    if (info.tokenName || info.tokenSymbol) L.push(`🪙 ${info.tokenName || '?'} ($${info.tokenSymbol || '?'})`);
    if (info.baseMint) L.push(`📦 Mint: <code>${info.baseMint}</code>`);
    if (info.configUsed) L.push(`⚙️ Config: <a href="https://solscan.io/account/${info.configUsed}">${shortAddr(info.configUsed)}</a>`);
    if (info.creator) L.push(`👑 Deployer: <a href="https://solscan.io/account/${info.creator}">${shortAddr(info.creator)}</a>`);
    if (info.pool) L.push(`🏊 Pool: <a href="https://solscan.io/account/${info.pool}">${shortAddr(info.pool)}</a>`);
    L.push(``);
    L.push(`🔗 <a href="https://solscan.io/tx/${info.signature}">View Transaction</a>`);
    return L.join('\n');
}

function formatNewConfigNotification(ownerName, configAddr) {
    return [
        `🔧 <b>New Config Created!</b>`, ``,
        `👤 Owner: <b>${ownerName}</b>`,
        `⚙️ Config: <a href="https://solscan.io/account/${configAddr}">${shortAddr(configAddr)}</a>`,
        ``, `Now monitoring this config for new deployments.`,
    ].join('\n');
}

// ──── Main watcher ──────────────────────────────────────────────────────────

function startConfigWatcher(onNewDeployment, onNewConfig) {
    const connections = createWatcherConnections();
    const seenSigs = loadSeenSigs();
    const discovered = loadDiscoveredConfigs();

    console.log(`[${ts()}] [WATCHER] Config watcher starting...`);

    // ── WebSocket (instant detection) ────────────────────────────────
    let wsConnection = null;
    const activeWsSubs = new Set();

    function subscribeWs(configAddr, ownerName) {
        if (activeWsSubs.has(configAddr)) return;
        try {
            if (!wsConnection) {
                const settings = loadSettings();
                const rpcUrl = settings.RPC_URL || '';
                // Use dedicated WS URL if available, otherwise convert RPC URL
                const wsUrl = settings.HELIUS_WS_URL || rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
                console.log(`[${ts()}] [WS] Connecting to ${wsUrl.slice(0, 50)}...`);
                wsConnection = new Connection(rpcUrl, { commitment: 'confirmed', wsEndpoint: wsUrl });
            }
            wsConnection.onLogs(new PublicKey(configAddr), async (logs) => {
                try {
                    const ll = (logs.logs || []).join(' ').toLowerCase();
                    if (!ll.includes('initializevirtualpool') && !ll.includes('initialize_virtual_pool') && !ll.includes('evtinitializepool')) return;
                    const sig = logs.signature;
                    const sk = `config:${configAddr}`;
                    if (!seenSigs[sk]) seenSigs[sk] = [];
                    if (seenSigs[sk].includes(sig)) return;
                    seenSigs[sk].push(sig);
                    console.log(`[${ts()}] [WS] ⚡ Deploy! Config: ${configAddr.slice(0, 8)}...`);
                    const tx = await tryRpc(connections, c => c.getTransaction(sig, { maxSupportedTransactionVersion: 0 }));
                    const info = parsePoolCreation(tx);
                    if (info) {
                        console.log(`[${ts()}] [WS] 🚀 ${ownerName} | ${info.tokenSymbol || '?'} | ${info.baseMint}`);
                        const html = formatDeployNotification(ownerName, info);
                        onNewDeployment(ownerName, { signature: sig, ...info }, html);
                    }
                    saveSeenSigs(seenSigs);
                } catch (e) { console.error(`[${ts()}] [WS] Error: ${e.message}`); }
            }, 'confirmed');
            activeWsSubs.add(configAddr);
        } catch (e) {
            console.error(`[${ts()}] [WS] Sub fail ${configAddr.slice(0, 8)}: ${e.message}`);
        }
    }

    // ── Polling backup (rotates RPCs, checks 3 configs per 5s) ───────

    let pollIdx = 0;
    const BATCH = 3;
    const POLL_MS = 5000;

    function getAllConfigEntries() {
        const all = [];
        const wallets = loadWatchedWallets();
        for (const [wa, cfgs] of Object.entries(discovered)) {
            const w = wallets.find(x => x.address === wa);
            const name = w ? w.name : 'Unknown';
            for (const c of cfgs) all.push({ addr: c, name });
        }
        return all;
    }

    async function pollBatch() {
        const all = getAllConfigEntries();
        if (all.length === 0) return;

        const batch = [];
        for (let i = 0; i < BATCH; i++) {
            if (pollIdx >= all.length) pollIdx = 0;
            batch.push(all[pollIdx++]);
        }

        await Promise.all(batch.map(async (item, i) => {
            const conn = connections[i % connections.length];
            try {
                const sigs = await conn.getSignaturesForAddress(new PublicKey(item.addr), { limit: 5 });
                const sk = `config:${item.addr}`;
                if (!seenSigs[sk]) seenSigs[sk] = [];

                for (const s of sigs) {
                    if (seenSigs[sk].includes(s.signature)) continue;
                    seenSigs[sk].push(s.signature);
                    try {
                        const tx = await tryRpc(connections, c => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
                        const info = parsePoolCreation(tx);
                        if (info) {
                            console.log(`[${ts()}] [POLL] 🚀 ${item.name} | ${info.tokenSymbol || '?'} | ${info.baseMint}`);
                            const html = formatDeployNotification(item.name, info);
                            onNewDeployment(item.name, { signature: s.signature, ...info }, html);
                        }
                    } catch (_) { }
                }
            } catch (_) { }
        }));
        saveSeenSigs(seenSigs);
    }

    // ── Wallet discovery (30s) ───────────────────────────────────────

    let isFirstRun = true;

    async function pollWallets() {
        const wallets = loadWatchedWallets();
        for (const wallet of wallets) {
            try {
                const newCfgs = await discoverConfigs(connections, wallet.address, seenSigs, isFirstRun);
                if (!discovered[wallet.address]) discovered[wallet.address] = [];
                for (const c of newCfgs) {
                    if (!discovered[wallet.address].includes(c)) {
                        discovered[wallet.address].push(c);
                        console.log(`[${ts()}] [WATCHER] ✅ Config ${c} → ${wallet.name}`);
                        subscribeWs(c, wallet.name);
                        if (!isFirstRun && onNewConfig) onNewConfig(wallet.name, c, formatNewConfigNotification(wallet.name, c));
                    }
                }
                if (isFirstRun) {
                    for (const c of (discovered[wallet.address] || [])) {
                        // Mark existing sigs as seen
                        try {
                            const sigs = await tryRpc(connections, cn => cn.getSignaturesForAddress(new PublicKey(c), { limit: 10 }));
                            const sk = `config:${c}`;
                            if (!seenSigs[sk]) seenSigs[sk] = [];
                            for (const s of sigs) {
                                if (!seenSigs[sk].includes(s.signature)) seenSigs[sk].push(s.signature);
                            }
                        } catch (_) { }
                        await new Promise(r => setTimeout(r, 300));
                    }
                }
            } catch (e) {
                console.error(`[${ts()}] [WATCHER] Error ${wallet.name}: ${e.message}`);
            }
        }
        if (isFirstRun) {
            const total = Object.values(discovered).reduce((s, a) => s + a.length, 0);
            console.log(`[${ts()}] [WATCHER] Discovered ${total} configs across ${wallets.length} wallets`);
        }
        isFirstRun = false;
        saveSeenSigs(seenSigs);
        saveDiscoveredConfigs(discovered);
    }

    // ── Boot ─────────────────────────────────────────────────────────

    pollWallets().then(() => {
        console.log(`[${ts()}] [WATCHER] Initial scan complete.`);

        // Subscribe WebSocket
        const wallets = loadWatchedWallets();
        for (const [wa, cfgs] of Object.entries(discovered)) {
            const w = wallets.find(x => x.address === wa);
            for (const c of cfgs) subscribeWs(c, w ? w.name : 'Unknown');
        }
        console.log(`[${ts()}] [WS] ${activeWsSubs.size} subscriptions`);

        // Start backup polling: 3 configs every 5s → full cycle ~62s for 37 configs
        setInterval(pollBatch, POLL_MS);
        console.log(`[${ts()}] [POLL] Backup: ${BATCH} configs / ${POLL_MS / 1000}s`);

        // Wallet discovery every 30s
        setInterval(pollWallets, 30000);
        console.log(`[${ts()}] [WATCHER] Wallet poll every 30s`);
    });
}

module.exports = { startConfigWatcher, loadWatchedWallets };
