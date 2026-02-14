import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';

export class TradingStrategy {
    constructor() {
        this.position = null;
        this.entryPrice = 0;
        this.entryTime = 0;
        this.shares = 0;
        this.maxHoldTime = 0;
        this.peakPrice = 0;
        this.ticksBelowTrailing = 0;
        this.consecutiveSells = 0;
        this.consecutiveBuyTicks = 0;
        this.wasStoppedOut = false;
        this.leftBuys = 2;
        this.hasTradedThisSession = false;
    }

    /**
     * Reset strategy state for new session
     */
    resetForNewSession() {
        this.hasTradedThisSession = false;
        this.consecutiveBuyTicks = 0;
        this.consecutiveSells = 0;
        this.wasStoppedOut = false;
        this.leftBuys = 2;
    }

    /**
     * Get strategy parameters based on time remaining
     */
    getStrategyParams(secondsLeft) {
        const strategies = CONFIG.STRATEGY;
        
        for (const [name, params] of Object.entries(strategies)) {
            const [min, max] = params.TIME_RANGE;
            if (secondsLeft >= min && secondsLeft < max) {
                return { name, ...params };
            }
        }
        
        return null;
    }

    /**
     * Evaluate if we should enter a position
     */
    evaluateBuySignal(upPrice, downPrice, secondsLeft) {
        // Don't buy if we already have a position or used up buys or stopped out
        if (this.position || this.leftBuys <= 0 || this.wasStoppedOut) {
            return null;
        }

        const strategy = this.getStrategyParams(secondsLeft);
        if (!strategy) {
            this.consecutiveBuyTicks = 0;
            return null;
        }

        const up = parseFloat(upPrice);
        const down = parseFloat(downPrice);
        const losingPrice = Math.min(up, down);
        const losingSide = up < down ? 'UP' : 'DOWN';

        // Check if price is in valid range
        const isPriceInRange = losingPrice >= strategy.MIN_PRICE && 
                              losingPrice <= strategy.MAX_PRICE;

        if (isPriceInRange) {
            this.consecutiveBuyTicks++;
            
            return {
                side: losingSide,
                price: losingPrice,
                strategy: strategy.name,
                positionSize: strategy.POSITION_SIZE,
                maxHoldTime: strategy.MAX_HOLD_TIME,
                upPrice: up,
                downPrice: down
            };
        }

        this.consecutiveBuyTicks = 0;
        return null;
    }

    /**
     * Execute buy (update internal state)
     */
    executeBuy(signal, balance) {
        const investmentAmount = balance * signal.positionSize;
        
        this.entryPrice = signal.price;
        this.entryTime = Date.now();
        this.shares = investmentAmount / signal.price;
        this.position = signal.side;
        this.maxHoldTime = signal.maxHoldTime;
        this.peakPrice = signal.price;
        this.hasTradedThisSession = true;
        this.leftBuys--;
        this.consecutiveBuyTicks = 0;

        return {
            investmentAmount,
            shares: this.shares,
            newBalance: balance - investmentAmount
        };
    }

    /**
     * Evaluate if we should exit position
     */
    evaluateSellSignal(currentPrice, secondsLeft) {
        if (!this.position) {
            return null;
        }

        const now = Date.now();
        const holdTimeSeconds = (now - this.entryTime) / 1000;

        // Track peak price
        if (currentPrice > this.peakPrice) {
            this.peakPrice = currentPrice;
        }

        const currentMultiple = currentPrice / this.entryPrice;
        const peakMultiple = this.peakPrice / this.entryPrice;

        // Check if trailing stop should be active
        const trailingIsActive = this.peakPrice >= this.entryPrice * CONFIG.EXIT.MIN_PROFIT_FOR_TRAILING;
        
        // Calculate stop price based on whether trailing is active
        let effectiveStopPrice;
        if (trailingIsActive) {
            // Once trailing activates, ONLY use peak-based trailing (no min profit lock!)
            effectiveStopPrice = this.peakPrice * CONFIG.EXIT.TRAILING_STOP_PERCENT;
        } else {
            // Before trailing activates, protect with min profit lock
            const minProfitPrice = this.entryPrice * CONFIG.EXIT.MIN_PROFIT_LOCK;
            effectiveStopPrice = minProfitPrice;
        }

        // Check trailing stop
        let isTrailingStop = false;
        if (trailingIsActive && currentPrice <= effectiveStopPrice) {
            this.ticksBelowTrailing++;
            if (this.ticksBelowTrailing >= CONFIG.EXIT.TRAILING_TICKS) {
                isTrailingStop = true;
            }
        } else {
            this.ticksBelowTrailing = 0;
        }

        // Check force sell conditions
        let isForceSell = false;
        let forceReason = "";

        if (secondsLeft < CONFIG.EXIT.SESSION_END_THRESHOLD) {
            isForceSell = true;
            forceReason = `SESSION ENDING (<${CONFIG.EXIT.SESSION_END_THRESHOLD}s)`;
        } else if (holdTimeSeconds >= this.maxHoldTime) {
            isForceSell = true;
            forceReason = `MAX HOLD (${this.maxHoldTime}s)`;
        }

        if (isTrailingStop || isForceSell) {
            this.consecutiveSells++;
            const needsConfirmation = !(isForceSell || isTrailingStop) && this.consecutiveSells < 2;

            if (!needsConfirmation) {
                return {
                    reason: isTrailingStop 
                        ? `TRAILING STOP (Peak: ${peakMultiple.toFixed(2)}x, -8%)`
                        : forceReason,
                    isTrailingStop,
                    isForceSell,
                    currentMultiple,
                    peakMultiple,
                    holdTimeSeconds,
                    emoji: isTrailingStop ? "📉" : "⏰"
                };
            }
        } else {
            this.consecutiveSells = 0;
            
            // Log hold status periodically
            if (holdTimeSeconds % 10 < 0.5 && holdTimeSeconds > 1) {
                console.log(
                    `   ⏳ Holding ${this.position}: ` +
                    `Current: $${currentPrice.toFixed(3)} (${currentMultiple.toFixed(2)}x) | ` +
                    `Peak: $${this.peakPrice.toFixed(3)} (${peakMultiple.toFixed(2)}x) | ` +
                    `Trail Stop: $${effectiveStopPrice.toFixed(3)} | ` +
                    `Ticks Below: ${this.ticksBelowTrailing}`
                );
            }
        }

        return null;
    }

    /**
     * Execute sell (update internal state)
     */
    executeSell(currentPrice) {
        const saleProceeds = this.shares * currentPrice;
        const investedAmount = this.shares * this.entryPrice;
        const profitLoss = saleProceeds - investedAmount;
        const profitLossPct = ((profitLoss / investedAmount) * 100);

        const result = {
            saleProceeds,
            investedAmount,
            profitLoss,
            profitLossPct,
            shares: this.shares,
            position: this.position
        };

        // Reset position state
        this.position = null;
        this.shares = 0;
        this.entryPrice = 0;
        this.entryTime = 0;
        this.peakPrice = 0;
        this.ticksBelowTrailing = 0;
        this.consecutiveSells = 0;

        return result;
    }

    /**
     * Mark as stopped out (prevents further trading this session)
     */
    setStoppedOut() {
        this.wasStoppedOut = true;
    }
}