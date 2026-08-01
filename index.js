const fs = require('fs');
const path = require('path');
const { fetchDmmProduct, downloadVideo, cleanupVideo } = require('./dmm_api');
const { postToTwitter } = require('./twitter_bot');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30000; // 30秒
const SCHEDULE_FILE = path.join(__dirname, 'post_schedule.json');

// 実行すべきか判定する関数
function checkScheduleAndMaybeExit() {
    console.log('Checking schedule...');
    if (process.env.FORCE_RUN === 'true') {
        console.log('Force run active (manual execution). Bypassing interval wait.');
        return;
    }

    if (!fs.existsSync(SCHEDULE_FILE)) {
        console.log('No schedule file found. First execution. Will proceed.');
        return; // 初回は実行
    }

    try {
        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        if (!schedule.lastPostTime || !schedule.nextIntervalMinutes) {
            console.log('Schedule file is invalid. Will proceed.');
            return;
        }

        const lastPost = new Date(schedule.lastPostTime);
        const nextInterval = schedule.nextIntervalMinutes;
        const now = new Date();

        const diffMinutes = Math.floor((now - lastPost) / (1000 * 60));
        console.log(`Last post: ${lastPost.toISOString()}`);
        console.log(`Time elapsed: ${diffMinutes} minutes. Required interval: ${nextInterval} minutes.`);

        if (diffMinutes < nextInterval) {
            console.log(`Not enough time has elapsed. Skipping execution.`);
            process.exit(0); // 正常終了（実行しない）
        }

        console.log(`Required interval of ${nextInterval} minutes has passed. Proceeding with execution.`);
    } catch (e) {
        console.error('Error parsing schedule file. Proceeding anyway:', e);
    }
}

// 次回スケジュールを更新して保存する関数
function updateSchedule() {
    // 1時間〜2時間の間（60分〜120分）のランダム値
    const nextInterval = Math.floor(Math.random() * (120 - 60 + 1)) + 60;
    const now = new Date();

    const schedule = {
        lastPostTime: now.toISOString(),
        nextIntervalMinutes: nextInterval
    };

    try {
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        console.log(`Schedule updated: Last post = ${schedule.lastPostTime}, Next interval = ${schedule.nextIntervalMinutes} mins`);
    } catch (e) {
        console.error('Failed to save schedule file:', e);
    }
}


async function main() {
    // スケジュール確認
    checkScheduleAndMaybeExit();

    console.log('--- Start DMM Affiliate to Twitter Bot (Japan VPN Active) ---');
    let videoPath = null;

    try {
        // 1. 日本VPN経由でDMMから商品情報を取得
        console.log('Fetching product from DMM API...');
        const productInfo = await fetchDmmProduct(); 
        
        console.log('Title:', productInfo.title);
        console.log('Affiliate URL:', productInfo.affiliateUrl);
        console.log('Sample Video URL:', productInfo.sampleVideoUrl);

        // 2. 日本VPN経由で動画をダウンロード
        if (productInfo.sampleVideoUrl) {
            console.log('Downloading sample video under Japan VPN...');
            videoPath = await downloadVideo(productInfo.sampleVideoUrl);
            console.log(`Video downloaded successfully to: ${videoPath}`);
        } else {
            console.log('No video URL found. Will post text only.');
        }

        // 3. Twitter投稿用のテキストを組み立てる（タイトル最優先）
        const title = productInfo.title || '';
        const description = productInfo.text || '';
        const tagsRaw = productInfo.tags || '';
        
        let summary = title;
        if (description && description.trim() !== '' && description !== title) {
            summary = `${title}\n${description}`;
        }
        
        if (summary.length > 95) {
            summary = summary.substring(0, 92) + '...';
        }
        
        const tagArray = tagsRaw.split(' ').filter(t => t.startsWith('#'));
        let finalTags = '';
        const MAX_TOTAL_CHARS = 135;

        for (let tag of tagArray) {
            if ((summary.length + finalTags.length + tag.length + 2) > MAX_TOTAL_CHARS) break;
            finalTags += (finalTags ? ' ' : '\n\n') + tag;
        }

        const mainText = `${summary}${finalTags}`.trim();
        const replyText = `👇詳細・続きはこちら\n${productInfo.affiliateUrl}`;

        // 4. Twitterへの投稿実行 (メイン投稿 & リプライ投稿)
        console.log('Posting to Twitter (Main and Reply)...');
        await postToTwitter(mainText, replyText, videoPath);

        // 5. 成功時の処理：次回スケジュール設定と記録更新
        updateSchedule();
        if (productInfo.contentId) {
            const { markAsPosted } = require('./dmm_api');
            markAsPosted(productInfo.contentId);
        }

        console.log('--- Post Sequence Successfully Completed ---');

    } catch (error) {
        console.error('An error occurred during execution:', error.message || error);
        throw error;
    } finally {
        if (videoPath) {
            cleanupVideo(videoPath);
        }
    }
}

// リトライ付き実行
async function runWithRetry() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await main();
            return; // 成功したら終了
        } catch (error) {
            const isNetworkError = error.message && (
                error.message.includes('ENOTFOUND') ||
                error.message.includes('ETIMEDOUT') ||
                error.message.includes('ECONNREFUSED') ||
                error.message.includes('ECONNRESET') ||
                error.message.includes('network')
            );
            
            if (isNetworkError && attempt < MAX_RETRIES) {
                console.log(`\n[Retry ${attempt}/${MAX_RETRIES}] Network error detected. Retrying in ${RETRY_DELAY_MS/1000}s...`);
                await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            } else {
                console.error(`[Final] Failed after ${attempt} attempt(s).`);
                process.exit(1);
            }
        }
    }
}

runWithRetry();
