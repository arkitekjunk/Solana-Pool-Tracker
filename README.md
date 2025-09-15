# 🎓 Pump.fun Graduation Tracker

Real-time tracking and monitoring of pump.fun tokens graduating to Raydium DEX with Telegram notifications. Built with Cloudflare Workers, Durable Objects, and modern glassmorphism UI.

## 📺 **Live Demo**
🌐 **Frontend:** https://807bbb66.solana-pool-tracker.pages.dev  
⚡ **Backend:** https://solana-worker.arkitekjunk.workers.dev

## ✨ **Features**

### 🎯 **Core Functionality**
- **Real-time Graduation Tracking**: Monitor pump.fun tokens graduating to Raydium DEX instantly
- **Token Images**: Automatic fetching from multiple CDNs (Jupiter, Solana Token List, Dexscreener)
- **Price Updates**: Live trading data refresh with actual API calls to Dexscreener
- **Telegram Notifications**: Instant alerts with price, market cap, and trading metrics
- **Persistent Storage**: SQLite-backed storage in Cloudflare Durable Objects
- **No Rate Limits**: Unlimited token storage (removed 100 token limit)

### 🎨 **Modern UI**
- **Midnight Aurora Theme**: Beautiful gradient background with cosmic colors
- **Glassmorphism Design**: Transparent containers with backdrop blur effects
- **Animated Background**: Floating particles and geometric shapes
- **Robot Logo**: Integrated robot_head.png with rainbow hover effects
- **Responsive Design**: Works perfectly on desktop and mobile
- **Live Statistics**: Real-time counts for total, 24h, and 7-day graduates

## 🏗️ **Architecture**

### 🔄 **Current Deployment (Cloud-Based)**
```
┌─────────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│   Cloudflare Pages  │    │  Cloudflare Workers  │    │   PumpPortal API    │
│   (Frontend UI)     │◄──►│   (Durable Objects)  │◄──►│   (WebSocket)       │
│                     │    │                      │    │                     │
│ • Glassmorphism UI  │    │ • WebSocket Handler  │    │ • subscribeMigration│
│ • Token Images      │    │ • Persistent Storage │    │ • Real-time events  │
│ • Price Updates     │    │ • Telegram Alerts   │    │                     │
│ • Live Statistics   │    │ • Data Enrichment   │    │                     │
└─────────────────────┘    └──────────────────────┘    └─────────────────────┘
                                       │
                                       ▼
                           ┌──────────────────────┐
                           │   Dexscreener API    │
                           │ • Token metadata     │
                           │ • Price & volume     │
                           │ • Market cap data    │
                           │ • Trading metrics    │
                           └──────────────────────┘
```

### 📁 **Project Structure**
```
solana-pool-tracker/
├── 📂 public/                     # Frontend (Cloudflare Pages)
│   ├── 🎨 index.html             # Main UI with glassmorphism design
│   └── 🤖 robot_head.png         # Logo asset
├── 📂 solana-worker/             # Backend (Cloudflare Workers)
│   ├── ⚙️ index.js               # Main worker routing
│   ├── 🔄 pumpportal-do.js       # Durable Object with WebSocket logic
│   └── 📋 wrangler.toml          # Cloudflare configuration
├── 📂 server.js                  # Local Node.js version (inactive)
└── 📖 README.md                  # This documentation
```

## 🚀 **Quick Start**

### ☁️ **Cloud Deployment (Recommended)**
The tracker is already deployed and running in the cloud. No setup required!

### 🛠️ **Local Development**
1. **Clone & Install**
   ```bash
   git clone <repository>
   cd solana-pool-tracker
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Deploy to Cloudflare**
   ```bash
   # Deploy backend
   cd solana-worker
   wrangler deploy
   
   # Deploy frontend
   cd ..
   wrangler pages deploy public --project-name solana-pool-tracker
   ```

## 🔧 **Configuration**

### 🔐 **Required Secrets (Cloudflare Workers)**
```bash
# Set via Cloudflare dashboard or wrangler
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

### 📱 **Telegram Setup**
1. Create bot: Message @BotFather → `/newbot`
2. Get chat ID: Message @userinfobot
3. Add secrets to Cloudflare Workers
4. Test via "Test Telegram" button in UI

## 📡 **API Reference**

### 🔗 **Endpoints**
- `GET /pumpportal/events` - Server-Sent Events for live graduation feed
- `GET /pumpportal/health` - Health check and connection status
- `POST /pumpportal/connect` - Force WebSocket reconnection
- `POST /api/test-telegram` - Send test notification

### 📊 **Data Flow**
1. **PumpPortal WebSocket** → Receives graduation events
2. **Durable Object** → Processes and stores data
3. **Dexscreener API** → Enriches with trading data and images
4. **Frontend SSE** → Real-time updates to UI
5. **Telegram API** → Sends notifications

## 🎨 **UI Features**

