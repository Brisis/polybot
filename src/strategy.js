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
        this.leftBuys = 1; // Limit to 1 buy per session to manage risk
        this.hasTradedThisSession = false;
    }

    /**
     * Check if current hour falls inside a configured trading window
     */
   isInTradingWindow() {
        const now = new Date();
        const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        const gmt2Minutes = (utcMinutes + 120) % 1440; // +120 min offset, wrap at 24h

        return CONFIG.TRADING_WINDOWS.some(w => {
            const [startH, startM] = w.start.split(":").map(Number);
            const [endH, endM]     = w.end.split(":").map(Number);
            const start = startH * 60 + startM;
            const end   = endH   * 60 + endM;
            return gmt2Minutes >= start && gmt2Minutes < end;
        });
    }

    /**
     * Reset strategy state for new session
     */
    resetForNewSession() {
        this.hasTradedThisSession = false;
        this.consecutiveBuyTicks = 0;
        this.consecutiveSells = 0;
        this.wasStoppedOut = false;
        this.leftBuys = 1;
    }

    /**
     * Evaluate if we should enter a position
     */
    evaluateBuySignal(upPrice, downPrice, secondsLeft, btcFeed = null) {
        // Don't enter if already in a position, out of buys, or stopped out
        if (this.position || this.leftBuys <= 0 || this.wasStoppedOut) return null;

        // Gate 1: trading window
        if (!this.isInTradingWindow()) return null;

        const strat = CONFIG.STRATEGY;

        // Gate 2: time window — only enter with ≤ ENTRY_SECONDS_LEFT but ≥ MIN_ENTRY_SECONDS left
        if (secondsLeft > strat.ENTRY_SECONDS_LEFT || secondsLeft < strat.MIN_ENTRY_SECONDS) return null;

        const up   = parseFloat(upPrice);
        const down = parseFloat(downPrice);

        // Losing side = the cheaper one
        const losingSide  = up < down ? 'UP' : 'DOWN';
        const loserPrice  = losingSide === 'UP' ? up : down;

        // Gate 3: price must be in the sweet-spot range (not noise, not too expensive)
        if (loserPrice < strat.MIN_ENTRY_PRICE || loserPrice > strat.MAX_ENTRY_PRICE) return null;

        // Gate 4: predict whether the reversal is plausible given BTC position,
        // velocity, and historical session volatility
        // if (btcFeed && CONFIG.BTC_FEED.ENABLED) {
        //     const snap = btcFeed.getSnapshot();

        //     if (CONFIG.BTC_FEED.LOG_SNAPSHOT) {
        //         const bias = snap.sessionBias !== null
        //             ? `${snap.sessionBias >= 0 ? '+' : ''}${snap.sessionBias.toFixed(3)}%`
        //             : 'n/a';
        //         const peg  = snap.sessionPeg ? `$${snap.sessionPeg.toFixed(2)}` : 'n/a';
        //         logger.info(
        //             `BTC $${snap.price?.toFixed(2) ?? 'n/a'} | Peg: ${peg} | ` +
        //             `Bias: ${bias} | ` +
        //             `Mom30s: ${snap.momentum30 !== null ? `${snap.momentum30 >= 0 ? '+' : ''}${snap.momentum30.toFixed(3)}%` : 'n/a'} | ` +
        //             `Vel10s: ${snap.velocity10 !== null ? `${snap.velocity10 >= 0 ? '+' : ''}${snap.velocity10.toFixed(2)}$/s` : 'n/a'}`
        //         );
        //     }

        //     const { plausible, confidence, details } = btcFeed.predictReversal(
        //         losingSide,
        //         secondsLeft,
        //     );

        //     if (!plausible || confidence < CONFIG.BTC_FEED.MIN_CONFIDENCE) {
        //         logger.warning(`Gate 4 FAILED -- reversal unlikely (confidence: ${confidence}/100, min: ${CONFIG.BTC_FEED.MIN_CONFIDENCE})`);
        //         return null;
        //     }

        //     logger.info(`Gate 4 PASSED -- reversal plausible (confidence: ${confidence}/100)`);
        // }

        const upside = ((strat.PROFIT_TARGET - loserPrice) / loserPrice * 100).toFixed(1);
        logger.info(
            `📡 Signal: ${losingSide} (losing side) @ $${loserPrice.toFixed(3)} | ` +
            `Upside to target: ${upside}% | ${secondsLeft}s left`
        );

        return {
            side:         losingSide,
            price:        loserPrice,
            strategy:     'LOSING_SIDE',
            positionSize: strat.POSITION_SIZE,
            maxHoldTime:  secondsLeft,
            upPrice:      up,
            downPrice:    down,
        };
    }

    /**
     * Execute buy (update internal state)
     */
    executeBuy(signal, balance) {
        const investmentAmount = 1; //balance * signal.positionSize;

        this.entryPrice          = signal.price;
        this.entryTime           = Date.now();
        this.shares              = investmentAmount / signal.price;
        this.position            = signal.side;
        this.maxHoldTime         = signal.maxHoldTime;
        this.peakPrice           = signal.price;
        this.hasTradedThisSession = true;
        this.leftBuys--;
        this.consecutiveBuyTicks = 0;

        return {
            investmentAmount,
            shares:          this.shares,
            newBalance:      balance - investmentAmount,
            effectiveMinSell: CONFIG.STRATEGY.PROFIT_TARGET, // target is always $0.99
        };
    }

    /**
     * Evaluate if we should exit the position
     */
    evaluateSellSignal(currentPrice, secondsLeft) {
        if (!this.position) return null;

        const strat = CONFIG.STRATEGY;
        const now   = Date.now();
        const holdTimeSeconds  = (now - this.entryTime) / 1000;
        const currentMultiple  = currentPrice / this.entryPrice;
        const peakMultiple     = this.peakPrice / this.entryPrice;

        // Track peak price
        if (currentPrice > this.peakPrice) this.peakPrice = currentPrice;

        // ── EXIT CONDITIONS ──────────────────────────────────────────────
        const isTarget    = currentPrice >= strat.PROFIT_TARGET;
        const isForce     = secondsLeft  <= strat.FORCE_EXIT_SECONDS;
        const isEmergency = secondsLeft  <  CONFIG.EXIT.EMERGENCY_EXIT_THRESHOLD;

        if (isTarget || isForce || isEmergency) {
            const reason = isTarget
                ? `PROFIT TARGET ($${strat.PROFIT_TARGET})`
                : isEmergency
                    ? `EMERGENCY EXIT (<${CONFIG.EXIT.EMERGENCY_EXIT_THRESHOLD}s)`
                    : `SESSION END (${secondsLeft}s left)`;

            return {
                reason,
                isTrailingStop:   false,
                isForceSell:      isForce || isEmergency,
                isEmergencyExit:  isEmergency,
                isMaxHoldExceeded: false,
                hasLiquidity:     true,
                currentMultiple,
                peakMultiple,
                holdTimeSeconds,
                emoji: isTarget ? '🎯' : isEmergency ? '🆘' : '⏰',
            };
        }

        // ── HOLD STATUS LOG (every ~5 s) ─────────────────────────────────
        if (holdTimeSeconds % 5 < 0.5 && holdTimeSeconds > 1) {
            const pct = (currentMultiple - 1) * 100;
            console.log(
                `   ⏳ ${this.position}: $${currentPrice.toFixed(3)} ` +
                `(${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) | ` +
                `~${secondsLeft}s left | target $${strat.PROFIT_TARGET}`
            );
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