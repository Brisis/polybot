# Polymarket Trading Bot

An automated trading bot for Polymarket's BTC Up/Down 15-minute markets. Features a sophisticated strategy with trailing stops, time-based entries, and position management.

## 🚀 Features

- **Modular Architecture**: Clean separation of concerns across multiple files
- **Mock Trading Mode**: Test strategies without risking real funds
- **Live Trading Mode**: Execute real trades on Polymarket
- **Advanced Strategy**: Time-weighted entry ranges, trailing stops, profit locks
- **Real-time Logging**: CSV logs for analysis and monitoring
- **Position Management**: Smart entry/exit with multiple safety mechanisms

## 📁 Project Structure

```
polymarket-trading-bot/
├── index.js          # Main bot orchestrator
├── config.js         # Configuration and constants
├── logger.js         # Logging utilities
├── market.js         # Market session management
├── strategy.js       # Trading strategy logic
├── trader.js         # Order execution and balance management
├── package.json      # Dependencies
├── .env              # Environment variables (create this)
└── .env.example      # Environment template
```

## 🛠️ Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```properties
PRIVATE_KEY=your_private_key_here
SIGNATURE_TYPE=1
FUNDER_ADDRESS=0xcedcfD38b74f2008224Cb3533C4fdA37694C4b24
MOCK_MODE=false
```

**Important Notes:**
- **PRIVATE_KEY**: Your wallet's private key (never share this!)
- **SIGNATURE_TYPE**: 
  - `0` = Standard EOA (MetaMask, hardware wallets)
  - `1` = Email/Magic wallet signatures
  - `2` = Browser wallet proxy signatures
- **FUNDER_ADDRESS**: Your Polymarket proxy address (for proxy wallets) or leave empty for EOA wallets
- **MOCK_MODE**: Set to `true` to test without real money, `false` for live trading

### 3. Fund Your Account

Make sure your Polymarket account has USDC on Polygon network:
- Minimum recommended: $10 USDC
- Bridge to Polygon if needed
- Verify your funder address has funds

## 🎮 Usage

### Mock Trading (Safe Testing)

Test the strategy without risking real funds:

```bash
npm run mock
```

or

```bash
MOCK_MODE=true npm start
```

### Live Trading

Execute real trades (requires funded account):

```bash
npm run live
```

or

```bash
npm start
```

### Stop the Bot

Press `Ctrl+C` to gracefully shutdown the bot.

## 📊 Strategy Overview

The bot implements a sophisticated V8 strategy:

### Entry Conditions

**Time-based strategy selection:**
- **Late Reversal** (120-180s left): 0.01-0.10 price range, 40% position size
- **Mid-Late Selective** (180-270s): 0.01-0.15 range, 40% position
- **Mid Conservative** (270-450s): 0.01-0.20 range, 40% position
- **Early Opportunistic** (450-800s): 0.01-0.25 range, 40% position

**Entry Logic:**
- Always buys the "losing" side (lower priced outcome)
- Maximum 2 entries per 15-minute session
- Price must be within strategy range
- No entries if previously stopped out this session

### Exit Conditions

**Trailing Stop:**
- Activates at 20% profit
- 15% drop from peak triggers exit
- Requires 3 consecutive ticks below threshold

**Profit Lock:**
- Minimum 10% profit lock active
- Never sell below 1.10x entry price once profitable

**Force Exits:**
- Max hold time per strategy (120-150s)
- Session ending (<10s remaining)

## 📈 Monitoring

### Console Output

Real-time feed showing:
- Current prices (UP/DOWN)
- Balance (real/mock)
- Position status
- Session progress
- Trading signals and executions

### CSV Logs

Daily CSV files: `logs_trade_YYYY-MM-DD.csv`

Columns:
- Timestamp
- Market slug
- Real balance
- Mock balance
- Current position
- UP price
- DOWN price
- Event type (TICK/TRADE)

## 🔧 Configuration

Edit `config.js` to customize:

### Trading Parameters

```javascript
INITIAL_BALANCE: 10.00,      // Starting mock balance
TICK_INTERVAL: 333,           // Price check frequency (ms)
SESSION_SYNC_INTERVAL: 15000, // Market sync frequency (ms)
```

### Strategy Parameters

Adjust entry ranges, position sizes, hold times in `CONFIG.STRATEGY` object.

### Exit Parameters

Modify trailing stops, profit locks in `CONFIG.EXIT` object.

### Order Parameters

```javascript
SLIPPAGE: 0.02,          // 2% slippage tolerance
MIN_ORDER_SIZE: 0.1,     // Minimum $0.10 USDC
MAX_RETRIES: 3,          // Order retry attempts
```

## 🔐 Security Best Practices

1. **Never commit `.env` file** - It contains your private key
2. **Use a dedicated trading wallet** - Don't use your main wallet
3. **Start with small amounts** - Test with minimal funds first
4. **Monitor closely** - Watch the bot during initial runs
5. **Set loss limits** - Don't risk more than you can afford to lose
6. **Regular backups** - Keep backups of your logs and configuration

## 📝 Module Documentation

### index.js
Main orchestrator that:
- Initializes all components
- Runs the main tick loop
- Handles buy/sell execution
- Manages session transitions

### config.js
Central configuration including:
- API endpoints
- Trading parameters
- Strategy configurations
- Environment variables

### logger.js
Logging utilities for:
- Console output (colored, formatted)
- CSV file logging
- Trade events
- Error reporting

### market.js
Market session management:
- Syncs to current 15-min BTC session
- Tracks session timing
- Provides token IDs
- Monitors market state

### strategy.js
Trading strategy logic:
- Buy signal evaluation
- Sell signal evaluation
- Position tracking
- Peak price monitoring
- Trailing stop calculations

### trader.js
Order execution and balance:
- Places buy/sell orders
- Tracks order status
- Manages balances
- Handles mock/live modes
- Order timeout and retry logic

## 🐛 Troubleshooting

### "PRIVATE_KEY is required"
- Make sure `.env` file exists with your private key

### "Authentication failed"
- Check your SIGNATURE_TYPE matches your wallet type
- Verify FUNDER_ADDRESS is correct for proxy wallets
- Ensure private key is valid

### "Insufficient balance"
- Fund your Polymarket account with USDC on Polygon
- Check your funder address has funds
- Minimum $0.10 per trade

### Orders not filling
- Increase SLIPPAGE in config.js
- Check market liquidity
- Verify prices are within reasonable ranges

### Bot not trading
- Ensure prices are within strategy ranges
- Check session timing (bot only trades at specific times)
- Verify not stopped out from previous trade
- Check leftBuys counter (max 2 per session)

## ⚠️ Disclaimer

**This bot is for educational purposes only.**

- Trading involves substantial risk of loss
- Past performance does not guarantee future results
- Only trade with funds you can afford to lose
- The authors are not responsible for any financial losses
- Always test in mock mode first
- Understand the code before running live

## 📜 License

MIT License - Use at your own risk

## 🤝 Contributing

Contributions welcome! Please:
1. Test thoroughly in mock mode
2. Document any changes
3. Follow existing code style
4. Add tests for new features

## 📞 Support

For issues or questions:
1. Check troubleshooting section
2. Review logs in CSV files
3. Test in mock mode first
4. Check Polymarket documentation

---

**Happy Trading! 🚀**
