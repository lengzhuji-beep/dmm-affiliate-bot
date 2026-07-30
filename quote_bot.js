require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';
const SCHEDULE_FILE = path.join(__dirname, 'post_schedule.json');

// 日本時間 (JST) の現在時刻を取得するヘルパー
function getJstDate() {
    const now = new Date();
    return new Date(now.getTime() + (9 * 60 * 60 * 1000));
}

// 引用リポスト用スケジュールのチェック
function checkQuoteScheduleAndMaybeExit() {
    console.log('Checking quote schedule...');
    if (!fs.existsSync(SCHEDULE_FILE)) {
        const initialSchedule = {
            quote: {
                lastQuoteTime: new Date(0).toISOString(),
                nextAllowedTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            }
        };
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(initialSchedule, null, 2), 'utf8');
    }

    try {
        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        if (!schedule.quote) {
            schedule.quote = {
                lastQuoteTime: new Date(0).toISOString(),
                nextAllowedTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            };
        }

        const jstNow = getJstDate();
        const jstTodayStr = jstNow.toISOString().split('T')[0];
        const currentHour = jstNow.getUTCHours();

        console.log(`Current JST Time: ${jstNow.toISOString()}, Hour: ${currentHour}`);

        // 1. 時間帯制限 (日本時間 7:00 〜 23:00)
        if (currentHour < 7 || currentHour > 23) {
            console.log('Outside active hours (7:00 - 23:00 JST). Skipping quote post.');
            process.exit(0);
        }

        // 2. 日付変更時にカウントをリセット
        if (schedule.quote.lastResetDate !== jstTodayStr) {
            console.log(`New day detected (${jstTodayStr}). Resetting daily quote count to 0.`);
            schedule.quote.todayCount = 0;
            schedule.quote.lastResetDate = jstTodayStr;
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        }

        // 3. ランダムインターバル制限 (30分〜60分)
        const now = new Date();
        const nextAllowed = new Date(schedule.quote.nextAllowedTime || 0);
        
        if (process.env.FORCE_RUN === 'true') {
            console.log('Force run active (manual execution). Bypassing interval wait.');
        } else if (now < nextAllowed) {
            const remainingMins = Math.ceil((nextAllowed - now) / (1000 * 60));
            console.log(`Random interval active. Next allowed quote in ${remainingMins} mins (at ${nextAllowed.toISOString()}). Skipping.`);
            process.exit(0);
        }

        console.log(`Quote schedule check passed. (Quotes sent today: ${schedule.quote.todayCount}). Proceeding with quote bot...`);
        return schedule;

    } catch (e) {
        console.error('Error checking quote schedule:', e);
        process.exit(1);
    }
}

// 送信成功時のスケジュール更新
function updateQuoteSchedule(schedule) {
    try {
        const now = new Date();
        const randomMinutes = Math.floor(Math.random() * 31) + 30; // 30〜60分
        const nextAllowed = new Date(now.getTime() + randomMinutes * 60 * 1000);

        schedule.quote.lastQuoteTime = now.toISOString();
        schedule.quote.nextAllowedTime = nextAllowed.toISOString();
        schedule.quote.lastRandomIntervalMinutes = randomMinutes;
        schedule.quote.todayCount = (schedule.quote.todayCount || 0) + 1;
        
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        console.log(`Quote schedule updated! Quotes today: ${schedule.quote.todayCount}. Next allowed in ${randomMinutes} mins (${nextAllowed.toISOString()})`);
    } catch (e) {
        console.error('Failed to update quote schedule:', e);
    }
}

