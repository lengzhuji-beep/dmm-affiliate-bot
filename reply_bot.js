require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Playwright-extraにstealthプラグインを登録
chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';
const SCHEDULE_FILE = path.join(__dirname, 'post_schedule.json');

// 日本時間 (JST) の現在時刻を取得するヘルパー
function getJstDate() {
    const now = new Date();
    // UTCから日本時間(+9時間)に変換
    return new Date(now.getTime() + (9 * 60 * 60 * 1000));
}

// スケジュールと制限のチェック
function checkReplyScheduleAndMaybeExit() {
    console.log('Checking reply schedule...');
    if (!fs.existsSync(SCHEDULE_FILE)) {
        console.log('Schedule file not found. Skipping reply.');
        process.exit(0);
    }

    try {
        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        if (!schedule.reply) {
            console.log('No reply schedule config. Initializing...');
            schedule.reply = {
                lastReplyTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            };
        }

        const jstNow = getJstDate();
        const jstTodayStr = jstNow.toISOString().split('T')[0]; // "YYYY-MM-DD"
        const currentHour = jstNow.getUTCHours(); // getJstDate()で+9時間しているので、この時間の時間部分はJSTの時

        console.log(`Current JST Time: ${jstNow.toISOString()}, Hour: ${currentHour}`);

        // 1. 時間帯制限 (日本時間 7:00 〜 23:00)
        if (currentHour < 7 || currentHour >= 23) {
            console.log('Outside active hours (7:00 - 23:00 JST). Skipping reply.');
            process.exit(0);
        }

        // 2. 日付変更時にカウントをリセット
        if (schedule.reply.lastResetDate !== jstTodayStr) {
            console.log(`New day detected (${jstTodayStr}). Resetting reply count to 0.`);
            schedule.reply.todayCount = 0;
            schedule.reply.lastResetDate = jstTodayStr;
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        }

        // 3. 1日の上限回数制限 (最大3回)
        if (schedule.reply.todayCount >= 3) {
            console.log(`Reply limit reached for today (${schedule.reply.todayCount}/3). Skipping.`);
            process.exit(0);
        }

        // 4. 前回の送信からのインターバル制限 (最低180分 = 3時間)
        const lastReply = new Date(schedule.reply.lastReplyTime);
        const diffMinutes = Math.floor((new Date() - lastReply) / (1000 * 60));
        const REQUIRED_INTERVAL = 180;

        console.log(`Last reply: ${lastReply.toISOString()}`);
        console.log(`Minutes elapsed since last reply: ${diffMinutes} mins (Required: ${REQUIRED_INTERVAL} mins).`);
        console.log(`Replies sent today: ${schedule.reply.todayCount}/3`);

        if (diffMinutes < REQUIRED_INTERVAL) {
            console.log(`Not enough time has elapsed since last reply. Skipping.`);
            process.exit(0);
        }

        console.log('Reply schedule check passed. Proceeding with reply bot...');
        return schedule;

    } catch (e) {
        console.error('Error checking reply schedule:', e);
        process.exit(1);
    }
}

// 送信成功時のスケジュール更新
function updateReplySchedule(schedule) {
    try {
        const now = new Date();
        schedule.reply.lastReplyTime = now.toISOString();
        schedule.reply.todayCount += 1;
        
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        console.log(`Reply schedule updated. Count: ${schedule.reply.todayCount}/3, Time: ${schedule.reply.lastReplyTime}`);
    } catch (e) {
        console.error('Failed to update reply schedule:', e);
    }
}

