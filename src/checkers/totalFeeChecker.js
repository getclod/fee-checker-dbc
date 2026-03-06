// totalFeeChecker.js — Get total fees earned across all pools for a config creator wallet
// Scans wallet → finds configs → finds pools per config → sums all fee metrics

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const { getClaimableFees } = require('./feeChecker');
const { parsePoolAccountData } = require('../services/poolScanner');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

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
 * Find all DBC config addresses created by a wallet.
 * Scans transaction history for create_config instructions.
 */
async function findConfigsByCreator(connections, walletAddr) {
    const pk = new PublicKey(walletAddr);
    const configs = [];

    try {
        const sigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, { limit: 1000 }));

        // Check in batches
        for (let i = 0; i < sigs.length; i += 5) {
            const batch = sigs.slice(i, i + 5);
            const results = await Promise.allSettled(
                batch.map(s => tryRpc(connections, c => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })))
            );

            for (const r of results) {
                if (r.status !== 'fulfilled' || !r.value) continue;
                const tx = r.value;
                if (!tx.meta || tx.meta.err) continue;
                const logs = (tx.meta.logMessages || []).join(' ').toLowerCase();
                if (!logs.includes('createconfig') && !logs.includes('create_config')) continue;

                // Extract config address from instruction accounts
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
                                if (configAddr && !configs.includes(configAddr)) {
                                    configs.push(configAddr);
                                }
                            }
                        }
                    }
                } catch (_) { }
            }

            // Small delay between batches
            if (i + 5 < sigs.length) await new Promise(r => setTimeout(r, 200));
        }
    } catch (e) {
        console.error(`[totalFee] Error scanning wallet: ${(e.message || '').slice(0, 80)}`);
    }

    return configs;
}

/**
 * Find all pool addresses for a given config address.
 * Uses getProgramAccounts with memcmp filter on config offset (byte 8).
 */
async function findPoolsByConfig(connections, configAddr) {
    const pools = [];
    try {
        const configPk = new PublicKey(configAddr);
        const accounts = await tryRpc(connections, c =>
            c.getProgramAccounts(new PublicKey(DBC_PROGRAM), {
                filters: [{ memcmp: { offset: 8, bytes: configPk.toBase58() } }],
                commitment: 'confirmed',
                encoding: 'base64',
            })
        );

        for (const { pubkey, account } of accounts) {
            const data = Buffer.from(account.data, 'base64');
            const parsed = parsePoolAccountData(data);
            if (parsed) {
                pools.push({
                    address: pubkey.toBase58(),
                    baseMint: parsed.baseMint,
                    config: configAddr,
                });
            }
        }
    } catch (e) {
        console.error(`[totalFee] Error finding pools for ${configAddr.slice(0, 8)}: ${(e.message || '').slice(0, 80)}`);
    }
    return pools;
}

/**
 * Get total fees for a config creator wallet.
 * Returns per-config breakdown + grand total.
 */
async function getTotalFees(walletAddr, solUsd = 0) {
    const connections = createConnections();

    // 1. Find all configs
    const configs = await findConfigsByCreator(connections, walletAddr);
    if (configs.length === 0) return { configs: [], grandTotal: 0, error: 'No configs found for this wallet' };

    const results = [];
    let grandTotalLifetime = 0;
    let grandTotalClaimed = 0;
    let grandTotalAvailable = 0;
    let poolCount = 0;

    // 2. For each config, find pools and check fees
    for (const configAddr of configs) {
        const pools = await findPoolsByConfig(connections, configAddr);
        let configTotal = 0;
        let configClaimed = 0;
        let configAvailable = 0;
        const poolDetails = [];

        for (const pool of pools) {
            try {
                const fees = await getClaimableFees(pool.address, solUsd);
                if (!fees.error) {
                    configTotal += fees.totalLifetime || 0;
                    configClaimed += fees.totalClaimed || 0;
                    configAvailable += fees.totalAvailable || 0;
                    poolDetails.push({
                        address: pool.address,
                        baseMint: pool.baseMint,
                        lifetime: fees.totalLifetime || 0,
                        claimed: fees.totalClaimed || 0,
                        available: fees.totalAvailable || 0,
                        quoteLabel: fees.quoteLabel || 'SOL',
                    });
                    poolCount++;
                }
            } catch (_) { }

            // Rate limit protection
            await new Promise(r => setTimeout(r, 300));
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
