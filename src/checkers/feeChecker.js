// feeChecker.js — Read-only claimable fee checker for DBC pools
// Extracted from DBC_v14/src/core/feeManager.js (no claim/write operations)

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function createRpcConnection() {
    const settings = loadSettings();
    return new Connection(settings.RPC_URL, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
        httpHeaders: { Origin: settings.RPC_ORIGIN },
    });
}

/**
 * Get claimable fees for a DBC pool (read-only).
 * Mirrors DBC_v14/src/core/feeManager.js getClaimableFees exactly.
 */
async function getClaimableFees(poolAddress, solUsd = 0) {
    const fail = (err) => ({
        quoteAmount: 0, quoteLabel: 'SOL', quotePrice: solUsd || 0,
        solUsd: solUsd || 0, quoteUsd: 0, readyToClaim: false, error: err,
    });

    if (!poolAddress || poolAddress === 'Unknown') return fail('Invalid pool');

    try {
        const connection = createRpcConnection();
        const poolPubkey = new PublicKey(poolAddress);

        // ── Try SDK first ────────────────────────────────────────────────────
        try {
            const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
            const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

            // Detect quote mint from pool state
            let quoteDecimals = 9;
            let quoteLabel = 'SOL';
            let quotePrice = solUsd || 0;

            try {
                const poolState = await dbcClient.state.getPool(poolPubkey);
                if (poolState && poolState.config) {
                    const configPk = typeof poolState.config.toBase58 === 'function'
                        ? poolState.config.toBase58() : String(poolState.config);
                    const config = await dbcClient.state.getPoolConfig(new PublicKey(configPk));
                    if (config && config.quoteMint) {
                        const qm = typeof config.quoteMint.toBase58 === 'function'
                            ? config.quoteMint.toBase58() : String(config.quoteMint);
                        if (qm === USD1_MINT) { quoteDecimals = 6; quoteLabel = 'USD1'; quotePrice = 1; }
                        else if (qm === USDC_MINT) { quoteDecimals = 6; quoteLabel = 'USDC'; quotePrice = 1; }
                        else {
                            try {
                                const mi = await connection.getParsedAccountInfo(new PublicKey(qm), { commitment: 'confirmed' });
                                const dec = mi?.value?.data?.parsed?.info?.decimals;
                                if (typeof dec === 'number') quoteDecimals = dec;
                            } catch (_) { }
                        }
                    }
                }
            } catch (_) { }

            const decimalsDivisor = Math.pow(10, quoteDecimals);

            // Get fee metrics
            const feeMetrics = await Promise.race([
                dbcClient.state.getPoolFeeMetrics(poolPubkey),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);

            if (feeMetrics && feeMetrics.current) {
                // Try different field names — same as DBC_v14 original
                const creatorQuoteFee = feeMetrics.current.creatorQuoteFee
                    || feeMetrics.current.quoteFee
                    || feeMetrics.current.creatorFee
                    || 0;

                let quoteAmount = 0;
                if (creatorQuoteFee) {
                    const rawAmount = typeof creatorQuoteFee.toNumber === 'function'
                        ? creatorQuoteFee.toNumber()
                        : (typeof creatorQuoteFee === 'bigint' || typeof creatorQuoteFee === 'number')
                            ? Number(creatorQuoteFee) : 0;
                    quoteAmount = rawAmount / decimalsDivisor;
                }

                if (quoteAmount > 0.0001) {
                    return {
                        quoteAmount,
                        creatorQuoteAmount: quoteAmount,
                        partnerQuoteAmount: 0,
                        quoteLabel, quotePrice,
                        solUsd: solUsd || 0,
                        quoteUsd: quoteAmount * quotePrice,
                        readyToClaim: true,
                    };
                }
                // If SDK returned 0, DON'T return — fall through to raw parsing
            }
        } catch (_) {
            // fall through to raw parsing
        }

        // ── Raw data fallback (same as DBC_v14) ─────────────────────────────
        const accountInfo = await Promise.race([
            connection.getAccountInfo(poolPubkey),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]).catch(() => null);

        if (!accountInfo) return fail('Pool not found or timeout');

        const data = accountInfo.data;

        // Detect quote mint from raw data
        let quoteDecimals = 9;
        let quoteLabel = 'SOL';
        let quotePrice = solUsd || 0;

        if (data && data.length >= 104) {
            try {
                const qm = new PublicKey(data.slice(72, 104)).toBase58();
                if (qm === USD1_MINT) { quoteDecimals = 6; quoteLabel = 'USD1'; quotePrice = 1; }
                else if (qm === USDC_MINT) { quoteDecimals = 6; quoteLabel = 'USDC'; quotePrice = 1; }
                else {
                    try {
                        const mi = await connection.getParsedAccountInfo(new PublicKey(qm), { commitment: 'confirmed' });
                        const dec = mi?.value?.data?.parsed?.info?.decimals;
                        if (typeof dec === 'number') quoteDecimals = dec;
                    } catch (_) { }
                }
            } catch (_) { }
        }

        const decimalsDivisor = Math.pow(10, quoteDecimals);
        let quoteAmount = 0;

        const offsets = [360, 376, 392, 408, 424];
        for (const off of offsets) {
            if (data.length >= off + 8) {
                try {
                    const raw = data.readBigUInt64LE(off);
                    const q = Number(raw) / decimalsDivisor;
                    if (q > 0 && q < 100000) { quoteAmount = q; break; }
                } catch (_) { }
            }
        }

        return {
            quoteAmount,
            creatorQuoteAmount: quoteAmount,
            partnerQuoteAmount: 0,
            quoteLabel, quotePrice,
            solUsd: solUsd || 0,
            quoteUsd: quoteAmount * quotePrice,
            readyToClaim: quoteAmount > 0.0001,
        };
    } catch (e) {
        return fail(e?.message || String(e));
    }
}

module.exports = { getClaimableFees };
