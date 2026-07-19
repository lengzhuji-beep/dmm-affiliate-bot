const fs = require('fs');
const https = require('https');
const path = require('path');

const API_URL = 'https://www.vpngate.net/api/iphone/';
const OUTPUT_FILE = path.join(__dirname, 'vpn.ovpn');

// コマンドライン引数から何番目のサーバーを使用するか取得 (デフォルト: 0番目＝最もスコアが高いサーバー)
const serverIndex = parseInt(process.argv[2] || '0', 10);

console.log(`Fetching VPN list from VPN Gate... (Using server index: ${serverIndex})`);

https.get(API_URL, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const lines = data.split(/\r?\n/);
      let headerLineIndex = -1;

      // ヘッダー行を見つける
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#HostName')) {
          headerLineIndex = i;
          break;
        }
      }

      if (headerLineIndex === -1) {
        console.error('Failed to parse VPN Gate API response: Header not found.');
        process.exit(1);
      }

      const headers = lines[headerLineIndex].substring(1).split(',');
      const ipIndex = headers.indexOf('IP');
      const scoreIndex = headers.indexOf('Score');
      const countryShortIndex = headers.indexOf('CountryShort');
      const configIndex = headers.indexOf('OpenVPN_ConfigData_Base64');

      const servers = [];

      for (let i = headerLineIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('*')) {
          continue; // 空行や終端のメタデータを除外
        }

        const cols = line.split(',');
        if (cols.length < headers.length) {
          continue;
        }

        const country = cols[countryShortIndex];
        // 日本のサーバーのみ抽出
        if (country === 'JP') {
          servers.push({
            ip: cols[ipIndex],
            score: parseInt(cols[scoreIndex] || '0', 10),
            configBase64: cols[configIndex]
          });
        }
      }

      if (servers.length === 0) {
        console.error('No Japanese VPN servers found.');
        process.exit(1);
      }

      // スコア順（降順）にソート
      servers.sort((a, b) => b.score - a.score);

      if (serverIndex >= servers.length) {
        console.error(`Requested server index ${serverIndex} is out of bounds (Total JP servers: ${servers.length}).`);
        process.exit(1);
      }

      const targetServer = servers[serverIndex];
      console.log(`Selected VPN Server IP: ${targetServer.ip} (Score: ${targetServer.score})`);

      // Base64デコードして.ovpnファイルを出力
      const ovpnConfig = Buffer.from(targetServer.configBase64, 'base64').toString('utf8');
      fs.writeFileSync(OUTPUT_FILE, ovpnConfig, 'utf8');

      console.log(`Saved OpenVPN config to ${OUTPUT_FILE}`);
      process.exit(0);

    } catch (err) {
      console.error('Error parsing VPN data:', err);
      process.exit(1);
    }
  });
}).on('error', (err) => {
  console.error('Failed to fetch VPN list:', err);
  process.exit(1);
});
