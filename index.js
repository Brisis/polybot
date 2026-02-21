import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { CONFIG, validateConfig } from './src/config.js';
import { logger } from './src/utils/logger.js';
import { MarketSession } from './src/market.js';
import { TradingStrategy } from './src/strategy.js';
import { Trader } from './src/trader.js';
import { BTCFeed } from './src/btc-feed.js';

class PolymarketBot {
    constructor() {
        this.publicClient = null;
        this.authClient = null;
        this.market = new MarketSession();
        this.strategy = new TradingStrategy();
        this.trader = null;
        this.btcFeed = new BTCFeed();
    }

    /**
     * Initialize the bot
     */
    async initialize() {
        try {
            // Validate configuration
            validateConfig();

            logger.step('Initializing Polymarket Trading Bot...');
            logger.info(`Mode: ${CONFIG.MOCK_MODE ? 'MOCK TRADING' : 'LIVE TRADING'}`);

            // Create signer from private key
            const signer = new Wallet(CONFIG.PRIVATE_KEY);
            const walletAddress = signer.address;
            
            logger.info(`Wallet: ${walletAddress}`);

            // Initialize public client (no auth needed)
            this.publicClient = new ClobClient(
                CONFIG.HOST, 
                CONFIG.CHAIN_ID
            );

            logger.success('Public client initialized');

            // Start BTC real-time feed
            // if (CONFIG.BTC_FEED.ENABLED) {
            //     this.btcFeed.start();
            // }

            // Initialize authenticated client for trading
            if (!CONFIG.MOCK_MODE) {
                try {
                    const l1Client = new ClobClient(
                        CONFIG.HOST,
                        CONFIG.CHAIN_ID,
                        signer,
                        undefined,
                        CONFIG.SIGNATURE_TYPE,
                        CONFIG.FUNDER_ADDRESS
                    );

                    logger.info('Deriving API credentials...');
                    const creds = await l1Client.deriveApiKey();

                    this.authClient = new ClobClient(
                        CONFIG.HOST,
                        CONFIG.CHAIN_ID,
                        signer,
                        creds,
                        CONFIG.SIGNATURE_TYPE,
                        CONFIG.FUNDER_ADDRESS
                    );

                    logger.success('Authenticated client initialized');
                } catch (error) {
                    logger.error(`Authentication failed: ${error.message}`);
                    logger.warning('Falling back to mock mode');
                    CONFIG.MOCK_MODE = true;
                }
            }

            // Use authenticated client if available, otherwise public
            const tradingClient = this.authClient || this.publicClient;
            this.trader = new Trader(tradingClient, this.market);

            // Sync to current market session
            await this.market.sync();

            // Update initial balance
            await this.trader.updateBalance();
            
            const balance = this.trader.getBalance();
            logger.success(
                `Bot initialized | Balance: $${balance} | ` +
                `Session: ${this.market.currentSlug}`
            );

            return true;
        } catch (error) {
            logger.error(`Initialization failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Main trading loop - check prices and execute strategy
     */
    async tick() {
        if (!this.market.isReady()) {
            return;
        }

        try {
            // Get current prices
            const prices = await this.trader.getPrices();
            if (!prices) return;

            const { up, down } = prices;
            const { secondsLeft, sessionProgress } = this.market.getTimeRemaining();

            // Log current state
            const balance = this.trader.getBalance();
            const inWindow = this.strategy.isInTradingWindow();
            logger.feed(
                up.toFixed(3),
                down.toFixed(3),
                this.trader.realBalance,
                balance,
                this.market.currentSlug,
                secondsLeft,
                sessionProgress,
                this.strategy.position,
                CONFIG.MOCK_MODE ? 'mock' : 'live',
                inWindow
            );

            // Evaluate strategy
            await this.evaluateStrategy(up, down, secondsLeft, balance);

        } catch (error) {
            logger.error(`Tick error: ${error.message}`);
        }
    }

    /**
     * Evaluate and execute trading strategy
     */
    async evaluateStrategy(up, down, secondsLeft, balance) {
        // Check for buy signal
        if (!this.strategy.position) {
            const buySignal = this.strategy.evaluateBuySignal(up, down, secondsLeft, this.btcFeed);

            if (buySignal) {
                await this.executeBuy(buySignal, balance);
            }
        }
        // Check for sell signal
        else {
            const currentPrice = this.strategy.position === 'UP' ? up : down;
            const sellSignal = this.strategy.evaluateSellSignal(currentPrice, secondsLeft);

            if (sellSignal) {
                await this.executeSell(sellSignal, currentPrice, up, down);
            }
        }
    }

    /**
     * Execute buy order
     */
    async executeBuy(signal, balance) {
        try {
            const investmentAmount = 1; //balance * signal.positionSize;

            // Check if we have sufficient balance
            if (!this.trader.hasSufficientBalance(investmentAmount)) {
                logger.warning(`Insufficient balance: $${balance} < $${investmentAmount.toFixed(2)}`);
                return;
            }

            // Place the order
            logger.info(`Executing BUY: ${signal.side} at $${signal.price.toFixed(3)}`);
            const orderResult = await this.trader.placeBuyOrder(
                signal.side,
                signal.price,
                investmentAmount
            );

            if (orderResult.success) {
                // Update strategy state ONLY if buy succeeded
                const result = this.strategy.executeBuy(signal, balance);

                const attemptInfo = orderResult.attempts > 1 ? ` (${orderResult.attempts} attempts)` : '';

                logger.trade(
                    `🚀 [${signal.strategy}] BUY ${signal.side} (losing side) at $${signal.price.toFixed(3)}${attemptInfo} | ` +
                    `Invested: $${result.investmentAmount.toFixed(2)} (${(signal.positionSize * 100).toFixed(0)}%) | ` +
                    `Shares: ${result.shares.toFixed(2)} | ` +
                    `Target: $${CONFIG.STRATEGY.PROFIT_TARGET} | ` +
                    `Upside: ${(((CONFIG.STRATEGY.PROFIT_TARGET - signal.price) / signal.price) * 100).toFixed(1)}% | ` +
                    `Time Left: ${this.market.getTimeRemaining().secondsLeft}s`,
                    {
                        up: signal.upPrice,
                        down: signal.downPrice,
                        position: signal.side,
                        mock: CONFIG.MOCK_MODE
                    },
                    {
                        currentSlug: this.market.currentSlug,
                        realBalance: this.trader.realBalance,
                        mockBalance: this.trader.balance
                    }
                ); 

                // Balance already updated in trader.placeBuyOrder()
            } else {
                // Buy failed after all retries
                logger.error(`❌ Failed to buy ${signal.side} after ${orderResult.attempts || 0} attempts!`);
                logger.error(`Error: ${orderResult.error}`);
                logger.warning(`Skipping this entry. Will look for next opportunity.`);
                
                // Log to CSV for monitoring
                const time = new Date().toLocaleTimeString('en-US', { hour12: false });
                logger.writeToCSV([
                    time,
                    this.market.currentSlug,
                    this.trader.realBalance,
                    this.trader.balance,
                    'NONE',
                    signal.upPrice,
                    signal.downPrice,
                    `ERROR: BUY FAILED - ${orderResult.error}`
                ]);
            }

        } catch (error) {
            logger.error(`Execute buy error: ${error.message}`);
            logger.error(error.stack);
        }
    }

    /**
     * Execute sell order
     */
    async executeSell(signal, currentPrice, up, down) {
        try {
            // Check for emergency exit warning
            if (signal.isEmergencyExit && !signal.hasLiquidity) {
                logger.warning(
                    `🆘 EMERGENCY EXIT: Price $${currentPrice.toFixed(3)} is below liquidity threshold ` +
                    `($${CONFIG.EXIT.MIN_SELL_PRICE}) but session is ending! Attempting sale...`
                );
            }

            logger.info(`Executing SELL: ${this.strategy.position} at $${currentPrice.toFixed(3)}`);
            
            const orderResult = await this.trader.placeSellOrder(
                this.strategy.position,
                currentPrice,
                this.strategy.shares
            );

            if (orderResult.success) {
                // Update strategy state ONLY if sell succeeded
                const result = this.strategy.executeSell(currentPrice);

                const attemptInfo = orderResult.attempts > 1 ? ` (${orderResult.attempts} attempts)` : '';
                
                // Add liquidity status to trade log
                const liquidityInfo = !signal.hasLiquidity 
                    ? ` ⚠️  [BELOW LIQUIDITY THRESHOLD]` 
                    : signal.isEmergencyExit 
                        ? ` [EMERGENCY EXIT]`
                        : '';

                logger.trade(
                    `${signal.emoji} SOLD ${result.position} at $${currentPrice.toFixed(3)}${attemptInfo}${liquidityInfo} | ` +
                    `Multiple: ${signal.currentMultiple.toFixed(2)}x (Peak: ${signal.peakMultiple.toFixed(2)}x) | ` +
                    `Reason: ${signal.reason} | ` +
                    `Hold Time: ${signal.holdTimeSeconds.toFixed(1)}s | ` +
                    `P&L: ${result.profitLoss >= 0 ? '+' : ''}$${result.profitLoss.toFixed(2)} ` +
                    `(${result.profitLossPct >= 0 ? '+' : ''}${result.profitLossPct.toFixed(1)}%) | ` +
                    `New Balance: $${this.trader.getBalance().toFixed(2)}`,
                    {
                        up,
                        down,
                        position: 'NONE',
                        mock: CONFIG.MOCK_MODE
                    },
                    {
                        currentSlug: this.market.currentSlug,
                        realBalance: this.trader.realBalance,
                        mockBalance: this.trader.balance
                    }
                );

                // Mark as stopped out if trailing stop
                if (signal.isTrailingStop) {
                    this.strategy.setStoppedOut();
                }
            } else {
                // Check if it's a liquidity issue
                if (orderResult.error && orderResult.error.includes('No liquidity')) {
                    // NO LIQUIDITY - Force close position to avoid being stuck
                    logger.error(`💀 NO LIQUIDITY to sell ${this.strategy.position} at $${currentPrice.toFixed(3)}`);
                    logger.warning(`This confirms the liquidity issue - price was $${currentPrice.toFixed(3)}, below recommended $${CONFIG.EXIT.MIN_SELL_PRICE}`);
                    logger.warning(`Accepting position as LOSS. Clearing strategy state.`);
                    
                    // Force close the position in strategy
                    const result = this.strategy.executeSell(currentPrice);
                    
                    logger.trade(
                        `💀 FORCED EXIT (no liquidity) ${result.position} at $${currentPrice.toFixed(3)} | ` +
                        `P&L: ${result.profitLoss >= 0 ? '+' : ''}$${result.profitLoss.toFixed(2)} ` +
                        `(${result.profitLossPct >= 0 ? '+' : ''}${result.profitLossPct.toFixed(1)}%) | ` +
                        `Tokens still held in wallet (worthless at this price)`,
                        {
                            up,
                            down,
                            position: 'NONE',
                            mock: CONFIG.MOCK_MODE
                        },
                        {
                            currentSlug: this.market.currentSlug,
                            realBalance: this.trader.realBalance,
                            mockBalance: this.trader.balance
                        }
                    );
                    
                    // Mark as stopped out if it was trailing stop
                    if (signal.isTrailingStop) {
                        this.strategy.setStoppedOut();
                    }
                } else {
                    // Other error - keep position open and retry
                    logger.error(`🚨 CRITICAL: Failed to sell ${this.strategy.position} after ${orderResult.attempts || 0} attempts!`);
                    logger.error(`Error: ${orderResult.error}`);
                    logger.warning(`Position remains OPEN. Will retry on next tick.`);
                    logger.warning(`Current price: $${currentPrice.toFixed(3)}, Shares: ${this.strategy.shares.toFixed(2)}`);
                    
                    // DO NOT update strategy state - keep position open
                    // Reset consecutive sells counter so it will try again immediately
                    this.strategy.consecutiveSells = 0;
                    this.strategy.ticksBelowTrailing = CONFIG.EXIT.TRAILING_TICKS;
                    
                    // Log to CSV for monitoring
                    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
                    logger.writeToCSV([
                        time,
                        this.market.currentSlug,
                        this.trader.realBalance,
                        this.trader.balance,
                        this.strategy.position,
                        up,
                        down,
                        `ERROR: SELL FAILED - ${orderResult.error}`
                    ]);
                }
            }

        } catch (error) {
            logger.error(`🚨 Execute sell EXCEPTION: ${error.message}`);
            logger.error(error.stack);
            logger.warning(`Position remains OPEN. Will retry on next tick.`);
        }
    }

    /**
     * Handle new market session
     */
    async onNewSession() {
        logger.step('New trading session detected');
        this.strategy.resetForNewSession();
        await this.trader.updateBalance();

        // Set session peg from the live Chainlink price at this exact moment.
        // Both the peg and all momentum calculations now come from the same source
        // — Polymarket's own Chainlink feed — so session bias is accurate.
        // if (CONFIG.BTC_FEED.ENABLED) {
        //     this.btcFeed.setSessionPeg(this.btcFeed.latestPrice);
        // }

        const balance = this.trader.getBalance();
        logger.info(`Session Balance: $${balance}`);
    }

    /**
     * Start the bot
     */
    async start() {
        const initialized = await this.initialize();
        if (!initialized) {
            logger.error('Failed to initialize bot');
            return;
        }

        // Main tick loop
        const tickInterval = setInterval(async () => {
            await this.tick();
        }, CONFIG.TICK_INTERVAL);

        // Market session sync loop
        const syncInterval = setInterval(async () => {
            const result = await this.market.sync();
            if (result.newSession) {
                // Save 120s volatility snapshot of the session that just closed
                // before anything resets — slug is still the old one at this point
                // if (CONFIG.BTC_FEED.ENABLED) {
                //     this.btcFeed.saveSessionVolatility(this.market.currentSlug);
                // }

                // Don't reset until any open position is closed first
                if (this.strategy.position) {
                    logger.warning(
                        `New session detected but position still open ` +
                        `(${this.strategy.position}) -- waiting for exit before switching...`
                    );
                } else {
                    await this.onNewSession();
                }
            }
        }, CONFIG.SESSION_SYNC_INTERVAL);

        logger.success('🤖 Bot started! Waiting for trading signals...\n');

        // Graceful shutdown
        process.on('SIGINT', () => {
            logger.warning('\nShutting down bot...');
            clearInterval(tickInterval);
            clearInterval(syncInterval);
            //this.btcFeed.stop();
            process.exit(0);
        });
    }
}

// Start the bot
const bot = new PolymarketBot();
bot.start().catch(error => {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
});