/**
 * 定期実行スケジューラー
 * 指定した間隔（デフォルト: 2時間）ごとにDMMアフィリエイトボットを実行する
 */
const { execFile } = require('child_process');
const path = require('path');

// 実行間隔（ミリ秒）: デフォルト2時間
const INTERVAL_HOURS = parseFloat(process.env.POST_INTERVAL_HOURS || '2');
const INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1000;

// 初回遅延（秒）: サーバー起動直後に少し待つ
const INITIAL_DELAY_SEC = parseFloat(process.env.INITIAL_DELAY_SEC || '10');

function runBot() {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    console.log(`\n[${now}] === Bot execution started ===`);

    const child = execFile('node', ['index.js'], {
        cwd: __dirname,
        env: { ...process.env },
        timeout: 5 * 60 * 1000 // 最大5分でタイムアウト
    }, (error, stdout, stderr) => {
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        if (error) {
            console.error(`[ERROR] Bot execution failed:`, error.message);
        }
        const nextRun = new Date(Date.now() + INTERVAL_MS).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        console.log(`[INFO] Next run scheduled at: ${nextRun}`);
    });
}

// 起動メッセージ
console.log('========================================');
console.log(' DMM Affiliate Twitter Bot - Scheduler');
console.log('========================================');
console.log(`Interval: ${INTERVAL_HOURS} hours`);
console.log(`Initial delay: ${INITIAL_DELAY_SEC} seconds`);
console.log(`Started at: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
console.log('========================================');

// 初回実行（少し待ってから）
setTimeout(() => {
    runBot();
    // 以降は定期実行
    setInterval(runBot, INTERVAL_MS);
}, INITIAL_DELAY_SEC * 1000);
