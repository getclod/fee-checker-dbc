// configWatcher.js — Monitor wallet owners → auto-discover configs → detect deploys
// Flow: wallet create_config → config address → initialize_virtual_pool

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const CONFIGS_FILE = path.join(__dirname, '../../configs.txt');
const SEEN_FILE = path.join(__dirname, '../../.seen_sigs.json');
const DISCOVERED_FILE = path.join(__dirname, '../../.discovered_configs.json');

const POLL_INTERVAL = 10_000; // 10 seconds

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
        try {
            return await fn(conn);
        } catch (e) {
            lastErr = e;
            if (e.message && (e.message.includes('403') || e.message.includes('not allowed') || e.message.includes('429'))) {
                continue;
            }
            throw e;
        }
    }
    throw lastErr || new Error('All RPCs failed');
}

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ──── File parsing ───────────────────────────────────────────────────────────

function loadWatchedWallets() {
    if (!fs.existsSync(CONFIGS_FILE)) return [];
    const lines = fs.readFileSync(CONFIGS_FILE, 'utf8').split('\n');
    const entries = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [addr, ...nameParts] = trimmed.split(':');
        const address = addr.trim();
        const name = nameParts.join(':').trim() || 'Unknown';
        if (address && address.length >= 32) {
            entries.push({ address, name });
        }
    }
    return entries;
}

function loadSeenSigs() {
    try {
        if (fs.existsSync(SEEN_FILE)) return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    } catch (_) { }
    return {};
}

function saveSeenSigs(seen) {
    try {
        const trimmed = {};
        for (const [key, sigs] of Object.entries(seen)) {
            trimmed[key] = sigs.slice(-500);
        }
        fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
    } catch (_) { }
}

function loadDiscoveredConfigs() {
    try {
        if (fs.existsSync(DISCOVERED_FILE)) return JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
    } catch (_) { }
    return {};
}

function saveDiscoveredConfigs(discovered) {
    try {
        fs.writeFileSync(DISCOVERED_FILE, JSON.stringify(discovered, null, 2));
    } catch (_) { }
}

// ──── Step 1: Discover config addresses from wallet ──────────────────────────

async function discoverConfigs(connections, walletAddr, seenSigs, isInitial = false) {
    const pk = new PublicKey(walletAddr);
    const key = `wallet:${walletAddr}`;
    if (!seenSigs[key]) seenSigs[key] = [];

    const newConfigs = [];

    try {
        // Initial scan: paginate through ALL history to find every config
        // Regular poll: just check latest 20 for new activity
        let allSignatures = [];

        if (isInitial) {
            // Deep scan — paginate through full history
            let before = undefined;
            let pageCount = 0;
            while (pageCount < 10) { // Max 10 pages × 1000 = 10000 txs
                const opts = { limit: 1000 };
                if (before) opts.before = before;

                const page = await tryRpc(connections, (conn) =>
                    conn.getSignaturesForAddress(pk, opts)
                );
                if (!page || page.length === 0) break;

                allSignatures = allSignatures.concat(page);
                before = page[page.length - 1].signature;
                pageCount++;

                // If we got less than 1000, we've reached the end
                if (page.length < 1000) break;
            }
            console.log(`[${ts()}] [WATCHER] Deep scan: ${allSignatures.length} txs for wallet ${walletAddr.slice(0, 8)}...`);
        } else {
            // Light poll — only check latest
            allSignatures = await tryRpc(connections, (conn) =>
                conn.getSignaturesForAddress(pk, { limit: 20 })
            );
        }

        for (const sig of allSignatures) {
            if (seenSigs[key].includes(sig.signature)) continue;

            try {
                const tx = await tryRpc(connections, (conn) =>
                    conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
                );

                if (tx && tx.meta && !tx.meta.err) {
                    const logs = tx.meta.logMessages || [];
                    const logsJoined = logs.join(' ').toLowerCase();

                    // Check for create_config in various formats
                    const isCreateConfig = logsJoined.includes('create_config')
                        || logsJoined.includes('createconfig')
                        || logsJoined.includes('create_pool_config');

                    // Also check if this tx interacts with DBC program and creates a new account
                    let hasDBC = false;
                    let dbcConfigAddr = null;

                    try {
                        const accountKeys = tx.transaction.message.accountKeys || [];
                        const keys = accountKeys.map(k => typeof k === 'string' ? k : (k.pubkey || k).toString());

                        for (const ix of (tx.transaction.message.instructions || [])) {
                            const programId = keys[ix.programIdIndex];
                            if (programId === DBC_PROGRAM) {
                                hasDBC = true;
                                const accs = ix.accounts || [];
                                if (accs.length >= 1) {
                                    const candidateAddr = keys[accs[0]];
                                    if (candidateAddr && candidateAddr !== walletAddr && candidateAddr !== DBC_PROGRAM) {
                                        dbcConfigAddr = candidateAddr;
                                    }
                                }
                            }
                        }
                    } catch (_) { }

                    // If it's a create_config OR it's a DBC tx that's NOT a pool init and NOT a claim
                    const isPoolInit = logsJoined.includes('initialize_virtual_pool') || logsJoined.includes('evtinitializepool');
                    const isClaim = logsJoined.includes('claim');

                    if ((isCreateConfig || (hasDBC && !isPoolInit && !isClaim)) && dbcConfigAddr) {
                        newConfigs.push(dbcConfigAddr);
                        console.log(`[${ts()}] [WATCHER] 🔍 Discovered config: ${dbcConfigAddr}`);
                    }
                }
            } catch (_) { }

            seenSigs[key].push(sig.signature);
        }
    } catch (e) {
        console.error(`[${ts()}] [WATCHER] Error scanning wallet ${walletAddr.slice(0, 8)}...: ${e.message}`);
    }

    return newConfigs;
}

