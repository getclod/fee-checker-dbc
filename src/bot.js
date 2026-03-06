// bot.js — Telegram Bot for DBC Fee & Config Checking + Config Watcher
// Entry point: node src/bot.js

const TelegramBot = require('node-telegram-bot-api');
const { getConfigFromMint } = require('./checkers/configChecker');
const { getClaimableFees } = require('./checkers/feeChecker');
const { getTotalFees } = require('./checkers/totalFeeChecker');
const { findPoolByTokenMint, fetchTokenMetadata } = require('./services/poolScanner');
const { getSolUsdPrice } = require('./services/priceService');
const { startConfigWatcher } = require('./services/configWatcher');
const {
    formatConfigMessage,
    formatFeeMessage,
    formatError,
    formatStartMessage,
} = require('./formatters/telegram');

// ──── Configuration ──────────────────────────────────────────────────────────

const BOT_TOKEN = '8744533288:AAHk9IYfsYcCzRul6j2-grn_l9bRxorWbz8';

// Chat ID(s) to send deployment notifications to
// Set this to your group chat ID or personal chat ID
// To find your chat ID, send /chatid to the bot
const NOTIFY_CHAT_IDS = [-1003779556965];

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

function extractAddress(text) {
    if (!text) return null;
    const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,50}/g);
    if (!matches) return null;
    for (const m of matches) {
        if (isValidBase58(m)) return m;
    }
    return null;
}

function getMintFromMessage(msg, match) {
    const arg = (match[1] || '').trim();
    if (arg && isValidBase58(arg)) return arg;
    if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
        const addr = extractAddress(replyText);
        if (addr) return addr;
    }
    return null;
}

// Extract Config Creator address from a replied fee message
function getCreatorFromReply(msg, match) {
    const arg = (match[1] || '').trim();
    if (arg && isValidBase58(arg)) return arg;
    if (msg.reply_to_message) {
        const replyText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
        // Look for "Config Creator:" line → extract address from solscan URL
        const creatorMatch = replyText.match(/Config Creator[^\n]*solscan\.io\/account\/([1-9A-HJ-NP-Za-km-z]{32,50})/);
        if (creatorMatch && isValidBase58(creatorMatch[1])) return creatorMatch[1];
        // Fallback: look for any address
        const addr = extractAddress(replyText);
        if (addr) return addr;
    }
    return null;
}

async function sendHtml(bot, chatId, html, replyMarkup) {
    try {
        return await bot.sendMessage(chatId, html, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: replyMarkup || undefined,
        });
    } catch (e) {
        const plain = html.replace(/<[^>]+>/g, '');
        return await bot.sendMessage(chatId, plain);
    }
}

// ──── Shared fee check logic ─────────────────────────────────────────────────

async function checkFeeForMint(mint, chatId, source) {
    log('INFO', source, chatId, `Checking fees for: ${mint}`);

    const poolInfo = await findPoolByTokenMint(mint);
    if (!poolInfo || !poolInfo.address) return null;

    log('INFO', source, chatId, `Pool: ${poolInfo.address}`);

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

    log('INFO', source, chatId,
        `Fees: ${feeData.totalAvailable || 0} ${feeData.quoteLabel || 'SOL'}`);

    const html = formatFeeMessage(feeData, poolInfo, tokenMeta, solUsd, configData);

    // Refresh button with mint encoded in callback data
    const refreshButton = {
        inline_keyboard: [[
            { text: '🔄 Refresh', callback_data: `refresh:${mint}` }
        ]]
    };

    return { html, refreshButton };
}

// ──── Bot Setup ──────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Handle Telegram polling errors gracefully (ETIMEDOUT, EFATAL, etc)
bot.on('polling_error', (err) => {
    const msg = (err.message || '').slice(0, 80);
    console.error(`[${ts()}] [ERROR] [polling] ${msg}`);
});

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

    await bot.sendChatAction(chatId, 'typing');

    try {
        const result = await checkFeeForMint(mint, chatId, '/fee');
        if (!result) {
            return sendHtml(bot, chatId, formatError('Pool Not Found', 'No DBC pool found for this mint.'));
        }
        return sendHtml(bot, chatId, result.html, result.refreshButton);
    } catch (e) {
        log('ERROR', '/fee', chatId, `Exception: ${e.message}`);
        return sendHtml(bot, chatId, formatError('Error', e.message || 'Unexpected error'));
    }
});

