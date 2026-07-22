#!/bin/bash

# 最大リトライ回数
MAX_RETRIES=5
RETRY_COUNT=0

# VPN一時保存用の設定ファイル名
OVPN_FILE="vpn.ovpn"

cleanup_vpn() {
  echo "Stopping OpenVPN..."
  sudo killall openvpn 2>/dev/null || true
  rm -f "$OVPN_FILE"
}

# スクリプトが途中でエラー終了した時のクリーンアップ
trap cleanup_vpn ERR EXIT

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  echo "========================================="
  echo "Attempting to connect to VPN (Try $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
  echo "========================================="

  # 既存 of OpenVPNプロセスがあれば終了
  sudo killall openvpn 2>/dev/null || true
  sleep 1

  # VPN Gateから設定ファイルを取得 (引数にインデックスを渡す)
  node vpn_connect.js "$RETRY_COUNT"
  if [ $? -ne 0 ]; then
    echo "Failed to get VPN config. Retrying next server..."
    RETRY_COUNT=$((RETRY_COUNT + 1))
    continue
  fi

  if [ ! -f "$OVPN_FILE" ]; then
    echo "VPN config file not found. Retrying next server..."
    RETRY_COUNT=$((RETRY_COUNT + 1))
    continue
  fi

  # OpenVPNをバックグラウンドで開始 (MTU/MSS問題を避けるため --mssfix 1400 を指定)
  echo "Starting OpenVPN daemon..."
  sudo openvpn --config "$OVPN_FILE" --mssfix 1400 --daemon vpn_process

  # 接続確認ループ (最大30秒)
  CONNECTED=false
  for i in {1..10}; do
    echo "Checking connection status (Attempt $i/10)..."
    sleep 3

    # 現在のグローバルIPと国コードを取得 (ipinfo.ioはレートリミットが厳しいため、db-ipとipapi.coをフォールバックとして使用)
    CURRENT_COUNTRY=$(curl -s --connect-timeout 5 https://api.db-ip.com/v2/free/self/countryCode | tr -d '\r\n')
    if [ -z "$CURRENT_COUNTRY" ] || [ ${#CURRENT_COUNTRY} -gt 2 ]; then
      CURRENT_COUNTRY=$(curl -s --connect-timeout 5 https://ipapi.co/country/ | tr -d '\r\n')
    fi
    
    CURRENT_IP=$(curl -s --connect-timeout 5 https://ifconfig.me/ | tr -d '\r\n')

    echo "Current IP: $CURRENT_IP, Country: $CURRENT_COUNTRY"

    if [ "$CURRENT_COUNTRY" = "JP" ]; then
      echo "Successfully connected to Japan VPN!"
      CONNECTED=true
      break
    fi
  done

  if [ "$CONNECTED" = true ]; then
    echo "VPN connection established. Ready to run bot."
    
    # 実行するスクリプトを引数から取得 (デフォルト: index.js)
    BOT_SCRIPT="${1:-index.js}"

    # ボットの実行
    echo "========================================="
    echo "Running Bot Script: node $BOT_SCRIPT"
    echo "========================================="
    node "$BOT_SCRIPT"
    BOT_EXIT_CODE=$?
    
    if [ $BOT_EXIT_CODE -eq 0 ]; then
      echo "Bot script completed successfully!"
      exit 0
    else
      echo "Bot script failed with exit code $BOT_EXIT_CODE."
      echo "Cleaning up current VPN and trying another server..."
      cleanup_vpn
      RETRY_COUNT=$((RETRY_COUNT + 1))
    fi
  else
    echo "Connection timeout or failed. Trying next server..."
    cleanup_vpn
    RETRY_COUNT=$((RETRY_COUNT + 1))
  fi
done

echo "Error: Could not complete bot execution after $MAX_RETRIES attempts."
exit 1
