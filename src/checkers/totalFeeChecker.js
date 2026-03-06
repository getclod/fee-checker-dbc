// totalFeeChecker.js — Get total fees earned across all pools for a config creator wallet
// Optimized: config cache + pool cache, fresh fee data every call

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const { getClaimableFees } = require('./feeChecker');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const DISCOVERED_FILE = path.join(__dirname, '../../.discovered_configs.json');
const POOL_CACHE_FILE = path.join(__dirname, '../../.discovered_pools.json');

function createConnections() {
    const settings = loadSettings();
    const rpcs = [settings.RPC_URL, ...(settings.RPC_URLS || [])].filter(Boolean);
    return rpcs.map(url => new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true }));
}

async function tryRpc(connections, fn, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        for (const conn of connections) {
            try { return await fn(conn); } catch (e) {
                lastErr = e;
                const msg = e.message || '';
                if (msg.includes('429') || msg.includes('502') || msg.includes('Too many') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
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

// ── Config cache ─────────────────────────────────────────────────────────────

function getConfigsFromCache(walletAddr) {
    try {
        if (fs.existsSync(DISCOVERED_FILE)) {
            const data = JSON.parse(fs.readFileSync(DISCOVERED_FILE, 'utf8'));
            if (data[walletAddr] && data[walletAddr].length > 0) return data[walletAddr];
        }
    } catch (_) { }
    return null;
}

// ── Pool cache ───────────────────────────────────────────────────────────────

function loadPoolCache() {
    try {
        if (fs.existsSync(POOL_CACHE_FILE)) return JSON.parse(fs.readFileSync(POOL_CACHE_FILE, 'utf8'));
    } catch (_) { }
    return {};
}

function savePoolCache(cache) {
    try { fs.writeFileSync(POOL_CACHE_FILE, JSON.stringify(cache, null, 2)); } catch (_) { }
}

// ── Scan wallet txs (paginated, unlimited) ───────────────────────────────────

async function findConfigsByCreator(connections, walletAddr) {
    const pk = new PublicKey(walletAddr);
    const configs = [];
    let before = undefined;

    try {
        while (true) {
            const opts = { limit: 1000 };
            if (before) opts.before = before;
            const sigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, opts));
            if (sigs.length === 0) break;

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

            // Paginate: if we got 1000, there might be more
            if (sigs.length < 1000) break;
            before = sigs[sigs.length - 1].signature;
            await new Promise(r => setTimeout(r, 300));
        }
    } catch (e) {
        console.error(`[totalFee] Scan error: ${(e.message || '').slice(0, 80)}`);
    }

    return configs;
}

// ── Find pools per config (with caching) ─────────────────────────────────────

async function findPoolsByConfig(connections, configAddr, poolCache) {
    // Check cache first
    if (poolCache[configAddr] && poolCache[configAddr].length > 0) {
        return poolCache[configAddr];
    }

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

    // Save to cache
    if (pools.length > 0) poolCache[configAddr] = pools;
    return pools;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function getTotalFees(walletAddr, solUsd = 0) {
    const connections = createConnections();
    const poolCache = loadPoolCache();

    // 1. Configs: cache first, then fallback scan (paginated, unlimited)
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

    // 2. Find pools (cached = instant, uncached = scan config txs)
    const allPools = [];
    let hadUncached = false;
    for (const c of configs) {
        const wasCached = !!poolCache[c];
        const pools = await findPoolsByConfig(connections, c, poolCache);
        allPools.push({ config: c, pools });
        if (!wasCached && pools.length > 0) {
            hadUncached = true;
            await new Promise(r => setTimeout(r, 500));
        }
    }
    if (hadUncached) savePoolCache(poolCache);

    // 3. Flatten all pools → check 3 at a time, 300ms between
    const configPoolMap = {};
    const flatPools = [];
    for (const { config: configAddr, pools } of allPools) {
        configPoolMap[configAddr] = { configTotal: 0, configClaimed: 0, configAvailable: 0, poolDetails: [] };
        for (const p of pools) flatPools.push({ ...p, configAddr });
    }
    poolCount = flatPools.length;

    const failedPools = [];

    for (let i = 0; i < flatPools.length; i += 3) {
        const batch = flatPools.slice(i, i + 3);
        const feeResults = await Promise.allSettled(
            batch.map(p => getClaimableFees(p.address, solUsd))
        );

        for (let j = 0; j < batch.length; j++) {
            const fees = feeResults[j].status === 'fulfilled' ? feeResults[j].value : null;
            if (!fees || fees.error) {
                failedPools.push(batch[j]);
                continue;
            }
            const cm = configPoolMap[batch[j].configAddr];
            cm.configTotal += fees.totalLifetime || 0;
            cm.configClaimed += fees.totalClaimed || 0;
            cm.configAvailable += fees.totalAvailable || 0;
            cm.poolDetails.push({
                address: batch[j].address,
                baseMint: batch[j].baseMint,
                lifetime: fees.totalLifetime || 0,
                claimed: fees.totalClaimed || 0,
                available: fees.totalAvailable || 0,
                quoteLabel: fees.quoteLabel || 'SOL',
            });
        }

        if (i + 3 < flatPools.length) await new Promise(r => setTimeout(r, 300));
    }

    // Retry failed pools once
    if (failedPools.length > 0) {
        await new Promise(r => setTimeout(r, 2000));
        for (let i = 0; i < failedPools.length; i += 2) {
            const batch = failedPools.slice(i, i + 2);
            const feeResults = await Promise.allSettled(
                batch.map(p => getClaimableFees(p.address, solUsd))
            );
            for (let j = 0; j < batch.length; j++) {
                const fees = feeResults[j].status === 'fulfilled' ? feeResults[j].value : null;
                if (!fees || fees.error) continue;
                const cm = configPoolMap[batch[j].configAddr];
                cm.configTotal += fees.totalLifetime || 0;
                cm.configClaimed += fees.totalClaimed || 0;
                cm.configAvailable += fees.totalAvailable || 0;
                cm.poolDetails.push({
                    address: batch[j].address,
                    baseMint: batch[j].baseMint,
                    lifetime: fees.totalLifetime || 0,
                    claimed: fees.totalClaimed || 0,
                    available: fees.totalAvailable || 0,
                    quoteLabel: fees.quoteLabel || 'SOL',
                });
            }
            if (i + 2 < failedPools.length) await new Promise(r => setTimeout(r, 500));
        }
    }

    // 4. Aggregate results
    for (const { config: configAddr } of allPools) {
        const cm = configPoolMap[configAddr];
        grandTotalLifetime += cm.configTotal;
        grandTotalClaimed += cm.configClaimed;
        grandTotalAvailable += cm.configAvailable;

        results.push({
            config: configAddr,
            pools: cm.poolDetails,
            totalLifetime: cm.configTotal,
            totalClaimed: cm.configClaimed,
            totalAvailable: cm.configAvailable,
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
