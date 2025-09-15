// Durable Object for maintaining PumpPortal WebSocket connection
export class PumpPortalTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.websocket = null;
    this.connected = false;
    this.graduatedTokens = [];
    this.sseClients = new Set(); // Track connected SSE clients
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/connect') {
      return this.handleConnect();
    }
    
    if (url.pathname === '/subscribe') {
      return this.handleSSESubscription(request);
    }
    
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
        connected: this.connected,
        graduates: this.graduatedTokens.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response('PumpPortal Durable Object', { status: 404 });
  }

  async handleConnect() {
    if (this.connected) {
      return new Response('Already connected');
    }

    try {
      // Connect to PumpPortal WebSocket for real-time data
      await this.connectToPumpPortal();
      this.connected = true;
      
      return new Response('Connected to PumpPortal WebSocket');
    } catch (error) {
      return new Response(`Connection failed: ${error.message}`, { status: 500 });
    }
  }

  async connectToPumpPortal() {
    try {
      // Create WebSocket connection to PumpPortal
      const wsUrl = 'wss://pumpportal.fun/api/data';
      
      const webSocket = new WebSocket(wsUrl);
      
      webSocket.addEventListener('open', () => {
        console.log('🚀 Connected to PumpPortal WebSocket');
        
        // Subscribe to migration/graduation events from pump.fun to DEX
        const subscribeMessage = {
          method: "subscribeMigration"
        };
        
        webSocket.send(JSON.stringify(subscribeMessage));
      });

      webSocket.addEventListener('message', async (event) => {
        try {
          await this.handlePumpPortalMessage(event.data);
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      });

      webSocket.addEventListener('close', () => {
        console.log('❌ PumpPortal WebSocket disconnected');
        this.connected = false;
        this.websocket = null;
        
        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          if (!this.connected) {
            this.connectToPumpPortal();
          }
        }, 5000);
      });

      webSocket.addEventListener('error', (error) => {
        console.error('PumpPortal WebSocket error:', error);
        this.connected = false;
        this.websocket = null;
      });

      this.websocket = webSocket;
      
      // Wait for connection to be established
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        webSocket.addEventListener('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        webSocket.addEventListener('error', () => {
          clearTimeout(timeout);
          reject(new Error('WebSocket connection failed'));
        });
      });
      
    } catch (error) {
      console.error('Failed to connect to PumpPortal:', error);
      throw error;
    }
  }

  async handlePumpPortalMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Debug: Log the full message structure
      console.log('📋 PumpPortal message received:', JSON.stringify(message, null, 2));
      
      // Check for pump.fun migration/graduation event (same format as working local server)
      if (message.txType === 'migrate' && message.mint && message.pool === 'pump-amm') {
        console.log(`🎓 PUMP.FUN GRADUATION DETECTED: ${message.mint} (${message.symbol || message.name || 'unnamed'})`);
        
        const graduateData = {
          mint: message.mint,
          name: message.name || null,
          symbol: message.symbol || null,
          graduatedAt: message.timestamp || new Date().toISOString(),
          liquidityUsd: message.liquidityUsd || message.initialBuy || null,
          priceUsd: message.priceUsd || null,
          graduationPairAddress: message.pairAddress || null,
          graduationDex: message.dex || 'raydium',
          signature: message.signature || 'unknown'
        };

        // Fetch additional token metadata and price data
        await this.enrichTokenData(graduateData);
        
        // Add to cache (keep last 100)
        this.graduatedTokens.unshift(graduateData);
        if (this.graduatedTokens.length > 100) {
          this.graduatedTokens = this.graduatedTokens.slice(0, 100);
        }

        // Send Telegram notification
        await this.sendTelegramNotification(graduateData);
        
        // Broadcast to all connected SSE clients
        this.broadcastToSSEClients(graduateData);
      }
    } catch (error) {
      console.error('Error processing PumpPortal message:', error);
    }
  }

  async enrichTokenData(graduateData) {
    try {
      // Wait 8 seconds for Dexscreener to index
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${graduateData.mint}`);
      const data = await response.json();
      
      if (data.pairs && data.pairs.length > 0) {
        // Find graduated pair or use first available
        const graduatedPair = data.pairs.find(pair => pair.dexId !== 'pumpfun') || data.pairs[0];
        
        graduateData.name = graduatedPair.baseToken.name;
        graduateData.symbol = graduatedPair.baseToken.symbol;
        graduateData.priceUsd = parseFloat(graduatedPair.priceUsd) || 0;
        graduateData.marketCap = graduatedPair.marketCap || 0;
        graduateData.dexscreenerUrl = graduatedPair.url;
      }
    } catch (error) {
      console.error('Error enriching token data:', error);
    }
  }

  async sendTelegramNotification(graduateData) {
    if (!this.env.TELEGRAM_BOT_TOKEN || !this.env.TELEGRAM_CHAT_ID) {
      return;
    }

    const message = `🎓 *PUMP.FUN GRADUATION ALERT*

🪙 *Token:* ${graduateData.symbol || 'Unknown'} (${graduateData.name || 'Unknown'})
💰 *Price:* $${graduateData.priceUsd ? graduateData.priceUsd.toFixed(6) : 'Unknown'}
📊 *Market Cap:* $${graduateData.marketCap ? graduateData.marketCap.toLocaleString() : 'Unknown'}
⏰ *Time:* ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}

🔗 *Links:*
• [Pump.fun](https://pump.fun/${graduateData.mint})
${graduateData.dexscreenerUrl ? `• [Dexscreener](${graduateData.dexscreenerUrl})` : ''}

\`${graduateData.mint}\``;

    try {
      await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        })
      });
    } catch (error) {
      console.error('Telegram notification failed:', error);
    }
  }

  broadcastToSSEClients(graduateData) {
    const eventData = `data: ${JSON.stringify({
      type: 'newGraduate',
      data: graduateData
    })}\n\n`;

    // Send to all connected SSE clients
    for (const client of this.sseClients) {
      try {
        client.send(eventData);
      } catch (error) {
        // Remove disconnected clients
        this.sseClients.delete(client);
      }
    }
  }

  async handleSSESubscription(request) {
    const origin = request.headers.get("Origin") || "*";
    
    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Cache-Control",
      "Vary": "Origin",
    });

    // Create a streaming response using ReadableStream
    const stream = new ReadableStream({
      start: (controller) => {
        const encoder = new TextEncoder();
        
        // Send initial connection confirmation
        controller.enqueue(encoder.encode(":connected\n\n"));
        
        // Send initial data
        const initialData = {
          type: 'graduates',
          data: this.graduatedTokens.slice(0, 20)
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialData)}\n\n`));

        // Create a client object for broadcasting
        const client = {
          controller,
          encoder,
          send: (data) => {
            try {
              controller.enqueue(encoder.encode(data));
            } catch (error) {
              // Client disconnected, remove from set
              this.sseClients.delete(client);
            }
          }
        };

        // Add client to our set for future broadcasts
        this.sseClients.add(client);

        // Heartbeat every 30 seconds
        const heartbeat = setInterval(() => {
          try {
            client.send(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
          } catch (error) {
            clearInterval(heartbeat);
            this.sseClients.delete(client);
          }
        }, 30000);

        // Clean up when stream is cancelled
        return () => {
          clearInterval(heartbeat);
          this.sseClients.delete(client);
        };
      }
    });

    return new Response(stream, { status: 200, headers });
  }
}