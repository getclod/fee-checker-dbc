// feeChecker.js — Read-only claimable fee checker for DBC pools
// Extracted from DBC_v14/src/api/claimApi.js check-fee logic

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
        disableRetryOnRateLimit: true,
        httpHeaders: { Origin: settings.RPC_ORIGIN },
    });
}

function safeNum(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v.toNumber === 'function') {
        try { return v.toNumber(); } catch (_) { return 0; }
    }
    return Number(v) || 0;
}

/**
 * Get claimable fees + total claimed for a DBC pool (read-only).
 * Mirrors DBC_v14/src/api/claimApi.js check-fee endpoint.
 */
async function getClaimableFees(poolAddress, solUsd = 0) {
    const fail = (err) => ({
        platformFee: 0, creatorFee: 0, totalClaimed: 0, totalLifetime: 0,
        totalAvailable: 0, quoteLabel: 'SOL', quotePrice: solUsd || 0,
        solUsd: solUsd || 0, readyToClaim: false, error: err,
    });

    if (!poolAddress || poolAddress === 'Unknown') return fail('Invalid pool');

    try {
        const connection = createRpcConnection();
        const poolPubkey = new PublicKey(poolAddress);

        const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
        const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

        // ── Detect quote mint ────────────────────────────────────────────────
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

        // Fallback quote detection from raw data
        if (quoteLabel === 'SOL' && quoteDecimals === 9) {
            try {
                const info = await connection.getAccountInfo(poolPubkey, 'confirmed');
                if (info && info.data && info.data.length >= 104) {
                    const qm = new PublicKey(info.data.slice(72, 104)).toBase58();
                    if (qm === USD1_MINT) { quoteDecimals = 6; quoteLabel = 'USD1'; quotePrice = 1; }
                    else if (qm === USDC_MINT) { quoteDecimals = 6; quoteLabel = 'USDC'; quotePrice = 1; }
                }
            } catch (_) { }
        }

        const decimalsDivisor = Math.pow(10, quoteDecimals);
        const isStablecoin = (quoteLabel === 'USD1' || quoteLabel === 'USDC');

        // ── Get fee metrics from SDK ─────────────────────────────────────────
        const feeMetrics = await Promise.race([
            dbcClient.state.getPoolFeeMetrics(poolPubkey),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);

        if (feeMetrics && feeMetrics.current) {
            // Partner (platform) fees
            const partnerQuoteFeeRaw = safeNum(
                feeMetrics.current.partnerQuoteFee
                || feeMetrics.current.partnerFee
                || feeMetrics.current.platformQuoteFee
                || feeMetrics.current.platformFee
            );

            // Creator fees
            const creatorQuoteFeeRaw = safeNum(
                feeMetrics.current.creatorQuoteFee
                || feeMetrics.current.creatorFee
                || feeMetrics.current.quoteFee
            );

            const platformFee = partnerQuoteFeeRaw / decimalsDivisor;
            const creatorFee = creatorQuoteFeeRaw / decimalsDivisor;
            const totalAvailable = platformFee + creatorFee;

            // Total lifetime accumulated fees
            let totalLifetime = 0;
            if (feeMetrics.total && feeMetrics.total.totalTradingQuoteFee) {
                totalLifetime = safeNum(feeMetrics.total.totalTradingQuoteFee) / decimalsDivisor;
            }

            // Total claimed = lifetime - available
            const totalClaimed = Math.max(0, totalLifetime - totalAvailable);

            return {
                platformFee,
                creatorFee,
                totalAvailable,
                totalClaimed,
                totalLifetime,
                quoteLabel,
                quotePrice,
                solUsd: solUsd || 0,
                readyToClaim: totalAvailable > 0.0001,
            };
        }

        return fail('Could not fetch fee metrics');
    } catch (e) {
        return fail(e?.message || String(e));
    }
}

module.exports = { getClaimableFees };