// Gemini APIを利用して返信文を生成する
async function generateReplyText(targetTweetText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set in environment variables');
    }

    console.log('Calling Gemini API to generate reply...');
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const prompt = `あなたは親しみやすく、共感力の高いユーザーです。以下のツイートに対して、自然で好意的な返信（リプライ）を1つ作成してください。

【対象のツイート】
"""
${targetTweetText}
"""

【制約事項】
- 日本語で作成してください。
- 100文字以内で簡潔に作成してください。
- 絵文字や感嘆符（！や？）を使っても構いませんが、スパムに見えないように最大1〜2個程度に抑えてください。
- アダルト系の単語や宣伝・アフィリエイト文句はリプライ欄では絶対に使用せず、あくまで普通の一般ユーザーが好意的な感想を送っているように見せてください。
- 返信文のみを出力してください（余計な挨拶や解説、クォーテーションは不要です）。`;

    const postData = JSON.stringify({
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    });

    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.candidates || json.candidates.length === 0) {
                        reject(new Error(`No candidates in Gemini response: ${data}`));
                        return;
                    }
                    const replyText = json.candidates[0].content.parts[0].text.trim();
                    resolve(replyText);
                } catch (e) {
                    reject(new Error(`Failed to parse Gemini API response: ${e.message}. Raw data: ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// X上のオーバーレイを閉じるヘルパー
async function dismissOverlays(page) {
    try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    } catch (e) {}
}

// メイン処理
async function main() {
    const scheduleData = checkReplyScheduleAndMaybeExit();

    console.log('Launching browser for reply bot...');
    const isHeadless = process.env.HEADLESS === 'true';
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: isHeadless,
        viewport: { width: 1280, height: 720 },
        args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [],
    });

    const page = await context.newPage();

    try {
        // Cookieの復元
        if (isHeadless) {
            const cookiePath = path.join(__dirname, 'twitter_cookies.json');
            if (fs.existsSync(cookiePath)) {
                const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
                const expandedCookies = [];
                for (const cookie of cookies) {
                    expandedCookies.push(cookie);
                    if (cookie.domain && cookie.domain.includes('twitter.com')) {
                        expandedCookies.push({ ...cookie, domain: cookie.domain.replace('twitter.com', 'x.com') });
                    } else if (cookie.domain && cookie.domain.includes('x.com')) {
                        expandedCookies.push({ ...cookie, domain: cookie.domain.replace('x.com', 'twitter.com') });
                    }
                }
                await context.addCookies(expandedCookies);
                console.log(`Loaded ${expandedCookies.length} cookies`);
            }
        }

        // 検索クエリでバズツイートを取得
        // アダルトアカウントと親和性の高い「グラビア」や「コスプレ」タグで、いいねが300以上のツイートを検索
        const searchUrl = 'https://x.com/search?q=%23%E3%82%B0%E3%83%A9%E3%83%93%E3%82%A2%20min_faves%3A300&f=live';
        console.log(`Navigating to search page: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(10000);
        await dismissOverlays(page);

        // 最初のツイート要素の探索
        console.log('Finding target tweet...');
        const tweetSelector = '[data-testid="tweet"]';
        await page.waitForSelector(tweetSelector, { timeout: 15000 });
        
        const tweets = page.locator(tweetSelector);
        const count = await tweets.count();
        if (count === 0) {
            throw new Error('No tweets found on search page.');
        }

        // 一番上のツイートの情報を取得
        const firstTweet = tweets.first();
        
        // ツイート詳細へのリンク（status URL）の取得
        const linkElement = firstTweet.locator('a[href*="/status/"]').first();
        const tweetHref = await linkElement.getAttribute('href');
        if (!tweetHref) {
            throw new Error('Could not find status URL for target tweet.');
        }
        
        const targetTweetUrl = `https://x.com${tweetHref}`;
        console.log(`Target tweet URL: ${targetTweetUrl}`);

        // ツイート本文の取得
        const textElement = firstTweet.locator('[data-testid="tweetText"]').first();
        const targetText = await textElement.innerText().catch(() => '');
        console.log(`Target tweet text preview: "${targetText.substring(0, 50)}..."`);

        if (!targetText) {
            throw new Error('Target tweet text is empty, cannot generate reply.');
        }

        // Geminiでリプライテキストを生成
        const replyText = await generateReplyText(targetText);
        console.log(`Generated reply: "${replyText}"`);

        // 対象のツイート個別ページへ直接移動
        console.log(`Navigating directly to tweet page...`);
        await page.goto(targetTweetUrl, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(7000);
        await dismissOverlays(page);

        // リプライボタンをクリック
        console.log('Clicking reply button...');
        await page.waitForSelector('[data-testid="reply"]', { timeout: 15000 });
        await page.locator('[data-testid="reply"]').first().click();
        
        // 入力エリアを待機
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'visible', timeout: 15000 });
        await page.waitForTimeout(2000);

        // 人間らしい遅延（ランダムなタイピングディレイ）を入れて入力
        console.log('Typing reply with human delay...');
        const textarea = page.locator('[data-testid="tweetTextarea_0"]').first();
        await textarea.click({ force: true });
        await page.waitForTimeout(1000);
        
        // 1文字ずつランダムなディレイを入れてタイピング
        for (const char of replyText) {
            await page.keyboard.type(char);
            // 50ms 〜 150ms のランダムな待機
            const delay = Math.floor(Math.random() * (150 - 50 + 1)) + 50;
            await page.waitForTimeout(delay);
        }
        await page.waitForTimeout(2000);

        // リプライ送信ボタンをクリック (オーバーレイをバイパスするためJSクリック)
        console.log('Submitting reply...');
        await page.evaluate(() => {
            const btn = document.querySelector('[data-testid="tweetButton"]')
                     || document.querySelector('[data-testid="tweetButtonInline"]');
            if (btn) btn.click();
        });

        console.log('Waiting for post success...');
        await page.waitForTimeout(5000);

        // 成功を記録
        console.log('Reply post sequence completed successfully!');
        updateReplySchedule(scheduleData);

    } catch (error) {
        console.error('Error in reply bot execution:', error);
        throw error;
    } finally {
        await page.waitForTimeout(2000);
        await context.close();
    }
}

main().catch(err => {
    console.error('Fatal error in reply bot:', err);
    process.exit(1);
});
