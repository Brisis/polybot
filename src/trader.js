import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';
import { AssetType } from "@polymarket/clob-client";

export class Trader {
    constructor(authClient, market) {
        this.authClient = authClient;
        this.market = market;
        this.balance = CONFIG.MOCK_MODE ? CONFIG.INITIAL_BALANCE : 0;
        this.realBalance = 0;
        this.pendingOrders = new Map();
        this.orderInProgress = false;  // ← ADD THIS LINE
    }

    /**
     * Update balance using Polymarket's API (correct method)
     */
    async updateBalance() {
        if (CONFIG.MOCK_MODE) {
            return this.balance;
        }

        try {
            // Use the correct API method from Polymarket
            const balData = await this.authClient.getBalanceAllowance({ 
                asset_type: "COLLATERAL" 
            });
            
            this.realBalance = (parseFloat(balData.balance) / 1000000).toFixed(2);
            return this.realBalance;
            
        } catch (error) {
            logger.error(`Failed to fetch balance: ${error.message}`);
            return this.realBalance;
        }
    }

    /**
     * Get current prices for UP and DOWN tokens
     */
    /**
     * Get current prices for UP and DOWN tokens with network retry
     */
    async getPrices() {
        const maxRetries = 3;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const tokens = this.market.getTokenIds();
                const [upRes, downRes] = await Promise.all([
                    this.authClient.getPrice(tokens.up, 'BUY').catch(() => null),
                    this.authClient.getPrice(tokens.down, 'BUY').catch(() => null)
                ]);

                if (upRes?.price && downRes?.price) {
                    return {
                        up: parseFloat(upRes.price),
                        down: parseFloat(downRes.price)
                    };
                }

                // No prices returned
                if (attempt < maxRetries) {
                    logger.warning(`Price fetch returned null (attempt ${attempt}/${maxRetries}), retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }

                return null;
                
            } catch (error) {
                const isNetworkError = error.code === 'ETIMEDOUT' || 
                                      error.code === 'ENOTFOUND' || 
                                      error.code === 'ECONNRESET' ||
                                      error.code === 'ECONNREFUSED';
                
                if (isNetworkError && attempt < maxRetries) {
                    logger.warning(
                        `Network error getting prices (attempt ${attempt}/${maxRetries}): ${error.code}`
                    );
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                    continue;
                }
                
                logger.error(`Failed to get prices: ${error.message}`);
                return null;
            }
        }
        
        logger.error(`Failed to get prices after ${maxRetries} attempts`);
        return null;
    }

    async placeBuyOrder(side, price, amount) {
        // Prevent duplicates
        if (this.orderInProgress) {
            logger.warning('Order in progress, skipping duplicate');
            return { success: false, error: 'Order in progress' };
        }

        if (CONFIG.MOCK_MODE) {
            this.balance -= amount;
            return {
                success: true,
                mock: true,
                shares: amount / price,
                spent: amount
            };
        }

        this.orderInProgress = true;  // Lock it

        try {  // ← Move try OUTSIDE the loop
            const tokens = this.market.getTokenIds();
            const tokenId = side === 'UP' ? tokens.up : tokens.down;

            // Validate tokenId
            if (!tokenId || tokenId === 'undefined') {
                throw new Error('Invalid tokenId - market may not be synced');
            }
            
            logger.info(
                `Placing BUY market order: ${side} for $${amount.toFixed(2)} USDC at ~$${price.toFixed(3)}/share`
            );

            // Use market order (FOK)
            const response = await this.authClient.createAndPostMarketOrder(
                {
                    tokenID: tokenId,
                    amount: amount,
                    side: 'BUY'
                },
                {
                    tickSize: '0.01',
                    negRisk: false
                },
                'FOK'
            );

            logger.info(`Order response: ${JSON.stringify(response)}`);

            if (response?.orderID) {
                const statusEmoji = response.status === 'matched' ? '✅' : 
                                response.status === 'live' ? '⏳' : '❌';
                
                logger.info(`Order ${statusEmoji} ${response.status} | ID: ${response.orderID}`);

                if (response.status === 'matched') {
                    // Success!
                    const actualShares = response.sizeMatched ? 
                        parseFloat(response.sizeMatched) : 
                        amount / price;
                    
                    const actualPrice = response.avgPrice ? 
                        parseFloat(response.avgPrice) : 
                        price;
                    
                    await this.updateBalance();
                    
                    logger.success(`✅ Buy order filled`);
                    return {
                        success: true,
                        orderId: response.orderID,
                        shares: actualShares,
                        spent: actualShares * actualPrice,
                        avgPrice: actualPrice,
                        attempts: 1
                    };
                } else {
                    // Order didn't match = NO LIQUIDITY
                    logger.error(`⚠️  No liquidity - order status: ${response.status}`);
                    return {
                        success: false,
                        error: 'No liquidity',
                        attempts: 1
                    };
                }
            }

            return {
                success: false,
                error: 'No orderID in response',
                attempts: 1
            };

        } catch (error) {
            logger.error(`Buy order error: ${error.message}`);
            return {
                success: false,
                error: error.message,
                attempts: 1
            };
        } finally {
            this.orderInProgress = false;  // ← Unlock OUTSIDE loop, at the very end
        }
    }

    /**
     * Place a sell order using market orders (FOK)
     */
    async placeSellOrder(side, price, shares) {
        // Prevent duplicates
        if (this.orderInProgress) {
            logger.warning('Order in progress, skipping duplicate');
            return { success: false, error: 'Order in progress' };
        }

        if (CONFIG.MOCK_MODE) {
            const proceeds = shares * price;
            this.balance += proceeds;
            return {
                success: true,
                mock: true,
                proceeds,
                shares
            };
        }

        this.orderInProgress = true;  // Lock it

        try {
            const tokens = this.market.getTokenIds();
            const tokenId = side === 'UP' ? tokens.up : tokens.down;

            // Validate tokenId
            if (!tokenId || tokenId === 'undefined') {
                throw new Error('Invalid tokenId - market may not be synced');
            }
            
            // Get ACTUAL balance from blockchain (not estimated shares)
            const balance = await getTokenBalance(this.authClient, tokenId);
            const actualShares = Number(balance) / (10 ** 6);
            
            if (actualShares <= 0) {
                throw new Error(`No tokens to sell. Balance: ${actualShares}`);
            }

            logger.info(
                `Placing SELL market order: ${actualShares.toFixed(2)} shares ` +
                `of ${side} at ~$${price.toFixed(3)}/share`
            );

            // USE MARKET ORDER (FOK) - fills immediately or cancels
            const response = await this.authClient.createAndPostMarketOrder(
                {
                    tokenID: tokenId,
                    amount: actualShares,  // Use actual balance
                    side: 'SELL'
                },
                {
                    tickSize: '0.01',      // ← Hardcoded like buy order
                    negRisk: false         // ← Hardcoded like buy order
                },
                'FOK'  // Fill-Or-Kill
            );

            logger.info(`Order response: ${JSON.stringify(response)}`);

            if (response?.orderID) {
                const statusEmoji = response.status === 'matched' ? '✅' : 
                                response.status === 'live' ? '⏳' : '❌';
                
                logger.info(`Order ${statusEmoji} ${response.status} | ID: ${response.orderID}`);

                if (response.status === 'matched') {
                    // Order filled successfully!
                    const filledShares = parseFloat(response.sizeMatched);
                    const filledPrice = parseFloat(response.avgPrice);
                    const proceeds = filledShares * filledPrice;
                    
                    await this.updateBalance();
                    
                    logger.success(`✅ Sell order filled`);
                    return {
                        success: true,
                        orderId: response.orderID,
                        proceeds: proceeds,
                        shares: filledShares,
                        avgPrice: filledPrice,
                        attempts: 1
                    };
                } else {
                    // Order didn't match = NO LIQUIDITY
                    logger.error(`⚠️  No liquidity - order status: ${response.status}`);
                    return {
                        success: false,
                        error: 'No liquidity',
                        attempts: 1
                    };
                }
            }

            return {
                success: false,
                error: 'No orderID in response',
                attempts: 1
            };

        } catch (error) {
            logger.error(`Sell order error: ${error.message}`);
            return {
                success: false,
                error: error.message,
                attempts: 1
            };
        } finally {
            this.orderInProgress = false;  // ← CRITICAL: Unlock here, OUTSIDE retry loop
        }
    }


    /**
     * Cancel an order
     */
    async cancelOrder(orderId) {
        try {
            await this.authClient.cancelOrder(orderId);
            this.pendingOrders.delete(orderId);
            logger.info(`Order ${orderId} cancelled`);
            return true;
        } catch (error) {
            logger.error(`Failed to cancel order ${orderId}: ${error.message}`);
            return false;
        }
    }

    async getTokenBalance(client, tokenId){
        const balance = await client.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });
        return balance.balance;
    }

    /**
     * Get current balance (real or mock)
     */
    getBalance() {
        return CONFIG.MOCK_MODE ? this.balance : this.realBalance;
    }

    /**
     * Check if we have sufficient balance for trade
     */
    hasSufficientBalance(amount) {
        const balance = this.getBalance();
        return balance >= amount && amount >= CONFIG.ORDER.MIN_ORDER_SIZE;
    }
}