// ── /totalfee <config_creator_wallet> ─────────────────────────────────────────

bot.onText(/\/totalfee(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const wallet = getCreatorFromReply(msg, match);

    if (!wallet) {
        log('WARN', '/totalfee', chatId, 'No wallet address');
        return sendHtml(bot, chatId, formatError(
            'Missing Address',
            'Usage: /totalfee <config_creator_wallet>\nShows total fees earned across all configs & pools.',
        ));
    }

    await sendHtml(bot, chatId, '⏳ Scanning wallet transactions... This may take a minute.');
    await bot.sendChatAction(chatId, 'typing');

    log('INFO', '/totalfee', chatId, `Scanning wallet: ${wallet}`);

    try {
        let solUsd = 0;
        try { solUsd = await getSolUsdPrice(); } catch (_) { }

        const result = await getTotalFees(wallet, solUsd);

        const shortAddr = (a) => (!a || a.length < 14) ? (a || '?') : `${a.slice(0, 6)}...${a.slice(-4)}`;
        const fmtNum = (n) => Number(n || 0).toFixed(6);
        const fmtUsd = (n, price) => {
            const val = Number(n || 0) * Number(price || 0);
            return val >= 0.01 ? `($${val.toFixed(2)})` : '';
        };

        const L = [];
        L.push(`💰 <b>Total Fee Report</b>`);
        L.push(`👤 Wallet: <a href="https://solscan.io/account/${wallet}">${shortAddr(wallet)}</a>`);
        L.push(`📊 ${result.txCount} DBC txs | ${result.claimCount} claims`);
        L.push(``);

        // Per-currency earned totals
        let totalUsdValue = 0;
        const currencyOrder = ['SOL', 'USD1', 'USDC'];
        const currencies = Object.keys(result.totals).sort((a, b) => {
            const ai = currencyOrder.indexOf(a);
            const bi = currencyOrder.indexOf(b);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

        for (const lbl of currencies) {
            const t = result.totals[lbl];
            const price = lbl === 'SOL' ? solUsd : 1;
            totalUsdValue += t.earned * price;
            L.push(`<b>── ${lbl} ──</b>`);
            L.push(`💰 Total Earned: ${fmtNum(t.earned)} ${lbl} ${fmtUsd(t.earned, price)}`);
            L.push(``);
        }

        L.push(`💵 <b>Total: $${totalUsdValue.toFixed(2)}</b>`);

        // Top 10 pools
        if (result.topPools.length > 0) {
            L.push(``);
            L.push(`🏆 <b>Top ${result.topPools.length} Pools:</b>`);
            for (let i = 0; i < result.topPools.length; i++) {
                const p = result.topPools[i];
                const price = p.quoteLabel === 'SOL' ? solUsd : 1;
                L.push(`${i + 1}. <a href="https://solscan.io/account/${p.address}">${shortAddr(p.address)}</a> → ${fmtNum(p.earned)} ${p.quoteLabel} ${fmtUsd(p.earned, price)}`);
            }
        }

        const logTotal = currencies.map(l => `${result.totals[l].earned.toFixed(2)} ${l}`).join(' + ');
        log('INFO', '/totalfee', chatId, `Done: ${result.claimCount} claims, ${logTotal}`);

        return sendHtml(bot, chatId, L.join('\n'));
    } catch (e) {
        log('ERROR', '/totalfee', chatId, `Exception: ${e.message}`);
        return sendHtml(bot, chatId, formatError('Error', e.message || 'Unexpected error'));
    }
});

// ── Auto-detect: bare CA paste → auto fee check ─────────────────────────────

bot.on('message', async (msg) => {
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/') || text.length < 32) return;

    const addr = extractAddress(text);
    if (!addr) return;
    if (text.length > addr.length + 10) return;

    const chatId = msg.chat.id;
    log('INFO', 'auto-fee', chatId, `Detected CA: ${addr}`);

    await bot.sendChatAction(chatId, 'typing');

    try {
        const result = await checkFeeForMint(addr, chatId, 'auto-fee');
        if (!result) return; // Not a DBC pool, silently ignore
        return sendHtml(bot, chatId, result.html, result.refreshButton);
    } catch (e) {
        log('ERROR', 'auto-fee', chatId, `Exception: ${e.message}`);
    }
});

// ── Refresh button callback ─────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const data = query.data || '';
    if (!data.startsWith('refresh:')) return;

    const mint = data.slice(8); // remove 'refresh:'
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    log('INFO', 'refresh', chatId, `Refreshing fees for: ${mint}`);

    // Acknowledge the button press
    await bot.answerCallbackQuery(query.id, { text: '🔄 Refreshing...' });

    try {
        const result = await checkFeeForMint(mint, chatId, 'refresh');
        if (!result) {
            await bot.answerCallbackQuery(query.id, { text: '❌ Pool not found' });
            return;
        }

        // Edit the existing message with fresh data
        // Try editMessageText first, fallback to editMessageCaption (for photo messages)
        try {
            await bot.editMessageText(result.html, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: result.refreshButton,
            });
        } catch (editErr) {
            // Photo message → try editMessageCaption, else send new message
            try {
                await bot.editMessageCaption(result.html, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: result.refreshButton,
                });
            } catch (_) {
                await sendHtml(bot, chatId, result.html, result.refreshButton);
            }
        }
    } catch (e) {
        log('ERROR', 'refresh', chatId, `Exception: ${(e.message || '').slice(0, 80)}`);
        try {
            await bot.answerCallbackQuery(query.id, { text: '❌ Refresh failed' });
        } catch (_) { }
    }
});

