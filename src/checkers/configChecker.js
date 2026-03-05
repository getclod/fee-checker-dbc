// configChecker.js — Read DBC pool config on-chain
// Extracted from DBC_v14/src/api/configCheckerApi.js (read-only, no Express)

const { Connection, PublicKey } = require('@solana/web3.js');
const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { loadSettings } = require('../config/settings');
const { findPoolByTokenMint } = require('../services/poolScanner');

const FEE_DENOMINATOR = 1e9;

// ──── helpers ────────────────────────────────────────────────────────────────

function bnToNumber(x, allowUnsafe = false) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'number') return x;
    if (typeof x === 'bigint') {
        const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
        const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
        if (!allowUnsafe && (x > MAX_SAFE || x < MIN_SAFE)) return x.toString();
        return Number(x);
    }
    if (typeof x.toNumber === 'function') {
        try { return x.toNumber(); } catch (_) {
            if (typeof x.toString === 'function') return x.toString();
        }
    }
    if (typeof x.toString === 'function') {
        const str = x.toString();
        const num = Number(str);
        if (!allowUnsafe && !Number.isSafeInteger(num) && num > Number.MAX_SAFE_INTEGER) return str;
        return num;
    }
    return Number(x);
}

function bnToBigInt(x) {
    if (x === null || x === undefined) return null;
    if (typeof x === 'bigint') return x;
    if (typeof x === 'number') return BigInt(x);
    if (typeof x.toString === 'function') return BigInt(x.toString());
    return null;
}

