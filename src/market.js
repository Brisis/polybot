import axios from 'axios';
import http from 'http';
import https from 'https';
import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

export class MarketSession {
    constructor() {
        this.currentTokenIds = [];
        this.currentSlug = "Searching...";
        this.sessionEndTime = 0;
        this.marketData = null;
    }

    /**
     * Sync to the current 15-minute BTC market session
     */
    async sync() {
        try {
            const now = Math.floor(Date.now() / 1000);
            const currentIntervalStart = Math.floor(now / 900) * 900;
            const targetSlug = `btc-updown-15m-${currentIntervalStart}`;

            const { data } = await axios.get(`${CONFIG.GAMMA_API}/markets`, { 
                params: { slug: targetSlug },
                httpAgent, 
                httpsAgent 
            });
            
            const market = Array.isArray(data) ? data[0] : data;

            if (market?.active) {
                const newIds = typeof market.clobTokenIds === 'string' 
                    ? JSON.parse(market.clobTokenIds) 
                    : market.clobTokenIds;

                const hasChanged = JSON.stringify(newIds) !== JSON.stringify(this.currentTokenIds);
                
                if (hasChanged) {
                    this.currentTokenIds = newIds;
                    this.currentSlug = targetSlug;
                    this.sessionEndTime = new Date(market.endDate).getTime();
                    this.marketData = market;
                    
                    logger.success(
                        `New Session: ${market.question} | Resolution: ${market.endDate}`
                    );
                    
                    return { newSession: true, market };
                }
            }
            
            return { newSession: false, market: this.marketData };
        } catch (error) {
            logger.error(`Market sync error: ${error.message}`);
            return { newSession: false, market: null };
        }
    }

    /**
     * Get time remaining in current session
     */
    getTimeRemaining() {
        const now = Date.now();
        const timeRemainingMs = this.sessionEndTime - now;
        const secondsLeft = Math.max(0, Math.floor(timeRemainingMs / 1000));
        const sessionProgress = 100 - ((secondsLeft / (15 * 60)) * 100);
        
        return { secondsLeft, sessionProgress };
    }

    /**
     * Check if market is ready to trade
     */
    isReady() {
        return this.currentTokenIds.length >= 2;
    }

    /**
     * Get token IDs for UP and DOWN outcomes
     */
    getTokenIds() {
        return {
            up: this.currentTokenIds[0],
            down: this.currentTokenIds[1]
        };
    }
}
