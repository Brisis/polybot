import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';

export class Trader {
    constructor(authClient, market) {
        this.authClient = authClient;
        this.market = market;
        this.balance = CONFIG.MOCK_MODE ? CONFIG.INITIAL_BALANCE : 0;
        this.realBalance = 0;
        this.pendingOrders = new Map();
    }

    /**
     * Update balance from chain
     */
    async updateBalance() {
        if (CONFIG.MOCK_MODE) {
            return this.balance;
        }

        try {
            const balances = await this.authClient.getBalances();
            // USDC balance on Polygon
            const usdcBalance = balances?.find(b => b.asset === 'USDC');
            this.realBalance = usdcBalance ? parseFloat(usdcBalance.balance) : 0;
            return this.realBalance;
        } catch (error) {
            logger.error(`Failed to fetch balance: ${error.message}`);
            return this.realBalance;
        }
    }

    /**
     * Get current prices for UP and DOWN tokens
     */
    async getPrices() {
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

            return null;
        } catch (error) {
            logger.error(`Failed to get prices: ${error.message}`);
            return null;
        }
    }

    /**
     * Place a buy order
     */
    async placeBuyOrder(side, price, amount) {
        if (CONFIG.MOCK_MODE) {
            // Mock mode - just update balance
            this.balance -= amount;
            return {
                success: true,
                mock: true,
                shares: amount / price,
                spent: amount
            };
        }

        try {
            const tokens = this.market.getTokenIds();
            const tokenId = side === 'UP' ? tokens.up : tokens.down;

            // Calculate shares to buy
            const shares = amount / price;
            
            // Create order with slippage protection
            const maxPrice = price * (1 + CONFIG.ORDER.SLIPPAGE);
            
            logger.info(
                `Placing BUY order: ${shares.toFixed(2)} shares of ${side} ` +
                `at $${price.toFixed(3)} (max: $${maxPrice.toFixed(3)})`
            );

            const order = {
                tokenID: tokenId,
                price: maxPrice.toFixed(4),
                size: shares.toFixed(2),
                side: 'BUY',
                feeRateBps: '0',
                nonce: Date.now(),
                expiration: Math.floor(Date.now() / 1000) + 3600 // 1 hour expiry
            };

            const signedOrder = await this.authClient.createOrder(order);
            const orderResult = await this.authClient.postOrder(signedOrder);

            if (orderResult?.orderID) {
                this.pendingOrders.set(orderResult.orderID, {
                    side,
                    price,
                    shares,
                    amount,
                    tokenId,
                    timestamp: Date.now()
                });

                logger.success(`Order placed: ${orderResult.orderID}`);

                // Wait for order to fill (simple polling)
                const filled = await this.waitForOrderFill(orderResult.orderID);

                if (filled) {
                    await this.updateBalance();
                    return {
                        success: true,
                        orderId: orderResult.orderID,
                        shares: filled.filledShares,
                        spent: filled.spent
                    };
                }

                return {
                    success: false,
                    error: 'Order timeout or partial fill'
                };
            }

            return {
                success: false,
                error: 'Failed to place order'
            };

        } catch (error) {
            logger.error(`Buy order failed: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Place a sell order
     */
    async placeSellOrder(side, price, shares) {
        if (CONFIG.MOCK_MODE) {
            // Mock mode - just update balance
            const proceeds = shares * price;
            this.balance += proceeds;
            return {
                success: true,
                mock: true,
                proceeds,
                shares
            };
        }

        try {
            const tokens = this.market.getTokenIds();
            const tokenId = side === 'UP' ? tokens.up : tokens.down;

            // Create order with slippage protection
            const minPrice = price * (1 - CONFIG.ORDER.SLIPPAGE);

            logger.info(
                `Placing SELL order: ${shares.toFixed(2)} shares of ${side} ` +
                `at $${price.toFixed(3)} (min: $${minPrice.toFixed(3)})`
            );

            const order = {
                tokenID: tokenId,
                price: minPrice.toFixed(4),
                size: shares.toFixed(2),
                side: 'SELL',
                feeRateBps: '0',
                nonce: Date.now(),
                expiration: Math.floor(Date.now() / 1000) + 3600
            };

            const signedOrder = await this.authClient.createOrder(order);
            const orderResult = await this.authClient.postOrder(signedOrder);

            if (orderResult?.orderID) {
                logger.success(`Sell order placed: ${orderResult.orderID}`);

                // Wait for order to fill
                const filled = await this.waitForOrderFill(orderResult.orderID);

                if (filled) {
                    await this.updateBalance();
                    return {
                        success: true,
                        orderId: orderResult.orderID,
                        proceeds: filled.proceeds,
                        shares: filled.filledShares
                    };
                }

                return {
                    success: false,
                    error: 'Order timeout or partial fill'
                };
            }

            return {
                success: false,
                error: 'Failed to place order'
            };

        } catch (error) {
            logger.error(`Sell order failed: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Wait for order to fill (with timeout)
     */
    async waitForOrderFill(orderId, maxWaitMs = 30000) {
        const startTime = Date.now();
        const checkInterval = 1000; // Check every second

        while (Date.now() - startTime < maxWaitMs) {
            try {
                const order = await this.authClient.getOrder(orderId);

                if (order.status === 'MATCHED') {
                    logger.success(`Order ${orderId} filled`);
                    
                    const filledShares = parseFloat(order.sizeMatched || order.size);
                    const avgPrice = parseFloat(order.price);
                    
                    return {
                        filledShares,
                        spent: order.side === 'BUY' ? filledShares * avgPrice : 0,
                        proceeds: order.side === 'SELL' ? filledShares * avgPrice : 0
                    };
                }

                if (order.status === 'CANCELLED' || order.status === 'EXPIRED') {
                    logger.warning(`Order ${orderId} ${order.status.toLowerCase()}`);
                    return null;
                }

                // Still pending, wait and check again
                await new Promise(resolve => setTimeout(resolve, checkInterval));

            } catch (error) {
                logger.error(`Error checking order ${orderId}: ${error.message}`);
                return null;
            }
        }

        logger.warning(`Order ${orderId} timeout after ${maxWaitMs}ms`);
        return null;
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
