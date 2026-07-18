/**
 * ログインページのスクリーンショットを撮影して原因を特定する
 */
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function capture() {
    console.log('Launching browser...');
    const context = await chromium.launchPersistentContext('./twitter_session', {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await context.newPage();

    try {
        // Step 1: x.com/home にアクセス
        console.log('Navigating to x.com/home...');
        await page.goto('https://x.com/home', { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(10000);
        await page.screenshot({ path: 'screenshot_1_home.png', fullPage: true });
        console.log('Screenshot 1 saved: screenshot_1_home.png');
        console.log('URL after home:', page.url());
        console.log('Title:', await page.title());

        // Step 2: ログインページにアクセス
        console.log('\nNavigating to login page...');
        await page.goto('https://x.com/i/flow/login', { waitUntil: 'commit', timeout: 60000 });
        await page.waitForTimeout(10000);
        await page.screenshot({ path: 'screenshot_2_login.png', fullPage: true });
        console.log('Screenshot 2 saved: screenshot_2_login.png');
        console.log('URL after login:', page.url());

        // Step 3: ページのHTML要素を確認
        const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || 'EMPTY');
        console.log('\nPage text (first 500 chars):\n', bodyText);

        // Step 4: input要素を全部リストアップ
        const inputs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input')).map(el => ({
                type: el.type,
                name: el.name,
                autocomplete: el.autocomplete,
                placeholder: el.placeholder,
                testid: el.getAttribute('data-testid'),
            }));
        });
        console.log('\nAll input elements:', JSON.stringify(inputs, null, 2));

    } catch (e) {
        console.error('Error:', e.message);
        await page.screenshot({ path: 'screenshot_error.png' }).catch(() => {});
    } finally {
        await context.close();
    }
}

capture();
