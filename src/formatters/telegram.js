// telegram.js — Clean minimal formatter for Telegram
// Uses mixed HTML (bold, code, links) for a modern card-style look

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

function fmtSol(n) {
    if (!n || !Number.isFinite(Number(n))) return '0.0000';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function fmtUsd(n) {
    if (!n || !Number.isFinite(Number(n)) || Number(n) < 0.01) return '$0.00';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function solscanToken(mint) {
    return `https://solscan.io/token/${mint}`;
}

function solscanAccount(addr) {
    return `https://solscan.io/account/${addr}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// START
// ──────────────────────────────────────────────────────────────────────────────

function formatStartMessage() {
    return [
        `<b>DBC Checker Bot</b>`,
        `Meteora Dynamic Bonding Curve`,
        ``,
        `<b>Commands</b>`,
        ``,
        `/checkerfee <code>&lt;mint&gt;</code>`,
        `Check claimable trading fees`,
        ``,
        `/checkerconfig <code>&lt;mint&gt;</code>`,
        `Read pool configuration`,
        ``,
        `Paste any token mint address after the command.`,
    ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// FEE CHECKER
// ──────────────────────────────────────────────────────────────────────────────

function formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd) {
    const label = feeData.quoteLabel || 'SOL';
    const name = (tokenMeta && tokenMeta.name) ? esc(tokenMeta.name) : 'Unknown';
    const symbol = (tokenMeta && tokenMeta.symbol) ? esc(tokenMeta.symbol) : '?';
    const price = (label === 'SOL') ? (solUsd || 0) : (feeData.quotePrice || 0);
    const mint = poolInfo ? poolInfo.baseMint : '';

    const lines = [];

    // Title
    lines.push(`<b>${name}</b>  <code>${symbol}</code>`);
    if (mint) {
        lines.push(`<a href="${solscanToken(mint)}">${shortAddr(mint, 6, 4)}</a>`);
    }
    lines.push(``);

    if (feeData.error) {
        lines.push(`Status: <code>Error</code>`);
        lines.push(`${esc(feeData.error)}`);
        return lines.join('\n');
    }

    if (!feeData.readyToClaim) {
        lines.push(`<b>No claimable fees</b>`);
        addPoolFooter(lines, poolInfo);
        return lines.join('\n');
    }

    // Amounts
    const totalQ = feeData.quoteAmount || 0;
    const creatorQ = feeData.creatorQuoteAmount ?? 0;
    const partnerQ = feeData.partnerQuoteAmount ?? 0;

    lines.push(`<b>Claimable Fees</b>`);
    lines.push(``);

    if (creatorQ > 0) {
        lines.push(`Creator`);
        lines.push(`<code>${fmtSol(creatorQ)} ${label}</code>  ~${fmtUsd(creatorQ * price)}`);
        lines.push(``);
    }

    if (partnerQ > 0) {
        lines.push(`Partner`);
        lines.push(`<code>${fmtSol(partnerQ)} ${label}</code>  ~${fmtUsd(partnerQ * price)}`);
        lines.push(``);
    }

    if (creatorQ > 0 && partnerQ > 0) {
        lines.push(`<b>Total</b>`);
        lines.push(`<code>${fmtSol(totalQ)} ${label}</code>  ~${fmtUsd(totalQ * price)}`);
        lines.push(``);
    }

    if (creatorQ === 0 && partnerQ === 0 && totalQ > 0) {
        lines.push(`Total`);
        lines.push(`<code>${fmtSol(totalQ)} ${label}</code>  ~${fmtUsd(totalQ * price)}`);
        lines.push(``);
    }

    // Price ref
    if (price > 0) {
        lines.push(`${label} = ${fmtUsd(price)}`);
        lines.push(``);
    }

    addPoolFooter(lines, poolInfo);
    return lines.join('\n');
}

function addPoolFooter(lines, poolInfo) {
    if (!poolInfo) return;
    lines.push(`<b>Pool</b>  <a href="${solscanAccount(poolInfo.address)}">${shortAddr(poolInfo.address, 6, 4)}</a>`);
    lines.push(`<b>Config</b>  <a href="${solscanAccount(poolInfo.config)}">${shortAddr(poolInfo.config, 6, 4)}</a>`);
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG CHECKER
// ──────────────────────────────────────────────────────────────────────────────

function formatConfigMessage(data, configAddress, poolInfo) {
    const lines = [];
    const cfgAddr = configAddress || (poolInfo && poolInfo.config) || '';

    // Title
    lines.push(`<b>Config Checker</b>`);
    if (poolInfo) {
        lines.push(`<a href="${solscanAccount(poolInfo.address)}">Pool ${shortAddr(poolInfo.address, 6, 4)}</a>  |  <a href="${solscanToken(poolInfo.baseMint)}">Mint ${shortAddr(poolInfo.baseMint, 6, 4)}</a>`);
    }
    lines.push(``);

    // Token
    lines.push(`<b>Token</b>`);
    lines.push(`Type <code>${esc(data.tokenType)}</code>  Decimals <code>${data.tokenDecimal}</code>`);
    lines.push(`Activation <code>${esc(data.activationType)}</code>`);
    lines.push(``);

    // Fee Schedule
    if (data.baseFee) {
        const bf = data.baseFee;
        lines.push(`<b>Fee Schedule</b>`);
        lines.push(`Mode <code>${esc(bf.mode)}</code>`);
        lines.push(`Start <code>${esc(bf.startFee)}</code>  End <code>${esc(bf.endFee)}</code>`);
        lines.push(`Duration <code>${esc(bf.duration)}</code>  Periods <code>${bf.numberOfPeriods}</code>`);
        if (bf.reductionFactor !== null && bf.reductionFactor !== undefined) {
            const r = 1 - (bf.reductionFactor / 10_000);
            lines.push(`Reduction <code>${bf.reductionFactor} bps</code> (x${r.toFixed(4)})`);
        }
        lines.push(``);
    }

    // LP + Fee Split
    if (data.lpDistribution && data.tradingFeeSplit) {
        const lp = data.lpDistribution;
        const ts = data.tradingFeeSplit;
        lines.push(`<b>LP Distribution</b>`);
        lines.push(`Creator <code>${lp.creatorLp}%</code> LP  <code>${lp.creatorLocked}%</code> locked`);
        lines.push(`Partner <code>${lp.partnerLp}%</code> LP  <code>${lp.partnerLocked}%</code> locked`);
        lines.push(``);
        lines.push(`<b>Fee Split</b>`);
        lines.push(`Creator <code>${ts.creator}%</code>  Partner <code>${ts.partner}%</code>`);
        lines.push(``);
    }

    // Dynamic Fee
    if (data.dynamicFee) {
        const df = data.dynamicFee;
        lines.push(`<b>Dynamic Fee</b>  <code>${df.status}</code>`);
        if (df.status === 'ON') {
            lines.push(`Bin <code>${df.binStep}</code>  Filter <code>${df.filterPeriod}</code>  Decay <code>${df.decayPeriod}</code>`);
        }
        lines.push(``);
    }

    // Migration
    if (data.migrationDetails) {
        const m = data.migrationDetails;
        lines.push(`<b>Migration</b>  <code>${esc(m.option)}</code>`);
        if (m.quoteThresholdSol) lines.push(`Threshold <code>${m.quoteThresholdSol} SOL</code>`);
        if (m.startMcQuote !== null && m.endMcQuote !== null) {
            lines.push(`MC  <code>${fmtMc(m.startMcQuote)}</code> → <code>${fmtMc(m.endMcQuote)}</code>`);
        }
        lines.push(``);
    }

    // Addresses
    lines.push(`<b>Addresses</b>`);
    lines.push(`Quote <code>${shortAddr(esc(data.quoteMint), 6, 4)}</code>`);
    lines.push(`Claimer <code>${shortAddr(esc(data.feeClaimer), 6, 4)}</code>`);
    lines.push(`Collect <code>${esc(data.collectFeeMode)}</code>`);

    const result = lines.join('\n');
    if (result.length > MAX_MSG_LEN) return result.slice(0, MAX_MSG_LEN - 10) + '\n...';
    return result;
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
    return `<b>${esc(title)}</b>\n\n${esc(message)}`;
}

module.exports = {
    formatConfigMessage,
    formatFeeMessage,
    formatError,
    formatStartMessage,
};
