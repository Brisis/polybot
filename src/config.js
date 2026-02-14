import 'dotenv/config';

export const CONFIG = {
    // API Configuration
    HOST: 'https://clob.polymarket.com',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CHAIN_ID: 137,
    
    // Trading Configuration
    INITIAL_BALANCE: 10.00,
    TICK_INTERVAL: 333, // Price check interval in ms
    SESSION_SYNC_INTERVAL: 15000, // Market session sync interval in ms
    
    // Environment Variables
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    SIGNATURE_TYPE: parseInt(process.env.SIGNATURE_TYPE || '0'),
    FUNDER_ADDRESS: process.env.FUNDER_ADDRESS,
    
    // Trading Mode
    MOCK_MODE: process.env.MOCK_MODE === 'true', // Set to 'true' for mock trading
    
    // Strategy Parameters
    STRATEGY: {
        LATE_REVERSAL: {
            TIME_RANGE: [120, 180],
            MIN_PRICE: 0.01,
            MAX_PRICE: 0.10,
            REQUIRED_STABILITY: 2,
            MAX_HOLD_TIME: 120,
            POSITION_SIZE: 0.40
        },
        MID_LATE_SELECTIVE: {
            TIME_RANGE: [180, 270],
            MIN_PRICE: 0.01,
            MAX_PRICE: 0.15,
            REQUIRED_STABILITY: 2,
            MAX_HOLD_TIME: 120,
            POSITION_SIZE: 0.40
        },
        MID_CONSERVATIVE: {
            TIME_RANGE: [270, 450],
            MIN_PRICE: 0.01,
            MAX_PRICE: 0.20,
            REQUIRED_STABILITY: 2,
            MAX_HOLD_TIME: 120,
            POSITION_SIZE: 0.40
        },
        EARLY_OPPORTUNISTIC: {
            TIME_RANGE: [450, 800],
            MIN_PRICE: 0.01,
            MAX_PRICE: 0.25,
            REQUIRED_STABILITY: 2,
            MAX_HOLD_TIME: 150,
            POSITION_SIZE: 0.40
        }
    },
    
    // Exit Strategy
    EXIT: {
        TRAILING_STOP_PERCENT: 0.92, // 15% trailing stop
        MIN_PROFIT_LOCK: 1.08, // 15% minimum profit lock
        MIN_PROFIT_FOR_TRAILING: 1.10, // 15% profit to activate trailing
        TRAILING_TICKS: 1, // Ticks below trailing before exit
        SESSION_END_THRESHOLD: 10, // Seconds before session end to force exit
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
