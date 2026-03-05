// telegram.js — Clean Telegram formatter

const MAX_MSG_LEN = 4000;

function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortAddr(addr, front = 6, back = 4) {
    if (!addr || addr === 'N/A' || addr.length < 14) return addr || 'N/A';
    return `${addr.slice(0, front)}...${addr.slice(-back)}`;
}

function fmtSol(n, label) {
    if (!n || !Number.isFinite(Number(n))) return `0.000000 ${label || 'SOL'}`;
    return Number(n).toFixed(6) + ` ${label || 'SOL'}`;
}

function fmtUsd(n) {
    if (!n || !Number.isFinite(Number(n)) || Number(n) < 0.01) return '$0.00';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function solscanAccount(addr) { return `https://solscan.io/account/${addr}`; }

// ──────────────────────────────────────────────────────────────────────────────

function formatStartMessage() {
    return [
        `🔍 <b>DBC Checker Bot</b>`,
        `Meteora Dynamic Bonding Curve`,
        ``,
        `📋 <b>Commands:</b>`,
        ``,
        `  /checkfee <code>&lt;mint&gt;</code>`,
        `  Check claimable trading fees`,
        ``,
        `  /checkconfig <code>&lt;mint&gt;</code>`,
        `  Read pool config details`,
        ``,
        `Paste any token CA after the command.`,
    ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// FEE CHECKER
// ──────────────────────────────────────────────────────────────────────────────

function formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd, configData) {
    const label = feeData.quoteLabel || 'SOL';
    const name = (tokenMeta && tokenMeta.name) ? esc(tokenMeta.name) : 'Unknown';
    const symbol = (tokenMeta && tokenMeta.symbol) ? esc(tokenMeta.symbol) : '?';
    const price = (label === 'SOL') ? (solUsd || 0) : (feeData.quotePrice || 0);
    const mint = poolInfo ? poolInfo.baseMint : '';

    const lines = [];

    lines.push(`🪙 <b>${name}</b> - $${symbol}`);
    lines.push(`<code>${mint}</code>`);
    lines.push(``);

    if (feeData.error) {
        lines.push(`❌ ${esc(feeData.error)}`);
        return lines.join('\n');
    }

    // Always show both, even if 0
    const creatorQ = feeData.creatorQuoteAmount ?? 0;
    const partnerQ = feeData.partnerQuoteAmount ?? 0;
    const totalQ = feeData.quoteAmount || (creatorQ + partnerQ);

    lines.push(`💰 Platform Fee (Available):`);
    lines.push(`${fmtSol(partnerQ, label)} (~${fmtUsd(partnerQ * price)})`);
    lines.push(``);

    lines.push(`💰 Creator Fee (Available):`);
    lines.push(`${fmtSol(creatorQ, label)} (~${fmtUsd(creatorQ * price)})`);
    lines.push(``);

    lines.push(`📊 <b>Total Available Fees:</b>`);
    lines.push(`${fmtSol(totalQ, label)} (~${fmtUsd(totalQ * price)})`);
    lines.push(``);



    // Info section
    if (poolInfo) {
        if (poolInfo.creator && poolInfo.creator !== 'Unknown') {
            lines.push(`👑 Deployer: <a href="${solscanAccount(poolInfo.creator)}">${shortAddr(poolInfo.creator)}</a>`);
        }
        lines.push(`⚙️ Config: <a href="${solscanAccount(poolInfo.config)}">${shortAddr(poolInfo.config)}</a>`);
    }

    if (configData && configData.feeClaimer && configData.feeClaimer !== 'N/A') {
        lines.push(`🔑 Config Creator: <a href="${solscanAccount(configData.feeClaimer)}">${shortAddr(configData.feeClaimer)}</a>`);
    }

    return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG CHECKER
// ──────────────────────────────────────────────────────────────────────────────

function formatConfigMessage(data, configAddress, poolInfo) {
    const lines = [];
    const cfgAddr = configAddress || (poolInfo && poolInfo.config) || '';

    lines.push(`✅ <b>Config Check Results</b>`);
    lines.push(``);

    // Addresses
    if (poolInfo && poolInfo.creator && poolInfo.creator !== 'Unknown') {
        lines.push(`👑 Deployer: <a href="${solscanAccount(poolInfo.creator)}">${shortAddr(poolInfo.creator)}</a>`);
    }
    lines.push(`⚙️ Config: <a href="${solscanAccount(cfgAddr)}">${shortAddr(cfgAddr)}</a>`);
    if (data.feeClaimer && data.feeClaimer !== 'N/A') {
        lines.push(`🔑 Config Creator: <a href="${solscanAccount(data.feeClaimer)}">${shortAddr(data.feeClaimer)}</a>`);
    }
    lines.push(``);

    // Token
    lines.push(`📦 <b>Token</b>`);
    lines.push(`   Type: <code>${esc(data.tokenType)}</code> · Decimals: <code>${data.tokenDecimal}</code>`);
    lines.push(`   Activation: <code>${esc(data.activationType)}</code>`);
    lines.push(``);

    // Fee Schedule
    if (data.baseFee) {
        const bf = data.baseFee;
        lines.push(`🛡️ <b>Fee Schedule</b>`);
        lines.push(`   Mode: <code>${esc(bf.mode)}</code>`);
        lines.push(`   Start: <code>${esc(bf.startFee)}</code> → End: <code>${esc(bf.endFee)}</code>`);
        lines.push(`   Duration: <code>${esc(bf.duration)}</code> · ${bf.numberOfPeriods} periods`);
        if (bf.reductionFactor !== null && bf.reductionFactor !== undefined) {
            const r = 1 - (bf.reductionFactor / 10_000);
            lines.push(`   Reduction: <code>${bf.reductionFactor} bps</code> (x${r.toFixed(4)})`);
        }
        lines.push(``);
    }

    // Fee split
    if (data.tradingFeeSplit) {
        const ts = data.tradingFeeSplit;
        lines.push(`📊 <b>Fee Split</b>`);
        lines.push(`   Creator: <code>${ts.creator}%</code> · Partner: <code>${ts.partner}%</code>`);
        lines.push(``);
    }

    // LP
    if (data.lpDistribution) {
        const lp = data.lpDistribution;
        lines.push(`💧 <b>LP Distribution</b>`);
        lines.push(`   Creator: <code>${lp.creatorLp}%</code> LP · <code>${lp.creatorLocked}%</code> locked`);
        lines.push(`   Partner: <code>${lp.partnerLp}%</code> LP · <code>${lp.partnerLocked}%</code> locked`);
        lines.push(``);
    }

    // Dynamic fee
    if (data.dynamicFee) {
        const df = data.dynamicFee;
        if (df.status === 'ON') {
            lines.push(`⚡ <b>Dynamic Fee:</b> <code>ON</code>`);
            lines.push(`   Bin: <code>${df.binStep}</code> · Filter: <code>${df.filterPeriod}</code> · Decay: <code>${df.decayPeriod}</code>`);
        } else {
            lines.push(`⚡ Dynamic Fee: <code>OFF</code>`);
        }
        lines.push(``);
    }

    // Migration
    if (data.migrationDetails) {
        const m = data.migrationDetails;
        lines.push(`🚀 <b>Migration:</b> <code>${esc(m.option)}</code>`);
        if (m.quoteThresholdSol) lines.push(`   Threshold: <code>${m.quoteThresholdSol} SOL</code>`);
        if (m.startMcQuote !== null && m.endMcQuote !== null) {
            lines.push(`   MC: <code>${fmtMc(m.startMcQuote)}</code> → <code>${fmtMc(m.endMcQuote)}</code>`);
        }
        lines.push(``);
    }

    lines.push(`🔑 Quote: <code>${shortAddr(esc(data.quoteMint), 6, 4)}</code>`);
    lines.push(`   Collect: <code>${esc(data.collectFeeMode)}</code>`);

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

function formatError(title, message) {
    return `❌ <b>${esc(title)}</b>\n\n${esc(message)}`;
}

module.exports = { formatConfigMessage, formatFeeMessage, formatError, formatStartMessage };
