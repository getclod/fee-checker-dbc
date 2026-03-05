// telegram.js — Elegant monospace formatter for Telegram HTML messages
// Clean, minimalist, no emoji — uses box-drawing and aligned columns

const MAX_MSG_LEN = 4000; // Telegram max is 4096, leave margin

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function line(label, value) {
    const l = String(label).padEnd(22);
    return `  ${l} ${esc(String(value))}`;
}

function divider(char = '-', width = 44) {
    return char.repeat(width);
}

function header(title) {
    const bar = '='.repeat(44);
    return `${bar}\n  ${title}\n${bar}`;
}

function shortAddr(addr) {
    if (!addr || addr === 'N/A' || addr.length < 12) return addr || 'N/A';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG formatter
// ──────────────────────────────────────────────────────────────────────────────

function formatConfigMessage(data, configAddress, poolInfo) {
    const lines = [];

    lines.push(header('DBC CONFIG CHECKER'));
    lines.push('');

    if (poolInfo) {
        lines.push(`  Pool       ${esc(poolInfo.address)}`);
        lines.push(`  Config     ${esc(configAddress || poolInfo.config)}`);
        lines.push(`  Base Mint  ${esc(poolInfo.baseMint)}`);
        lines.push('');
        lines.push(divider());
    }

    // Core Settings
    lines.push('');
    lines.push(`  [ CORE SETTINGS ]`);
    lines.push('');
    lines.push(line('Quote Mint', data.quoteMint));
    lines.push(line('Fee Claimer', shortAddr(data.feeClaimer)));
    lines.push(line('Leftover Receiver', shortAddr(data.leftoverReceiver)));
    lines.push(line('Pool Creation Fee', `${data.poolCreationFee} SOL`));
    lines.push(line('Collect Fee Mode', data.collectFeeMode));
    lines.push(line('Token Type', data.tokenType));
    lines.push(line('Token Decimals', data.tokenDecimal));
    lines.push(line('Activation Type', data.activationType));

    // LP Distribution
    if (data.lpDistribution) {
        lines.push('');
        lines.push(divider());
        lines.push('');
        lines.push(`  [ LP DISTRIBUTION ]`);
        lines.push('');
        lines.push(line('Partner LP', `${data.lpDistribution.partnerLp}%`));
        lines.push(line('Creator LP', `${data.lpDistribution.creatorLp}%`));
        lines.push(line('Partner Locked LP', `${data.lpDistribution.partnerLocked}%`));
        lines.push(line('Creator Locked LP', `${data.lpDistribution.creatorLocked}%`));
    }

    // Trading Fee Split
    if (data.tradingFeeSplit) {
        lines.push('');
        lines.push(divider());
        lines.push('');
        lines.push(`  [ TRADING FEE SPLIT ]`);
        lines.push('');
        lines.push(line('Partner (Platform)', `${data.tradingFeeSplit.partner}%`));
        lines.push(line('Creator', `${data.tradingFeeSplit.creator}%`));
    }

    // Base Fee / Anti-Sniper
    if (data.baseFee) {
        const bf = data.baseFee;
        lines.push('');
        lines.push(divider());
        lines.push('');
        lines.push(`  [ BASE FEE / ANTI-SNIPER ]`);
        lines.push('');
        lines.push(line('Scheduler Mode', bf.mode));
        lines.push(line('Start Fee', `${bf.startFee} (${bf.startFeeBps} bps)`));
        lines.push(line('End Fee', `${bf.endFee} (${bf.endFeeBps} bps)`));
        lines.push(line('Duration', bf.duration));
        lines.push(line('Periods', bf.numberOfPeriods));
        lines.push(line('Period Frequency', bf.periodFrequency));

        if (bf.reductionFactor !== null && bf.reductionFactor !== undefined) {
            const r = 1 - (bf.reductionFactor / 10_000);
            lines.push(line('Reduction Factor', `${bf.reductionFactor} bps (x${r.toFixed(4)})`));
        }

        if (bf.rateLimiter) {
            lines.push('');
            lines.push(`  [ RATE LIMITER ]`);
            lines.push(line('Base Fee', `${bf.rateLimiter.baseFeeBps} bps`));
            lines.push(line('Fee Increment', `${bf.rateLimiter.feeIncrementBps} bps`));
            lines.push(line('Reference Amount', bf.rateLimiter.referenceAmount));
            lines.push(line('Max Duration', bf.rateLimiter.maxLimiterDuration));
        }
    }

    // Dynamic Fee
    if (data.dynamicFee) {
        const df = data.dynamicFee;
        lines.push('');
        lines.push(divider());
        lines.push('');
        lines.push(`  [ DYNAMIC FEE ]`);
        lines.push('');
        lines.push(line('Status', df.status));
        if (df.status === 'ON') {
            lines.push(line('Bin Step', df.binStep));
            lines.push(line('Filter Period', df.filterPeriod));
            lines.push(line('Decay Period', df.decayPeriod));
            lines.push(line('Reduction Factor', df.reductionFactor));
            lines.push(line('Max Vol Accumulator', df.maxVolatilityAccumulator));
            lines.push(line('Variable Fee Ctrl', df.variableFeeControl));
        }
    }

    // Migration
    if (data.migrationDetails) {
        const m = data.migrationDetails;
        lines.push('');
        lines.push(divider());
        lines.push('');
        lines.push(`  [ MIGRATION ]`);
        lines.push('');
        lines.push(line('Option', m.option));
        if (m.quoteThresholdSol) lines.push(line('Quote Threshold', `${m.quoteThresholdSol} SOL`));
        if (m.startMcQuote !== null) lines.push(line('Start MC', fmtQuote(m.startMcQuote, data.quoteMint)));
        if (m.endMcQuote !== null) lines.push(line('End MC (Migration)', fmtQuote(m.endMcQuote, data.quoteMint)));
    }

    // Migration Fees
    if (data.migrationFees) {
        const mf = data.migrationFees;
        lines.push('');
        lines.push(divider());
        lines.push('');
        lines.push(`  [ MIGRATION FEES ]`);
        lines.push('');
        lines.push(line('Fee Option', mf.optionLabel));
        lines.push(line('Migration Fee %', `${mf.migrationFeePercentage}%`));
        lines.push(line('Creator Migration %', `${mf.creatorMigrationFeePercentage}%`));
    }

    lines.push('');
    lines.push(divider('='));

    const body = lines.join('\n');
    if (body.length > MAX_MSG_LEN) {
        return `<pre>${body.slice(0, MAX_MSG_LEN - 20)}\n... (truncated)</pre>`;
    }
    return `<pre>${body}</pre>`;
}

function fmtQuote(value, quoteMint) {
    if (value === null || value === undefined) return 'N/A';
    const label = (quoteMint && quoteMint.startsWith('So1111')) ? 'SOL' : 'Quote';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M ${label}`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K ${label}`;
    return `${value.toFixed(4)} ${label}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// FEE formatter
// ──────────────────────────────────────────────────────────────────────────────

function formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd) {
    const lines = [];

    lines.push(header('DBC FEE CHECKER'));
    lines.push('');

    // Token info
    if (tokenMeta && (tokenMeta.name || tokenMeta.symbol)) {
        lines.push(`  Token      ${esc(tokenMeta.name || 'Unknown')} (${esc(tokenMeta.symbol || '?')})`);
    }
    if (poolInfo) {
        lines.push(`  Pool       ${esc(poolInfo.address)}`);
        lines.push(`  Base Mint  ${esc(poolInfo.baseMint)}`);
        lines.push(`  Config     ${esc(poolInfo.config)}`);
    }

    lines.push('');
    lines.push(divider());
    lines.push('');
    lines.push(`  [ CLAIMABLE FEES ]`);
    lines.push('');

    const label = feeData.quoteLabel || 'SOL';

    if (feeData.error) {
        lines.push(line('Status', 'Error'));
        lines.push(line('Detail', feeData.error));
    } else if (!feeData.readyToClaim) {
        lines.push(line('Status', 'No claimable fees'));
        lines.push(line(`Total (${label})`, '0'));
    } else {
        lines.push(line('Status', 'Fees available'));
        lines.push('');

        // Amounts
        const totalQ = feeData.quoteAmount || 0;
        const creatorQ = feeData.creatorQuoteAmount ?? totalQ;
        const partnerQ = feeData.partnerQuoteAmount ?? 0;

        lines.push(line(`Total (${label})`, fmtNum(totalQ)));
        if (creatorQ > 0) lines.push(line(`  Creator`, fmtNum(creatorQ)));
        if (partnerQ > 0) lines.push(line(`  Partner`, fmtNum(partnerQ)));

        // USD values
        lines.push('');
        const price = feeData.quotePrice || 0;
        if (label === 'SOL' && solUsd > 0) {
            lines.push(line('SOL Price', `$${fmtNum(solUsd)}`));
            lines.push(line('Total (USD)', `$${fmtNum(totalQ * solUsd)}`));
            if (creatorQ > 0) lines.push(line('  Creator (USD)', `$${fmtNum(creatorQ * solUsd)}`));
            if (partnerQ > 0) lines.push(line('  Partner (USD)', `$${fmtNum(partnerQ * solUsd)}`));
        } else if (price > 0) {
            lines.push(line(`${label} Price`, `$${fmtNum(price)}`));
            lines.push(line('Total (USD)', `$${fmtNum(totalQ * price)}`));
        }
    }

    lines.push('');
    lines.push(divider('='));

    const body = lines.join('\n');
    if (body.length > MAX_MSG_LEN) {
        return `<pre>${body.slice(0, MAX_MSG_LEN - 20)}\n... (truncated)</pre>`;
    }
    return `<pre>${body}</pre>`;
}

function fmtNum(n) {
    if (n === null || n === undefined) return '0';
    const v = Number(n);
    if (!Number.isFinite(v)) return '0';
    if (Math.abs(v) < 0.0001) return '0';
    if (Math.abs(v) >= 1_000_000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (Math.abs(v) >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

// ──────────────────────────────────────────────────────────────────────────────
// ERROR formatter
// ──────────────────────────────────────────────────────────────────────────────

function formatError(title, message) {
    const lines = [];
    lines.push(divider('='));
    lines.push(`  ${esc(title)}`);
    lines.push(divider('='));
    lines.push('');
    lines.push(`  ${esc(message)}`);
    lines.push('');
    lines.push(divider('='));
    return `<pre>${lines.join('\n')}</pre>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// START / HELP formatter
// ──────────────────────────────────────────────────────────────────────────────

function formatStartMessage() {
    const lines = [];
    lines.push(header('DBC CHECKER BOT'));
    lines.push('');
    lines.push('  Meteora Dynamic Bonding Curve');
    lines.push('  On-chain fee and config checker');
    lines.push('');
    lines.push(divider());
    lines.push('');
    lines.push('  [ COMMANDS ]');
    lines.push('');
    lines.push('  /checkerfee <mint>');
    lines.push('    Check claimable trading fees');
    lines.push('    for any DBC pool by token mint.');
    lines.push('');
    lines.push('  /checkerconfig <mint>');
    lines.push('    Read full pool configuration');
    lines.push('    including fee schedule, LP split,');
    lines.push('    migration, and dynamic fee params.');
    lines.push('');
    lines.push(divider());
    lines.push('');
    lines.push('  Usage example:');
    lines.push('  /checkerfee So11...1112');
    lines.push('  /checkerconfig So11...1112');
    lines.push('');
    lines.push(divider('='));
    return `<pre>${lines.join('\n')}</pre>`;
}

module.exports = {
    formatConfigMessage,
    formatFeeMessage,
    formatError,
    formatStartMessage,
};
