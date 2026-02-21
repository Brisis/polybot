import WebSocket from 'ws';
import { logger } from './utils/logger.js';

const POLYMARKET_RTDS = 'wss://ws-live-data.polymarket.com';

const SUBSCRIBE_MSG = JSON.stringify({
    action: 'subscribe',
    subscriptions: [{
        topic:   'crypto_prices_chainlink',
        type:    '*',
        filters: JSON.stringify({ symbol: 'sol/usd' }),
    }],
});

const BUFFER_WINDOW_SECS   = 120;
const PING_INTERVAL_MS     = 5000;
const MAX_SESSION_HISTORY  = 20; // keep last 20 sessions of volatility data

export class BTCFeed {
    constructor() {
        this.ws             = null;
        this.prices         = []; // [ { price: number, time: number (ms) }, ... ]
        this.latestPrice    = null;
        this.sessionPeg     = null;
        this.connected      = false;
        this._reconnectTimer = null;
        this._pingTimer      = null;

        // Volatility history — one entry saved per completed session
        // { slug, timestamp, range, rangePct, stdDev, maxMove30s, maxMove30sPct, sessionBiasAtEnd }
        this.sessionHistory = [];
    }

    // -------------------------------------------------------------------------
    // PUBLIC API — SESSION PEG
    // -------------------------------------------------------------------------

    start() { this._connect(); }

    setSessionPeg(price) {
        if (!price || isNaN(price)) return;
        this.sessionPeg = price;
        const current = this.latestPrice;
        const drift   = current
            ? ` | live $${current.toFixed(2)} (${this._fmt(((current - price) / price) * 100)}% from peg)`
            : '';
        logger.info(`Session peg: $${price.toFixed(2)}${drift}`);
    }

    isReady() {
        if (!this.latestPrice) return false;
        const last = this.prices[this.prices.length - 1];
        return last && (Date.now() - last.time) < 5000;
    }

    // -------------------------------------------------------------------------
    // PUBLIC API — PRICE METRICS
    // -------------------------------------------------------------------------

    getMomentum(windowSecs = 30) {
        const recent = this._recentPrices(windowSecs);
        if (recent.length < 2) return null;
        return ((recent[recent.length - 1].price - recent[0].price) / recent[0].price) * 100;
    }

    getVelocity(windowSecs = 10) {
        const recent  = this._recentPrices(windowSecs);
        if (recent.length < 2) return null;
        const elapsed = (recent[recent.length - 1].time - recent[0].time) / 1000;
        if (elapsed === 0) return null;
        return (recent[recent.length - 1].price - recent[0].price) / elapsed; // $/s
    }

    getSessionBias() {
        if (!this.sessionPeg || !this.latestPrice) return null;
        return ((this.latestPrice - this.sessionPeg) / this.sessionPeg) * 100;
    }

    getSnapshot() {
        return {
            price:       this.latestPrice,
            sessionPeg:  this.sessionPeg,
            momentum30:  this.getMomentum(30),
            momentum60:  this.getMomentum(60),
            velocity10:  this.getVelocity(10),
            sessionBias: this.getSessionBias(),
            ready:       this.isReady(),
        };
    }

    // -------------------------------------------------------------------------
    // PUBLIC API — REVERSAL PREDICTION
    // -------------------------------------------------------------------------

