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
 * Returns { quoteAmount, quoteLabel, quotePrice, quoteUsd, readyToClaim }
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

        // ── Detect quote mint ────────────────────────────────────────────────
        let quoteDecimals = 9;
        let quoteLabel = 'SOL';
        let quotePrice = solUsd || 0;

        async function detectQuoteMint(conn, poolPk) {
            // Try SDK path
            try {
                const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
                const client = new DynamicBondingCurveClient(conn, 'confirmed');
                const poolState = await client.state.getPool(poolPk);

                if (poolState && poolState.config) {
                    const configPk = typeof poolState.config.toBase58 === 'function'
                        ? poolState.config : new PublicKey(String(poolState.config));
                    const config = await client.state.getPoolConfig(configPk);
                    if (config && config.quoteMint) {
                        const qm = typeof config.quoteMint.toBase58 === 'function'
                            ? config.quoteMint.toBase58() : String(config.quoteMint);
                        if (qm === USD1_MINT) { quoteDecimals = 6; quoteLabel = 'USD1'; quotePrice = 1; }
                        else if (qm === USDC_MINT) { quoteDecimals = 6; quoteLabel = 'USDC'; quotePrice = 1; }
                        else {
                            try {
                                const mi = await conn.getParsedAccountInfo(new PublicKey(qm), { commitment: 'confirmed' });
                                const dec = mi?.value?.data?.parsed?.info?.decimals;
                                if (typeof dec === 'number') quoteDecimals = dec;
                            } catch (_) { }
                        }
                        return;
                    }
                }
            } catch (_) { }

            // Fallback: parse from account data
            try {
                const info = await conn.getAccountInfo(poolPk, 'confirmed');
                if (info && info.data && info.data.length >= 104) {
                    const qm = new PublicKey(info.data.slice(72, 104)).toBase58();
                    if (qm === USD1_MINT) { quoteDecimals = 6; quoteLabel = 'USD1'; quotePrice = 1; }
                    else if (qm === USDC_MINT) { quoteDecimals = 6; quoteLabel = 'USDC'; quotePrice = 1; }
                    else {
                        try {
                            const mi = await conn.getParsedAccountInfo(new PublicKey(qm), { commitment: 'confirmed' });
                            const dec = mi?.value?.data?.parsed?.info?.decimals;
                            if (typeof dec === 'number') quoteDecimals = dec;
                        } catch (_) { }
                    }
                }
            } catch (_) { }
        }

        await detectQuoteMint(connection, poolPubkey);

        const decimalsDivisor = Math.pow(10, quoteDecimals);

        // ── SDK fee metrics ──────────────────────────────────────────────────
        try {
            const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
            const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

            const feeMetrics = await Promise.race([
                dbcClient.state.getPoolFeeMetrics(poolPubkey),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);

            if (feeMetrics && feeMetrics.current) {
                const raw = feeMetrics.current;

                // Safe BN/BigInt to number converter
                const toNum = (v) => {
                    if (v === null || v === undefined) return 0;
                    if (typeof v === 'number') return v;
                    if (typeof v === 'bigint') return Number(v);
                    if (typeof v.toNumber === 'function') {
                        try { return v.toNumber(); } catch (_) { return 0; }
                    }
                    if (typeof v.isZero === 'function' && v.isZero()) return 0;
                    return Number(v) || 0;
                };

                // Extract all possible fee fields (convert to real numbers first)
                const creatorQRaw = toNum(raw.creatorQuoteFee);
                const partnerQRaw = toNum(raw.partnerQuoteFee);
                const totalQRaw = toNum(raw.quoteFee) || toNum(raw.totalQuoteFee);
                const genericFee = toNum(raw.creatorFee) || toNum(raw.fee);

                // Calculate amounts
                let creatorQ = creatorQRaw / decimalsDivisor;
                let partnerQ = partnerQRaw / decimalsDivisor;
                let totalQ = creatorQ + partnerQ;

                // If both are 0 but a total/generic field has value, use that
                if (totalQ < 0.0001 && totalQRaw > 0) {
                    totalQ = totalQRaw / decimalsDivisor;
                    creatorQ = totalQ; // Assume creator if can't split
                    partnerQ = 0;
                }
                if (totalQ < 0.0001 && genericFee > 0) {
                    totalQ = genericFee / decimalsDivisor;
                    creatorQ = totalQ;
                    partnerQ = 0;
                }

                if (totalQ > 0.0001) {
                    return {
                        quoteAmount: totalQ,
                        creatorQuoteAmount: creatorQ,
                        partnerQuoteAmount: partnerQ,
                        quoteLabel,
                        quotePrice,
                        solUsd: solUsd || 0,
                        quoteUsd: totalQ * quotePrice,
                        readyToClaim: true,
                    };
                }
            }
        } catch (_) {
            // fall through to raw parsing
        }

        // ── Raw data fallback ────────────────────────────────────────────────
        const accountInfo = await Promise.race([
            connection.getAccountInfo(poolPubkey),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]).catch(() => null);

        if (!accountInfo) return fail('Pool not found or timeout');

        const data = accountInfo.data;
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
            quoteLabel,
            quotePrice,
            solUsd: solUsd || 0,
            quoteUsd: quoteAmount * quotePrice,
            readyToClaim: quoteAmount > 0.0001,
        };
    } catch (e) {
        return fail(e?.message || String(e));
    }
}

module.exports = { getClaimableFees };
