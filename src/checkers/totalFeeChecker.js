// totalFeeChecker.js — Accurate total fees by scanning actual claim/migration transactions
// Scans wallet tx history → counts real SOL/token gains from DBC interactions

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');
const fs = require('fs');
const path = require('path');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

/**
 * Scan wallet transaction history for actual DBC fee income.
 * Counts real SOL/USD1/USDC gains from claim and migration transactions.
 */
async function getTotalFees(walletAddr, solUsd = 0) {
    const connections = createConnections();
    const pk = new PublicKey(walletAddr);

    const totals = {};  // { SOL: { earned: X }, USD1: { earned: Y }, ... }
    const poolEarnings = {};  // poolAddr → { earned, quoteLabel, signatures }
    let txCount = 0;
    let claimCount = 0;
    let before = undefined;

    // Paginate through ALL wallet transactions
    while (true) {
        const opts = { limit: 1000 };
        if (before) opts.before = before;

        let sigs;
        try {
            sigs = await tryRpc(connections, c => c.getSignaturesForAddress(pk, opts));
        } catch (e) {
            console.error(`[totalFee] Sig scan error: ${(e.message || '').slice(0, 80)}`);
            break;
        }
        if (sigs.length === 0) break;

        // Process in batches of 10
        for (let i = 0; i < sigs.length; i += 10) {
            const batch = sigs.slice(i, i + 10);
            const results = await Promise.allSettled(
                batch.map(s => tryRpc(connections, c => c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })))
            );

            for (let bi = 0; bi < batch.length; bi++) {
                if (results[bi].status !== 'fulfilled' || !results[bi].value) continue;
                const tx = results[bi].value;
                if (!tx.meta || tx.meta.err) continue;
                txCount++;

                // Check if DBC program is involved
                const accountKeys = tx.transaction.message.accountKeys || [];
                const staticKeys = tx.transaction.message.staticAccountKeys || [];
                const allKeys = (accountKeys.length > 0 ? accountKeys : staticKeys).map(k =>
                    (typeof k === 'string' ? k : (k.pubkey || k)).toString()
                );
                if (tx.meta.loadedAddresses) {
                    if (tx.meta.loadedAddresses.writable) allKeys.push(...tx.meta.loadedAddresses.writable.map(k => k.toString()));
                    if (tx.meta.loadedAddresses.readonly) allKeys.push(...tx.meta.loadedAddresses.readonly.map(k => k.toString()));
                }

                const hasDBC = allKeys.includes(DBC_PROGRAM);
                if (!hasDBC) continue;

                // Check logs for claim/migration (skip create_config and initialize)
                const logs = (tx.meta.logMessages || []).join(' ').toLowerCase();
                const isSetup = logs.includes('createconfig') || logs.includes('create_config')
                    || logs.includes('initializevirtualpool') || logs.includes('initialize_virtual_pool');
                if (isSetup) continue;

                // Find wallet index
                const walletIndex = allKeys.indexOf(walletAddr);
                if (walletIndex === -1) continue;

                // Find pool address from DBC instruction (typically one of the first accounts)
                let poolAddr = null;
                for (const ix of (tx.transaction.message.instructions || [])) {
                    const pid = allKeys[ix.programIdIndex];
                    if (pid === DBC_PROGRAM) {
                        const a = ix.accounts || [];
                        // Pool is usually in the first few accounts
                        for (let ai = 0; ai < Math.min(a.length, 5); ai++) {
                            const addr = allKeys[a[ai]];
                            if (addr && addr !== walletAddr && addr !== DBC_PROGRAM) {
                                poolAddr = addr;
                                break;
                            }
                        }
                        break;
                    }
                }

                // Calculate SOL gain
                const pre = tx.meta.preBalances?.[walletIndex] || 0;
                const post = tx.meta.postBalances?.[walletIndex] || 0;
                const solGain = (post - pre) / 1e9;

                if (solGain > 0.0005) {
                    if (!totals.SOL) totals.SOL = { earned: 0 };
                    totals.SOL.earned += solGain;
                    claimCount++;

                    if (poolAddr) {
                        if (!poolEarnings[poolAddr]) poolEarnings[poolAddr] = { earned: 0, quoteLabel: 'SOL' };
                        poolEarnings[poolAddr].earned += solGain;
                        poolEarnings[poolAddr].quoteLabel = 'SOL';
                    }
                }

                // Check USD1/USDC token gains
                if (tx.meta.preTokenBalances && tx.meta.postTokenBalances) {
                    for (const postBal of tx.meta.postTokenBalances) {
                        if (postBal.owner !== walletAddr) continue;
                        const mint = postBal.mint;
                        if (mint !== USD1_MINT && mint !== USDC_MINT) continue;

                        const postAmount = Number(postBal.uiTokenAmount?.uiAmount || 0);
                        const preBal = tx.meta.preTokenBalances.find(p => p.owner === walletAddr && p.mint === mint);
                        const preAmount = preBal ? Number(preBal.uiTokenAmount?.uiAmount || 0) : 0;
                        const tokenGain = postAmount - preAmount;

                        if (tokenGain > 0.001) {
                            const label = mint === USD1_MINT ? 'USD1' : 'USDC';
                            if (!totals[label]) totals[label] = { earned: 0 };
                            totals[label].earned += tokenGain;
                            claimCount++;

                            if (poolAddr) {
                                if (!poolEarnings[poolAddr]) poolEarnings[poolAddr] = { earned: 0, quoteLabel: label };
                                poolEarnings[poolAddr].earned += tokenGain;
                                poolEarnings[poolAddr].quoteLabel = label;
                            }
                        }
                    }
                }
            }

            if (i + 10 < sigs.length) await new Promise(r => setTimeout(r, 100));
        }

        if (sigs.length < 1000) break;
        before = sigs[sigs.length - 1].signature;
        await new Promise(r => setTimeout(r, 300));
    }

    // Build top pools list
    const topPools = Object.entries(poolEarnings)
        .map(([addr, data]) => ({ address: addr, earned: data.earned, quoteLabel: data.quoteLabel }))
        .sort((a, b) => {
            const aUsd = a.earned * (a.quoteLabel === 'SOL' ? solUsd : 1);
            const bUsd = b.earned * (b.quoteLabel === 'SOL' ? solUsd : 1);
            return bUsd - aUsd;
        })
        .slice(0, 10);

    return {
        wallet: walletAddr,
        totals,
        topPools,
        txCount,
        claimCount,
        solUsd,
    };
}

module.exports = { getTotalFees };
