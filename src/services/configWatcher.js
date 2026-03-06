// configWatcher.js — Monitor wallet owners → auto-discover configs → detect deploys
// Hybrid: WebSocket for instant detection + polling backup with RPC rotation

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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
    return rpcs.map(url => new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true }));
}

async function tryRpc(connections, fn, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        for (const conn of connections) {
            try { return await fn(conn); } catch (e) {
                lastErr = e;
                const msg = e.message || '';
                if (msg.includes('429') || msg.includes('Too many') || msg.includes('502') || msg.includes('503') || msg.includes('Bad gateway') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                if (msg.includes('403') || msg.includes('not allowed')) continue;
                throw e;
            }
        }
    }
    throw lastErr || new Error('All RPCs failed');
}

function shortErr(e) { const m = (e.message || String(e)).replace(/<[^>]*>/g, '').slice(0, 80); return m; }

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
            // Paginate to get ALL txs
            let before = undefined;
            while (true) {
                const opts = { limit: 1000 };
                if (before) opts.before = before;
                const batch = await tryRpc(connections, c => c.getSignaturesForAddress(pk, opts));
                if (batch.length === 0) break;
                allSigs.push(...batch);
                if (batch.length < 1000) break;
                before = batch[batch.length - 1].signature;
                await new Promise(r => setTimeout(r, 300));
            }
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
        console.error(`[${ts()}] [WATCHER] Wallet scan error ${walletAddr.slice(0, 8)}: ${shortErr(e)}`);
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

    // Parse from logs
    for (const log of logs) {
        const m1 = log.match(/"creator"\s*:\s*"([^"]+)"/); if (m1) creator = m1[1];
        const m2 = log.match(/"baseMint"\s*:\s*"([^"]+)"/); if (m2) baseMint = m2[1];
        const m3 = log.match(/"pool"\s*:\s*"([^"]+)"/); if (m3) pool = m3[1];
        const m4 = log.match(/"config"\s*:\s*"([^"]+)"/); if (m4) configUsed = m4[1];
        const m5 = log.match(/"name"\s*:\s*"([^"]+)"/); if (m5) tokenName = m5[1];
        const m6 = log.match(/"symbol"\s*:\s*"([^"]+)"/); if (m6) tokenSymbol = m6[1];
    }

    // Parse from instruction accounts
    try {
        const accountKeys = tx.transaction.message.accountKeys || [];
        const staticKeys = tx.transaction.message.staticAccountKeys || [];
        const allKeys = (accountKeys.length > 0 ? accountKeys : staticKeys).map(k => (typeof k === 'string' ? k : (k.pubkey || k)).toString());
        // Also add loaded addresses (for versioned txs)
        if (tx.meta.loadedAddresses) {
            if (tx.meta.loadedAddresses.writable) allKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toString()));
            if (tx.meta.loadedAddresses.readonly) allKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toString()));
        }

        for (const ix of (tx.transaction.message.instructions || [])) {
            const pid = allKeys[ix.programIdIndex];
            if (pid === DBC_PROGRAM) {
                const a = ix.accounts || [];
                if (a.length >= 6) {
                    if (!configUsed) configUsed = allKeys[a[0]];
                    if (!creator) creator = allKeys[a[2]];
                    if (!baseMint) baseMint = allKeys[a[3]];
                    if (!pool) pool = allKeys[a[5]];
                }
            }
        }

        // Parse token name/symbol from inner instructions (Metaplex createMetadataAccountV3)
        const innerIxs = tx.meta.innerInstructions || [];
        for (const inner of innerIxs) {
            for (const iix of (inner.instructions || [])) {
                // Metaplex metadata program
                const pid = allKeys[iix.programIdIndex];
                if (pid === 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' && iix.data) {
                    try {
                        const buf = Buffer.from(iix.data, 'base64');
                        // createMetadataAccountV3 discriminator = 33
                        if (buf.length > 10 && buf[0] === 33) {
                            let offset = 1 + 4; // skip discriminator + name length prefix position
                            // Read name length (4 bytes LE)
                            const nameLen = buf.readUInt32LE(1);
                            if (nameLen > 0 && nameLen < 200) {
                                tokenName = buf.slice(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
                                offset += nameLen;
                                // Read symbol length (4 bytes LE)
                                const symLen = buf.readUInt32LE(offset);
                                offset += 4;
                                if (symLen > 0 && symLen < 50) {
                                    tokenSymbol = buf.slice(offset, offset + symLen).toString('utf8').replace(/\0/g, '').trim();
                                }
                            }
                        }
                    } catch (_) { }
                }
            }
        }
    } catch (_) { }

    if (!baseMint && !pool) return null;
    return { creator, baseMint, pool, configUsed, tokenName, tokenSymbol };
}

