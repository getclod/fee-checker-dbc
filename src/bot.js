// bot.js — Telegram Bot for DBC Fee & Config Checking
// Entry point: node src/bot.js

const TelegramBot = require('node-telegram-bot-api');
const { getConfigFromMint } = require('./checkers/configChecker');
const { getClaimableFees } = require('./checkers/feeChecker');
const { findPoolByTokenMint, fetchTokenMetadata } = require('./services/poolScanner');
const { getSolUsdPrice } = require('./services/priceService');
const {
    formatConfigMessage,
    formatFeeMessage,
    formatError,
    formatStartMessage,
} = require('./formatters/telegram');

// ──── Configuration ──────────────────────────────────────────────────────────

const BOT_TOKEN = '8744533288:AAHk9IYfsYcCzRul6j2-grn_l9bRxorWbz8';

// ──── Logging ────────────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, cmd, chatId, msg) {
    console.log(`[${ts()}] [${level}] [${cmd}] chat=${chatId} | ${msg}`);
}

// ──── Helpers ────────────────────────────────────────────────────────────────

function isValidBase58(str) {
    if (!str || str.length < 32 || str.length > 50) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(str);
}

/**
 * Extract a Solana address from text.
 * Looks for any base58 string that's 32-50 chars long.
 */
function extractAddress(text) {
    if (!text) return null;
    const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,50}/g);
    if (!matches) return null;
    // Return the first valid-looking address
    for (const m of matches) {
        if (isValidBase58(m)) return m;
    }
    return null;
}

/**
 * Get mint address from command args OR from the replied-to message.
 * Supports: /fee <mint>  OR  reply to a message containing a CA with /fee
 */
function getMintFromMessage(msg, match) {
    // First try: argument after command
    const arg = (match[1] || '').trim();
    if (arg && isValidBase58(arg)) return arg;

    // Second try: extract from replied message
    if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
        const addr = extractAddress(replyText);
        if (addr) return addr;
    }

    return null;
}

async function sendHtml(bot, chatId, html) {
    try {
        await bot.sendMessage(chatId, html, { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
        const plain = html.replace(/<[^>]+>/g, '');
        await bot.sendMessage(chatId, plain);
    }
}

// ──── Bot Setup ──────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log(`[${ts()}] [BOOT] DBC Checker Bot starting...`);
console.log(`[${ts()}] [BOOT] Polling for Telegram updates`);

// ── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    log('INFO', '/start', chatId, 'Welcome message sent');
    sendHtml(bot, chatId, formatStartMessage());
});

// ── /config <mint> ───────────────────────────────────────────────────────────

bot.onText(/\/config(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const mint = getMintFromMessage(msg, match);

    if (!mint) {
        log('WARN', '/config', chatId, 'No mint address found');
        return sendHtml(bot, chatId, formatError(
            'Missing Address',
            'Usage: /config <mint>\nOr reply to a message containing a CA.',
        ));
    }

    log('INFO', '/config', chatId, `Checking config for: ${mint}`);
    await bot.sendChatAction(chatId, 'typing');

    try {
        const result = await getConfigFromMint(mint);

        if (!result.success) {
            log('WARN', '/config', chatId, `Failed: ${result.error}`);
            return sendHtml(bot, chatId, formatError('Config Check Failed', result.error));
        }

        log('INFO', '/config', chatId, 'Config read OK');
        const html = formatConfigMessage(
            result.data,
            result.configAddress || (result.poolInfo && result.poolInfo.config),
            result.poolInfo,
        );
        return sendHtml(bot, chatId, html);
    } catch (e) {
        log('ERROR', '/config', chatId, `Exception: ${e.message}`);
        return sendHtml(bot, chatId, formatError('Error', e.message || 'Unexpected error'));
    }
});

// ── /fee <mint> ──────────────────────────────────────────────────────────────

