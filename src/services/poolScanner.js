// poolScanner.js — Find DBC pool by token mint address
// Extracted from DBC_v14/src/services/poolScanner.js (read-only operations only)

const { Connection, PublicKey } = require('@solana/web3.js');
const { loadSettings } = require('../config/settings');

const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

const settings = loadSettings();

function createRpcConnection() {
    return new Connection(settings.RPC_URL, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 30000,
        disableRetryOnRateLimit: true,
        httpHeaders: { Origin: settings.RPC_ORIGIN },
    });
}

/**
 * Parse pool account data to extract key fields.
 * DBC Pool layout:
 *   byte  8-40  : config pubkey
 *   byte 40-72  : creator pubkey
 *   byte 72-104 : quote_mint
 *   byte 104-136: base_mint
 *   byte 136-168: base_vault
 *   byte 168-200: quote_vault
 */
function parsePoolAccountData(data) {
    try {
        if (!data || data.length < 200) return null;

        return {
            config: new PublicKey(data.slice(8, 40)).toBase58(),
            creator: new PublicKey(data.slice(40, 72)).toBase58(),
            quoteMint: new PublicKey(data.slice(72, 104)).toBase58(),
            baseMint: new PublicKey(data.slice(104, 136)).toBase58(),
            baseVault: new PublicKey(data.slice(136, 168)).toBase58(),
            quoteVault: new PublicKey(data.slice(168, 200)).toBase58(),
        };
    } catch (e) {
        return null;
    }
}

/**
 * Find pool address from token mint (baseMint).
 * Method 1: SDK getPoolByBaseMint (most reliable)
 * Method 2: memcmp filter with getProgramAccounts
 * Method 3: Scan all pools and filter manually
 */
async function findPoolByTokenMint(tokenMint) {
    const connection = createRpcConnection();
    const mintPubkey = new PublicKey(tokenMint);

    // Method 1 — SDK
    try {
        const { DynamicBondingCurveClient } = require('@meteora-ag/dynamic-bonding-curve-sdk');
        const dbcClient = new DynamicBondingCurveClient(connection, 'confirmed');

        const poolState = await Promise.race([
            dbcClient.state.getPoolByBaseMint(mintPubkey),
            new Promise((_, reject) => setTimeout(() => reject(new Error('SDK timeout')), 10000)),
        ]);

        if (poolState && poolState.publicKey) {
            const poolAddress = poolState.publicKey.toBase58
                ? poolState.publicKey.toBase58()
                : poolState.publicKey.toString();
            const account = poolState.account || {};

            const extract = (field) => {
                const val = account[field];
                if (!val) return 'Unknown';
                return typeof val.toBase58 === 'function' ? val.toBase58() : val.toString();
            };

            return {
                address: poolAddress,
                baseMint: extract('baseMint') !== 'Unknown' ? extract('baseMint') : tokenMint,
                quoteMint: extract('quoteMint'),
                config: extract('config'),
                creator: extract('creator') !== 'Unknown' ? extract('creator') : extract('poolCreator'),
                baseVault: extract('baseVault'),
                quoteVault: extract('quoteVault'),
            };
        }
    } catch (_) {
        // fall through
    }

    // Method 2 — memcmp filter
    try {
        const accounts = await connection.getProgramAccounts(new PublicKey(DBC_PROGRAM), {
            filters: [{ memcmp: { offset: 104, bytes: mintPubkey.toBase58() } }],
            commitment: 'confirmed',
            encoding: 'base64',
        });

        for (const { pubkey, account } of accounts) {
            const data = Buffer.from(account.data, 'base64');
            const parsed = parsePoolAccountData(data);
            if (parsed && parsed.baseMint === tokenMint) {
                return { address: pubkey.toBase58(), ...parsed };
            }
        }
    } catch (_) {
        // fall through
    }

    // Method 3 — full scan
    try {
        const allAccounts = await connection.getProgramAccounts(new PublicKey(DBC_PROGRAM), {
            commitment: 'confirmed',
            encoding: 'base64',
        });

        for (const { pubkey, account } of allAccounts) {
            try {
                const data = Buffer.from(account.data, 'base64');
                if (data.length < 136) continue;
                const extractedMint = new PublicKey(data.slice(104, 136)).toBase58();
                if (extractedMint === tokenMint) {
                    const parsed = parsePoolAccountData(data);
                    if (parsed) return { address: pubkey.toBase58(), ...parsed };
                }
            } catch (_) {
                continue;
            }
        }
    } catch (_) {
        // fall through
    }

    return null;
}

/**
 * Fetch token metadata (Name, Symbol) from Metaplex Metadata Account.
 */
async function fetchTokenMetadata(mintAddress) {
    if (!mintAddress) return { name: '', symbol: '' };
    try {
        const connection = createRpcConnection();
        const mintPubkey = new PublicKey(mintAddress);
        const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
            METADATA_PROGRAM_ID,
        );

        const info = await connection.getAccountInfo(pda);
        if (!info || !info.data) return { name: '', symbol: '' };

        const data = info.data;
        let p = 65;
        const nameLen = data.readUInt32LE(p);
        p += 4;
        const name = data.slice(p, p + nameLen).toString('utf8').replace(/\0/g, '').trim();
        p += nameLen;
        const symLen = data.readUInt32LE(p);
        p += 4;
        const symbol = data.slice(p, p + symLen).toString('utf8').replace(/\0/g, '').trim();

        return { name, symbol };
    } catch (_) {
        return { name: '', symbol: '' };
    }
}

module.exports = { findPoolByTokenMint, fetchTokenMetadata, parsePoolAccountData };
