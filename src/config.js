import 'dotenv/config';

export const CONFIG = {
    // API Configuration
    HOST: 'https://clob.polymarket.com',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CHAIN_ID: 137,
    
    // Trading Configuration
    INITIAL_BALANCE: 30.00,
    TICK_INTERVAL: 500, // Price check interval in ms
    SESSION_SYNC_INTERVAL: 20000, // Market session sync interval in ms

    // Environment Variables
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    SIGNATURE_TYPE: parseInt(process.env.SIGNATURE_TYPE || '1'),
    FUNDER_ADDRESS: process.env.FUNDER_ADDRESS,
    
    // Trading Mode
    MOCK_MODE: process.env.MOCK_MODE === 'true', // Set to 'true' for mock trading
    
    // Trading Windows — only enter positions during these hours (local time)
   TRADING_WINDOWS: [
        { start: "04:40", end: "05:00" },
        { start: "16:25", end: "16:35" },
    ],

    // BTC Real-Time Feed (Polymarket RTDS — Chainlink BTC/USD)
    BTC_FEED: {
        ENABLED:              true,  // Set false to bypass Gate 4 entirely
        LOG_SNAPSHOT:         true,  // Log BTC snapshot on every buy signal evaluation
        MIN_CONFIDENCE:       80,    // Minimum predictReversal confidence score (0-100) to enter
        REVERSAL_WINDOW_SECS: 10,    // Velocity look-back for projected move calculation
    },

    // Strategy: buy the losing (cheaper) side near session end at a very low price
    STRATEGY: {
        ENTRY_SECONDS_LEFT:  120,  // Only enter when ≤ this many seconds remain
        MIN_ENTRY_SECONDS:   5,    // Don't enter if fewer than this many seconds remain
        MIN_ENTRY_PRICE:     0.01, // Ignore prices below this (rounding noise)
        MAX_ENTRY_PRICE:     0.02, // Maximum price to enter (the "cheap" losing side)
        POSITION_SIZE:       0.40, // Fraction of balance to invest per trade
        PROFIT_TARGET:       0.99, // Exit immediately when price hits this
        FORCE_EXIT_SECONDS:  0,    // Force-exit when session has this many seconds left
    },

    // Exit guardrails (used for emergency / liquidity edge cases)
    EXIT: {
        EMERGENCY_EXIT_THRESHOLD: 0, // Seconds before session end → accept any price
    },
    
    // Order Configuration
    ORDER: {
        SLIPPAGE: 0.02, // 2% slippage tolerance
        MIN_ORDER_SIZE: 0.1, // Minimum order size in USDC
        MAX_RETRIES: 3, // Maximum order retry attempts
    }
};

// Validate required environment variables
export function validateConfig() {
    if (!CONFIG.PRIVATE_KEY) {
        throw new Error('PRIVATE_KEY is required in .env file');
    }
    
    if (!CONFIG.MOCK_MODE && !CONFIG.FUNDER_ADDRESS) {
        console.warn('⚠️  FUNDER_ADDRESS not set. Will use wallet address as funder.');
    }
    
    return true;
}