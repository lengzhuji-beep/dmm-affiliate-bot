/**
 * ローカルPCのTwitterセッションからCookieを抽出してJSONファイルに保存する
 */
require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';

async function exportCookies() {
    console.log('Launching browser to export cookies...');
    
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();
    
    console.log('Navigating to Twitter...');
    await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // ログイン状態を確認
    try {
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'attached', timeout: 10000 });
        console.log('Logged in! Extracting cookies...');
    } catch (e) {
        console.log('Not logged in. Please log in manually...');
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'attached', timeout: 300000 });
    }

    // Cookieを取得して保存
    const cookies = await context.cookies();
    const twitterCookies = cookies.filter(c => 
        c.domain.includes('twitter.com') || c.domain.includes('x.com')
    );
    
    fs.writeFileSync('twitter_cookies.json', JSON.stringify(twitterCookies, null, 2));
    console.log(`Exported ${twitterCookies.length} cookies to twitter_cookies.json`);
    
    await context.close();
    console.log('Done! Transfer twitter_cookies.json to your server.');
}

exportCookies().catch(console.error);
