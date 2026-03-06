// configWatcher.js — Monitor config addresses for new pool deployments
// Polls Solana RPC for new transactions on watched configs

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const CONFIGS_FILE = path.join(__dirname, '../../configs.txt');
const SEEN_FILE = path.join(__dirname, '../../.seen_sigs.json');

const POLL_INTERVAL = 30_000; // 30 seconds

// Use dedicated RPCs first, public as last fallback
function createWatcherConnection() {
    const settings = loadSettings();
    // All RPC URLs from settings + public fallback
    const rpcs = [
        ...(settings.RPC_URLS || [settings.RPC_URL]),
        'https://api.mainnet-beta.solana.com',
    ];
    return rpcs.map(url => new Connection(url, {
        commitment: 'confirmed',
    }));
}

// Try multiple RPCs until one works
async function tryRpc(connections, fn) {
    for (const conn of connections) {
        try {
            return await fn(conn);
        } catch (e) {
            if (e.message && (e.message.includes('403') || e.message.includes('not allowed') || e.message.includes('429'))) {
                continue; // Try next RPC
            }
            throw e;
        }
    }
    throw new Error('All RPCs failed');
}

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Load watched configs from configs.txt
 * Format: configAddress:NAME (one per line)
 */
function loadWatchedConfigs() {
    if (!fs.existsSync(CONFIGS_FILE)) return [];
    const lines = fs.readFileSync(CONFIGS_FILE, 'utf8').split('\n');
    const configs = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [addr, ...nameParts] = trimmed.split(':');
        const name = nameParts.join(':').trim() || 'Unknown';
        if (addr && addr.length >= 32) {
            configs.push({ address: addr.trim(), name });
        }
    }
    return configs;
}

/**
 * Load seen signatures to avoid duplicate notifications
 */
function loadSeenSigs() {
    try {
        if (fs.existsSync(SEEN_FILE)) {
            return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
        }
    } catch (_) { }
    return {};
}

function saveSeenSigs(seen) {
    try {
        // Keep only last 500 entries per config to prevent file from growing too large
        const trimmed = {};
        for (const [key, sigs] of Object.entries(seen)) {
            trimmed[key] = sigs.slice(-500);
        }
        fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
    } catch (_) { }
}

/**
 * Parse a pool creation transaction to extract token info
 */
function parsePoolCreation(tx, configAddress) {
    if (!tx || !tx.meta || tx.meta.err) return null;

    const logs = tx.meta.logMessages || [];

    // Check if this is a DBC pool creation
    const hasInitPool = logs.some(l =>
        l.includes('initialize_virtual_pool') || l.includes('evtInitializePool')
    );
    if (!hasInitPool) return null;

    // Extract from log events
    let creator = null;
    let baseMint = null;
    let pool = null;
    let tokenName = '';
    let tokenSymbol = '';

    // Parse event data from logs
    for (const log of logs) {
        if (log.includes('"creator"')) {
            const m = log.match(/"creator"\s*:\s*"([^"]+)"/);
            if (m) creator = m[1];
        }
        if (log.includes('"baseMint"')) {
            const m = log.match(/"baseMint"\s*:\s*"([^"]+)"/);
            if (m) baseMint = m[1];
        }
        if (log.includes('"pool"')) {
            const m = log.match(/"pool"\s*:\s*"([^"]+)"/);
            if (m) pool = m[1];
        }
    }

    // Try to get account keys
    try {
        const accountKeys = tx.transaction.message.accountKeys || [];
        const keys = accountKeys.map(k => typeof k === 'string' ? k : (k.pubkey || k).toString());

        // In initialize_virtual_pool_with_spl_token:
        // #1 = Config, #3 = Creator, #4 = Base Mint, #6 = Pool
        for (const ix of (tx.transaction.message.instructions || [])) {
            const programId = keys[ix.programIdIndex];
            if (programId === DBC_PROGRAM) {
                const accs = ix.accounts || [];
                if (accs.length >= 6) {
                    if (!creator) creator = keys[accs[2]]; // Creator
                    if (!baseMint) baseMint = keys[accs[3]]; // Base Mint
                    if (!pool) pool = keys[accs[5]]; // Pool
                }
            }
        }

        // Check inner instructions too
        if (tx.meta.innerInstructions) {
            for (const inner of tx.meta.innerInstructions) {
                for (const ix of (inner.instructions || [])) {
                    // Look for createMetadataAccountV3 to get token name/symbol
                    // The metadata is in the instruction data
                }
            }
        }
    } catch (_) { }

    // Try to extract name from log messages (Metaplex metadata)
    for (const log of logs) {
        if (log.includes('"name"')) {
            const m = log.match(/"name"\s*:\s*"([^"]+)"/);
            if (m) tokenName = m[1];
        }
        if (log.includes('"symbol"')) {
            const m = log.match(/"symbol"\s*:\s*"([^"]+)"/);
            if (m) tokenSymbol = m[1];
        }
    }

    if (!baseMint && !pool) return null;

    return { creator, baseMint, pool, tokenName, tokenSymbol };
}

