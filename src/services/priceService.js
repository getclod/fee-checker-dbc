// priceService.js — SOL/USD price via Jupiter Quote API with Axiom fallback
// Extracted from DBC_v14/src/services/priceService.js

const axios = require('axios');
const { loadSettings } = require('../config/settings');

let cache = { solUsd: 0, ts: 0 };

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function getSolUsdPrice() {
    const now = Date.now();
    if (cache.solUsd > 0 && (now - cache.ts) < 15000) return cache.solUsd;

    const settings = loadSettings();

    // Jupiter Quote API
    try {
        const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
        if (settings.JUPITER_API_KEY) headers['x-api-key'] = settings.JUPITER_API_KEY;

        const amount = 1e9;
        const resp = await axios.get(
            `https://api.jup.ag/swap/v1/quote?inputMint=${WSOL_MINT}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=50`,
            { timeout: 10000, headers },
        );

        if (resp?.data?.outAmount) {
            const price = Number(resp.data.outAmount) / 1e6;
            if (Number.isFinite(price) && price > 0) {
                cache = { solUsd: price, ts: now };
                return price;
            }
        }
    } catch (_) {
        // fall through
    }

    // Axiom fallback
    try {
        const resp = await axios.get('https://axiom.trade/api/coin-prices', {
            timeout: 7000,
            headers: { accept: 'application/json', referer: 'https://axiom.trade/pulse?chain=sol' },
        });

        const raw = resp?.data?.data?.SOL;
        const price = Number.parseFloat(String(raw || '').replace(',', '.'));
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid SOL price');

        cache = { solUsd: price, ts: now };
        return price;
    } catch (e) {
        throw new Error(`Failed to get SOL price: ${e.message}`);
    }
}

module.exports = { getSolUsdPrice };
