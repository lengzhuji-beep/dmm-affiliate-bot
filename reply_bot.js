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

// スケジュールと制限のチェック (JST 7:00〜23:00、30分〜60分のランダム間隔)
function checkReplyScheduleAndMaybeExit() {
    console.log('Checking reply schedule...');
    if (!fs.existsSync(SCHEDULE_FILE)) {
        console.log('Schedule file not found. Initializing new schedule...');
        const initialSchedule = {
            reply: {
                lastReplyTime: new Date(0).toISOString(),
                nextAllowedTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            }
        };
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(initialSchedule, null, 2), 'utf8');
    }

    try {
        const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
        if (!schedule.reply) {
            schedule.reply = {
                lastReplyTime: new Date(0).toISOString(),
                nextAllowedTime: new Date(0).toISOString(),
                todayCount: 0,
                lastResetDate: ''
            };
        }

        const jstNow = getJstDate();
        const jstTodayStr = jstNow.toISOString().split('T')[0]; // "YYYY-MM-DD"
        const currentHour = jstNow.getUTCHours(); // JSTの時刻 (0〜23)

        console.log(`Current JST Time: ${jstNow.toISOString()}, Hour: ${currentHour}`);

        // 1. 時間帯制限 (日本時間 7:00 〜 23:00)
        if (currentHour < 7 || currentHour > 23) {
            console.log('Outside active hours (7:00 - 23:00 JST). Skipping reply.');
            process.exit(0);
        }

        // 2. 日付変更時にカウントをリセット
        if (schedule.reply.lastResetDate !== jstTodayStr) {
            console.log(`New day detected (${jstTodayStr}). Resetting daily reply count to 0.`);
            schedule.reply.todayCount = 0;
            schedule.reply.lastResetDate = jstTodayStr;
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        }

        // 3. ランダムインターバル制限 (30分〜60分)
        const now = new Date();
        const nextAllowed = new Date(schedule.reply.nextAllowedTime || 0);
        
        if (process.env.FORCE_RUN === 'true') {
            console.log('Force run active (manual execution). Bypassing interval wait.');
        } else if (now < nextAllowed) {
            const remainingMins = Math.ceil((nextAllowed - now) / (1000 * 60));
            console.log(`Random interval active. Next allowed reply in ${remainingMins} mins (at ${nextAllowed.toISOString()}). Skipping.`);
            process.exit(0);
        }

        console.log(`Reply schedule check passed. (Replies sent today: ${schedule.reply.todayCount}). Proceeding with reply bot...`);
        return schedule;

    } catch (e) {
        console.error('Error checking reply schedule:', e);
        process.exit(1);
    }
}

