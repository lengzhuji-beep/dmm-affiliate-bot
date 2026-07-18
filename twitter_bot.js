require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Playwright-extraにstealthプラグインを登録
chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';

/**
 * Xのページに乗っているオーバーレイ（#layers）を全て強制的に非表示にする
 */
async function dismissOverlays(page) {
    try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
    } catch (e) {}

    try {
        await page.evaluate(() => {
            const layers = document.getElementById('layers');
            if (layers) {
                Array.from(layers.children).forEach(el => {
                    el.style.display = 'none';
                });
            }
        });
        await page.waitForTimeout(300);
    } catch (e) {}
}

/**
 * Twitterにログインまたはセッションを復元し、動画付きツイートとリプライを投稿する
 * @param {string} text 投稿するテキスト（親ツイート）
 * @param {string} replyText リプライとして投稿するテキスト
 * @param {string} videoPath 添付する動画ファイルのパス（ローカル）
 */
async function postToTwitter(text, replyText, videoPath) {
    console.log('Launching browser...');
    
    const isHeadless = process.env.HEADLESS === 'true';
    console.log(`Browser mode: ${isHeadless ? 'headless (server)' : 'headed (local)'}`);
    
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: isHeadless,
        viewport: { width: 1280, height: 720 },
        args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : [],
    });

    const page = await context.newPage();

    try {
        // ヘッドレスモード時はCookieファイルからセッションを復元
        if (isHeadless) {
            const cookiePath = require('path').join(__dirname, 'twitter_cookies.json');
            if (require('fs').existsSync(cookiePath)) {
                const cookies = JSON.parse(require('fs').readFileSync(cookiePath, 'utf8'));
                
                // .twitter.com と .x.com の両方のドメインにCookieを設定
                const expandedCookies = [];
                for (const cookie of cookies) {
                    expandedCookies.push(cookie);
                    // ドメインを複製（twitter.com → x.com、またはその逆）
                    if (cookie.domain && cookie.domain.includes('twitter.com')) {
                        expandedCookies.push({ ...cookie, domain: cookie.domain.replace('twitter.com', 'x.com') });
                    } else if (cookie.domain && cookie.domain.includes('x.com')) {
                        expandedCookies.push({ ...cookie, domain: cookie.domain.replace('x.com', 'twitter.com') });
                    }
                }
                
                await context.addCookies(expandedCookies);
                console.log(`Loaded ${expandedCookies.length} cookies (both domains)`);
            } else {
                console.warn('WARNING: twitter_cookies.json not found! Login will fail in headless mode.');
            }
        }

        console.log('Navigating to Twitter...');
        // waitUntil: 'commit' でサーバーの初回レスポンスですぐに制御を返す
        await page.goto('https://x.com/home', { waitUntil: 'commit', timeout: 60000 });
        // ページのレンダリング完了を待機
        await page.waitForTimeout(10000);

        // プレミアム登録画面へのリダイレクト対策
        if (page.url().includes('premium_sign_up') || page.url().includes('i/flow')) {
            console.log('Redirect detected. Going back to home...');
            await page.goto('https://x.com/home', { waitUntil: 'commit', timeout: 60000 });
            await page.waitForTimeout(5000);
        }

        // オーバーレイを除去
        await dismissOverlays(page);

        // ログイン状態の判定
        let isLoggedIn = false;
        try {
            await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'attached', timeout: 8000 });
            isLoggedIn = true;
        } catch (e) {
            isLoggedIn = false;
        }

        if (!isLoggedIn) {
            const username = process.env.TWITTER_USERNAME;
            const password = process.env.TWITTER_PASSWORD;
            const email = process.env.TWITTER_EMAIL;

            if (!username || !password) {
                console.log('--- LOGIN REQUIRED (no credentials in .env) ---');
                console.log('Please log in manually on the browser window.');
                console.log('Waiting up to 5 minutes...');
                await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'attached', timeout: 300000 });
            } else {
                console.log('Auto-login starting...');
                
                // ログインページに遷移
                await page.goto('https://x.com/i/flow/login', { waitUntil: 'commit', timeout: 60000 });
                console.log('Login page loaded. Waiting for render...');
                await page.waitForTimeout(10000);

                // 「Log in」ボタンをクリックしてログインフォームを表示
                console.log('Looking for Log in button...');
                await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a, span, div[role="button"]'));
                    const loginBtn = links.find(el => 
                        el.textContent.trim() === 'Log in' || 
                        el.textContent.trim() === 'ログイン'
                    );
                    if (loginBtn) {
                        console.log('Found login button, clicking...');
                        loginBtn.click();
                    }
                });
                await page.waitForTimeout(5000);

                // ユーザー名入力フィールドの出現を待つ
                console.log('Waiting for username input...');
                const usernameInput = page.locator('input[autocomplete="username"], input[name="text"], input[type="text"]').first();
                await usernameInput.waitFor({ state: 'visible', timeout: 30000 });
                console.log('Username input found!');
                await usernameInput.fill(username);
                await page.waitForTimeout(500);
                // 「次へ」ボタンをクリック
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const nextBtn = buttons.find(b => b.textContent.includes('次へ') || b.textContent.includes('Next'));
                    if (nextBtn) nextBtn.click();
                });
                await page.waitForTimeout(2000);

                // メールアドレス確認（追加認証が求められた場合）
                try {
                    const emailInput = page.locator('input[data-testid="ocfEnterTextTextInput"]');
                    if (await emailInput.isVisible({ timeout: 3000 })) {
                        console.log('Email verification required, entering email...');
                        await emailInput.fill(email || username);
                        await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button'));
                            const nextBtn = buttons.find(b => b.textContent.includes('次へ') || b.textContent.includes('Next'));
                            if (nextBtn) nextBtn.click();
                        });
                        await page.waitForTimeout(2000);
                    }
                } catch (e) {
                    // メール確認は不要だった場合はスキップ
                }

                // パスワード入力
                console.log('Entering password...');
                const passwordInput = page.locator('input[type="password"]');
                await passwordInput.waitFor({ state: 'visible', timeout: 10000 });
                await passwordInput.fill(password);
                await page.waitForTimeout(500);
                // 「ログイン」ボタンをクリック
                await page.evaluate(() => {
                    const btn = document.querySelector('[data-testid="LoginForm_Login_Button"]');
                    if (btn) btn.click();
                });
                await page.waitForTimeout(5000);

                // ログイン成功を確認
                console.log('Verifying login...');
                await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'attached', timeout: 30000 });
                console.log('Auto-login successful!');
            }
        }

        // コンポーザーが見えることを確認
        console.log('Wait for composer...');
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'attached', timeout: 15000 });

        // 再度オーバーレイを除去
        await dismissOverlays(page);

        // === 動画アップロード ===
        if (videoPath) {
            console.log(`Uploading video: ${videoPath}`);
            try {
                const fileInput = page.locator('input[data-testid="fileInput"]').first();
                await fileInput.setInputFiles(videoPath);
                
                console.log('File set. Waiting for Twitter to process the video...');
                await page.waitForSelector('[data-testid="attachments"]', { state: 'visible', timeout: 60000 });
                console.log('Video attachment detected!');
                await page.waitForTimeout(5000);
            } catch (err) {
                console.error('Primary upload failed:', err.message);
                const fallbackInput = page.locator('input[type="file"]').first();
                await fallbackInput.setInputFiles(videoPath);
                await page.waitForSelector('[data-testid="attachments"]', { state: 'visible', timeout: 60000 });
            }
        }

        // === 親ツイートの入力・投稿 ===
        console.log('Typing main text...');
        const textarea = page.locator('[data-testid="tweetTextarea_0"]').first();
        await textarea.click({ force: true });
        await page.waitForTimeout(500);
        await page.keyboard.type(text, { delay: 30 });
        await page.waitForTimeout(1000);

        // === ポストボタンのクリック ===
        console.log('Waiting for post button to become enabled...');
        // Step 1: ボタンのdisabledが解除されるまで最大120秒待つ（動画エンコード待ち）
        await page.waitForFunction(() => {
            const btn = document.querySelector('[data-testid="tweetButtonInline"]')
                     || document.querySelector('[data-testid="tweetButton"]');
            return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }, { timeout: 120000 });
        console.log('Post button is now enabled!');

        // Step 2: JavaScriptで直接クリックイベントを発火（#layersのオーバーレイを完全バイパス）
        console.log('Clicking post button via JavaScript...');
        await page.evaluate(() => {
            const btn = document.querySelector('[data-testid="tweetButtonInline"]')
                     || document.querySelector('[data-testid="tweetButton"]');
            if (btn) btn.click();
        });

        // 投稿完了待機
        console.log('Waiting for post to finish...');
        await page.waitForTimeout(5000);
        await page.waitForSelector('[data-testid="toast"]', { timeout: 15000 })
            .catch(() => console.log('Toast not detected, assuming success.'));
        await page.waitForTimeout(3000);

        // === リプライの投稿 ===
        if (replyText) {
            console.log('Starting reply sequence...');
            
            // 確実に自分の投稿にリプライするため、投稿直後の「表示」リンクをクリックするか、URLを確認
            try {
                const toast = page.locator('[data-testid="toast"]').first();
                const viewLink = toast.locator('a').first();
                if (await viewLink.isVisible()) {
                    console.log('Navigating to the status page via toast...');
                    await viewLink.click();
                    await page.waitForURL(/status/, { timeout: 15000 });
                } else {
                    // トーストが見つからない場合は、トップのツイート（自分のもののはず）をリプライ対象にする
                    console.log('Toast link not found, attempting searching on current page...');
                }
            } catch (e) {
                console.log('Could not navigate via toast, using fallback...');
            }

            // ステータスページ、またはホームの最上部でリプライボタンを探す
            console.log('Looking for reply button...');
            await page.waitForSelector('[data-testid="reply"]', { timeout: 10000 });
            // 自爆リプライの誤爆を防ぐため、一番上のツイートのリプライボタンをクリック
            await page.locator('[data-testid="reply"]').first().click();

            // リプライ用入力エリアが表示されるのを待つ
            await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'visible', timeout: 10000 });
            await page.waitForTimeout(1000);
            
            console.log('Typing reply text...');
            await page.keyboard.type(replyText, { delay: 30 });
            await page.waitForTimeout(1000);

            // リプライ用投稿ボタン（JavaScriptで直接クリック - オーバーレイをバイパス）
            console.log('Clicking reply post button via JavaScript...');
            await page.evaluate(() => {
                // リプライダイアログでは tweetButton が使われる
                const btn = document.querySelector('[data-testid="tweetButton"]')
                         || document.querySelector('[data-testid="tweetButtonInline"]');
                if (btn) btn.click();
            });

            console.log('Reply successfully posted!');
            await page.waitForTimeout(3000);
        }

        console.log('All sequences finished!');

    } catch (error) {
        console.error('Error during Twitter post:', error);
        throw error; // エラーを再スローして、GitHub Actions側で「失敗」を検知できるようにします
    } finally {
        await page.waitForTimeout(3000);
        await context.close();
    }
}

module.exports = {
    postToTwitter
};
