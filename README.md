# DBC Fee & Config Checker — Telegram Bot

Standalone Telegram bot for checking Meteora Dynamic Bonding Curve (DBC) pool fees and configurations on-chain.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and usage guide |
| `/checkerfee <mint>` | Check claimable trading fees for a DBC pool |
| `/checkerconfig <mint>` | Read full pool configuration (fee schedule, LP split, migration, dynamic fee) |

## Setup

```bash
git clone https://github.com/getclod/fee-checker-dbc.git
cd fee-checker-dbc
npm install
```

## Configuration

Edit `setting.json` to set your RPC endpoints:

```json
{
  "RPC_URLS": ["https://your-rpc-endpoint.com"],
  "RPC_ORIGIN": "http://localhost",
  "JUPITER_API_KEY": "your-jupiter-api-key"
}
```

## Run

```bash
node src/bot.js
```

### Run with PM2 (recommended for VPS)

```bash
npm install -g pm2
pm2 start src/bot.js --name dbc-checker
pm2 save
pm2 startup
```

## Project Structure

```
src/
  bot.js                    Entry point — Telegram bot
  config/settings.js        Loads setting.json (RPC config)
  services/
    poolScanner.js           Find DBC pool by token mint
    priceService.js          SOL/USD price (Jupiter + Axiom)
  checkers/
    configChecker.js         On-chain config reader
    feeChecker.js            Claimable fee checker (read-only)
  formatters/
    telegram.js              Monospace HTML output for Telegram
```

## Dependencies

- `@solana/web3.js` — Solana RPC interaction
- `@meteora-ag/dynamic-bonding-curve-sdk` — DBC pool/config reading
- `node-telegram-bot-api` — Telegram bot framework
- `axios` — HTTP client for price feeds
- `bs58` — Base58 encoding