    /**
     * Predicts whether a reversal for `losingSide` is plausible given:
     *   1. How far BTC is from peg (session bias)
     *   2. Current velocity projected over remaining seconds
     *   3. Historical volatility — is this move within what the market normally does?
     *
     * Returns { plausible, confidence, details } where confidence is 0–100.
     */
    predictReversal(losingSide, secondsLeft) {
        if (!this.isReady() || !this.sessionPeg || !this.latestPrice) {
            return { plausible: false, confidence: 0, details: 'Feed not ready' };
        }

        const price     = this.latestPrice;
        const peg       = this.sessionPeg;
        const bias      = this.getSessionBias();      // % BTC is from peg
        const vel10     = this.getVelocity(10);       // $/s over last 10s
        const mom30     = this.getMomentum(30);       // % over last 30s
        const vol       = this.getHistoricalVolatility();

        // ------------------------------------------------------------------
        // 1. DIRECTION CHECK
        //    Losing side UP  → BTC dropped below peg (bias < 0) → needs to rise
        //    Losing side DOWN → BTC rose above peg (bias > 0) → needs to fall
        // ------------------------------------------------------------------
        const directionNeeded = losingSide === 'UP' ? 'up' : 'down';
        const biasAligned     = losingSide === 'UP' ? bias <= 0 : bias >= 0;

        if (!biasAligned) {
            // BTC is already on the winning side — the "losing" side is actually
            // being priced cheaply for a different reason (late-session momentum).
            // Still allow, but note it.
            logger.info(
                `Reversal note: bias ${this._fmt(bias)}% — BTC already ` +
                `${bias > 0 ? 'above' : 'below'} peg, ${losingSide} side is contrarian`
            );
        }

        // ------------------------------------------------------------------
        // 2. DISTANCE TO PEG
        //    How many dollars does BTC need to move to reach peg?
        // ------------------------------------------------------------------
        const distanceToPeg    = Math.abs(peg - price);           // $
        const distanceToPegPct = Math.abs(bias);                  // %

        // ------------------------------------------------------------------
        // 3. PROJECTED MOVE
        //    Use last 10s velocity projected over remaining time.
        //    Cap at 60s to avoid over-projecting from short velocity samples.
        // ------------------------------------------------------------------
        const projectionWindow = Math.min(secondsLeft, 60);
        const projectedMove    = vel10 !== null ? Math.abs(vel10 * projectionWindow) : 0; // $
        const projectedMovePct = price > 0 ? (projectedMove / price) * 100 : 0;

        // Is the projected move in the right direction?
        const velDirectionRight = vel10 !== null
            ? (losingSide === 'UP' ? vel10 >= 0 : vel10 <= 0)
            : false;

        const projectedCovers = projectedMove >= distanceToPeg;

        // ------------------------------------------------------------------
        // 4. HISTORICAL VOLATILITY CHECK
        //    Is the required move within the range this market normally moves?
        // ------------------------------------------------------------------
        let volCheck = null;
        let volScore = 50; // neutral if no history

        if (vol) {
            // avgRange is the avg % high-low range over 120s across past sessions
            // If distanceToPegPct < avgRange, this move has happened before
            const withinHistoricalRange = distanceToPegPct <= vol.avgRangePct;
            const withinMaxMove30s      = distanceToPegPct <= vol.avgMaxMove30sPct * (secondsLeft / 30);

            volScore = withinHistoricalRange && withinMaxMove30s ? 75
                     : withinHistoricalRange ? 55
                     : withinMaxMove30s      ? 45
                     : 20;

            volCheck = {
                distanceToPegPct:   distanceToPegPct.toFixed(4),
                avgRangePct:        vol.avgRangePct.toFixed(4),
                avgMaxMove30sPct:   vol.avgMaxMove30sPct.toFixed(4),
                withinHistoricalRange,
                withinMaxMove30s,
                sessionsAnalysed:   vol.count,
            };
        }

        // ------------------------------------------------------------------
        // 5. CONFIDENCE SCORE  (0-100)
        // ------------------------------------------------------------------
        let confidence = 0;

        // Velocity pointing right direction: +30
        if (velDirectionRight) confidence += 30;

        // Projected move covers distance to peg: +25
        if (projectedCovers) confidence += 25;

        // Momentum aligns with direction needed: +20
        if (mom30 !== null) {
            const momAligned = losingSide === 'UP' ? mom30 >= 0 : mom30 <= 0;
            if (momAligned) confidence += 20;
        }

        // Historical volatility score: 0-25 (scaled from volScore 0-100)
        confidence += Math.round(volScore * 0.25);

        const plausible = confidence >= 80; // threshold — adjustable

        // ------------------------------------------------------------------
        // 6. LOG SUMMARY
        // ------------------------------------------------------------------
        const lines = [
            `Reversal prediction [${losingSide}] | ${plausible ? 'PLAUSIBLE' : 'UNLIKELY'} | Confidence: ${confidence}/100`,
            `  Peg: $${peg.toFixed(2)} | Live: $${price.toFixed(2)} | Bias: ${this._fmt(bias)}% | Need to move: $${distanceToPeg.toFixed(2)} (${distanceToPegPct.toFixed(4)}%)`,
            `  Velocity: ${vel10 !== null ? this._fmt(vel10) + '$/s' : 'n/a'} | Direction: ${directionNeeded} | Vel aligned: ${velDirectionRight ? 'YES' : 'NO'}`,
            `  Projected move (${projectionWindow}s): $${projectedMove.toFixed(2)} | Covers distance: ${projectedCovers ? 'YES' : 'NO'}`,
            `  Momentum 30s: ${mom30 !== null ? this._fmt(mom30) + '%' : 'n/a'}`,
        ];

        if (volCheck) {
            lines.push(
                `  HistVol (${volCheck.sessionsAnalysed} sessions): ` +
                `avgRange ${volCheck.avgRangePct}% | avgMaxMove30s ${volCheck.avgMaxMove30sPct}% | ` +
                `withinRange: ${volCheck.withinHistoricalRange} | withinMove30s: ${volCheck.withinMaxMove30s}`
            );
        } else {
            lines.push('  HistVol: no data yet (building history...)');
        }

        lines.forEach(l => logger.info(l));

        return {
            plausible,
            confidence,
            details: {
                bias,
                distanceToPeg,
                distanceToPegPct,
                projectedMove,
                projectedMovePct,
                projectedCovers,
                velDirectionRight,
                volCheck,
            },
        };
    }