// ── /chatid — helper to get chat ID for notifications ───────────────────────

bot.onText(/\/chatid/, (msg) => {
    const chatId = msg.chat.id;
    sendHtml(bot, chatId, `📋 <b>Chat ID:</b> <code>${chatId}</code>\n\nAdd this ID to NOTIFY_CHAT_IDS in bot.js to receive deploy notifications here.`);
});

// ── Error handling ───────────────────────────────────────────────────────────

bot.on('polling_error', (err) => {
    console.error(`[${ts()}] [ERROR] [polling] ${err.message}`);
});

process.on('unhandledRejection', (err) => {
    console.error(`[${ts()}] [ERROR] [unhandled] ${err.message || err}`);
});

console.log(`[${ts()}] [BOOT] Bot is ready. Listening for commands...`);

// ── Start Config Watcher ─────────────────────────────────────────────────────

startConfigWatcher(
    // On new deployment
    (ownerName, info, html) => {
        const replyMarkup = {
            inline_keyboard: [[
                { text: '🔍 Check Fee', callback_data: `refresh:${info.baseMint}` }
            ]]
        };
        for (const chatId of NOTIFY_CHAT_IDS) {
            const sendNotif = async () => {
                try {
                    if (info.image) {
                        // Send as photo with caption
                        await bot.sendPhoto(chatId, info.image, {
                            caption: html,
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup,
                        });
                    } else {
                        await sendHtml(bot, chatId, html, replyMarkup);
                    }
                } catch (e) {
                    // Fallback to text if photo fails
                    try { await sendHtml(bot, chatId, html, replyMarkup); } catch (_) { }
                    console.error(`[${ts()}] [WATCHER] Notify error ${chatId}: ${e.message}`);
                }
            };
            sendNotif();
        }
    },
    // On new config discovered (silent — only logs to console, no group notification)
    (ownerName, configAddr, html) => {
        console.log(`[${ts()}] [WATCHER] New config by ${ownerName}: ${configAddr}`);
    }
);

console.log(`[${ts()}] [BOOT] Config watcher active. Monitoring configs.txt`);

