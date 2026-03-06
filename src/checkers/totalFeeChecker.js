// totalFeeChecker.js — Get total fees earned across all pools for a config creator wallet
// Optimized: uses discovered_configs.json cache, parallel processing

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const { getClaimableFees } = require('./feeChecker');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const DISCOVERED_FILE = path.join(__dirname, '../../.discovered_configs.json');

function createConnections() {
    const settings = loadSettings();
    const rpcs = [settings.RPC_URL, ...(settings.RPC_URLS || [])].filter(Boolean);
    return rpcs.map(url => new Connection(url, { commitment: 'confirmed' }));
}

async function tryRpc(connections, fn) {
    let lastErr;
    for (const conn of connections) {
        try { return await fn(conn); } catch (e) {
            lastErr = e;
            const msg = e.message || '';
            if (msg.includes('429') || msg.includes('502') || msg.includes('403') || msg.includes('ETIMEDOUT')) continue;
            throw e;
        }
    }
    throw lastErr || new Error('All RPCs failed');
}

/**
 * Get configs from discovered_configs.json cache (instant!) or fallback to tx scan.
 */
function getConfigsFromCache(walletAddr) {
    try {
        if (fs.existsSync(DISCOVERED_FILE)) {
            const data = JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
            if (data[walletAddr] && data[walletAddr].length > 0) {
                return data[walletAddr];
            }
        }
    } catch (_) { }
    return null;
}

/**
 * Fallback: scan wallet txs to find configs (slow).
 */
async function findConfigsByCreator(connections, walletAddr) {
    const pk = new PublicKey(walletAddr);
    const configs = [];

    try {
        const sigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, { limit: 1000 }));

        for (let i = 0; i < sigs.length; i += 10) {
            const batch = sigs.slice(i, i + 10);
            const results = await Promise.allSettled(
                batch.map(s => tryRpc(connections, c => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })))
            );

            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const tx = r.value;
                if (!tx.meta || tx.meta.err) continue;
                const logs = (tx.meta.logMessages || []).join(' ').toLowerCase();
                if (!logs.includes('createconfig') && !logs.includes('create_config')) continue;

                try {
                    const accountKeys = tx.transaction.message.accountKeys || [];
                    const staticKeys = tx.transaction.message.staticAccountKeys || [];
                    const allKeys = (accountKeys.length > 0 ? accountKeys : staticKeys).map(k => (typeof k === 'string' ? k : (k.pubkey || k)).toString());
                    if (tx.meta.loadedAddresses) {
                        if (tx.meta.loadedAddresses.writable) allKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toString()));
                        if (tx.meta.loadedAddresses.readonly) allKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toString()));
                    }

                    for (const ix of (tx.transaction.message.instructions || [])) {
                        const pid = allKeys[ix.programIdIndex];
                        if (pid === DBC_PROGRAM) {
                            const a = ix.accounts || [];
                            if (a.length >= 2) {
                                const configAddr = allKeys[a[0]];
                                if (configAddr && !configs.includes(configAddr)) configs.push(configAddr);
                            }
                        }
                    }
                } catch (_) { }
            }

            if (i + 10 < sigs.length) await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) {
        console.error(`[totalFee] Scan error: ${(e.message || '').slice(0, 80)}`);
    }

    return configs;
}

/**
 * Find all pool addresses for a given config address.
 * Scans config's transaction history for initialize_virtual_pool.
 */