### 🌙 **Midnight Aurora Theme**
- **Gradient**: Deep blues and purples (`#0f0c29` → `#0f4c75`)
- **Particles**: Floating animated elements with glow effects
- **Glassmorphism**: Semi-transparent containers with backdrop blur
- **Typography**: White text with proper contrast

### 🖼️ **Token Display**
- **Images**: Multi-source fallback (Jupiter, Solana Token List, Dexscreener)
- **Metadata**: Name, symbol, mint address truncation
- **Trading Data**: Price, 24h change, volume, market cap
- **Links**: Direct links to Pump.fun, Solscan, Dexscreener

### 📱 **Responsive Design**
- **Desktop**: Full table with all columns
- **Mobile**: Optimized layout with stacked information
- **Touch**: Large tap targets for mobile interaction

## 💾 **Data Management**

### 🗃️ **Storage**
- **Type**: SQLite in Cloudflare Durable Objects
- **Capacity**: 1GB free tier (far exceeds needs)
- **Persistence**: Automatic data persistence across deployments
- **Backup**: Data survives worker restarts and deployments

### 🔄 **Data Refresh**
- **Manual**: "Update Prices" button fetches latest data
- **Automatic**: New graduations auto-enrich after 8s delay
- **Rate Limiting**: 200ms delays between API calls
- **Error Handling**: Continues on individual token failures

## 🐛 **Troubleshooting**

### ❌ **Common Issues**

#### 🔌 **WebSocket Disconnected**
- **Symptom**: Status shows "Disconnected"
- **Solution**: Click "Refresh" button to reconnect
- **Prevention**: Auto-reconnection with exponential backoff

#### 📷 **Images Not Loading**
- **Symptom**: Only fallback coin emojis show
- **Cause**: New tokens not yet indexed by CDNs
- **Solution**: Click "Update Prices" to retry image fetching
- **Timeline**: Images usually available within hours of graduation

#### 📱 **Telegram Not Working**
- **Check**: Secrets are set in Cloudflare Workers dashboard
- **Test**: Use "Test Telegram" button in UI
- **Verify**: Bot token and chat ID are correct

#### 🎯 **Missing Graduations**
- **Check**: WebSocket connection status in UI
- **Debug**: Browser console shows detailed logs
- **Reset**: Use "Refresh" button to force reconnection

## 📈 **Monitoring & Analytics**

### 📊 **Built-in Statistics**
- **Total Graduates**: All-time graduation count
- **Last 24 Hours**: Recent graduation activity
- **Last 7 Days**: Weekly graduation trends
- **Live Updates**: Real-time counter updates

### 🔍 **Debugging**
- **Browser Console**: Detailed API logs and WebSocket events
- **Status Indicators**: Visual connection status
- **Error Messages**: Clear error reporting for failed operations

## 🚨 **For Next AI Assistant**

### 🔥 **Critical Information**

#### 🏗️ **Architecture Understanding**
- **WORKING VERSION**: Cloud deployment (Cloudflare Pages + Workers)
- **INACTIVE VERSION**: Local server.js (kept for reference only)
- **DO NOT**: Modify server.js - it's the old local version
- **ALWAYS**: Make changes to `solana-worker/` directory for backend

#### 🔑 **Key Components**
1. **pumpportal-do.js**: Core WebSocket logic, NEVER change subscription method
2. **index.html**: Complete frontend, includes all animations and styling
3. **wrangler.toml**: Deployment config, uses SQLite Durable Objects

#### ⚠️ **Critical Code Points**
```javascript
// EXACT working subscription - DO NOT CHANGE
const subscribeMessage = { method: "subscribeMigration" };

// EXACT graduation detection - DO NOT CHANGE  
if (message.txType === 'migrate' && message.mint && message.pool === 'pump-amm')
```

#### 🎨 **Theme & Styling**
- **Current Theme**: Midnight Aurora (`--midnight-aurora` gradient)
- **Colors**: Deep blues/purples with white text
- **Animations**: Floating particles + geometric shapes at z-index 0
- **Images**: Multi-CDN fallback system implemented

#### 📱 **Deployment Commands**
```bash
# Backend
cd solana-worker && wrangler deploy

# Frontend  
cd /Users/benwatts/solana-pool-tracker && wrangler pages deploy public --project-name solana-pool-tracker
```

#### 🛡️ **What NOT to Touch**
- WebSocket subscription method (causes graduation detection to break)
- Durable Object storage logic (data persistence)
- CORS headers in SSE handling
- Core gradient theme variables (user-approved)

#### 🔧 **Safe to Modify**
- UI styling and layout
- Animation effects and particles
- Token image sources and fallbacks
- Trading data display formatting
- Additional API endpoints

### 🎯 **Known Working State**
- ✅ Graduation tracking: WORKING (fixed subscription method)
- ✅ Price updates: WORKING (real API calls implemented)  
- ✅ Token images: WORKING (multi-CDN fallback)
- ✅ Telegram notifications: WORKING
- ✅ Animations: WORKING (midnight theme)
- ✅ Responsive design: WORKING

Last verified: September 15, 2025 - All systems operational