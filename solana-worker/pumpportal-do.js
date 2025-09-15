// Durable Object for maintaining PumpPortal WebSocket connection
export class PumpPortalTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.websocket = null;
    this.connected = false;
    this.graduatedTokens = [];
    this.sseClients = new Set(); // Track connected SSE clients
    this.initialized = false;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    
    // Load persisted graduates from storage
    const stored = await this.state.storage.get('graduatedTokens');
    this.graduatedTokens = stored || [];
    
    console.log(`📚 Loaded ${this.graduatedTokens.length} stored graduates from persistent storage`);
    this.initialized = true;
    
    // Auto-reconnect if not connected (handles Durable Object restarts)
    if (!this.connected && !this.websocket) {
      console.log('🔄 Auto-reconnecting WebSocket on Durable Object initialization...');
      try {
        await this.connectToPumpPortal();
        this.connected = true;
        console.log('✅ Auto-reconnection successful');
      } catch (error) {
        console.error('❌ Auto-reconnection failed:', error.message);
      }
    }
  }

  async fetch(request) {
    await this.ensureInitialized();
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
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }
    
    if (url.pathname === '/update-graduates' && request.method === 'POST') {
      return this.handleUpdateGraduates(request);
    }
    
    if (url.pathname === '/heartbeat') {
      return this.handleHeartbeat();
    }
    
    return new Response('PumpPortal Durable Object', { status: 404 });
  }

  async handleUpdateGraduates(request) {
    try {
      const updatedGraduates = await request.json();
      
      if (!Array.isArray(updatedGraduates)) {
        return new Response('Invalid data format', { status: 400 });
      }
      
      // Update the stored graduates data
      this.graduatedTokens = updatedGraduates;
      
      // Persist to storage
      await this.state.storage.put('graduatedTokens', this.graduatedTokens);
      console.log(`💾 Updated and saved ${this.graduatedTokens.length} graduates to persistent storage`);
      
      return new Response(JSON.stringify({
        success: true,
        count: this.graduatedTokens.length,
        message: 'Graduates data updated successfully'
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
      
    } catch (error) {
      console.error('Error updating graduates data:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }
  }

  async handleHeartbeat() {
    // Heartbeat endpoint to keep Durable Object active and check/restore connection
    const status = {
      timestamp: new Date().toISOString(),
      connected: this.connected,
      graduates: this.graduatedTokens.length,
      hasWebSocket: !!this.websocket,
      keepAliveActive: !!this.keepAliveInterval
    };
    
    // If not connected, attempt auto-reconnection
    if (!this.connected) {
      console.log('💓 Heartbeat detected disconnection, attempting auto-reconnect...');
      try {
        await this.connectToPumpPortal();
        this.connected = true;
        status.connected = true;
        status.reconnected = true;
        console.log('✅ Heartbeat auto-reconnection successful');
      } catch (error) {
        console.error('❌ Heartbeat auto-reconnection failed:', error.message);
        status.reconnectionError = error.message;
      }
    }
    
    return new Response(JSON.stringify(status), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
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
        
        // Set up keepalive ping every 30 seconds to prevent idle disconnection
        this.keepAliveInterval = setInterval(() => {
          if (webSocket.readyState === WebSocket.OPEN) {
            try {
              webSocket.send(JSON.stringify({ method: "ping" }));
              console.log('📡 Sent keepalive ping to PumpPortal');
            } catch (error) {
              console.error('❌ Keepalive ping failed:', error);
              clearInterval(this.keepAliveInterval);
            }
          } else {
            console.log('⚠️ WebSocket not open, clearing keepalive');
            clearInterval(this.keepAliveInterval);
          }
        }, 30000);
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
        
        // Clear keepalive interval
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }
        
        // Note: Can't use setTimeout in Cloudflare Workers Durable Objects reliably
        // Reconnection will be handled by frontend health checks and manual reconnection
        console.log('🔄 WebSocket disconnected - reconnection available via /connect endpoint');
      });

      webSocket.addEventListener('error', (error) => {
        console.error('PumpPortal WebSocket error:', error);
        this.connected = false;
        this.websocket = null;
        
        // Clear keepalive interval
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }
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
      
      // Debug: Log the full message structure for ALL messages
      console.log('📋 PumpPortal message received:', JSON.stringify(message, null, 2));
      
      // Check for pump.fun migration/graduation event (EXACT same logic as working local server)
      if (message.txType === 'migrate' && message.mint && message.pool === 'pump-amm') {
        console.log(`🎓 PUMP.FUN GRADUATION DETECTED: ${message.mint} (${message.symbol || message.name || 'unnamed'})`);
        
        const graduationTime = message.timestamp || new Date().toISOString();
        
        const graduateData = {
          mint: message.mint,
          name: message.name || null,
          symbol: message.symbol || null,
          graduatedAt: graduationTime,
          timestamp: graduationTime, // Frontend expects this field for Time column
          liquidityUsd: message.liquidityUsd || message.initialBuy || null,
          priceUsd: message.priceUsd || null,
          graduationPairAddress: message.pairAddress || null,
          graduationDex: message.dex || 'raydium',
          signature: message.signature || 'unknown'
        };

        // Fetch additional token metadata and price data
        await this.enrichTokenData(graduateData);
        
        // Add to persistent storage (no limit)
        this.graduatedTokens.unshift(graduateData);

        // Persist to storage
        await this.state.storage.put('graduatedTokens', this.graduatedTokens);
        console.log(`💾 Saved ${this.graduatedTokens.length} graduates to persistent storage`);

        // Send Telegram notification
        await this.sendTelegramNotification(graduateData);
        
        // Broadcast to all connected SSE clients
        this.broadcastToSSEClients(graduateData);
      } else if (message.txType === 'migrate') {
        console.log(`⏭️  Skipping non-pump.fun migration: ${message.mint} (pool: ${message.pool})`);
      } else {
        // Log why the message was rejected for debugging
        const hasType = message.txType || message.type || message.event || 'none';
        const hasMint = message.mint ? 'yes' : 'no';
        const hasPool = message.pool || message.dex || 'none';
        console.log(`🚫 Message rejected - txType/type/event: ${hasType}, mint: ${hasMint}, pool/dex: ${hasPool}`);
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
        
        // Try multiple image sources
        graduateData.tokenImage = graduatedPair.baseToken.image || 
                                 graduatedPair.info?.imageUrl || 
                                 graduatedPair.info?.image ||
                                 graduatedPair.baseToken?.logoURI ||
                                 null;
        
        if (graduateData.tokenImage) {
          console.log(`🖼️ Found image for ${graduateData.symbol}: ${graduateData.tokenImage}`);
        } else {
          console.log(`📷 No image found for ${graduateData.symbol}`);
        }
        graduateData.priceUsd = parseFloat(graduatedPair.priceUsd) || 0;
        graduateData.marketCap = graduatedPair.marketCap || 0;
        graduateData.dexscreenerUrl = graduatedPair.url;
        
        // Add trading data that frontend expects
        graduateData.volume24h = graduatedPair.volume?.h24 || null;
        graduateData.volume1h = graduatedPair.volume?.h1 || null;
        graduateData.txns24h = graduatedPair.txns?.h24 || null;
        graduateData.txns1h = graduatedPair.txns?.h1 || null;
        graduateData.priceChange24h = graduatedPair.priceChange?.h24 || null;
        graduateData.priceChange1h = graduatedPair.priceChange?.h1 || null;
        
        console.log(`📊 Enriched ${graduateData.symbol} with trading data: Vol24h=$${graduateData.volume24h || 'N/A'}, Change24h=${graduateData.priceChange24h || 'N/A'}%`);
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