/**
 * Check a config address for new pool deployments
 */
async function checkConfigForNewPools(connections, configAddr, seenSigs) {
    const configPk = new PublicKey(configAddr);
    const key = configAddr;

    if (!seenSigs[key]) seenSigs[key] = [];

    try {
        const signatures = await tryRpc(connections, (conn) =>
            conn.getSignaturesForAddress(configPk, { limit: 10 })
        );

        const newDeployments = [];

        for (const sig of signatures) {
            if (seenSigs[key].includes(sig.signature)) continue;

            try {
                const tx = await tryRpc(connections, (conn) =>
                    conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
                );

                const result = parsePoolCreation(tx, configAddr);
                if (result) {
                    newDeployments.push({ signature: sig.signature, ...result });
                }
            } catch (_) { }

            seenSigs[key].push(sig.signature);
        }

        return newDeployments;
    } catch (e) {
        console.error(`[${ts()}] [WATCHER] Error checking ${configAddr.slice(0, 8)}...: ${e.message}`);
        return [];
    }
}

/**
 * Format notification message for a new deployment
 */
function formatDeployNotification(ownerName, info) {
    const lines = [];
    lines.push(`🚀 <b>New Token Deployed!</b>`);
    lines.push(``);
    lines.push(`👤 Config: <b>${ownerName}</b>`);

    if (info.tokenName || info.tokenSymbol) {
        lines.push(`🪙 ${info.tokenName || '?'} (${info.tokenSymbol || '?'})`);
    }

    if (info.baseMint) {
        lines.push(`📦 Mint: <code>${info.baseMint}</code>`);
    }

    if (info.creator) {
        lines.push(`👑 Creator: <a href="https://solscan.io/account/${info.creator}">${info.creator.slice(0, 6)}...${info.creator.slice(-4)}</a>`);
    }

    if (info.pool) {
        lines.push(`🏊 Pool: <a href="https://solscan.io/account/${info.pool}">${info.pool.slice(0, 6)}...${info.pool.slice(-4)}</a>`);
    }

    lines.push(``);
    lines.push(`🔗 <a href="https://solscan.io/tx/${info.signature}">View Transaction</a>`);

    return lines.join('\n');
}

/**
 * Start the config watcher loop
 * @param {Function} onNewDeployment - callback(ownerName, info, formattedHtml)
 */
function startConfigWatcher(onNewDeployment) {
    const connections = createWatcherConnection();
    const seenSigs = loadSeenSigs();

    console.log(`[${ts()}] [WATCHER] Config watcher starting...`);

    // Initial run: mark existing sigs as seen (don't notify on startup)
    let isFirstRun = true;

    async function poll() {
        const configs = loadWatchedConfigs(); // Re-read each time so you can add configs live
        if (configs.length === 0) return;

        for (const cfg of configs) {
            try {
                const newDeployments = await checkConfigForNewPools(connections, cfg.address, seenSigs);

                if (!isFirstRun && newDeployments.length > 0) {
                    for (const info of newDeployments) {
                        console.log(`[${ts()}] [WATCHER] 🚀 New deployment detected! Config: ${cfg.name}, Mint: ${info.baseMint}`);
                        const html = formatDeployNotification(cfg.name, info);
                        onNewDeployment(cfg.name, info, html);
                    }
                } else if (isFirstRun && newDeployments.length > 0) {
                    console.log(`[${ts()}] [WATCHER] Initial scan: ${newDeployments.length} existing txs for ${cfg.name} (skipped)`);
                }
            } catch (e) {
                console.error(`[${ts()}] [WATCHER] Poll error for ${cfg.name}: ${e.message}`);
            }
        }

        isFirstRun = false;
        saveSeenSigs(seenSigs);
    }

    // Run immediately, then every POLL_INTERVAL
    poll().then(() => {
        console.log(`[${ts()}] [WATCHER] Initial scan complete. Polling every ${POLL_INTERVAL / 1000}s`);
        setInterval(poll, POLL_INTERVAL);
    });
}

module.exports = { startConfigWatcher, loadWatchedConfigs };
