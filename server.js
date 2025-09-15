require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const moment = require('moment-timezone');
const path = require('path');
const WebSocket = require('ws');

// Telegram Bot configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// In-memory storage for pools (last 100)
let detectedPools = [];
const MAX_POOLS = 100;

// Deduplication set for transaction signatures
const processedSignatures = new Set();

// SSE connections
const sseClients = [];
const moralisSSEClients = [];

// Program IDs to monitor
const PROGRAM_IDS = {
  'Raydium AMM v4': '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'Raydium CP-Swap': 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'Raydium CLMM': 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'Orca Whirlpools': 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'Orca Token-Swap v2': '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',
  'Meteora DLMM': 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Pump.fun': '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'PumpSwap AMM': 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
};

// Pool creation instruction patterns - expanded to catch more variants
const POOL_INIT_PATTERNS = [
  'initialize',
  'initialize_pool',
  'initializepool',
  'create_pool',
  'createpool',
  'init_pool',
  'initpool',
  'init',
  'setup',
  'new_pool',
  'newpool',
  'deploy',
  'launch',
  // Raydium specific
  'initializeamm',
  'initialize_amm',
  'initializeclmm',
  'initialize_clmm',
  'initializewhirlpool',
  'initialize_whirlpool',
  // Orca specific
  'initializepool',
  'initialize_pool_v2',
  'initializepoolv2'
];

// Function to get program name by ID
function getProgramName(programId) {
  for (const [name, id] of Object.entries(PROGRAM_IDS)) {
    if (id === programId) return name;
  }
  return 'Unknown';
}

// Function to check if instruction is pool initialization or liquidity event
function isPoolInitInstruction(instruction) {
  // For pump.fun specifically, we want to detect when tokens get their first liquidity
  // This typically happens when pump.fun tokens are migrated to Raydium
  
  // Check if parsed data exists (unlikely with Enhanced webhooks)
  if (instruction.parsed && instruction.parsed.type) {
    const instructionType = instruction.parsed.type.toLowerCase();
    return POOL_INIT_PATTERNS.some(pattern => 
      instructionType.includes(pattern.toLowerCase())
    );
  }
  
  // For pump.fun and PumpSwap, any swap transaction indicates liquidity activity
  // We'll capture all pump.fun/PumpSwap swaps to detect new token launches with liquidity
  if (instruction.programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' || 
      instruction.programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') {
    console.log(`    🚀 Pump.fun/PumpSwap activity detected!`);
    return true; // All pump.fun/PumpSwap transactions are of interest
  }
  
  // For other programs, use the existing logic
  if (instruction.data && instruction.accounts) {
    const accountCount = instruction.accounts.length;
    const hasEnoughAccounts = accountCount >= 8;
    
    const dataLength = instruction.data ? instruction.data.length : 0;
    const hasComplexData = dataLength > 20;
    
    if (hasEnoughAccounts && hasComplexData) {
      console.log(`    🎯 Potential pool operation: ${accountCount} accounts, ${dataLength} data length`);
      return true;
    }
  }
  
  return false;
}

// Function to extract pool data from instruction
function extractPoolData(instruction, signature) {
  const poolData = {
    signature,
    programId: instruction.programId,
    program: getProgramName(instruction.programId),
    timestamp: moment().tz('Australia/Brisbane').format(),
    poolAddress: null,
    tokenMintA: null,
    tokenMintB: null,
    tokenNameA: null,
    tokenNameB: null,
    tokenSymbolA: null,
    tokenSymbolB: null,
    liquidity: null
  };

  try {
    // Extract pool address and token mints based on instruction data
    if (instruction.parsed && instruction.parsed.info) {
      const info = instruction.parsed.info;
      
      // Common fields across different programs
      poolData.poolAddress = info.pool || info.poolState || info.whirlpool || info.ammId;
      poolData.tokenMintA = info.tokenMintA || info.mintA || info.tokenA;
      poolData.tokenMintB = info.tokenMintB || info.mintB || info.tokenB;
    }

    // Try to extract from accounts if not found in info
    if (!poolData.tokenMintA || !poolData.tokenMintB) {
      const accounts = instruction.accounts || [];
      if (accounts.length >= 2) {
        poolData.tokenMintA = poolData.tokenMintA || accounts[0];
        poolData.tokenMintB = poolData.tokenMintB || accounts[1];
      }
    }
  } catch (error) {
    console.log('Error extracting pool data:', error.message);
  }

  return poolData;
}

