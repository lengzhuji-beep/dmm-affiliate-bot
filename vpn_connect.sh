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

  # 既存のOpenVPNプロセスがあれば終了
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

  # OpenVPNをバックグラウンドで開始
  echo "Starting OpenVPN daemon..."
  sudo openvpn --config "$OVPN_FILE" --daemon vpn_process

  # 接続確認ループ (最大30秒)
  CONNECTED=false
  for i in {1..10}; do
    echo "Checking connection status (Attempt $i/10)..."
    sleep 3

    # 現在のグローバルIPと国コードを取得
    CURRENT_COUNTRY=$(curl -s --connect-timeout 5 https://ipinfo.io/country | tr -d '\r\n')
    CURRENT_IP=$(curl -s --connect-timeout 5 https://ipinfo.io/ip | tr -d '\r\n')

    echo "Current IP: $CURRENT_IP, Country: $CURRENT_COUNTRY"

    if [ "$CURRENT_COUNTRY" = "JP" ]; then
      echo "Successfully connected to Japan VPN!"
      CONNECTED=true
      break
    fi
  done

  if [ "$CONNECTED" = true ]; then
    echo "VPN connection established. Ready to run bot."
    
    # ボットの実行
    echo "========================================="
    echo "Running Bot Script..."
    echo "========================================="
    node index.js
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
