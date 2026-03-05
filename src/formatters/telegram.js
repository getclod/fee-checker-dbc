// telegram.js — Elegant monospace formatter for Telegram HTML messages

const MAX_MSG_LEN = 4000;

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function shortAddr(addr, front = 4, back = 4) {
    if (!addr || addr === 'N/A' || addr.length < 12) return addr || 'N/A';
    return `${addr.slice(0, front)}...${addr.slice(-back)}`;
}

function fmtNum(n, decimals = 4) {
    if (n === null || n === undefined) return '0';
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    if (Math.abs(v) < 0.0001) return '0';
    return v.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 2 });
}

function fmtUsd(n) {
    if (n === null || n === undefined || Number(n) === 0) return '$0.00';
    const v = Number(n);
    if (!Number.isFinite(v)) return '$0.00';
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

// ──────────────────────────────────────────────────────────────────────────────
// START / HELP
// ──────────────────────────────────────────────────────────────────────────────

function formatStartMessage() {
    const lines = [
        ``,
        `  DBC CHECKER BOT`,
        `  ───────────────────────────`,
        `  Meteora Dynamic Bonding Curve`,
        `  On-chain checker for Solana`,
        ``,
        ``,
        `  COMMANDS`,
        `  ───────────────────────────`,
        ``,
        `  /checkerfee   &lt;mint&gt;`,
        `  Check claimable trading fees`,
        ``,
        `  /checkerconfig &lt;mint&gt;`,
        `  Read pool configuration`,
        ``,
        ``,
        `  Paste any token CA/mint address`,
        `  after the command to begin.`,
        ``,
    ];
    return `<pre>${lines.join('\n')}</pre>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// FEE CHECKER
// ──────────────────────────────────────────────────────────────────────────────

function formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd) {
    const label = feeData.quoteLabel || 'SOL';
    const tokenName = (tokenMeta && tokenMeta.name) ? tokenMeta.name : 'Unknown';
    const tokenSymbol = (tokenMeta && tokenMeta.symbol) ? tokenMeta.symbol : '?';

    const lines = [];

    // Header
    lines.push(``);
    lines.push(`  FEE CHECKER`);
    lines.push(`  ───────────────────────────`);

    // Token identity
    lines.push(`  ${esc(tokenName)} (${esc(tokenSymbol)})`);
    lines.push(``);

    if (feeData.error) {
        lines.push(`  Status    Error`);
        lines.push(`  Detail    ${esc(feeData.error)}`);
        lines.push(``);
        addPoolLinks(lines, poolInfo);
        return wrap(lines);
    }

    if (!feeData.readyToClaim) {
        lines.push(`  Status    No fees to claim`);
        lines.push(``);
        addPoolLinks(lines, poolInfo);
        return wrap(lines);
    }

    // Fee amounts
    const totalQ = feeData.quoteAmount || 0;
    const creatorQ = feeData.creatorQuoteAmount ?? 0;
    const partnerQ = feeData.partnerQuoteAmount ?? 0;
    const price = (label === 'SOL') ? (solUsd || 0) : (feeData.quotePrice || 0);

    lines.push(`  CLAIMABLE FEES`);
    lines.push(`  ───────────────────────────`);
    lines.push(``);

    if (creatorQ > 0 && partnerQ > 0) {
        lines.push(`  Creator   ${fmtNum(creatorQ)} ${label}`);
        lines.push(`            ${fmtUsd(creatorQ * price)}`);
        lines.push(``);
        lines.push(`  Partner   ${fmtNum(partnerQ)} ${label}`);
        lines.push(`            ${fmtUsd(partnerQ * price)}`);
        lines.push(``);
        lines.push(`  ───────────────────────────`);
        lines.push(`  Total     ${fmtNum(totalQ)} ${label}`);
        lines.push(`            ${fmtUsd(totalQ * price)}`);
    } else if (creatorQ > 0) {
        lines.push(`  Creator   ${fmtNum(creatorQ)} ${label}`);
        lines.push(`            ${fmtUsd(creatorQ * price)}`);
    } else if (partnerQ > 0) {
        lines.push(`  Partner   ${fmtNum(partnerQ)} ${label}`);
        lines.push(`            ${fmtUsd(partnerQ * price)}`);
    } else {
        lines.push(`  Total     ${fmtNum(totalQ)} ${label}`);
        lines.push(`            ${fmtUsd(totalQ * price)}`);
    }

    lines.push(``);

    // Price reference
    if (price > 0) {
        lines.push(`  ${label} Price  ${fmtUsd(price)}`);
        lines.push(``);
    }

    // Pool links
    addPoolLinks(lines, poolInfo);

    return wrap(lines);
}

function addPoolLinks(lines, poolInfo) {
    if (!poolInfo) return;
    lines.push(`  POOL INFO`);
    lines.push(`  ───────────────────────────`);
    lines.push(`  Pool    ${esc(poolInfo.address)}`);
    lines.push(`  Mint    ${esc(poolInfo.baseMint)}`);
    lines.push(`  Config  ${esc(poolInfo.config)}`);
    lines.push(``);
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG CHECKER
// ──────────────────────────────────────────────────────────────────────────────

function formatConfigMessage(data, configAddress, poolInfo) {
    const lines = [];

    // Header
    lines.push(``);
    lines.push(`  CONFIG CHECKER`);
    lines.push(`  ───────────────────────────`);

    if (poolInfo) {
        lines.push(`  Pool    ${esc(poolInfo.address)}`);
        lines.push(`  Mint    ${esc(poolInfo.baseMint)}`);
        lines.push(`  Config  ${esc(configAddress || poolInfo.config)}`);
    }
    lines.push(``);

    // Token info
    lines.push(`  TOKEN`);
    lines.push(`  ───────────────────────────`);
    lines.push(`  Type       ${esc(data.tokenType)}`);
    lines.push(`  Decimals   ${data.tokenDecimal}`);
    lines.push(`  Activation ${esc(data.activationType)}`);
    lines.push(``);

    // Fee schedule
    if (data.baseFee) {
        const bf = data.baseFee;
        lines.push(`  FEE SCHEDULE`);
        lines.push(`  ───────────────────────────`);
        lines.push(`  Mode       ${esc(bf.mode)}`);
        lines.push(`  Start      ${esc(bf.startFee)}`);
        lines.push(`  End        ${esc(bf.endFee)}`);
        lines.push(`  Duration   ${esc(bf.duration)}`);
        lines.push(`  Periods    ${bf.numberOfPeriods}`);
        lines.push(`  Frequency  ${bf.periodFrequency}`);
        if (bf.reductionFactor !== null && bf.reductionFactor !== undefined) {
            const r = 1 - (bf.reductionFactor / 10_000);
            lines.push(`  Reduction  ${bf.reductionFactor} bps (x${r.toFixed(4)})`);
        }
        lines.push(``);
    }

    // LP distribution
    if (data.lpDistribution) {
        const lp = data.lpDistribution;
        lines.push(`  LP DISTRIBUTION`);
        lines.push(`  ───────────────────────────`);
        lines.push(`  Creator LP       ${lp.creatorLp}%`);
        lines.push(`  Creator Locked   ${lp.creatorLocked}%`);
        lines.push(`  Partner LP       ${lp.partnerLp}%`);
        lines.push(`  Partner Locked   ${lp.partnerLocked}%`);
        lines.push(``);
    }

    // Trading fee split
    if (data.tradingFeeSplit) {
        lines.push(`  TRADING FEE SPLIT`);
        lines.push(`  ───────────────────────────`);
        lines.push(`  Creator    ${data.tradingFeeSplit.creator}%`);
        lines.push(`  Partner    ${data.tradingFeeSplit.partner}%`);
        lines.push(``);
    }

    // Dynamic fee
    if (data.dynamicFee) {
        const df = data.dynamicFee;
        lines.push(`  DYNAMIC FEE`);
        lines.push(`  ───────────────────────────`);
        lines.push(`  Status     ${df.status}`);
        if (df.status === 'ON') {
            lines.push(`  Bin Step   ${df.binStep}`);
            lines.push(`  Filter     ${df.filterPeriod}`);
            lines.push(`  Decay      ${df.decayPeriod}`);
            lines.push(`  Reduction  ${df.reductionFactor}`);
            lines.push(`  Max Vol    ${df.maxVolatilityAccumulator}`);
            lines.push(`  Var Ctrl   ${df.variableFeeControl}`);
        }
        lines.push(``);
    }

    // Migration
    if (data.migrationDetails) {
        const m = data.migrationDetails;
        lines.push(`  MIGRATION`);
        lines.push(`  ───────────────────────────`);
        lines.push(`  Option     ${esc(m.option)}`);
        if (m.quoteThresholdSol) {
            lines.push(`  Threshold  ${m.quoteThresholdSol} SOL`);
        }
        if (m.startMcQuote !== null) {
            lines.push(`  Start MC   ${fmtMc(m.startMcQuote)}`);
        }
        if (m.endMcQuote !== null) {
            lines.push(`  End MC     ${fmtMc(m.endMcQuote)}`);
        }
        lines.push(``);
    }

    // Addresses
    lines.push(`  ADDRESSES`);
    lines.push(`  ───────────────────────────`);
    lines.push(`  Quote Mint  ${esc(data.quoteMint)}`);
    lines.push(`  Fee Claimer ${esc(shortAddr(data.feeClaimer, 6, 6))}`);
    lines.push(`  Collect     ${esc(data.collectFeeMode)}`);
    lines.push(``);

    return wrap(lines);
}

function fmtMc(value) {
    if (value === null || value === undefined) return 'N/A';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return `${value.toFixed(2)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// ERROR
// ──────────────────────────────────────────────────────────────────────────────

function formatError(title, message) {
    const lines = [
        ``,
        `  ${esc(title)}`,
        `  ───────────────────────────`,
        ``,
        `  ${esc(message)}`,
        ``,
    ];
    return `<pre>${lines.join('\n')}</pre>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Util
// ──────────────────────────────────────────────────────────────────────────────

function wrap(lines) {
    const body = lines.join('\n');
    if (body.length > MAX_MSG_LEN) {
        return `<pre>${body.slice(0, MAX_MSG_LEN - 20)}\n...</pre>`;
    }
    return `<pre>${body}</pre>`;
}

module.exports = {
    formatConfigMessage,
    formatFeeMessage,
    formatError,
    formatStartMessage,
};