// Function to fetch token metadata from Solana
async function fetchTokenMetadata(mintAddress) {
  try {
    // Try Helius metadata API first
    const response = await axios.post(
      `https://api.helius.xyz/v0/token-metadata?api-key=${process.env.HELIUS_API_KEY}`,
      {
        mintAccounts: [mintAddress]
      },
      { timeout: 3000 }
    );
    
    if (response.data && response.data.length > 0) {
      const metadata = response.data[0];
      return {
        name: metadata.onChainMetadata?.metadata?.data?.name || null,
        symbol: metadata.onChainMetadata?.metadata?.data?.symbol || null
      };
    }
  } catch (error) {
    console.log(`Token metadata fetch failed for ${mintAddress}:`, error.message);
  }
  
  return { name: null, symbol: null };
}

// Function to fetch liquidity and token metadata (optional, non-blocking)
async function fetchTokenData(poolData) {
  if (!poolData.tokenMintA) return;

  // Fetch token metadata for both mints
  const promises = [];
  
  if (poolData.tokenMintA) {
    promises.push(fetchTokenMetadata(poolData.tokenMintA));
  }
  if (poolData.tokenMintB) {
    promises.push(fetchTokenMetadata(poolData.tokenMintB));
  }

  try {
    const [metadataA, metadataB] = await Promise.all(promises);
    
    if (metadataA) {
      poolData.tokenNameA = metadataA.name;
      poolData.tokenSymbolA = metadataA.symbol;
    }
    if (metadataB) {
      poolData.tokenNameB = metadataB.name;
      poolData.tokenSymbolB = metadataB.symbol;
    }

    // Also try to fetch liquidity from Dexscreener
    const dexResponse = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${poolData.tokenMintA}`,
      { timeout: 3000 }
    );
    
    if (dexResponse.data && dexResponse.data.pairs && dexResponse.data.pairs.length > 0) {
      const pair = dexResponse.data.pairs.find(p => 
        p.baseToken.address === poolData.tokenMintA && 
        p.quoteToken.address === poolData.tokenMintB
      ) || dexResponse.data.pairs[0];
      
      if (pair && pair.liquidity && pair.liquidity.usd) {
        poolData.liquidity = `$${parseFloat(pair.liquidity.usd).toLocaleString()}`;
      }
    }
  } catch (error) {
    console.log('Token data fetch failed (non-blocking):', error.message);
  }
}

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  // Respond quickly to Helius
  res.status(200).json({ status: 'received' });

  try {
    const transactions = req.body;
    if (!Array.isArray(transactions)) {
      console.log('⚠️  Webhook received non-array data:', typeof req.body);
      return;
    }

    console.log(`📥 Webhook received ${transactions.length} transactions`);

    for (const tx of transactions) {
      if (!tx.signature || processedSignatures.has(tx.signature)) continue;
      
      processedSignatures.add(tx.signature);
      
      console.log(`🔍 Processing tx: ${tx.signature}`);
      
      // Check each instruction in the transaction
      if (tx.instructions) {
        console.log(`  📋 Transaction has ${tx.instructions.length} instructions`);
        
        for (const instruction of tx.instructions) {
          console.log(`    🔧 Instruction: programId=${instruction.programId}, parsed=${instruction.parsed ? 'yes' : 'no'}`);
          
          // Check if this is a monitored program
          if (!Object.values(PROGRAM_IDS).includes(instruction.programId)) {
            console.log(`    ⏭️  Skipping non-monitored program: ${instruction.programId}`);
            continue;
          }
          
          console.log(`    ✅ Found monitored program: ${getProgramName(instruction.programId)}`);
          console.log(`    🎯 This is a transaction on our target program!`);
          
          // Log instruction details for debugging
          if (instruction.parsed) {
            console.log(`    📝 Parsed instruction type: ${instruction.parsed.type}`);
            console.log(`    📋 Full parsed data:`, JSON.stringify(instruction.parsed, null, 2));
          } else {
            console.log(`    ❌ No parsed data available`);
            console.log(`    🔍 Raw instruction:`, JSON.stringify(instruction, null, 2));
          }
          
          // Check if this is a pool initialization instruction
          if (!isPoolInitInstruction(instruction)) {
            console.log(`    ⏭️  Not a pool init instruction (type: ${instruction.parsed?.type || 'unknown'})`);
            // Continue processing other instructions instead of skipping
            continue;
          }
          
          console.log(`🟢 Pool creation detected: ${tx.signature} on ${getProgramName(instruction.programId)}`);
          
          // Extract pool data
          const poolData = extractPoolData(instruction, tx.signature);
          
          // Add to our list
          detectedPools.unshift(poolData);
          if (detectedPools.length > MAX_POOLS) {
            detectedPools = detectedPools.slice(0, MAX_POOLS);
          }
          
          // Broadcast to SSE clients
          broadcastToSSE(poolData);
          
          // Fetch token metadata and liquidity asynchronously (non-blocking)
          fetchTokenData(poolData).then(() => {
            // Broadcast updated data with token names
            broadcastToSSE(poolData);
          });
          
          break; // Only process first matching instruction per transaction
        }
      } else {
        console.log(`  ❌ No instructions in transaction ${tx.signature}`);
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error.message);
  }
});

// SSE endpoint
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  // Send initial data
  res.write(`data: ${JSON.stringify({ type: 'pools', data: detectedPools })}\n\n`);

  req.on('close', () => {
    const index = sseClients.findIndex(client => client.id === clientId);
    if (index !== -1) sseClients.splice(index, 1);
  });
});

// Function to broadcast to all SSE clients
function broadcastToSSE(data) {
  const message = `data: ${JSON.stringify({ type: 'newPool', data })}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(message);
    } catch (error) {
      console.log('SSE client disconnected');
    }
  });
}

