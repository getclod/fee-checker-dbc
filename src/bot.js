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

function extractMint(text, command) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return null;
    return parts[1];
}

function isValidBase58(str) {
    if (!str || str.length < 32 || str.length > 50) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(str);
}

async function sendHtml(bot, chatId, html) {
    try {
        await bot.sendMessage(chatId, html, { parse_mode: 'HTML' });
    } catch (e) {
        // If HTML parse fails, try sending as plain text
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

// ── /checkerconfig <mint> ────────────────────────────────────────────────────

bot.onText(/\/checkerconfig(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = (match[1] || '').trim();

    if (!input) {
        log('WARN', '/checkerconfig', chatId, 'No mint address provided');
        return sendHtml(bot, chatId, formatError(
            'Missing Argument',
            'Usage: /checkerconfig <token_mint_address>',
        ));
    }

    if (!isValidBase58(input)) {
        log('WARN', '/checkerconfig', chatId, `Invalid address: ${input.slice(0, 12)}...`);
        return sendHtml(bot, chatId, formatError(
            'Invalid Address',
            'Please provide a valid Solana base58 address.',
        ));
    }

    log('INFO', '/checkerconfig', chatId, `Checking config for mint: ${input}`);

    // Send "processing" indicator
    await bot.sendChatAction(chatId, 'typing');

    try {
        const result = await getConfigFromMint(input);

        if (!result.success) {
            log('WARN', '/checkerconfig', chatId, `Config check failed: ${result.error}`);
            return sendHtml(bot, chatId, formatError('Config Check Failed', result.error));
        }

        log('INFO', '/checkerconfig', chatId, `Config read successfully`);
        const html = formatConfigMessage(
            result.data,
            result.configAddress || (result.poolInfo && result.poolInfo.config),
            result.poolInfo,
        );
        return sendHtml(bot, chatId, html);
    } catch (e) {
        log('ERROR', '/checkerconfig', chatId, `Exception: ${e.message}`);
        return sendHtml(bot, chatId, formatError('Error', e.message || 'Unexpected error'));
    }
});

// ── /checkerfee <mint> ───────────────────────────────────────────────────────

bot.onText(/\/checkerfee(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = (match[1] || '').trim();

    if (!input) {
        log('WARN', '/checkerfee', chatId, 'No mint address provided');
        return sendHtml(bot, chatId, formatError(
            'Missing Argument',
            'Usage: /checkerfee <token_mint_address>',
        ));
    }

    if (!isValidBase58(input)) {
        log('WARN', '/checkerfee', chatId, `Invalid address: ${input.slice(0, 12)}...`);
        return sendHtml(bot, chatId, formatError(
            'Invalid Address',
            'Please provide a valid Solana base58 address.',
        ));
    }

    log('INFO', '/checkerfee', chatId, `Checking fees for mint: ${input}`);

    await bot.sendChatAction(chatId, 'typing');

    try {
        // Step 1: Find pool
        log('INFO', '/checkerfee', chatId, 'Resolving pool from mint...');
        const poolInfo = await findPoolByTokenMint(input);

        if (!poolInfo || !poolInfo.address) {
            log('WARN', '/checkerfee', chatId, 'Pool not found for this mint');
            return sendHtml(bot, chatId, formatError(
                'Pool Not Found',
                'No DBC pool found for this token mint address.',
            ));
        }

        log('INFO', '/checkerfee', chatId, `Pool found: ${poolInfo.address}`);

        // Step 2: Get SOL price
        let solUsd = 0;
        try { solUsd = await getSolUsdPrice(); } catch (_) { solUsd = 0; }

        // Step 3: Get claimable fees
        const feeData = await getClaimableFees(poolInfo.address, solUsd);

        // Step 4: Get token metadata
        let tokenMeta = { name: '', symbol: '' };
        try { tokenMeta = await fetchTokenMetadata(poolInfo.baseMint || input); } catch (_) { }

        log('INFO', '/checkerfee', chatId,
            `Fees: ${feeData.quoteAmount || 0} ${feeData.quoteLabel || 'SOL'} | Ready: ${feeData.readyToClaim}`);

        const html = formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd);
        return sendHtml(bot, chatId, html);
    } catch (e) {
        log('ERROR', '/checkerfee', chatId, `Exception: ${e.message}`);
        return sendHtml(bot, chatId, formatError('Error', e.message || 'Unexpected error'));
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