bot.onText(/\/fee(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const mint = getMintFromMessage(msg, match);

    if (!mint) {
        log('WARN', '/fee', chatId, 'No mint address found');
        return sendHtml(bot, chatId, formatError(
            'Missing Address',
            'Usage: /fee <mint>\nOr reply to a message containing a CA.',
        ));
    }

    log('INFO', '/fee', chatId, `Checking fees for: ${mint}`);
    await bot.sendChatAction(chatId, 'typing');

    try {
        // Find pool
        const poolInfo = await findPoolByTokenMint(mint);

        if (!poolInfo || !poolInfo.address) {
            log('WARN', '/fee', chatId, 'Pool not found');
            return sendHtml(bot, chatId, formatError('Pool Not Found', 'No DBC pool found for this mint.'));
        }

        log('INFO', '/fee', chatId, `Pool: ${poolInfo.address}`);

        // Get SOL price + fees + token metadata + config (parallel where possible)
        let solUsd = 0;
        try { solUsd = await getSolUsdPrice(); } catch (_) { solUsd = 0; }

        const feeData = await getClaimableFees(poolInfo.address, solUsd);

        let tokenMeta = { name: '', symbol: '' };
        let configData = null;
        try { tokenMeta = await fetchTokenMetadata(poolInfo.baseMint || mint); } catch (_) { }
        try {
            const configResult = await getConfigFromMint(mint);
            if (configResult.success) configData = configResult.data;
        } catch (_) { }

        log('INFO', '/fee', chatId,
            `Fees: ${feeData.quoteAmount || 0} ${feeData.quoteLabel || 'SOL'} | Ready: ${feeData.readyToClaim}`);

        const html = formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd, configData);
        return sendHtml(bot, chatId, html);
    } catch (e) {
        log('ERROR', '/fee', chatId, `Exception: ${e.message}`);
        return sendHtml(bot, chatId, formatError('Error', e.message || 'Unexpected error'));
    }
});
// ── Auto-detect: bare CA paste → auto fee check ─────────────────────────────

bot.on('message', async (msg) => {
    const text = (msg.text || '').trim();
    // Skip commands, empty, or short messages
    if (!text || text.startsWith('/') || text.length < 32) return;

    // Check if the message is a standalone Solana address
    const addr = extractAddress(text);
    if (!addr) return;

    // Only trigger if the message is mostly just the address (allow small extra text)
    if (text.length > addr.length + 10) return;

    const chatId = msg.chat.id;
    log('INFO', 'auto-fee', chatId, `Detected CA: ${addr}`);

    await bot.sendChatAction(chatId, 'typing');

    try {
        const poolInfo = await findPoolByTokenMint(addr);
        if (!poolInfo || !poolInfo.address) {
            // Not a DBC pool, silently ignore
            log('INFO', 'auto-fee', chatId, 'Not a DBC pool, skipping');
            return;
        }

        log('INFO', 'auto-fee', chatId, `Pool: ${poolInfo.address}`);

        let solUsd = 0;
        try { solUsd = await getSolUsdPrice(); } catch (_) { solUsd = 0; }

        const feeData = await getClaimableFees(poolInfo.address, solUsd);

        let tokenMeta = { name: '', symbol: '' };
        let configData = null;
        try { tokenMeta = await fetchTokenMetadata(poolInfo.baseMint || addr); } catch (_) { }
        try {
            const configResult = await getConfigFromMint(addr);
            if (configResult.success) configData = configResult.data;
        } catch (_) { }

        log('INFO', 'auto-fee', chatId,
            `Fees: ${feeData.totalAvailable || 0} ${feeData.quoteLabel || 'SOL'}`);

        const html = formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd, configData);
        return sendHtml(bot, chatId, html);
    } catch (e) {
        log('ERROR', 'auto-fee', chatId, `Exception: ${e.message}`);
        // Silently ignore errors for auto-detect
    }
});

// ── Error handling ───────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
    console.error(`[${ts()}] [ERROR] [polling] ${err.message}`);
});

process.on('unhandledRejection', (err) => {
    console.error(`[${ts()}] [ERROR] [unhandled] ${err.message || err}`);
});

console.log(`[${ts()}] [BOOT] Bot is ready. Listening for commands...`);