// Fetch token name/symbol via Helius DAS API
async function fetchTokenMeta(mintAddr) {
    const settings = loadSettings();
    const rpcUrl = settings.RPC_URL || '';
    try {
        const body = JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getAsset',
            params: { id: mintAddr }
        });
        const res = await new Promise((resolve, reject) => {
            const url = new URL(rpcUrl);
            const mod = url.protocol === 'https:' ? https : http;
            const req = mod.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (resp) => {
                let data = '';
                resp.on('data', c => data += c);
                resp.on('end', () => resolve(JSON.parse(data)));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        if (res.result && res.result.content) {
            const meta = res.result.content.metadata || {};
            const links = res.result.content.links || {};
            const files = res.result.content.files || [];
            return {
                name: meta.name || '',
                symbol: meta.symbol || '',
                image: links.image || (files.length > 0 ? files[0].uri : '') || '',
            };
        }
    } catch (_) { }
    return null;
}

// ──── Notification format ────────────────────────────────────────────────────

function shortAddr(a) { return (!a || a.length < 14) ? (a || '?') : `${a.slice(0, 6)}...${a.slice(-4)}`; }

function formatDeployNotification(ownerName, info) {
    const L = [];
    L.push(`🚀 <b>New Token Deployed!</b>`);
    L.push(`👤 Dev: <b>${ownerName}</b>`);
    L.push(``);
    if (info.tokenName || info.tokenSymbol) L.push(`🪙 ${info.tokenName || '?'} - $${info.tokenSymbol || '?'}`);
    if (info.baseMint) L.push(`<code>${info.baseMint}</code>`);
    L.push(``);
    if (info.creator) L.push(`👑 Deployer: <a href="https://solscan.io/account/${info.creator}">${shortAddr(info.creator)}</a>`);
    if (info.configUsed) L.push(`⚙️ Config: <a href="https://solscan.io/account/${info.configUsed}">${shortAddr(info.configUsed)}</a>`);
    if (info.configCreator) L.push(`🔑 Config Creator: <a href="https://solscan.io/account/${info.configCreator}">${shortAddr(info.configCreator)}</a>`);
    if (info.signature) L.push(`🔗 <a href="https://solscan.io/tx/${info.signature}">View Transaction</a>`);
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

    function subscribeWs(configAddr, ownerName, walletAddr) {
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
                        info.signature = sig;
                        info.configCreator = walletAddr;
                        // Wait for indexer then fetch token metadata
                        if (info.baseMint) {
                            await new Promise(r => setTimeout(r, 3000)); // Wait 3s for indexer
                            let meta = await fetchTokenMeta(info.baseMint);
                            if (meta && !meta.image) {
                                // Retry once after 3s more if no image
                                await new Promise(r => setTimeout(r, 3000));
                                meta = await fetchTokenMeta(info.baseMint);
                            }
                            if (meta) {
                                if (!info.tokenName) info.tokenName = meta.name;
                                if (!info.tokenSymbol) info.tokenSymbol = meta.symbol;
                                if (meta.image) info.image = meta.image;
                            }
                        }
                        console.log(`[${ts()}] [WS] 🚀 ${ownerName} | ${info.tokenName || '?'} ($${info.tokenSymbol || '?'}) | Mint: ${info.baseMint}`);
                        const html = formatDeployNotification(ownerName, info);
                        onNewDeployment(ownerName, info, html);
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
            for (const c of cfgs) all.push({ addr: c, name, walletAddr: wa });
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
                            info.signature = s.signature;
                            info.configCreator = item.walletAddr;
                            if (info.baseMint) {
                                await new Promise(r => setTimeout(r, 3000));
                                let meta = await fetchTokenMeta(info.baseMint);
                                if (meta && !meta.image) {
                                    await new Promise(r => setTimeout(r, 3000));
                                    meta = await fetchTokenMeta(info.baseMint);
                                }
                                if (meta) {
                                    if (!info.tokenName) info.tokenName = meta.name;
                                    if (!info.tokenSymbol) info.tokenSymbol = meta.symbol;
                                    if (meta.image) info.image = meta.image;
                                }
                            }
                            console.log(`[${ts()}] [POLL] 🚀 ${item.name} | ${info.tokenName || '?'} ($${info.tokenSymbol || '?'}) | Mint: ${info.baseMint}`);
                            const html = formatDeployNotification(item.name, info);
                            onNewDeployment(item.name, info, html);
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
                        subscribeWs(c, wallet.name, wallet.address);
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
            for (const c of cfgs) subscribeWs(c, w ? w.name : 'Unknown', wa);
        }
        console.log(`[${ts()}] [WS] ${activeWsSubs.size} subscriptions`);

        // Start backup polling: 3 configs every 5s → full cycle ~62s for 37 configs
        setInterval(pollBatch, POLL_MS);
        console.log(`[${ts()}] [POLL] Backup: ${BATCH} configs / ${POLL_MS / 1000}s`);

        // Wallet discovery every 10s
        setInterval(pollWallets, 10000);
        console.log(`[${ts()}] [WATCHER] Wallet poll every 10s`);
    });
}

module.exports = { startConfigWatcher, loadWatchedWallets };
