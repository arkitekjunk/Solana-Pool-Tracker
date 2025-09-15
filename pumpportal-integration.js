// Connect to PumpPortal WebSocket for real-time pump.fun token updates
function connectToPumpPortal() {
  if (pumpPortalWs && pumpPortalWs.readyState === WebSocket.OPEN) {
    console.log('🔗 PumpPortal already connected');
    return;
  }

  console.log('🔗 Connecting to PumpPortal WebSocket...');
  pumpPortalLastConnectTime = new Date().toISOString();

  pumpPortalWs = new WebSocket('wss://pumpportal.fun/api/data');

  pumpPortalWs.on('open', () => {
    console.log('✅ PumpPortal WebSocket connected successfully');
    pumpPortalConnected = true;
    pumpPortalReconnectAttempts = 0;

    // Subscribe to new token events (this includes graduation events)
    const subscribeMessage = {
      method: "subscribeNewToken"
    };
    pumpPortalWs.send(JSON.stringify(subscribeMessage));
    console.log('📡 Subscribed to pump.fun new token events');
  });

  pumpPortalWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Check if this is a token creation/graduation event
      if (message.txType === 'create' && message.mint) {
        console.log(`🎓 New pump.fun token detected: ${message.mint}`);
        
        // Check if we've already processed this token
        const key = message.mint + (message.timestamp || '');
        if (seenGraduations.has(key)) {
          return; // Skip duplicates
        }
        seenGraduations.add(key);

        // Create graduate data from PumpPortal message
        const graduateData = {
          mint: message.mint,
          name: message.name || null,
          symbol: message.symbol || null,
          graduatedAt: message.timestamp || new Date().toISOString(),
          liquidityUsd: message.initialBuy || null,
          priceUsd: null, // Will be filled by Dexscreener
          timestamp: moment().tz('Australia/Brisbane').format(),
          pumpfunUrl: `https://pump.fun/${message.mint}`,
          dexscreenerUrl: null,
          graduationPairAddress: null,
          graduationDex: null,
          volume24h: null,
          volume1h: null,
          txns24h: null,
          txns1h: null,
          priceChange24h: null,
          priceChange1h: null,
          marketCap: message.marketCap || null,
          fdv: null,
          priceUsdCurrent: null
        };

        // Add to our cache
        graduatedTokens.unshift(graduateData);
        
        // Keep only last 100 graduates
        if (graduatedTokens.length > 100) {
          graduatedTokens.splice(100);
        }

        // Broadcast immediately to frontend
        broadcastToMoralisSSE(graduateData);
        console.log(`🚀 Broadcasted new pump.fun token: ${message.symbol || message.mint}`);

        // Fetch Dexscreener data asynchronously
        setTimeout(async () => {
          try {
            const dexData = await fetchDexscreenerData(graduateData.mint);
            if (dexData) {
              Object.assign(graduateData, {
                dexscreenerUrl: dexData.dexscreenerUrl,
                graduationPairAddress: dexData.graduationPairAddress,
                graduationDex: dexData.graduationDex,
                volume24h: dexData.volume24h,
                volume1h: dexData.volume1h,
                txns24h: dexData.txns24h,
                txns1h: dexData.txns1h,
                priceChange24h: dexData.priceChange24h,
                priceChange1h: dexData.priceChange1h,
                marketCap: dexData.marketCap,
                fdv: dexData.fdv,
                priceUsdCurrent: dexData.priceUsdCurrent
              });
              
              // Re-broadcast with enriched data
              broadcastToMoralisSSE(graduateData);
            }
          } catch (error) {
            console.log(`Failed to fetch Dexscreener data for ${graduateData.mint}:`, error.message);
          }
        }, 2000); // 2 second delay for Dexscreener fetch
      }
    } catch (error) {
      console.error('Error processing PumpPortal message:', error.message);
    }
  });

  pumpPortalWs.on('error', (error) => {
    console.error('❌ PumpPortal WebSocket error:', error.message);
    pumpPortalConnected = false;
  });

  pumpPortalWs.on('close', (code, reason) => {
    console.log(`🔌 PumpPortal WebSocket closed: ${code} ${reason}`);
    pumpPortalConnected = false;
    
    // Attempt to reconnect with exponential backoff
    if (pumpPortalReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      pumpPortalReconnectAttempts++;
      const delay = Math.pow(2, pumpPortalReconnectAttempts) * 1000; // 2s, 4s, 8s, 16s, 32s
      console.log(`🔄 Attempting to reconnect to PumpPortal in ${delay/1000}s (attempt ${pumpPortalReconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      
      setTimeout(() => {
        connectToPumpPortal();
      }, delay);
    } else {
      console.error('❌ Max reconnection attempts reached. Please restart the server.');
    }
  });
}