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

// ブラウザ操作でWeb版Gemini (またはWeb AI) から返信文を生成する (API制限を完全回避)
async function generateReplyViaBrowser(page, targetTweetText) {
    console.log('Navigating to Web Gemini (https://gemini.google.com/)...');
    
    // 新しいタブを開いてWeb版Geminiにアクセス
    const geminiPage = await page.context().newPage();
    
    try {
        await geminiPage.goto('https://gemini.google.com/', { waitUntil: 'commit', timeout: 60000 });
        await geminiPage.waitForTimeout(4000);

        const prompt = `あなたはTwitterで日常を楽しむフレンドリーで親しみやすい一般ユーザーです。以下のツイートに対して、好意的で柔らかいトーンの感想リプライ（1つのみ）を作成してください。

【対象ツイート】
${targetTweetText}

【ルール・雰囲気】
- 親しみやすく柔らかい口調（例: 「めちゃくちゃ素敵ですね✨」「すごく綺麗で見入っちゃいました😊」「応援してます！」など）
- 固いビジネス調や問合せ風の挨拶（「何かお手伝いできることはありますか」等）は絶対に禁止。
- 100文字以内で簡潔に。絵文字を1〜2個添えて自然に。
- アダルト表現や宣伝・営業文句は含めず、純粋なファンのような褒め言葉・共感のコメントにする。
- 返信文のみを出力。`;

        // 入力エリアを特定してプロンプトを入力
        console.log('Finding prompt input area on Web Gemini...');
        const inputSelectors = [
            'div[contenteditable="true"]',
            'textarea',
            '.aria-textarea',
            'p.is-placeholder'
        ];
        
        let inputFound = false;
        for (const selector of inputSelectors) {
            try {
                const el = geminiPage.locator(selector).first();
                if (await el.isVisible({ timeout: 3000 })) {
                    await el.click();
                    await geminiPage.waitForTimeout(500);
                    await geminiPage.keyboard.type(prompt, { delay: 10 });
                    inputFound = true;
                    console.log(`Successfully typed prompt into selector: ${selector}`);
                    break;
                }
            } catch (e) {}
        }

        if (!inputFound) {
            console.log('Fallback: clicking center of the page and typing prompt...');
            await geminiPage.mouse.click(600, 500);
            await geminiPage.keyboard.type(prompt, { delay: 10 });
        }

        await geminiPage.waitForTimeout(1000);

        // 送信ボタンのクリック、またはEnterキー押下
        console.log('Submitting prompt to Gemini...');
        const sendBtn = geminiPage.locator('button[aria-label*="送信"], button[aria-label*="Send"], button.send-button').first();
        if (await sendBtn.isVisible({ timeout: 2000 })) {
            await sendBtn.click();
        } else {
            await geminiPage.keyboard.press('Enter');
        }

        // 生成完了まで待機 (10秒)
        console.log('Waiting for AI response generation...');
        await geminiPage.waitForTimeout(10000);

        // 回答テキストの抽出
        const responseSelectors = [
            '.markdown',
            'message-content',
            'model-response',
            '.response-container-content',
            '[data-test-id="conversation-turn"]'
        ];

        let replyText = '';
        for (const selector of responseSelectors) {
            try {
                const elems = geminiPage.locator(selector);
                const count = await elems.count();
                if (count > 0) {
                    replyText = await elems.last().innerText();
                    if (replyText && replyText.trim().length > 5) {
                        break;
                    }
                }
            } catch (e) {}
        }

        if (!replyText) {
            // 万が一抽出できなかった場合のフォールバック（シンプルな定型共感文）
            console.warn('Could not extract generated text from Web Gemini. Using fallback natural reply.');
            const fallbackReplies = [
                "めちゃくちゃ素敵ですね！応援してます✨",
                "すごく綺麗ですね！思わず見入っちゃいました😊",
                "最高のショットですね！共有ありがとうございます👍",
                "めちゃくちゃ魅力的です！今日も一日頑張れそうです✨"
            ];
            replyText = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
        }

        // 余分な引用符などをクリーンアップ
        replyText = replyText.replace(/^["「]/, '').replace(/["」]$/, '').trim();
        // 100文字に収める
        if (replyText.length > 100) {
            replyText = replyText.substring(0, 97) + '...';
        }

        console.log(`==> Successfully obtained reply text: "${replyText}"`);
        
        await geminiPage.close().catch(() => {});
        return replyText;

    } catch (e) {
        console.error('Error during Web Gemini browser interaction:', e.message);
        await geminiPage.close().catch(() => {});
        // 万が一のエラー時の安全フォールバック
        return "すごく素敵ですね！投稿ありがとうございます✨";
    }
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

        // Web版Gemini(ブラウザ操作)でリプライテキストを自動生成 (API完全非依存)
        const replyText = await generateReplyViaBrowser(page, targetText);
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
