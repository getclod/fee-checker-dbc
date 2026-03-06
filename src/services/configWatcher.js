// configWatcher.js — Monitor config/wallet addresses for new DBC pool deployments
// Polls Solana RPC for new transactions

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const CONFIGS_FILE = path.join(__dirname, '../../configs.txt');
const SEEN_FILE = path.join(__dirname, '../../.seen_sigs.json');

const POLL_INTERVAL = 30_000; // 30 seconds

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

// ──── Config file parsing ────────────────────────────────────────────────────

/**
 * Load watched wallets from configs.txt
 * Format: walletAddress:NAME (one per line)
 */
function loadWatchedConfigs() {
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

// ──── Seen signatures ────────────────────────────────────────────────────────

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

// ──── Transaction parsing ────────────────────────────────────────────────────

/**
 * Parse a DBC pool creation transaction
 */
function parsePoolCreation(tx) {
    if (!tx || !tx.meta || tx.meta.err) return null;

    const logs = tx.meta.logMessages || [];

    // Must be a DBC pool init
    const hasInitPool = logs.some(l =>
        l.includes('initialize_virtual_pool') || l.includes('evtInitializePool')
    );
    if (!hasInitPool) return null;

    let creator = null;
    let baseMint = null;
    let pool = null;
    let configUsed = null;
    let tokenName = '';
    let tokenSymbol = '';

    // Parse from log events
    for (const log of logs) {
        const creatorMatch = log.match(/"creator"\s*:\s*"([^"]+)"/);
        if (creatorMatch) creator = creatorMatch[1];

        const mintMatch = log.match(/"baseMint"\s*:\s*"([^"]+)"/);
        if (mintMatch) baseMint = mintMatch[1];

        const poolMatch = log.match(/"pool"\s*:\s*"([^"]+)"/);
        if (poolMatch) pool = poolMatch[1];

        const configMatch = log.match(/"config"\s*:\s*"([^"]+)"/);
        if (configMatch) configUsed = configMatch[1];

        const nameMatch = log.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) tokenName = nameMatch[1];

        const symbolMatch = log.match(/"symbol"\s*:\s*"([^"]+)"/);
        if (symbolMatch) tokenSymbol = symbolMatch[1];
    }

    // Fallback: parse from instruction accounts
    try {
        const accountKeys = tx.transaction.message.accountKeys || [];
        const keys = accountKeys.map(k => typeof k === 'string' ? k : (k.pubkey || k).toString());

        for (const ix of (tx.transaction.message.instructions || [])) {
            const programId = keys[ix.programIdIndex];
            if (programId === DBC_PROGRAM) {
                const accs = ix.accounts || [];
                if (accs.length >= 6) {
                    if (!configUsed) configUsed = keys[accs[0]]; // #1 Config
                    if (!creator) creator = keys[accs[2]];        // #3 Creator
                    if (!baseMint) baseMint = keys[accs[3]];      // #4 Base Mint
                    if (!pool) pool = keys[accs[5]];              // #6 Pool
                }
            }
        }
    } catch (_) { }

    if (!baseMint && !pool) return null;

    return { creator, baseMint, pool, configUsed, tokenName, tokenSymbol };
}

// ──── Check for new deployments ──────────────────────────────────────────────

async function checkForNewPools(connections, entry, seenSigs) {
    const pk = new PublicKey(entry.address);
    const key = entry.address;

    if (!seenSigs[key]) seenSigs[key] = [];

    try {
        const signatures = await tryRpc(connections, (conn) =>
            conn.getSignaturesForAddress(pk, { limit: 15 })
        );

        const newDeployments = [];

        for (const sig of signatures) {
            if (seenSigs[key].includes(sig.signature)) continue;

            try {
                const tx = await tryRpc(connections, (conn) =>
                    conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0 })
                );

                const result = parsePoolCreation(tx);
                if (result) {
                    newDeployments.push({ signature: sig.signature, ...result });
                }
            } catch (_) { }

            seenSigs[key].push(sig.signature);
        }

        return newDeployments;
    } catch (e) {
        console.error(`[${ts()}] [WATCHER] Error checking ${entry.address.slice(0, 8)}...: ${e.message}`);
        return [];
    }
}

// ──── Notification format ────────────────────────────────────────────────────

function shortAddr(addr) {
    if (!addr || addr.length < 14) return addr || '?';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatDeployNotification(ownerName, info) {
    const lines = [];
    lines.push(`🚀 <b>New Token Deployed!</b>`);
    lines.push(``);
    lines.push(`👤 Deployer: <b>${ownerName}</b>`);

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
        lines.push(`👑 Creator: <a href="https://solscan.io/account/${info.creator}">${shortAddr(info.creator)}</a>`);
    }

    if (info.pool) {
        lines.push(`🏊 Pool: <a href="https://solscan.io/account/${info.pool}">${shortAddr(info.pool)}</a>`);
    }

    lines.push(``);
    lines.push(`🔗 <a href="https://solscan.io/tx/${info.signature}">View Transaction</a>`);

    return lines.join('\n');
}

// ──── Main watcher loop ──────────────────────────────────────────────────────

function startConfigWatcher(onNewDeployment) {
    const connections = createWatcherConnections();
    const seenSigs = loadSeenSigs();

    console.log(`[${ts()}] [WATCHER] Config watcher starting...`);

    let isFirstRun = true;

    async function poll() {
        const entries = loadWatchedConfigs();
        if (entries.length === 0) return;

        for (const entry of entries) {
            try {
                const newDeployments = await checkForNewPools(connections, entry, seenSigs);

                if (!isFirstRun && newDeployments.length > 0) {
                    for (const info of newDeployments) {
                        console.log(`[${ts()}] [WATCHER] 🚀 New deploy! ${entry.name} | ${info.tokenSymbol || '?'} | Mint: ${info.baseMint}`);
                        const html = formatDeployNotification(entry.name, info);
                        onNewDeployment(entry.name, info, html);
                    }
                } else if (isFirstRun && newDeployments.length > 0) {
                    console.log(`[${ts()}] [WATCHER] Initial scan: ${newDeployments.length} existing txs for ${entry.name} (skipped)`);
                }
            } catch (e) {
                console.error(`[${ts()}] [WATCHER] Poll error for ${entry.name}: ${e.message}`);
            }
        }

        isFirstRun = false;
        saveSeenSigs(seenSigs);
    }

    poll().then(() => {
        console.log(`[${ts()}] [WATCHER] Initial scan complete. Polling every ${POLL_INTERVAL / 1000}s`);
        setInterval(poll, POLL_INTERVAL);
    });
}

module.exports = { startConfigWatcher, loadWatchedConfigs };