// ブラウザ操作でWeb版Geminiからリアルな引用テキストを生成
async function generateQuoteViaBrowser(page, targetTweetText) {
    console.log('Navigating to Web Gemini (https://gemini.google.com/)...');
    const geminiPage = await page.context().newPage();
    
    try {
        await geminiPage.goto('https://gemini.google.com/', { waitUntil: 'commit', timeout: 60000 });
        await geminiPage.waitForTimeout(4000);

        const cleanTargetText = targetTweetText.replace(/[\r\n]+/g, ' ').trim();
        const prompt = `あなたはTwitterに生息するリアルな一般オタク・ファンユーザーです。以下の【対象ツイート】を読んで、他人のツイートを「引用リポスト（引用ツイート）」する際の、リアルなネットスラングや感嘆表現を含めた短くフランクなコメントを1つ作成してください。

【対象ツイート】
${cleanTargetText}

【口調のお手本イメージ（※このようなノリ・語尾で作成すること）】
- 待ってめちゃくちゃ可愛いんだがｗｗ
- 刺さりすぎてやばい、即保存したわ笑
- 最高すぎる！！マジで目の保養だわ✨
- 流石に可愛すぎてビビった、、
- はい優勝！！めちゃくちゃ似合ってる笑
- スタイル神がかってるな、、目の保養すぎる
- まじで可愛い！思わず二度見しちゃったわ笑
- えぐい可愛い、、今日も一日頑張れるわ✨
- ビジュが良すぎて普通に声出た、、最高
- こんなん好きになるに決まってんじゃん笑

【ルール・口調】
- **敬語（〜です、〜ます、〜ください等）は絶対禁止**。本物のTwitter民のリアルな口調・語尾（〜なんだが、〜すぎ、〜だわ、笑、ｗｗ、✨等）にすること。
- 【対象ツイート】の具体的内容（「${cleanTargetText.substring(0, 15)}」等）に軽く触れてコメントすること。
- 50文字以内で短くフランクに。
- 返信文のみを出力。余計な挨拶やメタ解説は一切不要。`;

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
                    await el.evaluate((node, text) => {
                        if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
                            node.value = text;
                        } else {
                            node.innerText = text;
                        }
                        node.dispatchEvent(new Event('input', { bubbles: true }));
                    }, prompt);
                    inputFound = true;
                    break;
                }
            } catch (e) {}
        }

        if (!inputFound) {
            await geminiPage.mouse.click(600, 500);
            await geminiPage.keyboard.type(prompt.replace(/\n/g, ' '), { delay: 5 });
        }

        await geminiPage.waitForTimeout(1000);

        const sendBtn = geminiPage.locator('button[aria-label*="送信"], button[aria-label*="Send"], button.send-button').first();
        if (await sendBtn.isVisible({ timeout: 2000 })) {
            await sendBtn.click();
        } else {
            await geminiPage.keyboard.press('Enter');
        }

        await geminiPage.waitForTimeout(10000);

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
                    if (replyText && replyText.trim().length > 5) break;
                }
            } catch (e) {}
        }

        replyText = (replyText || '').replace(/^["「]/, '').replace(/["」]$/, '').trim();

        const ngKeywords = ['対象ツイート', '記載されていない', '文章を教えて', 'リプライ', 'AI', 'プロンプト', 'モデル', 'とは', '用語', 'を指します'];
        const isNgResponse = ngKeywords.some(kw => replyText.includes(kw));

        if (!replyText || isNgResponse || replyText.length > 90) {
            console.warn(`Generated quote text was invalid. Using natural casual fallback.`);
            const naturalFallbacks = [
                "待ってめちゃくちゃ可愛いんだがｗｗ",
                "刺さりすぎてやばい、即保存したわ笑",
                "最高すぎる！！マジで目の保養だわ✨",
                "流石に可愛すぎてビビった、、",
                "はい優勝！！めちゃくちゃ似合ってる笑",
                "スタイル神がかってるな、、目の保養すぎる",
                "まじで可愛い！思わず二度見しちゃったわ笑",
                "えぐい可愛い、、今日も一日頑張れるわ✨",
                "ビジュが良すぎて普通に声出た、、最高",
                "こんなん好きになるに決まってんじゃん笑"
            ];
            replyText = naturalFallbacks[Math.floor(Math.random() * naturalFallbacks.length)];
        } else if (replyText.length > 100) {
            replyText = replyText.substring(0, 97) + '...';
        }

        console.log(`==> Successfully obtained quote text: "${replyText}"`);
        await geminiPage.close().catch(() => {});
        return replyText;

    } catch (e) {
        console.error('Error during Web Gemini browser interaction for quote:', e.message);
        await geminiPage.close().catch(() => {});
        return "最高すぎる！！マジで目の保養だわ✨";
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
    const scheduleData = checkQuoteScheduleAndMaybeExit();

    console.log('Launching browser for quote bot...');
    const isHeadless = process.env.HEADLESS === 'true';
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: isHeadless,
        viewport: { width: 1280, height: 720 },
        args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [],
    });

    const page = await context.newPage();

    try {
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

        const tagCandidates = [
            { tag: '#グラビア', query: '%23%E3%82%B0%E3%83%A9%E3%83%93%E3%82%A2' },
            { tag: '#コスプレ', query: '%23%E3%82%B3%E3%82%B9%E3%83%97%E3%83%AC' },
            { tag: '#水着',     query: '%23%E6%B0%B4%E7%9D%80' },
            { tag: '#自撮り部', query: '%23%E8%87%AA%E6%92%AE%E3%82%8A%E9%83%A8' },
            { tag: '#美女',     query: '%23%E7%BE%8E%E5%A5%B3' }
        ];
        const selectedTag = tagCandidates[Math.floor(Math.random() * tagCandidates.length)];
        const searchUrl = `https://x.com/search?q=${selectedTag.query}%20min_faves%3A500&f=live`;
        console.log(`Selected target hashtag for Quote: ${selectedTag.tag} (min_faves: 500)`);
        console.log(`Navigating to search page: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(10000);
        await dismissOverlays(page);

        console.log('Finding target tweet for Quote...');
        const tweetSelector = '[data-testid="tweet"]';
        await page.waitForSelector(tweetSelector, { timeout: 15000 });
        
        const tweets = page.locator(tweetSelector);
        const count = await tweets.count();

        let targetTweetUrl = '';
        let targetText = '';
        let cleanText = '';
        let targetTweetElement = null;

        for (let i = 0; i < Math.min(count, 10); i++) {
            const tweet = tweets.nth(i);
            const textElement = tweet.locator('[data-testid="tweetText"]').first();
            const rawText = await textElement.innerText().catch(() => '');
            const textWithoutHashtags = rawText.replace(/#[\w\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]+/g, '').trim();

            if (textWithoutHashtags.length >= 10) {
                const linkElement = tweet.locator('a[href*="/status/"]').first();
                const tweetHref = await linkElement.getAttribute('href').catch(() => null);
                if (tweetHref) {
                    targetTweetUrl = `https://x.com${tweetHref}`;
                    targetText = rawText;
                    cleanText = textWithoutHashtags;
                    targetTweetElement = tweet;
                    console.log(`Found valid target tweet for Quote (Index ${i}): ${targetTweetUrl}`);
                    break;
                }
            }
        }

        if (!targetTweetUrl || !cleanText) {
            throw new Error('Could not find any tweet with substantial non-hashtag body text for Quote.');
        }

        const quoteComment = await generateQuoteViaBrowser(page, cleanText);
        console.log(`Generated Quote comment: "${quoteComment}"`);

        // 引用リポスト操作
        console.log('Performing Quote Tweet action...');
        
        // リポストボタンのクリック
        const retweetButton = targetTweetElement.locator('[data-testid="retweet"]').first();
        await retweetButton.click();
        await page.waitForTimeout(1500);

        // 「引用 (Quote)」メニューの選択
        console.log('Selecting Quote option...');
        const quoteMenuItem = page.locator('a[href*="/retweet"], [role="menuitem"]:has-text("引用"), [role="menuitem"]:has-text("Quote")').first();
        await quoteMenuItem.click();
        await page.waitForTimeout(3000);

        // ダイアログ内のテキスト入力エリア
        console.log('Typing quote comment...');
        const quoteInput = page.locator('[data-testid="tweetTextarea_0"], div[contenteditable="true"]').first();
        await quoteInput.click();
        await page.waitForTimeout(500);

        // 人間らしい入力速度でタイピング
        for (const char of quoteComment) {
            await page.keyboard.type(char);
            await page.waitForTimeout(Math.floor(Math.random() * 50) + 30);
        }
        await page.waitForTimeout(1000);

        // 「ポストする / Post」ボタンのクリック
        console.log('Submitting Quote Tweet...');
        const postButton = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
        await postButton.click();
        await page.waitForTimeout(5000);

        console.log('Quote Tweet submitted successfully!');

        updateQuoteSchedule(scheduleData);
        console.log('Quote bot script completed successfully!');

    } catch (err) {
        console.error('Error in quote bot execution:', err);
        throw err;
    } finally {
        await context.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('Fatal error in quote bot:', err);
    process.exit(1);
});