    // -------------------------------------------------------------------------
    // PUBLIC API — SESSION VOLATILITY HISTORY
    // -------------------------------------------------------------------------

    /**
     * Save the last 120s of price data as a volatility snapshot for this session.
     * Call this right before marking the new session open (i.e., at session boundary).
     *
     * @param {string} slug  The session slug being closed
     */
    saveSessionVolatility(slug) {
        const buffer = this._recentPrices(120);
        if (buffer.length < 10) {
            logger.warning(`HistVol: not enough data to save session ${slug} (${buffer.length} ticks)`);
            return null;
        }

        const priceValues = buffer.map(p => p.price);
        const high        = Math.max(...priceValues);
        const low         = Math.min(...priceValues);
        const open        = priceValues[0];
        const close       = priceValues[priceValues.length - 1];
        const range       = high - low;
        const rangePct    = (range / open) * 100;

        // Max 30s move — scan in 30s rolling windows
        let maxMove30s    = 0;
        for (let i = 0; i < buffer.length; i++) {
            const windowStart = buffer[i].time;
            const windowEnd   = windowStart + 30_000;
            const window      = buffer.filter(p => p.time >= windowStart && p.time <= windowEnd);
            if (window.length < 2) continue;
            const wHigh = Math.max(...window.map(p => p.price));
            const wLow  = Math.min(...window.map(p => p.price));
            maxMove30s  = Math.max(maxMove30s, wHigh - wLow);
        }
        const maxMove30sPct = (maxMove30s / open) * 100;

        // Standard deviation
        const mean   = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
        const stdDev = Math.sqrt(
            priceValues.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / priceValues.length
        );

        const sessionBiasAtEnd = this.getSessionBias();

        const entry = {
            slug,
            timestamp:       Date.now(),
            ticks:           buffer.length,
            open,
            close,
            high,
            low,
            range,
            rangePct,
            maxMove30s,
            maxMove30sPct,
            stdDev,
            sessionBiasAtEnd,
        };

        this.sessionHistory.push(entry);

        // Keep only the last MAX_SESSION_HISTORY sessions
        if (this.sessionHistory.length > MAX_SESSION_HISTORY) {
            this.sessionHistory.shift();
        }

        logger.info(
            `HistVol saved [${slug}] | ` +
            `Range: $${range.toFixed(2)} (${rangePct.toFixed(4)}%) | ` +
            `MaxMove30s: $${maxMove30s.toFixed(2)} (${maxMove30sPct.toFixed(4)}%) | ` +
            `StdDev: $${stdDev.toFixed(2)} | ` +
            `Ticks: ${buffer.length} | ` +
            `Sessions stored: ${this.sessionHistory.length}/${MAX_SESSION_HISTORY}`
        );

        return entry;
    }

