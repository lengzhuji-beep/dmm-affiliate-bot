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
            reply: {
                lastReplyTime: new Date(0).toISOString(),
                nextAllowedTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            },
            quote: {
                lastQuoteTime: new Date(0).toISOString(),
                nextAllowedTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            },
            processedTweetUrls: []
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
function updateQuoteSchedule(schedule, targetTweetUrl) {
    try {
        const now = new Date();
        const randomMinutes = Math.floor(Math.random() * 31) + 30; // 30〜60分
        const nextAllowed = new Date(now.getTime() + randomMinutes * 60 * 1000);

        schedule.quote.lastQuoteTime = now.toISOString();
        schedule.quote.nextAllowedTime = nextAllowed.toISOString();
        schedule.quote.lastRandomIntervalMinutes = randomMinutes;
        schedule.quote.todayCount = (schedule.quote.todayCount || 0) + 1;
        
        // 処理済みURL履歴の追加 (重複防止: 最大1000件保存)
        if (!schedule.processedTweetUrls) {
            schedule.processedTweetUrls = [];
        }
        if (targetTweetUrl && !schedule.processedTweetUrls.includes(targetTweetUrl)) {
            schedule.processedTweetUrls.push(targetTweetUrl);
            if (schedule.processedTweetUrls.length > 1000) {
                schedule.processedTweetUrls = schedule.processedTweetUrls.slice(-1000);
            }
        }
        
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        console.log(`Quote schedule updated! Quotes today: ${schedule.quote.todayCount}. Recorded URL: ${targetTweetUrl}`);
    } catch (e) {
        console.error('Failed to update quote schedule:', e);
    }
}

