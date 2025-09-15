#!/bin/bash

# 24/7 Monitoring Script for Solana Pool Tracker
# This script pings the heartbeat endpoint every 2 minutes to keep the Durable Object active

HEARTBEAT_URL="https://solana-worker.arkitekjunk.workers.dev/pumpportal/heartbeat"
LOG_FILE="/tmp/solana-tracker-monitor.log"

echo "🚀 Starting 24/7 monitoring for Solana Pool Tracker..." | tee -a "$LOG_FILE"
echo "📍 Heartbeat URL: $HEARTBEAT_URL" | tee -a "$LOG_FILE"
echo "📝 Log file: $LOG_FILE" | tee -a "$LOG_FILE"
echo "⏰ Ping interval: 2 minutes" | tee -a "$LOG_FILE"
echo "================================" | tee -a "$LOG_FILE"

while true; do
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Send heartbeat request
    response=$(curl -s "$HEARTBEAT_URL" 2>&1)
    curl_exit_code=$?
    
    if [ $curl_exit_code -eq 0 ]; then
        # Parse the JSON response to check connection status
        connected=$(echo "$response" | grep -o '"connected":[^,]*' | cut -d':' -f2)
        graduates=$(echo "$response" | grep -o '"graduates":[^,]*' | cut -d':' -f2)
        
        if [ "$connected" = "true" ]; then
            echo "[$timestamp] ✅ HEALTHY - Connected: $connected, Graduates: $graduates" | tee -a "$LOG_FILE"
        else
            echo "[$timestamp] ⚠️  WARNING - Connection lost, attempting auto-reconnect..." | tee -a "$LOG_FILE"
            echo "[$timestamp] Response: $response" | tee -a "$LOG_FILE"
        fi
    else
        echo "[$timestamp] ❌ ERROR - Heartbeat failed (curl exit code: $curl_exit_code)" | tee -a "$LOG_FILE"
        echo "[$timestamp] Error details: $response" | tee -a "$LOG_FILE"
    fi
    
    # Wait 2 minutes before next ping
    sleep 120
done