// ──── Step 2: Check config address for new pool deploys ──────────────────────

function parsePoolCreation(tx) {
    if (!tx || !tx.meta || tx.meta.err) return null;

    const logs = tx.meta.logMessages || [];
    const hasInitPool = logs.some(l =>
        l.includes('initialize_virtual_pool') || l.includes('evtInitializePool')
    );
    if (!hasInitPool) return null;

    let creator = null, baseMint = null, pool = null, configUsed = null;
    let tokenName = '', tokenSymbol = '';

    for (const log of logs) {
        const m1 = log.match(/"creator"\s*:\s*"([^"]+)"/); if (m1) creator = m1[1];
        const m2 = log.match(/"baseMint"\s*:\s*"([^"]+)"/); if (m2) baseMint = m2[1];
        const m3 = log.match(/"pool"\s*:\s*"([^"]+)"/); if (m3) pool = m3[1];
        const m4 = log.match(/"config"\s*:\s*"([^"]+)"/); if (m4) configUsed = m4[1];
        const m5 = log.match(/"name"\s*:\s*"([^"]+)"/); if (m5) tokenName = m5[1];
        const m6 = log.match(/"symbol"\s*:\s*"([^"]+)"/); if (m6) tokenSymbol = m6[1];
    }

    try {
        const accountKeys = tx.transaction.message.accountKeys || [];
        const keys = accountKeys.map(k => typeof k === 'string' ? k : (k.pubkey || k).toString());
        for (const ix of (tx.transaction.message.instructions || [])) {
            const programId = keys[ix.programIdIndex];
            if (programId === DBC_PROGRAM) {
                const accs = ix.accounts || [];
                if (accs.length >= 6) {
                    if (!configUsed) configUsed = keys[accs[0]];
                    if (!creator) creator = keys[accs[2]];
                    if (!baseMint) baseMint = keys[accs[3]];
                    if (!pool) pool = keys[accs[5]];
                }
            }
        }
    } catch (_) { }

    if (!baseMint && !pool) return null;
    return { creator, baseMint, pool, configUsed, tokenName, tokenSymbol };
}