// ブラウザ操作でWeb版GeminiからリアルなTwitter口調の引用コメント文を生成
async function generateQuoteCommentViaBrowser(page, targetTweetText) {
    console.log('Navigating to Web Gemini (https://gemini.google.com/)...');
    const geminiPage = await page.context().newPage();
    
    try {
        await geminiPage.goto('https://gemini.google.com/', { waitUntil: 'commit', timeout: 60000 });
        await geminiPage.waitForTimeout(4000);

        const cleanTargetText = targetTweetText.replace(/[\r\n]+/g, ' ').trim();
        const prompt = `あなたはTwitter(X)に日常的に生息するリアルな一般オタク・ファンユーザーです。
以下の【対象ツイート】に対して、AIっぽさを完全に消し、自分のタイムラインに引用リポストする際の一言コメントを1つ作成してください。

【対象ツイート】
${cleanTargetText}

【人間らしい引用リポストの多様な視点・表現スタイル（※毎回ランダムに異なるアプローチを選んで作成すること）】
- **拡散・推し布教系**: 「全人類これ見てくれ…」「みんな見ろ、これが神だ」「TLのフォロワー全員に刺され」
- **直感リアクション・叫び系**: 「待って無理死んだｗｗｗ」「ビジュ爆発しすぎ」「語彙力持っていかれたわ」
- **ツッコミ・パワーワード反応系**: 「〇〇はズルすぎるｗｗ」「これは流石に反応せざるを得ない笑」「パワーワードすぎて無理ｗｗ」
- **日常感情吐露系**: 「疲れが一気に吹き飛んだ…感謝」「仕事終わりにこれは助かる」「TL流れてきて叫んだわ」
- **短文・スラング系**: 「優勝」「神」「尊い…」「天才」「助かる✨」

【出力ルール・制約】
- **敬語（〜です、〜ます等）は絶対禁止**。本物のTwitter民のフランクな口調・語尾（〜なんだが、〜すぎ、〜だわ、草、ｗｗ、✨、…等）を使用。
- 「目の保養」「即保存」などの擦り切れたテンプレ表現に頼らず、対象ツイートの具体的な内容やワードに自然に触れること。
- 15〜50文字程度で、リアルな短文にする。
- 引用コメント本文のみを出力。カギカッコや挨拶、解説は一切不要。`;

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
                    await el.evaluate((node, text) => {
                        if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
                            node.value = text;
                        } else {
                            node.innerText = text;
                        }
                        node.dispatchEvent(new Event('input', { bubbles: true }));
                    }, prompt);
                    inputFound = true;
                    console.log(`Successfully set prompt value into selector: ${selector}`);
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

        let commentText = '';
        for (const selector of responseSelectors) {
            try {
                const elems = geminiPage.locator(selector);
                const count = await elems.count();
                if (count > 0) {
                    commentText = await elems.last().innerText();
                    if (commentText && commentText.trim().length > 5) break;
                }
            } catch (e) {}
        }

        commentText = (commentText || '').replace(/^["「]/, '').replace(/["」]$/, '').trim();

        const ngKeywords = ['対象ツイート', '記載されていない', '文章を教えて', 'リプライ', 'AI', 'プロンプト', 'モデル', 'とは', '用語', 'を指します'];
        const isNgResponse = ngKeywords.some(kw => commentText.includes(kw));

        if (!commentText || isNgResponse || commentText.length > 90) {
            console.warn(`Generated text was invalid. Using natural casual fallback.`);
            const naturalFallbacks = [
                "全人類これ見てくれ…✨",
                "ビジュ爆発しすぎてて草",
                "語彙力消し飛んだわ笑",
                "TL流れてきて思わず叫んだわｗｗ",
                "これは流石に反応せざるを得ない笑",
                "仕事終わりにこれは助かる…！"
            ];
            commentText = naturalFallbacks[Math.floor(Math.random() * naturalFallbacks.length)];
        } else if (commentText.length > 100) {
            commentText = commentText.substring(0, 97) + '...';
        }

        console.log(`==> Successfully obtained quote comment: "${commentText}"`);
        await geminiPage.close().catch(() => {});
        return commentText;

    } catch (e) {
        console.error('Error during Web Gemini browser interaction:', e.message);
        await geminiPage.close().catch(() => {});
        return "全人類これ見てくれ…最高すぎる✨";
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

        // ターゲットツイートの探索
        let targetTweetUrl = '';
        let targetText = '';
        let cleanText = '';
        const processedUrls = scheduleData.processedTweetUrls || [];

        // 対象アカウントリスト (ユーザー指定)
        const targetAccounts = [
            'yukina__0069',
            'lovelysensi_',
            'Lili_amamiya22',
            'ELINA0121212',
            'iamhangyobacks',
            'rito_6327',
            '_R_A_R_A2nd',
            'mitsuhashi_sab'
        ];

        // ハッシュタグ候補
        const tagCandidates = [
            { tag: '#グラビア', query: '%23%E3%82%B0%E3%83%A9%E3%83%93%E3%82%A2' },
            { tag: '#コスプレ', query: '%23%E3%82%B3%E3%82%B9%E3%83%97%E3%83%AC' },
            { tag: '#水着',     query: '%23%E6%B0%B4%E7%9D%80' },
            { tag: '#自撮り部', query: '%23%E8%87%AA%E6%92%AE%E3%82%8A%E9%83%A8' },
            { tag: '#美女',     query: '%23%E7%BE%8E%E5%A5%B3' },
            { tag: '#グラビアアイドル', query: '%23%E3%82%B0%E3%83%A9%E3%83%93%E3%82%A2%E3%82%A2%E3%82%A4%E3%83%89%E3%83%AB' },
            { tag: '#コスプレイヤー',   query: '%23%E3%82%B3%E3%82%B9%E3%83%97%E3%83%AC%E3%82%A4%E3%83%84%E3%83%BC' },
            { tag: '#ポートレート',     query: '%23%E3%83%9D%E3%83%BC%E3%83%88%E3%83%AC%E3%83%BC%E3%83%88' },
            { tag: '#自撮り女子',       query: '%23%E8%87%AA%E6%92%AE%E3%82%8A%E5%A5%B3%E5%AD%90' },
            { tag: '#美少女',           query: '%23%E7%BE%8E%E5%B0%91%E5%A5%B3' },
            { tag: '#横顔美女',         query: '%23%E6%A8%AA%E9%A1%94%E7%BE%8E%E5%A5%B3' },
            { tag: '#1ミリでもいいなと思ったらRT', query: '%231%E3%83%9F%E3%83%AA%E3%81%A7%E3%82%82%E3%81%84%E3%81%84%E3%81%AA%E3%81%A8%E6%80%9D%E3%81%A3%E3%81%9F%E3%82%89RT' }
        ];

        // 探索ソースのリストを作成してシャッフル
        const searchSources = [];
        for (const acc of targetAccounts) {
            searchSources.push({ type: 'account', value: acc, url: `https://x.com/${acc}` });
        }
        for (const tag of tagCandidates) {
            searchSources.push({ type: 'hashtag', value: tag.tag, url: `https://x.com/search?q=${tag.query}%20min_faves%3A500&f=top` });
        }

        const shuffledSources = [...searchSources].sort(() => 0.5 - Math.random());

        for (const source of shuffledSources) {
            console.log(`Searching for 30k+ impression tweets in ${source.type}: ${source.value}...`);
            await page.goto(source.url, { waitUntil: 'commit', timeout: 60000 });
            await page.waitForTimeout(6000);
            await dismissOverlays(page);

            for (let scrollCount = 0; scrollCount < 4; scrollCount++) {
                const tweets = page.locator('[data-testid="tweet"]');
                const count = await tweets.count();

                for (let i = 0; i < count; i++) {
                    try {
                        const tweet = tweets.nth(i);

                        const linkElement = tweet.locator('a[href*="/status/"]').first();
                        const tweetHref = await linkElement.getAttribute('href').catch(() => null);
                        if (!tweetHref) continue;

                        const fullUrl = `https://x.com${tweetHref}`;
                        if (processedUrls.includes(fullUrl)) continue; // 重複チェック

                        // 自アカウントからのポストはスキップ
                        if (fullUrl.includes('/av_favorite_av/')) continue;

                        // インプレッション数のチェック (30,000以上)
                        const views = await getTweetViews(tweet);
                        console.log(`Checking tweet ${fullUrl} - Views: ${views}`);
                        if (views < 30000) {
                            continue; // 3万未満はスキップ
                        }

                        const textElement = tweet.locator('[data-testid="tweetText"]').first();
                        const rawText = await textElement.innerText().catch(() => '');
                        const textWithoutHashtags = rawText.replace(/#[\w\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]+/g, '').trim();

                        if (textWithoutHashtags.length >= 5 || rawText.length >= 5) {
                            targetTweetUrl = fullUrl;
                            targetText = rawText;
                            cleanText = textWithoutHashtags || rawText;
                            console.log(`>>> Found 30k+ views target tweet under ${source.value} (${views} views): ${targetTweetUrl}`);
                            break;
                        }
                    } catch (e) {}
                }

                if (targetTweetUrl) break;

                await page.mouse.wheel(0, 1500);
                await page.waitForTimeout(1500);
            }

            if (targetTweetUrl) break;
        }

        if (!targetTweetUrl || !cleanText) {
            console.log('No eligible tweet with 30,000+ views found across sources. Exiting.');
            await context.close();
            return;
        }

        // AIで引用用コメントを生成
        const commentText = await generateQuoteCommentViaBrowser(page, cleanText);
        console.log(`Generated quote comment: "${commentText}"`);

        // 対象ツイートの個別ページへ移動
        console.log(`Navigating directly to target tweet page for Quote: ${targetTweetUrl}`);
        await page.goto(targetTweetUrl, { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(7000);
        await dismissOverlays(page);

        // リポスト/引用ボタンをクリック
        console.log('Clicking Retweet/Quote button...');
        const retweetButton = page.locator('[data-testid="retweet"]').first();
        await retweetButton.click();
        await page.waitForTimeout(1500);

        // 引用メニューを選択
        console.log('Selecting Quote menu option...');
        const quoteMenuItem = page.locator('a[href*="/retweet"], [role="menuitem"]:has-text("引用"), [role="menuitem"]:has-text("Quote")').first();
        await quoteMenuItem.click();
        await page.waitForTimeout(3000);

        // 引用テキスト入力
        console.log('Typing quote comment with human delay...');
        const quoteInput = page.locator('[data-testid="tweetTextarea_0"], div[contenteditable="true"]').first();
        await quoteInput.click();
        await page.waitForTimeout(500);

        for (const char of commentText) {
            await page.keyboard.type(char);
            await page.waitForTimeout(Math.floor(Math.random() * 50) + 30);
        }
        await page.waitForTimeout(1000);

        // 投稿ボタンをクリック
        console.log('Submitting Quote Tweet...');
        const postButton = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
        await postButton.click();
        await page.waitForTimeout(5000);

        console.log('Quote Tweet submitted successfully!');

        updateQuoteSchedule(scheduleData, targetTweetUrl);
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