function fmt(num, digits = 6) {
    if (num === null || num === undefined) return 'N/A';
    if (typeof num === 'string') {
        const n = Number(num);
        if (Number.isFinite(n) && Number.isSafeInteger(n))
            return n.toLocaleString('en-US', { maximumFractionDigits: digits });
        return num.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    const n = Number(num);
    if (!Number.isFinite(n)) return 'N/A';
    return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtInt(num) {
    if (num === null || num === undefined) return 'N/A';
    if (typeof num === 'string') return num.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const n = Number(num);
    if (!Number.isFinite(n)) return 'N/A';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtPct(p, digits = 3) {
    if (p === null || p === undefined) return 'N/A';
    const rounded = Number(Number(p).toFixed(digits));
    const str = String(rounded);
    return str.includes('.') ? `${str.replace(/\.0+$/, '')}%` : `${str}%`;
}

function numeratorToPercent(n) {
    if (n === null || n === undefined) return null;
    return (n / FEE_DENOMINATOR) * 100;
}

function numeratorToBps(n) {
    if (n === null || n === undefined) return null;
    return (n / FEE_DENOMINATOR) * 10_000;
}

function secondsToHuman(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(sec)) return 'N/A';
    const s = Math.max(0, sec);
    const mins = Math.floor(s / 60);
    const rem = Math.round(s - mins * 60);
    if (mins <= 0) return `${rem}s`;
    if (mins < 60) return `${mins}m ${rem}s`;
    const hours = Math.floor(mins / 60);
    const rmins = mins - hours * 60;
    return `${hours}h ${rmins}m`;
}

function padHex(hex, bytes) {
    return (hex || '').replace(/^0x/, '').padStart(bytes * 2, '0');
}

function numToHex(n, bytes = 0) {
    if (n === null || n === undefined) return 'N/A';
    const bi = bnToBigInt(n);
    if (bi === null) return 'N/A';
    const hex = bi.toString(16);
    return bytes > 0 ? padHex(hex, bytes) : hex;
}

function getAny(obj, paths) {
    for (const p of paths) {
        const parts = p.split('.');
        let cur = obj;
        let ok = true;
        for (const k of parts) {
            if (cur && Object.prototype.hasOwnProperty.call(cur, k)) { cur = cur[k]; } else { ok = false; break; }
        }
        if (ok && cur !== undefined) return cur;
    }
    return undefined;
}

function activationLabel(t) {
    const v = bnToNumber(t);
    if (v === 0) return 'Slot (~0.4s est.)';
    if (v === 1) return 'Timestamp (seconds)';
    return `Unknown (${v})`;
}

function baseFeeModeLabel(m) {
    const x = bnToNumber(m);
    switch (x) {
        case 0: return 'FeeTimeSchedulerLinear';
        case 1: return 'FeeTimeSchedulerExponential';
        case 2: return 'RateLimiter';
        case 3: return 'FeeMarketCapSchedulerLinear';
        case 4: return 'FeeMarketCapSchedulerExponential';
        default: return `Unknown (${x})`;
    }
}

function calcEndingFeeNumerator({ cliff, baseFeeMode, numberOfPeriods, thirdFactorRaw }) {
    if (cliff === null || cliff === undefined) return null;
    if (!numberOfPeriods || numberOfPeriods <= 0) return null;
    const mode = bnToNumber(baseFeeMode);
    if (mode === 0 || mode === 3) {
        if (!thirdFactorRaw) return null;
        return Math.max(0, cliff - numberOfPeriods * thirdFactorRaw);
    }
    if (mode === 1 || mode === 4) {
        if (!thirdFactorRaw) return null;
        const r = 1 - (thirdFactorRaw / 10_000);
        return Math.max(0, cliff * Math.pow(r, numberOfPeriods));
    }
    return null;
}

function estimateDurationSeconds({ activationType, numberOfPeriods, periodFrequency }) {
    if (!numberOfPeriods || !periodFrequency) return null;
    const t = bnToNumber(activationType);
    if (t === 0) return numberOfPeriods * periodFrequency * 0.4;
    if (t === 1) return numberOfPeriods * periodFrequency;
    return null;
}

function pubkeyStr(x) {
    if (!x) return 'N/A';
    try {
        if (typeof x === 'string') return x;
        if (typeof x.toBase58 === 'function') return x.toBase58();
        if (typeof x.toString === 'function') return x.toString();
    } catch (_) { }
    return String(x);
}

function sol(u64Lamports) {
    const n = bnToNumber(u64Lamports);
    if (n === null) return null;
    return n / 1e9;
}

function unitLabelForFrequency(t) {
    const v = bnToNumber(t);
    if (v === 0) return 'slot';
    if (v === 1) return 's';
    return '';
}

function pct(numer) { return fmtPct(numeratorToPercent(numer), 3); }

function bps(numer) {
    const v = numeratorToBps(numer);
    return v === null ? 'N/A' : `${fmt(v, 2)} bps`;
}

// ──── core ───────────────────────────────────────────────────────────────────

async function readConfigData(configAddress) {
    try {
        const settings = loadSettings();
        const connection = new Connection(settings.RPC_URL, 'confirmed');
        const client = new DynamicBondingCurveClient(connection, 'confirmed');

        const configPubkey = new PublicKey(configAddress);
        const config = await client.state.getPoolConfig(configPubkey);

        if (!config) return { success: false, error: 'Config not found' };

        const baseFee = getAny(config, ['poolFees.baseFee', 'poolFees.base_fee', 'pool_fees.baseFee']);
        const dynamicFee = getAny(config, ['poolFees.dynamicFee', 'poolFees.dynamic_fee', 'pool_fees.dynamicFee']);

        const result = { success: true, data: {} };

        // Core fields
        result.data.quoteMint = pubkeyStr(getAny(config, ['quoteMint', 'quote_mint']));
        result.data.feeClaimer = pubkeyStr(getAny(config, ['feeClaimer', 'fee_claimer']));
        result.data.leftoverReceiver = pubkeyStr(getAny(config, ['leftoverReceiver', 'leftover_receiver']));
        result.data.poolCreationFee = fmt(sol(getAny(config, ['poolCreationFee', 'pool_creation_fee'])), 9);

        const collectFeeMode = bnToNumber(getAny(config, ['collectFeeMode', 'collect_fee_mode']));
        const collectModes = ['Both', 'Partner Only', 'Creator Only'];
        result.data.collectFeeMode = collectModes[collectFeeMode] || `Unknown (${collectFeeMode})`;

        const tokenType = bnToNumber(getAny(config, ['tokenType', 'token_type']));
        result.data.tokenType = tokenType === 0 ? 'SPL' : tokenType === 1 ? 'Token2022' : `Unknown (${tokenType})`;
        result.data.tokenDecimal = bnToNumber(getAny(config, ['tokenDecimal', 'token_decimal']));

        const activationTypeRaw = bnToNumber(getAny(config, ['activationType', 'activation_type']));
        result.data.activationType = activationLabel(activationTypeRaw);

        // LP Distribution
        result.data.lpDistribution = {
            partnerLp: bnToNumber(getAny(config, ['partnerLiquidityPercentage', 'partner_liquidity_percentage'])) ?? 0,
            creatorLp: bnToNumber(getAny(config, ['creatorLiquidityPercentage', 'creator_liquidity_percentage'])) ?? 0,
            partnerLocked: bnToNumber(getAny(config, ['partnerPermanentLockedLiquidityPercentage', 'partner_permanent_locked_liquidity_percentage'])) ?? 0,
            creatorLocked: bnToNumber(getAny(config, ['creatorPermanentLockedLiquidityPercentage', 'creator_permanent_locked_liquidity_percentage'])) ?? 0,
        };

        // Trading Fee Split
        const creatorTradingFeePct = bnToNumber(getAny(config, ['creatorTradingFeePercentage', 'creator_trading_fee_percentage'])) ?? 0;
        result.data.tradingFeeSplit = { partner: 100 - creatorTradingFeePct, creator: creatorTradingFeePct };

        // Dynamic Fee
        if (dynamicFee) {
            const dInitialized = bnToNumber(getAny(dynamicFee, ['initialized'])) ?? 0;
            const dBinStep = bnToNumber(getAny(dynamicFee, ['binStep', 'bin_step'])) ?? 0;
            const dFilterPeriod = bnToNumber(getAny(dynamicFee, ['filterPeriod', 'filter_period'])) ?? 0;
            const dDecayPeriod = bnToNumber(getAny(dynamicFee, ['decayPeriod', 'decay_period'])) ?? 0;
            const dReductionFactor = bnToNumber(getAny(dynamicFee, ['reductionFactor', 'reduction_factor'])) ?? 0;
            const dMaxVol = bnToNumber(getAny(dynamicFee, ['maxVolatilityAccumulator', 'max_volatility_accumulator'])) ?? 0;
            const dVfc = bnToNumber(getAny(dynamicFee, ['variableFeeControl', 'variable_fee_control'])) ?? 0;

            const isAllZero = !dInitialized && !dBinStep && !dFilterPeriod && !dDecayPeriod && !dReductionFactor && !dMaxVol && !dVfc;

            result.data.dynamicFee = {
                status: isAllZero ? 'OFF' : 'ON',
                initialized: dInitialized, binStep: dBinStep, filterPeriod: dFilterPeriod,
                decayPeriod: dDecayPeriod, reductionFactor: dReductionFactor,
                maxVolatilityAccumulator: dMaxVol, variableFeeControl: dVfc,
            };
        }

        // Base Fee / Anti-Sniper
        if (baseFee) {
            const cliff = bnToNumber(getAny(baseFee, ['cliffFeeNumerator', 'cliff_fee_numerator']));
            const bfMode = bnToNumber(getAny(baseFee, ['baseFeeMode', 'base_fee_mode']));
            const numberOfPeriods = bnToNumber(getAny(baseFee, ['firstFactor', 'first_factor']));
            const periodFrequency = bnToNumber(getAny(baseFee, ['secondFactor', 'second_factor']));
            const thirdFactorRaw = bnToNumber(getAny(baseFee, ['thirdFactor', 'third_factor']));

            const endingNumerator = calcEndingFeeNumerator({ cliff, baseFeeMode: bfMode, numberOfPeriods, thirdFactorRaw });
            const durationSec = estimateDurationSeconds({ activationType: activationTypeRaw, numberOfPeriods, periodFrequency });

            result.data.baseFee = {
                mode: baseFeeModeLabel(bfMode), baseFeeMode: bfMode,
                startFee: fmtPct(numeratorToPercent(cliff), 3),
                startFeeBps: fmtInt(numeratorToBps(cliff)),
                endFee: endingNumerator !== null ? fmtPct(numeratorToPercent(endingNumerator), 3) : 'N/A',
                endFeeBps: endingNumerator !== null ? fmt(numeratorToBps(endingNumerator), 2) : 'N/A',
                duration: durationSec !== null ? secondsToHuman(durationSec) : 'N/A',
                durationSeconds: durationSec,
                numberOfPeriods, periodFrequency,
                reductionFactor: (bfMode === 1 || bfMode === 4) ? thirdFactorRaw : null,
                cliffFeeNumerator: cliff, thirdFactor: thirdFactorRaw,
            };

            if (bfMode === 2) {
                result.data.baseFee.rateLimiter = {
                    baseFeeBps: numeratorToBps(cliff),
                    feeIncrementBps: thirdFactorRaw,
                    referenceAmount: numberOfPeriods,
                    maxLimiterDuration: periodFrequency,
                };
            }
        }

        // Migration Fee Option
        const migrationFeeOption = bnToNumber(getAny(config, ['migrationFeeOption', 'migration_fee_option']));
        const migrationFeePercentage = bnToNumber(getAny(config, ['migrationFeePercentage', 'migration_fee_percentage']));
        const creatorMigrationFeePercentage = bnToNumber(getAny(config, ['creatorMigrationFeePercentage', 'creator_migration_fee_percentage']));
        result.data.migrationFees = {
            option: migrationFeeOption,
            optionLabel: migrationFeeOption !== null ? `${migrationFeeOption}%` : 'N/A',
            migrationFeePercentage: migrationFeePercentage ?? 0,
            creatorMigrationFeePercentage: creatorMigrationFeePercentage ?? 0,
        };

        // Migration
        const migrationOption = bnToNumber(getAny(config, ['migrationOption', 'migration_option']));
        const migrationOptionLabels = ['MET_DAMM_V1', 'MET_DAMM_V2', 'LOCK', 'DYNAMIC'];
        result.data.migrationOption = migrationOptionLabels[migrationOption] || `Unknown (${migrationOption})`;

        const migrationQuoteThreshold = getAny(config, ['migrationQuoteThreshold', 'migration_quote_threshold']);
        if (migrationQuoteThreshold !== undefined)
            result.data.migrationQuoteThreshold = fmt(sol(migrationQuoteThreshold), 6);

        // Market cap calculation
        const qMint = pubkeyStr(getAny(config, ['quoteMint', 'quote_mint']));
        const quoteDecimal = (qMint && qMint.startsWith('So1111')) ? 9 : 6;
        const tokenDec = bnToNumber(getAny(config, ['tokenDecimal', 'token_decimal'])) ?? 9;
        let totalSupplyNum = bnToNumber(getAny(config, ['totalTokenSupply', 'total_token_supply']), true);
        if (!totalSupplyNum) totalSupplyNum = 1_000_000_000;
        const totalSupplyRaw = BigInt(totalSupplyNum) * BigInt(Math.pow(10, tokenDec));

        const TWO_POW_64 = BigInt('18446744073709551616');
        const PRECISION = BigInt('1000000000000');

        function sqrtPriceToMc(sqrtPriceVal) {
            try {
                const sqrtP = BigInt(String(sqrtPriceVal));
                const sqrtPScaled = sqrtP * PRECISION / TWO_POW_64;
                const priceScaled = sqrtPScaled * sqrtPScaled;
                const mcRaw = priceScaled * totalSupplyRaw / (PRECISION * PRECISION);
                return Number(mcRaw) / Math.pow(10, quoteDecimal);
            } catch (_) { return null; }
        }

        const sqrtStartPrice = getAny(config, ['sqrtStartPrice', 'sqrt_start_price']);
        const migrationSqrtPrice = getAny(config, ['migrationSqrtPrice', 'migration_sqrt_price']);
        const migrationBaseThreshold = getAny(config, ['migrationBaseThreshold', 'migration_base_threshold']);

        result.data.migrationDetails = {
            option: result.data.migrationOption,
            optionRaw: migrationOption,
            quoteThresholdSol: migrationQuoteThreshold !== undefined ? fmt(sol(migrationQuoteThreshold), 6) : null,
            quoteThresholdLamports: migrationQuoteThreshold !== undefined ? fmtInt(bnToNumber(migrationQuoteThreshold)) : null,
            baseThreshold: migrationBaseThreshold !== undefined ? fmtInt(bnToNumber(migrationBaseThreshold)) : null,
            sqrtPrice: migrationSqrtPrice !== undefined ? String(migrationSqrtPrice) : null,
            sqrtStartPrice: sqrtStartPrice !== undefined ? String(sqrtStartPrice) : null,
            startMcQuote: sqrtStartPrice !== undefined ? sqrtPriceToMc(sqrtStartPrice) : null,
            endMcQuote: migrationSqrtPrice !== undefined ? sqrtPriceToMc(migrationSqrtPrice) : null,
        };

        return result;
    } catch (error) {
        return { success: false, error: error?.message || 'Unknown error occurred' };
    }
}

async function getConfigFromMint(mintAddress) {
    try {
        const poolInfo = await findPoolByTokenMint(mintAddress);
        if (!poolInfo || !poolInfo.config) {
            return { success: false, error: 'Pool/config not found for this mint address' };
        }

        const result = await readConfigData(poolInfo.config);
        // Attach pool info for the formatter
        if (result.success) {
            result.poolInfo = poolInfo;
            result.configAddress = poolInfo.config;
        }
        return result;
    } catch (error) {
        return { success: false, error: error?.message || 'Failed to get config from mint' };
    }
}

module.exports = { readConfigData, getConfigFromMint };