async function checkConfigForDeploys(connections, configAddr, seenSigs) {
    const pk = new PublicKey(configAddr);
    const key = `config:${configAddr}`;
    if (!seenSigs[key]) seenSigs[key] = [];

    const newDeploys = [];

    try {
        const signatures = await tryRpc(connections, (conn) =>
            conn.getSignaturesForAddress(pk, { limit: 10 })
        );

        for (const sig of signatures) {
            if (seenSigs[key].includes(sig.signature)) continue;

            try {
                const tx = await tryRpc(connections, (conn) =>
                    conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
                );
                const result = parsePoolCreation(tx);
                if (result) {
                    newDeploys.push({ signature: sig.signature, ...result });
                }
            } catch (_) { }

            seenSigs[key].push(sig.signature);
        }
    } catch (e) {
        console.error(`[${ts()}] [WATCHER] Error checking config ${configAddr.slice(0, 8)}...: ${e.message}`);
    }

    return newDeploys;
}

// ──── Notification ───────────────────────────────────────────────────────────

function shortAddr(addr) {
    if (!addr || addr.length < 14) return addr || '?';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDeployNotification(ownerName, info) {
    const lines = [];
    lines.push(`🚀 <b>New Token Deployed!</b>`);
    lines.push(``);
    lines.push(`👤 Owner: <b>${ownerName}</b>`);

    if (info.tokenName || info.tokenSymbol) {
        lines.push(`🪙 ${info.tokenName || '?'} ($${info.tokenSymbol || '?'})`);
    }
    if (info.baseMint) {
        lines.push(`📦 Mint: <code>${info.baseMint}</code>`);
    }
    if (info.configUsed) {
        lines.push(`⚙️ Config: <a href="https://solscan.io/account/${info.configUsed}">${shortAddr(info.configUsed)}</a>`);
    }
    if (info.creator) {
        lines.push(`👑 Deployer: <a href="https://solscan.io/account/${info.creator}">${shortAddr(info.creator)}</a>`);
    }
    if (info.pool) {
        lines.push(`🏊 Pool: <a href="https://solscan.io/account/${info.pool}">${shortAddr(info.pool)}</a>`);
    }
    lines.push(``);
    lines.push(`🔗 <a href="https://solscan.io/tx/${info.signature}">View Transaction</a>`);

    return lines.join('\n');
}

function formatNewConfigNotification(ownerName, configAddr) {
    return [
        `🔧 <b>New Config Created!</b>`,
        ``,
        `👤 Owner: <b>${ownerName}</b>`,
        `⚙️ Config: <a href="https://solscan.io/account/${configAddr}">${shortAddr(configAddr)}</a>`,
        ``,
        `Now monitoring this config for new deployments.`,
    ].join('\n');
}

// ──── Main watcher ──────────────────────────────────────────────────────────

function startConfigWatcher(onNewDeployment, onNewConfig) {
    const connections = createWatcherConnections();
    const seenSigs = loadSeenSigs();
    const discovered = loadDiscoveredConfigs();

    console.log(`[${ts()}] [WATCHER] Config watcher starting...`);

    // Track active WebSocket subscriptions
    const activeSubscriptions = new Set();
    let wsConnection = null;

    // Create WebSocket connection for real-time monitoring
    function createWsConnection() {
        const settings = loadSettings();
        const rpcUrl = settings.RPC_URL || '';
        // Convert https:// to wss:// for WebSocket
        const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        return new Connection(wsUrl, {
            commitment: 'confirmed',
            wsEndpoint: wsUrl,
        });
    }

    // Subscribe to a config address for real-time deploy detection
    function subscribeToConfig(configAddr, ownerName) {
        if (activeSubscriptions.has(configAddr)) return;

        try {
            if (!wsConnection) wsConnection = createWsConnection();

            const configPk = new PublicKey(configAddr);
            const subId = wsConnection.onLogs(configPk, async (logs, ctx) => {
                try {
                    const logsStr = (logs.logs || []).join(' ').toLowerCase();
                    const hasPoolInit = logsStr.includes('initialize_virtual_pool')
                        || logsStr.includes('evtinitializepool');

                    if (!hasPoolInit) return;

                    const sig = logs.signature;
                    const seenKey = `config:${configAddr}`;
                    if (!seenSigs[seenKey]) seenSigs[seenKey] = [];
                    if (seenSigs[seenKey].includes(sig)) return;
                    seenSigs[seenKey].push(sig);

                    console.log(`[${ts()}] [WS] ⚡ Deploy detected on ${configAddr.slice(0, 8)}! Sig: ${sig.slice(0, 16)}...`);

                    // Fetch full transaction for details
                    try {
                        const tx = await tryRpc(connections, (conn) =>
                            conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 })
                        );

                        const info = parsePoolCreation(tx);
                        if (info) {
                            console.log(`[${ts()}] [WS] 🚀 ${ownerName} | ${info.tokenSymbol || '?'} | Mint: ${info.baseMint}`);
                            const html = formatDeployNotification(ownerName, info);
                            onNewDeployment(ownerName, { signature: sig, ...info }, html);
                        }
                    } catch (e) {
                        console.error(`[${ts()}] [WS] Error fetching tx: ${e.message}`);
                    }

                    saveSeenSigs(seenSigs);
                } catch (e) {
                    console.error(`[${ts()}] [WS] Error processing log: ${e.message}`);
                }
            }, 'confirmed');

            activeSubscriptions.add(configAddr);
        } catch (e) {
            console.error(`[${ts()}] [WS] Failed to subscribe ${configAddr.slice(0, 8)}: ${e.message}`);
        }
    }

    // Subscribe to all discovered configs
    function subscribeAll() {
        for (const [walletAddr, configs] of Object.entries(discovered)) {
            const wallets = loadWatchedWallets();
            const wallet = wallets.find(w => w.address === walletAddr);
            const name = wallet ? wallet.name : 'Unknown';

            for (const cfgAddr of configs) {
                subscribeToConfig(cfgAddr, name);
            }
        }
        console.log(`[${ts()}] [WS] Subscribed to ${activeSubscriptions.size} configs for real-time detection`);
    }

    // Polling: only for wallet config discovery (slower)
    const WALLET_POLL = 30_000; // 30s for wallet scan
    let isFirstRun = true;

    async function pollWallets() {
        const wallets = loadWatchedWallets();
        if (wallets.length === 0) return;

        for (const wallet of wallets) {
            try {
                const newConfigs = await discoverConfigs(connections, wallet.address, seenSigs, isFirstRun);
                if (!discovered[wallet.address]) discovered[wallet.address] = [];

                let addedNew = false;
                for (const cfgAddr of newConfigs) {
                    if (!discovered[wallet.address].includes(cfgAddr)) {
                        discovered[wallet.address].push(cfgAddr);
                        console.log(`[${ts()}] [WATCHER] ✅ Added config ${cfgAddr} for ${wallet.name}`);
                        addedNew = true;

                        // Immediately subscribe the new config to WebSocket
                        subscribeToConfig(cfgAddr, wallet.name);

                        if (!isFirstRun && onNewConfig) {
                            const html = formatNewConfigNotification(wallet.name, cfgAddr);
                            onNewConfig(wallet.name, cfgAddr, html);
                        }
                    }
                }

                // On first run, mark existing config sigs as seen (with delay to avoid 429)
                if (isFirstRun) {
                    const configsToWatch = discovered[wallet.address] || [];
                    for (const cfgAddr of configsToWatch) {
                        await checkConfigForDeploys(connections, cfgAddr, seenSigs);
                        await new Promise(r => setTimeout(r, 500)); // 500ms delay per config
                    }
                }
            } catch (e) {
                console.error(`[${ts()}] [WATCHER] Poll error for ${wallet.name}: ${e.message}`);
            }
        }

        if (isFirstRun) {
            const totalConfigs = Object.values(discovered).reduce((sum, arr) => sum + arr.length, 0);
            console.log(`[${ts()}] [WATCHER] Discovered ${totalConfigs} configs across ${wallets.length} wallets`);
        }

        isFirstRun = false;
        saveSeenSigs(seenSigs);
        saveDiscoveredConfigs(discovered);
    }

    // Start: initial scan → subscribe → poll
    pollWallets().then(() => {
        console.log(`[${ts()}] [WATCHER] Initial scan complete.`);

        // Subscribe all discovered configs to WebSocket
        subscribeAll();

        // Poll wallets for new configs every 30s
        console.log(`[${ts()}] [WATCHER] Wallet poll every ${WALLET_POLL / 1000}s | Deploys via WebSocket ⚡`);
        setInterval(pollWallets, WALLET_POLL);
    });
}

module.exports = { startConfigWatcher, loadWatchedWallets };

