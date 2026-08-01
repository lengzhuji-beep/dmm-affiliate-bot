const fs = require('fs');
const path = require('path');
const { fetchDmmProduct, downloadVideo } = require('./dmm_api');

const SCHEDULE_FILE = path.join(__dirname, 'post_schedule.json');
const PREPARED_DATA_FILE = path.join(__dirname, 'prepared_post.json');

function checkScheduleAndMaybeExit() {
    console.log('Checking schedule...');
    if (process.env.FORCE_RUN === 'true') {
        console.log('Force run active (manual execution). Bypassing interval wait.');
        return true;
    }

    if (!fs.existsSync(SCHEDULE_FILE)) {
        console.log('No schedule file found. First execution. Will proceed.');
        return true;
    }

    try {
        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        if (!schedule.lastPostTime || !schedule.nextIntervalMinutes) {
            console.log('Schedule file is invalid. Will proceed.');
            return true;
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
        return true;
    } catch (e) {
        console.error('Error parsing schedule file. Proceeding anyway:', e);
        return true;
    }
}

async function prepare() {
    checkScheduleAndMaybeExit();

    console.log('--- Step 1: Pre-downloading Video & Fetching Product Info (Before VPN) ---');
    try {
        console.log('Fetching product from DMM API...');
        const productInfo = await fetchDmmProduct();

        console.log('Title:', productInfo.title);
        console.log('Affiliate URL:', productInfo.affiliateUrl);
        console.log('Sample Video URL:', productInfo.sampleVideoUrl);

        let videoPath = null;
        if (productInfo.sampleVideoUrl) {
            console.log('Pre-downloading sample video on high-speed connection...');
            videoPath = await downloadVideo(productInfo.sampleVideoUrl);
            console.log(`Video downloaded successfully to: ${videoPath}`);
        } else {
            console.log('No video URL found.');
        }

        // 投稿用のテキストを組み立てる
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

        const preparedData = {
            productInfo,
            videoPath,
            mainText,
            replyText,
            preparedAt: new Date().toISOString()
        };

        fs.writeFileSync(PREPARED_DATA_FILE, JSON.stringify(preparedData, null, 2), 'utf8');
        console.log('--- Pre-download Complete & Post Data Prepared Successfully ---');

    } catch (error) {
        console.error('Failed to prepare video & product info before VPN:', error.message);
        process.exit(1);
    }
}

prepare();
