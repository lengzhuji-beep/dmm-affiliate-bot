/**
 * サーバー環境でのPlaywright動作診断スクリプト
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function diagnose() {
    console.log('=== Playwright Diagnostic ===');
    console.log('Node version:', process.version);
    console.log('DISPLAY:', process.env.DISPLAY);
    
    let context, page;
    try {
        console.log('\n[1] Launching browser...');
        context = await chromium.launchPersistentContext('./test_session', {
            headless: false,
            viewport: { width: 1280, height: 720 },
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        console.log('[1] OK - Browser launched');

        page = await context.newPage();
        console.log('[2] OK - Page created');

        // テスト1: Googleに接続
        console.log('\n[3] Navigating to google.com...');
        await page.goto('https://www.google.com', { timeout: 30000 });
        console.log('[3] OK - Google loaded. URL:', page.url());

        // テスト2: twitter.comに接続
        console.log('\n[4] Navigating to twitter.com...');
        await page.goto('https://twitter.com', { timeout: 60000, waitUntil: 'domcontentloaded' });
        console.log('[4] OK - Twitter loaded. URL:', page.url());
        
        // ページの内容を少し確認
        const title = await page.title();
        console.log('[4] Page title:', title);

        // テスト3: x.comに接続
        console.log('\n[5] Navigating to x.com...');
        await page.goto('https://x.com', { timeout: 60000, waitUntil: 'domcontentloaded' });
        console.log('[5] OK - x.com loaded. URL:', page.url());

    } catch (error) {
        console.error('\n[FAIL]', error.message);
    } finally {
        if (context) await context.close();
        console.log('\n=== Diagnostic Complete ===');
    }
}

diagnose();