    /**
     * Returns aggregated volatility stats across saved sessions.
     * Returns null if no history yet.
     */
    getHistoricalVolatility() {
        if (this.sessionHistory.length === 0) return null;

        const count          = this.sessionHistory.length;
        const avgRangePct    = this.sessionHistory.reduce((s, e) => s + e.rangePct, 0)    / count;
        const avgMaxMove30sPct = this.sessionHistory.reduce((s, e) => s + e.maxMove30sPct, 0) / count;
        const avgStdDev      = this.sessionHistory.reduce((s, e) => s + e.stdDev, 0)      / count;
        const maxRangePct    = Math.max(...this.sessionHistory.map(e => e.rangePct));
        const minRangePct    = Math.min(...this.sessionHistory.map(e => e.rangePct));

        return {
            count,
            avgRangePct,
            avgMaxMove30sPct,
            avgStdDev,
            maxRangePct,
            minRangePct,
        };
    }

    // -------------------------------------------------------------------------
    // Gate 4 (used by strategy.js)
    // -------------------------------------------------------------------------

    /**
     * Full gate check — combines momentum alignment + reversal prediction.
     * Returns { aligned, plausible, confidence, momentum, reason }
     */
    checkMomentumAlignment(losingSide, windowSecs = 30, threshold = 0) {
        if (!this.isReady()) {
            return { aligned: false, momentum: null, reason: 'BTC feed not ready' };
        }
        const momentum = this.getMomentum(windowSecs);
        if (momentum === null) {
            return { aligned: false, momentum: null, reason: 'Insufficient BTC data' };
        }
        const aligned = losingSide === 'UP' ? momentum >= threshold : momentum <= -threshold;
        const dir     = momentum >= 0 ? 'up' : 'down';
        const sign    = momentum >= 0 ? '+' : '';
        const check   = aligned ? 'favours' : 'against';
        return {
            aligned,
            momentum,
            reason: `Chainlink BTC ${dir} ${sign}${momentum.toFixed(3)}% / ${windowSecs}s -- ${check} ${losingSide} reversal`,
        };
    }

    // -------------------------------------------------------------------------
    // INTERNAL
    // -------------------------------------------------------------------------

    _recentPrices(windowSecs) {
        const cutoff = Date.now() - windowSecs * 1000;
        return this.prices.filter(p => p.time >= cutoff);
    }

    _fmt(n) {
        if (n === null || n === undefined) return 'n/a';
        return (n >= 0 ? '+' : '') + n.toFixed(3);
    }

    _connect() {
        logger.info('Connecting to Polymarket RTDS (Chainlink BTC/USD)...');
        this.ws = new WebSocket(POLYMARKET_RTDS);

        this.ws.on('open', () => {
            this.connected = true;
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
            }
            this.ws.send(SUBSCRIBE_MSG);
            this._pingTimer = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
            }, PING_INTERVAL_MS);
            logger.success('BTC feed connected (Polymarket RTDS Chainlink)');
        });

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);
                if (msg.topic !== 'crypto_prices_chainlink') return;
                if (!msg.payload?.value) return;
                const price = parseFloat(msg.payload.value);
                const time  = Date.now();
                this.latestPrice = price;
                this.prices.push({ price, time });
                const cutoff = time - BUFFER_WINDOW_SECS * 1000;
                this.prices = this.prices.filter(p => p.time >= cutoff);
            } catch (_) {}
        });

        this.ws.on('error', (err) => {
            logger.error(`BTC feed error: ${err.message}`);
        });

        this.ws.on('close', () => {
            this.connected = false;
            if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
            logger.warning('BTC feed disconnected -- reconnecting in 3s...');
            this._reconnectTimer = setTimeout(() => this._connect(), 3000);
        });
    }

    stop() {
        if (this._pingTimer)      clearInterval(this._pingTimer);
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        if (this.ws)              this.ws.close();
    }
}