async function findPoolsByConfig(connections, configAddr) {
    const pools = [];
    try {
        const pk = new PublicKey(configAddr);
        const sigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, { limit: 200 }));

        for (let i = 0; i < sigs.length; i += 10) {
            const batch = sigs.slice(i, i + 10);
            const results = await Promise.allSettled(
                batch.map(s => tryRpc(connections, c => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })))
            );

            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const tx = r.value;
                if (!tx.meta || tx.meta.err) continue;
                const logs = (tx.meta.logMessages || []).join(' ').toLowerCase();
                if (!logs.includes('initializevirtualpool') && !logs.includes('initialize_virtual_pool')) continue;

                try {
                    const accountKeys = tx.transaction.message.accountKeys || [];
                    const staticKeys = tx.transaction.message.staticAccountKeys || [];
                    const allKeys = (accountKeys.length > 0 ? accountKeys : staticKeys).map(k => (typeof k === 'string' ? k : (k.pubkey || k)).toString());
                    if (tx.meta.loadedAddresses) {
                        if (tx.meta.loadedAddresses.writable) allKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toString()));
                        if (tx.meta.loadedAddresses.readonly) allKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toString()));
                    }

                    for (const ix of (tx.transaction.message.instructions || [])) {
                        const pid = allKeys[ix.programIdIndex];
                        if (pid === DBC_PROGRAM) {
                            const a = ix.accounts || [];
                            if (a.length >= 6) {
                                const poolAddr = allKeys[a[5]];
                                const baseMint = allKeys[a[3]];
                                if (poolAddr && !pools.find(p => p.address === poolAddr)) {
                                    pools.push({ address: poolAddr, baseMint, config: configAddr });
                                }
                            }
                        }
                    }
                } catch (_) { }
            }

            if (i + 10 < sigs.length) await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) {
        console.error(`[totalFee] Pools error ${configAddr.slice(0, 8)}: ${(e.message || '').slice(0, 80)}`);
    }
    return pools;
}

/**
 * Get total fees for a config creator wallet.
 * Uses cache for instant config lookup, parallel pool scanning.
 */
async function getTotalFees(walletAddr, solUsd = 0) {
    const connections = createConnections();

    // 1. Try cache first (instant), fallback to tx scan
    let configs = getConfigsFromCache(walletAddr);
    if (!configs) {
        configs = await findConfigsByCreator(connections, walletAddr);
    }
    if (configs.length === 0) return { configs: [], grandTotal: 0, error: 'No configs found for this wallet' };

    const results = [];
    let grandTotalLifetime = 0;
    let grandTotalClaimed = 0;
    let grandTotalAvailable = 0;
    let poolCount = 0;

    // 2. Find pools for each config (1 at a time to avoid 429)
    const allPools = [];
    for (const c of configs) {
        const pools = await findPoolsByConfig(connections, c);
        allPools.push({ config: c, pools });
        if (pools.length > 0) await new Promise(r => setTimeout(r, 300));
    }

    // 3. Check fees (2 pools at a time, 500ms between batches)
    for (const { config: configAddr, pools } of allPools) {
        let configTotal = 0, configClaimed = 0, configAvailable = 0;
        const poolDetails = [];

        for (let i = 0; i < pools.length; i += 2) {
            const batch = pools.slice(i, i + 2);
            const feeResults = await Promise.allSettled(
                batch.map(p => getClaimableFees(p.address, solUsd))
            );

            for (let j = 0; j < batch.length; j++) {
                if (feeResults[j].status !== 'fulfilled') continue;
                const fees = feeResults[j].value;
                if (fees.error) continue;
                configTotal += fees.totalLifetime || 0;
                configClaimed += fees.totalClaimed || 0;
                configAvailable += fees.totalAvailable || 0;
                poolDetails.push({
                    address: batch[j].address,
                    baseMint: batch[j].baseMint,
                    lifetime: fees.totalLifetime || 0,
                    claimed: fees.totalClaimed || 0,
                    available: fees.totalAvailable || 0,
                    quoteLabel: fees.quoteLabel || 'SOL',
                });
                poolCount++;
            }

            if (i + 2 < pools.length) await new Promise(r => setTimeout(r, 500));
        }

        grandTotalLifetime += configTotal;
        grandTotalClaimed += configClaimed;
        grandTotalAvailable += configAvailable;

        results.push({
            config: configAddr,
            pools: poolDetails,
            totalLifetime: configTotal,
            totalClaimed: configClaimed,
            totalAvailable: configAvailable,
        });
    }

    return {
        wallet: walletAddr,
        configs: results,
        poolCount,
        grandTotalLifetime,
        grandTotalClaimed,
        grandTotalAvailable,
        solUsd,
    };
}

module.exports = { getTotalFees };