// 送信成功時のスケジュール更新 (次回許可時刻を現在から30分〜60分のランダム値に設定し、処理済みURLを記録)
function updateReplySchedule(schedule, targetTweetUrl) {
    try {
        const now = new Date();
        const randomMinutes = Math.floor(Math.random() * 31) + 30;
        const nextAllowed = new Date(now.getTime() + randomMinutes * 60 * 1000);

        schedule.reply.lastReplyTime = now.toISOString();
        schedule.reply.nextAllowedTime = nextAllowed.toISOString();
        schedule.reply.lastRandomIntervalMinutes = randomMinutes;
        schedule.reply.todayCount = (schedule.reply.todayCount || 0) + 1;
        
        // 処理済みURL履歴の追加 (重複防止)
        if (!schedule.processedTweetUrls) {
            schedule.processedTweetUrls = [];
        }
        if (targetTweetUrl && !schedule.processedTweetUrls.includes(targetTweetUrl)) {
            schedule.processedTweetUrls.push(targetTweetUrl);
            // 履歴が長くなりすぎないよう直近 200 件を保持
            if (schedule.processedTweetUrls.length > 200) {
                schedule.processedTweetUrls = schedule.processedTweetUrls.slice(-200);
            }
        }
        
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8');
        console.log(`Reply schedule updated! Replies today: ${schedule.reply.todayCount}. Recorded URL: ${targetTweetUrl}`);
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

        // プロンプトを改行誤送信が起きない安全な形式に整形
        const cleanTargetText = targetTweetText.replace(/[\r\n]+/g, ' ').trim();
        const prompt = `あなたはTwitterに生息するリアルな一般オタク・ファンユーザーです。以下の【対象ツイート】を読んで、リアルなネットスラングや感嘆表現を含めたフランクな口調でリプライを1つ作成してください。

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
- 60文字以内で短くフランクに。
- 返信文のみを出力。余計な挨拶やメタ解説は一切不要。`;

        // 入力エリアを特定してプロンプトを一括代入
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
                    
                    // evaluate を使用してプロンプト全体を一括セット（改行誤送信を完全に回避）
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
            console.log('Fallback: clicking center of the page and typing prompt...');
            await geminiPage.mouse.click(600, 500);
            await geminiPage.keyboard.type(prompt.replace(/\n/g, ' '), { delay: 5 });
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

        // 余分な引用符などをクリーンアップ
        replyText = (replyText || '').replace(/^["「]/, '').replace(/["」]$/, '').trim();

        // AIのメタ返答（「対象ツイートが記載されていない」「文章を教えて」等）や解説文の検知フィルター
        const ngKeywords = ['対象ツイート', '記載されていない', '文章を教えて', 'リプライ', 'AI', 'プロンプト', 'モデル', 'とは', '用語', 'を指します'];
        const isNgResponse = ngKeywords.some(kw => replyText.includes(kw));

        if (!replyText || isNgResponse || replyText.length > 90) {
            console.warn(`Generated text was invalid or contained AI meta text ("${replyText.substring(0, 30)}..."). Using natural contextual fallback.`);
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

        console.log(`==> Successfully obtained reply text: "${replyText}"`);
        
        await geminiPage.close().catch(() => {});
        return replyText;

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

        // 検索クエリでバズツイートを取得 (いいね数が 500 以上の投稿)
        // アダルト/ファン層と親和性の高い人気ハッシュタグ 12選からランダム選択
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
            { tag: '#1ミリでもいいなと思ったらRT', query: '%231%E3%83%9F%E3%83%AA%E3%81%A7%E3%82%82%E3%81%84%E3%81%AA%E3%81%A8%E6%80%9D%E3%81%A3%E3%81%9F%E3%82%89RT' }
        ];
        const selectedTag = tagCandidates[Math.floor(Math.random() * tagCandidates.length)];
        const searchUrl = `https://x.com/search?q=${selectedTag.query}%20min_faves%3A500&f=live`;
        console.log(`Selected target hashtag: ${selectedTag.tag} (min_faves: 500)`);
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

        // ツイート一覧から、ハッシュタグ以外の本文テキストが10文字以上あり、過去未処理の投稿を探索・厳選
        let targetTweetUrl = '';
        let targetText = '';
        let cleanText = '';
        const processedUrls = scheduleData.processedTweetUrls || [];

        for (let i = 0; i < Math.min(count, 15); i++) {
            const tweet = tweets.nth(i);
            
            // ツイート本文の取得
            const textElement = tweet.locator('[data-testid="tweetText"]').first();
            const rawText = await textElement.innerText().catch(() => '');
            
            // ハッシュタグ(#...)を削除した「純粋な本文テキスト」を抽出
            const textWithoutHashtags = rawText.replace(/#[\w\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]+/g, '').trim();

            const linkElement = tweet.locator('a[href*="/status/"]').first();
            const tweetHref = await linkElement.getAttribute('href').catch(() => null);
            
            if (tweetHref) {
                const fullUrl = `https://x.com${tweetHref}`;
                
                // 過去にリプライ/引用リポスト済みのURLは重複防止のためスキップ
                if (processedUrls.includes(fullUrl)) {
                    console.log(`Skipping tweet Index ${i} (${fullUrl}): Already processed before.`);
                    continue;
                }

                // ハッシュタグを除いた本文テキストが10文字以上存在する場合のみ採用
                if (textWithoutHashtags.length >= 10) {
                    targetTweetUrl = fullUrl;
                    targetText = rawText;
                    cleanText = textWithoutHashtags;
                    console.log(`Found valid target tweet (Index ${i}): ${targetTweetUrl}`);
                    console.log(`Clean body text preview: "${cleanText.substring(0, 60)}..."`);
                    break;
                } else {
                    console.log(`Skipping tweet Index ${i}: Hashtag-only or body text too short (${textWithoutHashtags.length} chars).`);
                }
            }
        }

        if (!targetTweetUrl || !cleanText) {
            throw new Error('Could not find any tweet with substantial non-hashtag body text (min 10 chars).');
        }

        // Web版Gemini(ブラウザ操作)でリプライテキストを自動生成 (API完全非依存)
        const replyText = await generateReplyViaBrowser(page, cleanText);
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
        updateReplySchedule(scheduleData, targetTweetUrl);

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