// API endpoint to get current pools
app.get('/api/pools', (req, res) => {
  res.json({
    pools: detectedPools,
    count: detectedPools.length,
    processedSignatures: processedSignatures.size
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Scanner management
let webhookId = null;
let tunnelProcess = null;
let currentTunnelUrl = null;

// Start scanner endpoint
app.post('/api/scanner/start', async (req, res) => {
  try {
    if (webhookId) {
      return res.json({ status: 'already_running', webhookId });
    }

    // Clean up any existing processes first
    if (tunnelProcess) {
      try {
        tunnelProcess.kill('SIGTERM');
      } catch (error) {
        console.log('Error cleaning up existing tunnel:', error.message);
      }
      tunnelProcess = null;
      currentTunnelUrl = null;
    }

    // Start Cloudflare tunnel
    const { spawn } = require('child_process');
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`]);
    
    // Wait for tunnel URL
    let tunnelUrl = null;
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Tunnel startup timeout'));
      }, 10000);
      
      tunnelProcess.stderr.on('data', (data) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          tunnelUrl = match[0];
          currentTunnelUrl = tunnelUrl;
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    if (!tunnelUrl) {
      throw new Error('Failed to get tunnel URL');
    }

    // Create webhook
    const webhookData = {
      webhookType: 'enhanced',
      transactionTypes: ['SWAP'],
      accountAddresses: [
        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CP-Swap
        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpools
        '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Token-Swap v2
        'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'  // Meteora DLMM
      ],
      webhookURL: `${tunnelUrl}/webhook`
    };

    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${process.env.HELIUS_API_KEY}`,
      webhookData
    );

    webhookId = response.data.webhookID;
    console.log(`🚀 Scanner started!`);
    console.log(`📡 Webhook ID: ${webhookId}`);
    console.log(`🌐 Tunnel URL: ${tunnelUrl}`);
    
    res.json({ 
      status: 'started', 
      webhookId, 
      tunnelUrl,
      message: 'Pump.fun scanner started successfully!'
    });
  } catch (error) {
    console.error('Failed to start scanner:', error.message);
    
    // Cleanup on failure
    if (tunnelProcess) {
      tunnelProcess.kill();
      tunnelProcess = null;
    }
    
    res.status(500).json({ 
      status: 'error', 
      error: 'Failed to start scanner',
      details: error.message 
    });
  }
});

// Stop scanner endpoint
app.post('/api/scanner/stop', async (req, res) => {
  try {
    let stoppedComponents = [];

    // Delete webhook if exists
    if (webhookId) {
      try {
        await axios.delete(
          `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${process.env.HELIUS_API_KEY}`
        );
        console.log(`🗑️ Webhook deleted: ${webhookId}`);
        stoppedComponents.push('webhook');
      } catch (error) {
        console.error('Failed to delete webhook:', error.message);
        // Don't fail the entire stop process if webhook deletion fails
        stoppedComponents.push('webhook (failed)');
      }
      webhookId = null;
    }

    // Stop tunnel process with proper cleanup
    if (tunnelProcess) {
      try {
        // Kill the process and all its children
        if (process.platform === 'win32') {
          require('child_process').exec(`taskkill /pid ${tunnelProcess.pid} /T /F`);
        } else {
          tunnelProcess.kill('SIGTERM');
          // Give it a moment to terminate gracefully
          setTimeout(() => {
            if (tunnelProcess && !tunnelProcess.killed) {
              tunnelProcess.kill('SIGKILL');
            }
          }, 2000);
        }
        console.log(`🔌 Tunnel stopped`);
        stoppedComponents.push('tunnel');
      } catch (error) {
        console.error('Failed to stop tunnel:', error.message);
        stoppedComponents.push('tunnel (failed)');
      }
      tunnelProcess = null;
      currentTunnelUrl = null;
    }

    console.log(`⏹️ Scanner stopped`);
    
    res.json({ 
      status: 'stopped', 
      stoppedComponents,
      message: 'Scanner stopped successfully!'
    });
  } catch (error) {
    console.error('Failed to stop scanner:', error.message);
    res.status(500).json({ 
      status: 'error', 
      error: 'Failed to stop scanner',
      details: error.message 
    });
  }
});

// Get scanner status
app.get('/api/scanner/status', (req, res) => {
  res.json({
    running: !!webhookId,
    webhookId,
    tunnelUrl: currentTunnelUrl,
    poolCount: detectedPools.length
  });
});

// Clear all data endpoint
app.post('/api/data/clear', (req, res) => {
  try {
    detectedPools.length = 0;
    processedSignatures.clear();
    
    // Broadcast clear message to all SSE clients
    const clearMessage = `data: ${JSON.stringify({ type: 'clear' })}\n\n`;
    sseClients.forEach(client => {
      try {
        client.res.write(clearMessage);
      } catch (error) {
        console.log('SSE client disconnected');
      }
    });
    
    console.log('🗑️ All pool data cleared');
    
    res.json({ 
      status: 'success', 
      message: 'All pool data cleared',
      poolCount: 0
    });
  } catch (error) {
    console.error('Failed to clear data:', error.message);
    res.status(500).json({ 
      status: 'error', 
      error: 'Failed to clear data',
      details: error.message 
    });
  }
});

// PumpPortal WebSocket for pump.fun graduates
const seenGraduations = new Set();
const graduatedTokens = [];
let pumpPortalWs = null;
let pumpPortalLastConnectTime = null;
let pumpPortalReconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let pumpPortalConnected = false;

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

    // Subscribe to migration events (graduation from pump.fun to DEX)
    const subscribeMessage = {
      method: "subscribeMigration"
    };
    pumpPortalWs.send(JSON.stringify(subscribeMessage));
    console.log('📡 Subscribed to pump.fun migration/graduation events');
  });

  pumpPortalWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Debug: Log the full message structure
      console.log('📋 PumpPortal message received:', JSON.stringify(message, null, 2));
      
      // Check if this is a pump.fun migration/graduation event
      if (message.txType === 'migrate' && message.mint && message.pool === 'pump-amm') {
        console.log(`🎓 PUMP.FUN GRADUATION DETECTED: ${message.mint} (${message.symbol || message.name || 'unnamed'})`);
        
        const tokenAddress = message.mint;
        if (!tokenAddress) return;
        
        // Check if we've already processed this token
        const key = tokenAddress + (message.timestamp || '');
        if (seenGraduations.has(key)) {
          return; // Skip duplicates
        }
        seenGraduations.add(key);

        // Get name and symbol immediately from Dexscreener
        let tokenName = message.name || null;
        let tokenSymbol = message.symbol || null;
        
        try {
          const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
          if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            const pair = response.data.pairs[0];
            tokenName = tokenName || pair.baseToken?.name || null;
            tokenSymbol = tokenSymbol || pair.baseToken?.symbol || null;
            console.log(`📝 Got token metadata: ${tokenSymbol} (${tokenName})`);
          }
        } catch (error) {
          console.log(`Failed to fetch initial token metadata for ${tokenAddress}:`, error.message);
        }

        // Create graduate data from migration event
        const graduateData = {
          mint: tokenAddress,
          name: tokenName,
          symbol: tokenSymbol,
          graduatedAt: message.timestamp || new Date().toISOString(),
          liquidityUsd: message.liquidityUsd || message.initialBuy || null,
          priceUsd: message.priceUsd || null,
          timestamp: moment().tz('Australia/Brisbane').format(),
          pumpfunUrl: `https://pump.fun/${tokenAddress}`,
          dexscreenerUrl: null,
          graduationPairAddress: message.pairAddress || null,
          graduationDex: message.dex || 'raydium', // Default to raydium
          volume24h: null,
          volume1h: null,
          txns24h: null,
          txns1h: null,
          priceChange24h: null,
          priceChange1h: null,
          marketCap: message.marketCap || null,
          fdv: null,
          priceUsdCurrent: message.priceUsd || null
        };

        // Add to our cache
        graduatedTokens.unshift(graduateData);
        
        // Keep only last 100 graduates
        if (graduatedTokens.length > 100) {
          graduatedTokens.splice(100);
        }

        // Broadcast immediately to frontend
        broadcastToMoralisSSE(graduateData);
        console.log(`🚀 Broadcasted graduated token: ${tokenSymbol || tokenName || tokenAddress}`);

        // Fetch enhanced Dexscreener data first, then send Telegram notification
        setTimeout(async () => {
          console.log(`⏰ Starting 3-second delayed enhancement for ${tokenAddress}`);
          try {
            console.log(`📡 Fetching enhanced Dexscreener data for ${tokenAddress}...`);
            const dexData = await fetchDexscreenerData(tokenAddress);
            console.log(`📊 Dexscreener returned:`, dexData ? 'Data found' : 'No data');
            if (dexData) {
              console.log(`💰 Price: ${dexData.priceUsdCurrent}, Market Cap: ${dexData.marketCap}`);
              Object.assign(graduateData, {
                dexscreenerUrl: dexData.dexscreenerUrl,
                graduationPairAddress: dexData.graduationPairAddress || graduateData.graduationPairAddress,
                graduationDex: dexData.graduationDex || graduateData.graduationDex,
                volume24h: dexData.volume24h,
                volume1h: dexData.volume1h,
                txns24h: dexData.txns24h,
                txns1h: dexData.txns1h,
                priceChange24h: dexData.priceChange24h,
                priceChange1h: dexData.priceChange1h,
                marketCap: dexData.marketCap || graduateData.marketCap,
                fdv: dexData.fdv,
                priceUsdCurrent: dexData.priceUsdCurrent || graduateData.priceUsdCurrent
              });
              
              // Re-broadcast with enriched data
              broadcastToMoralisSSE(graduateData);
              console.log(`📊 Enhanced data loaded for ${graduateData.symbol || tokenAddress}`);
              
              // CONFIRM we have price and market cap before sending notification
              if (graduateData.priceUsdCurrent && graduateData.marketCap) {
                console.log(`✅ CONFIRMED - Price: $${graduateData.priceUsdCurrent}, Market Cap: $${graduateData.marketCap}`);
                sendTelegramNotification(graduateData);
              } else {
                console.log(`⚠️  Missing price/market cap data - Price: ${graduateData.priceUsdCurrent}, MC: ${graduateData.marketCap}`);
                console.log(`🔄 Will retry fetching data in 10 seconds...`);
                
                // Retry once more after 10 seconds
                setTimeout(async () => {
                  try {
                    const retryDexData = await fetchDexscreenerData(graduateData.mint);
                    if (retryDexData && retryDexData.priceUsdCurrent) {
                      Object.assign(graduateData, retryDexData);
                      console.log(`✅ RETRY SUCCESS - Price: $${graduateData.priceUsdCurrent}, Market Cap: $${graduateData.marketCap}`);
                      sendTelegramNotification(graduateData);
                      broadcastToMoralisSSE(graduateData);
                    } else {
                      console.log(`❌ Retry failed - sending notification with basic data`);
                      sendTelegramNotification(graduateData);
                    }
                  } catch (error) {
                    console.log(`❌ Retry error:`, error.message);
                    sendTelegramNotification(graduateData);
                  }
                }, 10000);
              }
            } else {
              // If no Dexscreener data at all, try multiple retries before giving up
              console.log(`⚠️  No Dexscreener data found - will retry multiple times`);
              let retryCount = 0;
              const maxRetries = 3;
              
              const retryFetch = async () => {
                retryCount++;
                console.log(`🔄 Retry ${retryCount}/${maxRetries} for ${graduateData.mint}...`);
                
                try {
                  const retryDexData = await fetchDexscreenerData(graduateData.mint);
                  if (retryDexData && retryDexData.priceUsdCurrent) {
                    Object.assign(graduateData, retryDexData);
                    console.log(`✅ RETRY ${retryCount} SUCCESS - Price: $${graduateData.priceUsdCurrent}, Market Cap: $${graduateData.marketCap}`);
                    sendTelegramNotification(graduateData);
                    broadcastToMoralisSSE(graduateData);
                    return;
                  }
                } catch (error) {
                  console.log(`❌ Retry ${retryCount} error:`, error.message);
                }
                
                if (retryCount < maxRetries) {
                  // Retry again in 15 seconds
                  setTimeout(retryFetch, 15000);
                } else {
                  console.log(`❌ All ${maxRetries} retries failed - sending basic notification`);
                  sendTelegramNotification(graduateData);
                }
              };
              
              // Start first retry in 10 seconds
              setTimeout(retryFetch, 10000);
            }
          } catch (error) {
            console.log(`Failed to fetch enhanced data for ${tokenAddress}:`, error.message);
            // Send notification anyway with basic data
            sendTelegramNotification(graduateData);
          }
        }, 8000); // 8 second delay to allow Dexscreener to index the graduated pair
      } else if (message.txType === 'migrate') {
        console.log(`⏭️  Skipping non-pump.fun migration: ${message.mint} (pool: ${message.pool})`);
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


// Function to fetch additional data from Dexscreener (free API)
async function fetchDexscreenerData(tokenAddress) {
  try {
    console.log(`🌐 Making request to Dexscreener for ${tokenAddress}`);
    
    // Use curl since axios has network connectivity issues
    const { exec } = require('child_process');
    const curlCommand = `curl -s "https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}"`;
    
    const result = await new Promise((resolve, reject) => {
      exec(curlCommand, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
    
    const response = { data: JSON.parse(result.stdout) };

    if (response.data && response.data.pairs && response.data.pairs.length > 0) {
      const pairs = response.data.pairs;
      console.log(`🔍 Found ${pairs.length} pairs for ${tokenAddress}`);
      
      // Log all pairs to see what we're working with
      pairs.forEach((pair, i) => {
        console.log(`  Pair ${i + 1}: ${pair.dexId} - ${pair.priceUsd ? '$' + pair.priceUsd : 'No price'} - MC: ${pair.marketCap || 'None'}`);
      });
      
      // Find non-pumpfun pairs (graduated pairs)
      const graduatedPairs = pairs.filter(pair => pair.dexId !== 'pumpfun');
      console.log(`🎯 Found ${graduatedPairs.length} graduated pairs`);
      
      // If no graduated pairs yet, use the most recent pump.fun data temporarily
      let targetPair = null;
      if (graduatedPairs.length > 0) {
        // Use the first graduated pair (preferred)
        targetPair = graduatedPairs.sort((a, b) => a.pairCreatedAt - b.pairCreatedAt)[0];
        console.log(`✅ Using graduated pair: ${targetPair.dexId}`);
      } else {
        // Fall back to pump.fun data while waiting for graduated pair to appear
        const pumpPairs = pairs.filter(pair => pair.dexId === 'pumpfun');
        if (pumpPairs.length > 0) {
          targetPair = pumpPairs[0];
          console.log(`⏳ Using pump.fun data temporarily (graduated pair not indexed yet)`);
        }
      }
      
      if (targetPair) {
        return {
          dexscreenerUrl: targetPair.url,
          graduationPairAddress: targetPair.pairAddress,
          graduationDex: targetPair.dexId,
          graduatedAt: new Date(targetPair.pairCreatedAt).toISOString(),
          // Enhanced trading data
          volume24h: targetPair.volume?.h24 || null,
          volume1h: targetPair.volume?.h1 || null,
          txns24h: targetPair.txns?.h24 || null,
          txns1h: targetPair.txns?.h1 || null,
          priceChange24h: targetPair.priceChange?.h24 || null,
          priceChange1h: targetPair.priceChange?.h1 || null,
          marketCap: targetPair.marketCap || null,
          fdv: targetPair.fdv || null,
          liquidityUsd: targetPair.liquidity?.usd || null,
          priceUsdCurrent: targetPair.priceUsd || null
        };
      }
    }
  } catch (error) {
    console.log(`❌ Failed to fetch Dexscreener data for ${tokenAddress}:`, error.message);
    return null;
  }
  
  console.log(`⚠️  No pairs found on Dexscreener for ${tokenAddress}`);
  return null;
}

// Function to broadcast to Moralis SSE clients
function broadcastToMoralisSSE(data) {
  const message = `data: ${JSON.stringify({ type: 'newGraduate', data })}\n\n`;
  moralisSSEClients.forEach(client => {
    try {
      client.res.write(message);
    } catch (error) {
      console.log('Moralis SSE client disconnected');
    }
  });
}

// Function to send Telegram notification
async function sendTelegramNotification(graduateData) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('📱 Telegram not configured - skipping notification');
    return;
  }

  try {
    console.log('🔍 Building Telegram message for:', graduateData.mint);
    const symbol = graduateData.symbol || 'Unknown';
    const name = graduateData.name || 'Unknown Token';
    const mint = graduateData.mint;
    const dex = graduateData.graduationDex || 'pump-amm';
    const price = graduateData.priceUsdCurrent ? `$${parseFloat(graduateData.priceUsdCurrent).toFixed(6)}` : 'Unknown';
    const marketCap = graduateData.marketCap ? `$${parseInt(graduateData.marketCap).toLocaleString()}` : 'Unknown';
    
    const message = `🎓 *PUMP.FUN GRADUATION ALERT*

🪙 *Token:* ${symbol} (${name})
💰 *Price:* ${price}
📊 *Market Cap:* ${marketCap}
🏦 *DEX:* ${dex}
⏰ *Time:* ${moment().tz('Australia/Brisbane').format('DD/MM/YY HH:mm')}

🔗 *Links:*
• [Pump.fun](https://pump.fun/${mint})
${graduateData.dexscreenerUrl ? `• [Dexscreener](${graduateData.dexscreenerUrl})` : ''}

\`${mint}\``;

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    console.log('📤 Sending to Telegram via curl');
    console.log('📤 Message content:', message);
    
    // Use curl since axios has connectivity issues
    const { exec } = require('child_process');
    
    // Properly escape the JSON payload to avoid shell injection
    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID, 
      text: message, 
      parse_mode: 'Markdown', 
      disable_web_page_preview: false
    });
    
    // Escape single quotes and other special characters for shell
    const escapedPayload = payload.replace(/'/g, "'\"'\"'");
    const curlCommand = `curl -X POST "${telegramUrl}" -H "Content-Type: application/json" -d '${escapedPayload}'`;
    
    const result = await new Promise((resolve, reject) => {
      exec(curlCommand, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
    
    const response = JSON.parse(result.stdout);
    if (response.ok) {
      console.log('✅ Telegram notification sent via curl');
    } else {
      throw new Error(`Telegram API error: ${result.stdout}`);
    }
    
    console.log(`📱 Telegram notification sent for ${symbol}`);
  } catch (error) {
    console.error('❌ Failed to send Telegram notification:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    if (error.response) {
      console.error('📋 Response data:', error.response.data);
      console.error('📋 Response status:', error.response.status);
    }
  }
}

// Moralis SSE endpoint
app.get('/moralis/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const clientId = Date.now();
  moralisSSEClients.push({ id: clientId, res });

  // Send initial data
  res.write(`data: ${JSON.stringify({ type: 'graduates', data: graduatedTokens })}\n\n`);

  req.on('close', () => {
    const index = moralisSSEClients.findIndex(client => client.id === clientId);
    if (index !== -1) moralisSSEClients.splice(index, 1);
  });
});

// Add missing graduate endpoint (for debugging)
app.post('/api/add-graduate/:tokenAddress', async (req, res) => {
  try {
    const tokenAddress = req.params.tokenAddress;
    console.log(`🔍 Manually adding missing graduate: ${tokenAddress}`);
    
    // Check if already exists
    const existing = graduatedTokens.find(g => g.mint === tokenAddress);
    if (existing) {
      return res.json({ status: 'already_exists', token: tokenAddress });
    }
    
    // Create basic graduate data (we'll get details from Dexscreener)
    const graduateData = {
      mint: tokenAddress,
      name: null,
      symbol: null,
      graduatedAt: new Date().toISOString(),
      liquidityUsd: null,
      priceUsd: null,
      timestamp: moment().tz('Australia/Brisbane').format(),
      pumpfunUrl: `https://pump.fun/${tokenAddress}`,
      dexscreenerUrl: null,
      graduationPairAddress: null,
      graduationDex: null,
      volume24h: null,
      volume1h: null,
      txns24h: null,
      txns1h: null,
      priceChange24h: null,
      priceChange1h: null,
      marketCap: null,
      fdv: null,
      priceUsdCurrent: null
    };
    
    // Add to cache
    graduatedTokens.unshift(graduateData);
    if (graduatedTokens.length > 100) {
      graduatedTokens.splice(100);
    }
    
    // Broadcast to SSE clients
    broadcastToMoralisSSE(graduateData);
    
    // Fetch Dexscreener data
    fetchDexscreenerData(tokenAddress).then(dexData => {
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
        broadcastToMoralisSSE(graduateData);
      }
    });
    
    res.json({ status: 'added', token: tokenAddress, data: graduateData });
    
  } catch (error) {
    console.error('Failed to add missing graduate:', error.message);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Refresh trading data endpoint (free Dexscreener API only)
app.post('/api/refresh-trading-data', async (req, res) => {
  try {
    console.log('🔄 Manual trading data refresh requested');
    res.json({ 
      status: 'initiated', 
      message: 'Trading data refresh started',
      tokensToUpdate: graduatedTokens.length
    });

    // Refresh Dexscreener data for all graduates
    graduatedTokens.forEach(async (graduateData, index) => {
      // Add small delay to avoid rate limiting
      setTimeout(async () => {
        try {
          const dexData = await fetchDexscreenerData(graduateData.mint);
          if (dexData) {
            // Update trading data
            graduateData.volume24h = dexData.volume24h;
            graduateData.volume1h = dexData.volume1h;
            graduateData.txns24h = dexData.txns24h;
            graduateData.txns1h = dexData.txns1h;
            graduateData.priceChange24h = dexData.priceChange24h;
            graduateData.priceChange1h = dexData.priceChange1h;
            graduateData.marketCap = dexData.marketCap;
            graduateData.fdv = dexData.fdv;
            graduateData.priceUsdCurrent = dexData.priceUsdCurrent;
            
            // Re-broadcast updated data
            broadcastToMoralisSSE(graduateData);
          }
        } catch (error) {
          console.log(`Failed to refresh trading data for ${graduateData.mint}:`, error.message);
        }
      }, index * 150); // 150ms delay between each request (slightly faster than initial load)
    });
    
  } catch (error) {
    console.error('Failed to initiate trading data refresh:', error.message);
    res.status(500).json({ 
      status: 'error', 
      error: 'Failed to initiate refresh',
      details: error.message 
    });
  }
});

// PumpPortal health endpoint
app.get('/moralis/health', (req, res) => {
  res.json({
    ok: true,
    connected: pumpPortalConnected,
    lastConnectTime: pumpPortalLastConnectTime,
    reconnectAttempts: pumpPortalReconnectAttempts,
    itemsCached: graduatedTokens.length
  });
});

// Test Telegram notification endpoint
app.post('/api/test-telegram', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Telegram not configured. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env file.' 
      });
    }

    // Create test graduate data
    const testGraduateData = {
      mint: 'TestToken123ABCxyz456789TestPumpToken',
      name: 'Test Token',
      symbol: 'TEST',
      graduatedAt: new Date().toISOString(),
      liquidityUsd: 75000,
      priceUsd: 0.000123,
      timestamp: moment().tz('Australia/Brisbane').format(),
      pumpfunUrl: `https://pump.fun/TestToken123ABCxyz456789TestPumpToken`,
      dexscreenerUrl: 'https://dexscreener.com/solana/test',
      graduationPairAddress: 'TestPairAddress123',
      graduationDex: 'pump-amm',
      volume24h: 12500,
      volume1h: 1200,
      txns24h: { buys: 145, sells: 98 },
      txns1h: { buys: 15, sells: 8 },
      priceChange24h: 23.45,
      priceChange1h: 5.67,
      marketCap: 123456,
      fdv: 150000,
      priceUsdCurrent: 0.000123
    };

    // Send test notification
    await sendTelegramNotification(testGraduateData);
    
    res.json({ 
      status: 'success', 
      message: 'Test notification sent to Telegram!',
      chatId: TELEGRAM_CHAT_ID
    });
  } catch (error) {
    console.error('Failed to send test notification:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to send test notification: ' + error.message 
    });
  }
});

