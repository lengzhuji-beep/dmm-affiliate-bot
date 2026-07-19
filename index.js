const { fetchDmmProduct, downloadVideo, cleanupVideo } = require('./dmm_api');
const { postToTwitter } = require('./twitter_bot');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30000; // 30秒

async function main() {
    console.log('--- Start DMM Affiliate to Twitter Bot ---');
    let videoPath = null;

    try {
        // 1. DMMから商品情報を取得
        console.log('Fetching product from DMM API...');
        const productInfo = await fetchDmmProduct(); 
        
        console.log('Title:', productInfo.title);
        console.log('Affiliate URL:', productInfo.affiliateUrl);
        console.log('Sample Video URL:', productInfo.sampleVideoUrl);

        // 2. 動画のダウンロード
        if (productInfo.sampleVideoUrl) {
            console.log('Downloading sample video...');
            videoPath = await downloadVideo(productInfo.sampleVideoUrl);
            console.log(`Video downloaded to: ${videoPath}`);
        } else {
            console.log('No video URL found. Will post text only.');
        }

        // 3. Twitter投稿用のテキストを組み立てる（文字数制限を厳密に管理）
        const description = productInfo.text || '';
        const tagsRaw = productInfo.tags || '';
        
        let summary = description;
        if (summary.length > 90) {
            summary = summary.substring(0, 87) + '...';
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

        // 4. PlaywrightでTwitter投稿（メイン + リプライ）
        console.log('Posting to Twitter (Main and Reply)...');
        await postToTwitter(mainText, replyText, videoPath);

        // 5. 投稿成功したらIDを記録する
        if (productInfo.contentId) {
            const fs = require('fs');
            const path = require('path');
            const postedIdsFile = path.join(__dirname, 'posted_ids.json');
            let postedIds = [];
            if (fs.existsSync(postedIdsFile)) {
                try {
                    postedIds = JSON.parse(fs.readFileSync(postedIdsFile, 'utf8'));
                } catch (e) {}
            }
            postedIds.push(productInfo.contentId);
            // 重複を排除して保存
            fs.writeFileSync(postedIdsFile, JSON.stringify([...new Set(postedIds)], null, 2));
            console.log(`Saved posted ID: ${productInfo.contentId}`);
        }

    } catch (error) {
        console.error('An error occurred during execution:', error);
        throw error; // リトライ判定のために再スロー
    } finally {
        if (videoPath) {
            console.log('Cleaning up temporary files...');
            cleanupVideo(videoPath);
        }
        console.log('--- Finished ---');
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
