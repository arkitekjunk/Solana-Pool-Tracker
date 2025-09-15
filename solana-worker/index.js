// Cloudflare Worker for Solana Pool Tracker with Durable Objects
import { PumpPortalTracker } from './pumpportal-do.js';

// CORS headers for all responses
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cross-Origin-Embedder-Policy': 'unsafe-none',
};

export { PumpPortalTracker };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Get Durable Object instance
    const durableObjectId = env.PUMPPORTAL_TRACKER.idFromName('singleton');
    const durableObject = env.PUMPPORTAL_TRACKER.get(durableObjectId);

    // Route handling
    if (url.pathname === '/api/test-telegram') {
      return handleTestTelegram(request, env);
    }
    
    if (url.pathname === '/pumpportal/events') {
      // Forward to Durable Object for SSE handling
      return durableObject.fetch(new Request(request.url.replace(url.pathname, '/subscribe'), request));
    }
    
    if (url.pathname === '/pumpportal/health') {
      return durableObject.fetch(new Request(request.url.replace(url.pathname, '/status'), request));
    }
    
    if (url.pathname === '/pumpportal/connect') {
      return durableObject.fetch(new Request(request.url.replace(url.pathname, '/connect'), request));
    }
    
    if (url.pathname === '/pumpportal/update-graduates' && request.method === 'POST') {
      return durableObject.fetch(new Request(request.url.replace(url.pathname, '/update-graduates'), request));
    }
    
    if (url.pathname === '/pumpportal/heartbeat') {
      return durableObject.fetch(new Request(request.url.replace(url.pathname, '/heartbeat'), request));
    }

    // Default response
    return new Response('Solana Pool Tracker Worker with Durable Objects', { 
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
    });
  },

  // Cron trigger handler - runs every 2 minutes to keep Durable Object alive
  async scheduled(event, env, ctx) {
    console.log('⏰ Cron trigger fired to keep system alive');
    
    try {
      // Get Durable Object instance and ping heartbeat
      const durableObjectId = env.PUMPPORTAL_TRACKER.idFromName('singleton');
      const durableObject = env.PUMPPORTAL_TRACKER.get(durableObjectId);
      
      // Send heartbeat request to keep DO alive and check/restore connection
      const heartbeatRequest = new Request('https://dummy.url/heartbeat');
      const response = await durableObject.fetch(heartbeatRequest);
      const status = await response.json();
      
      console.log('💓 Cron heartbeat result:', {
        connected: status.connected,
        graduates: status.graduates,
        reconnected: status.reconnected || false,
        timestamp: status.timestamp
      });
      
      if (status.reconnected) {
        console.log('🔄 Cron trigger successfully reconnected WebSocket');
      }
      
    } catch (error) {
      console.error('❌ Cron trigger heartbeat failed:', error);
    }
  }
};

// Test Telegram notification
async function handleTestTelegram(request, env) {
  const testMessage = `>� *TEST NOTIFICATION*

� Solana Pool Tracker is working!
=P Time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}
< Source: Cloudflare Worker

This is a test message to verify your Telegram bot setup.`;

  const success = await sendTelegramMessage(testMessage, env);
  
  return new Response(JSON.stringify({ 
    success,
    message: success ? 'Test notification sent!' : 'Failed to send notification'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Server-Sent Events for real-time updates
async function handleSSE(request, env) {
  // Simple SSE response that works in Cloudflare Workers
  const sseData = `data: ${JSON.stringify({
    type: 'graduates',
    data: graduatedTokens.slice(0, 20)
  })}\n\n`;
  
  return new Response(sseData, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
  });
}

// Health check
async function handleHealth(request, env) {
  return new Response(JSON.stringify({
    status: 'healthy',
    graduates: graduatedTokens.length,
    pumpPortalConnected,
    timestamp: new Date().toISOString()
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Send Telegram notification
async function sendTelegramMessage(message, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('Telegram credentials not configured');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });

    const result = await response.json();
    return result.ok;
  } catch (error) {
    console.error('Telegram error:', error);
    return false;
  }
}

// WebSocket connection to PumpPortal (simplified for now)
async function connectToPumpPortal(env) {
  // Note: WebSocket connections in Workers need special handling
  // This is a placeholder - we'll implement the full PumpPortal integration next
  console.log('PumpPortal connection placeholder');
}