// Function to automatically refresh trading data for recent graduates
async function autoRefreshTradingData() {
  if (graduatedTokens.length === 0) {
    console.log('🔄 Auto-refresh: No graduates to refresh');
    return;
  }

  console.log(`🔄 Auto-refreshing trading data for ${graduatedTokens.length} graduates...`);
  
  // Refresh data for graduates from the last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentGraduates = graduatedTokens.filter(graduate => {
    const graduateTime = new Date(graduate.graduatedAt || graduate.timestamp);
    return graduateTime >= oneDayAgo;
  });

  console.log(`🎯 Found ${recentGraduates.length} recent graduates to refresh`);

  for (const graduate of recentGraduates) {
    try {
      const dexData = await fetchDexscreenerData(graduate.mint);
      if (dexData) {
        Object.assign(graduate, {
          volume24h: dexData.volume24h,
          volume1h: dexData.volume1h,
          txns24h: dexData.txns24h,
          txns1h: dexData.txns1h,
          priceChange24h: dexData.priceChange24h,
          priceChange1h: dexData.priceChange1h,
          marketCap: dexData.marketCap || graduate.marketCap,
          fdv: dexData.fdv,
          priceUsdCurrent: dexData.priceUsdCurrent || graduate.priceUsdCurrent
        });
        
        // Broadcast updated data to frontend
        broadcastToMoralisSSE(graduate);
      }
      
      // Small delay between requests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.log(`Failed to refresh data for ${graduate.mint}:`, error.message);
    }
  }
  
  console.log('✅ Auto-refresh completed');
}

// Start automatic refresh every 10 minutes
setInterval(autoRefreshTradingData, 10 * 60 * 1000); // 10 minutes

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Solana Pool Tracker running on http://localhost:${PORT}`);
  console.log(`📊 Monitoring ${Object.keys(PROGRAM_IDS).length} program IDs for pool creation`);
  console.log(`🕐 Timestamps in Australia/Brisbane timezone`);
  console.log(`🔄 Auto-refresh enabled: Trading data updates every 10 minutes`);
  
  // Start PumpPortal WebSocket connection
  console.log(`🎓 Starting PumpPortal pump.fun graduate tracking (FREE)`);
  connectToPumpPortal();
  
  // Run initial auto-refresh after 30 seconds
  setTimeout(() => {
    console.log('🚀 Running initial auto-refresh...');
    autoRefreshTradingData();
  }, 30000);
});

// Cleanup on exit
process.on('SIGINT', () => {
  if (pumpPortalWs && pumpPortalWs.readyState === WebSocket.OPEN) {
    console.log('🔌 Closing PumpPortal WebSocket...');
    pumpPortalWs.close();
  }
  process.exit();
});

module.exports = app;