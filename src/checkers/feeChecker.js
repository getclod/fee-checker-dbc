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

function dbg(msg) {
    console.log(`[FEE-DEBUG] ${msg}`);
}

/**
 * Get claimable fees for a DBC pool (read-only).
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

        // Always get raw account data first (needed for both quote detection and fallback)
        const accountInfo = await Promise.race([
            connection.getAccountInfo(poolPubkey),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]).catch(() => null);

        if (!accountInfo) return fail('Pool not found or timeout');

        const data = accountInfo.data;
        dbg(`Pool data length: ${data.length}`);

        // Detect quote from raw data
        if (data && data.length >= 104) {
            try {
                const qm = new PublicKey(data.slice(72, 104)).toBase58();
                dbg(`Quote mint from raw data: ${qm}`);
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

        dbg(`Quote: ${quoteLabel} decimals=${quoteDecimals}`);
        const decimalsDivisor = Math.pow(10, quoteDecimals);

        // ── Try SDK fee metrics ──────────────────────────────────────────────
        let sdkAmount = 0;
        try {
            const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
            const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

            const feeMetrics = await Promise.race([
                dbcClient.state.getPoolFeeMetrics(poolPubkey),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);

            if (feeMetrics && feeMetrics.current) {
                const cur = feeMetrics.current;
                // Log ALL available fields
                const fields = Object.keys(cur);
                dbg(`SDK feeMetrics.current fields: ${fields.join(', ')}`);

                for (const f of fields) {
                    const v = cur[f];
                    const num = safeNum(v);
                    dbg(`  ${f} = ${v} (num=${num})`);
                }

                // Try to extract fee from any available field
                for (const fieldName of ['creatorQuoteFee', 'quoteFee', 'creatorFee', 'totalQuoteFee', 'partnerQuoteFee', 'fee']) {
                    const val = cur[fieldName];
                    if (val !== undefined && val !== null) {
                        const num = safeNum(val);
                        if (num > 0) {
                            sdkAmount = num / decimalsDivisor;
                            dbg(`SDK found fee in field '${fieldName}': raw=${num} converted=${sdkAmount}`);
                            break;
                        }
                    }
                }
            } else {
                dbg('SDK: feeMetrics.current is null/undefined');
            }
        } catch (e) {
            dbg(`SDK error: ${e.message}`);
        }

        // ── Raw data parsing (always try) ────────────────────────────────────
        let rawAmount = 0;
        const offsets = [360, 376, 392, 408, 424, 200, 208, 216, 232, 248, 264, 280, 296, 312, 328, 344];
        for (const off of offsets) {
            if (data.length >= off + 8) {
                try {
                    const raw = data.readBigUInt64LE(off);
                    const q = Number(raw) / decimalsDivisor;
                    if (q > 0 && q < 100000) {
                        dbg(`Raw offset ${off}: raw=${raw} => ${q} ${quoteLabel}`);
                        if (q > rawAmount) rawAmount = q;
                    }
                } catch (_) { }
            }
        }

        dbg(`Results: SDK=${sdkAmount} Raw=${rawAmount}`);

        // Use whichever found fees
        const quoteAmount = sdkAmount > 0 ? sdkAmount : rawAmount;

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
        dbg(`Fatal error: ${e.message}`);
        return fail(e?.message || String(e));
    }
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

module.exports = { getClaimableFees };
