# Solana Pool Tracker

Real-time tracking of Solana liquidity pools and pump.fun token graduations with Telegram notifications.

## Features

- **New Pools (Helius)**: Monitor new liquidity pool creations across Raydium, Orca, and Meteora DEXs
- **Graduated Tokens (PumpPortal)**: Real-time tracking of pump.fun tokens graduating to DEXs
- **Telegram Notifications**: Instant alerts when tokens graduate with price, market cap, and trading data
- **Auto Data Refresh**: Automatic updates every 10 minutes with latest trading metrics

## How It Works

### Pool Tracking (Helius WebSocket)
- Monitors program IDs for Raydium, Orca, and Meteora DEXs
- Captures new liquidity pool creations in real-time
- Displays pool details, liquidity amounts, and trading pairs

### Graduation Tracking (PumpPortal WebSocket - FREE)
- Connects to PumpPortal's WebSocket for real-time pump.fun events
- Detects when tokens graduate from pump.fun to Raydium (reach $69K market cap)
- Fetches additional trading data from Dexscreener API
- Implements retry logic for tokens with delayed data indexing

### Telegram Integration
- Sends notifications immediately when tokens graduate
- Confirms data availability before sending (price, market cap, name)
- Handles special characters in token names safely
- Includes pump.fun links and trading metrics in notifications

## Setup

1. Copy `.env.example` to `.env`
2. Configure your API keys:
   ```
   HELIUS_API_KEY=your_helius_api_key_here
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here (optional)
   TELEGRAM_CHAT_ID=your_chat_id_here (optional)
   ```
3. Run `node server.js`

## Usage

The app provides a tabbed interface:

1. **New Pools (Helius)**: Live liquidity pool creations with refresh controls
2. **Graduated Tokens**: pump.fun graduates with trading data and Telegram test button

### Telegram Setup (Optional)
1. Create a bot via @BotFather on Telegram
2. Get your chat ID by messaging @userinfobot
3. Add credentials to `.env`
4. Use the "Test Telegram" button to verify setup

## API Endpoints

- `GET /helius/events`: SSE stream for new pool events
- `GET /moralis/events`: SSE stream for graduate events  
- `GET /moralis/health`: Health check for graduation tracking
- `POST /api/scanner/start`: Start pool scanner
- `POST /api/scanner/stop`: Stop pool scanner
- `POST /api/data/clear`: Clear cached data
- `POST /api/test-telegram`: Send test notification

## Technical Details

### Data Sources
- **PumpPortal WebSocket**: Free real-time pump.fun graduation events
- **Helius WebSocket**: Solana program monitoring with paid API
- **Dexscreener API**: Free trading data (price, volume, market cap)

### Reliability Features
- Multi-retry system for tokens with delayed data (10s, 25s, 40s intervals)
- Fallback to pump.fun data when DEX pairs aren't indexed yet
- Proper error handling and connection recovery
- Shell escaping for special characters in notifications

### Performance
- Efficient caching with 100-token history limit
- Auto-refresh every 10 minutes to keep data current
- Duplicate detection to prevent reprocessing

## Configuration

- `PORT`: Server port (default: 3000)
- `HELIUS_API_KEY`: Required for pool monitoring
- `TELEGRAM_BOT_TOKEN`: Optional for notifications
- `TELEGRAM_CHAT_ID`: Optional for notifications