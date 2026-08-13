require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';

(async () => {
    console.log('Launching browser to check @av_favorite_av...');
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: true,
        viewport: { width: 1280, height: 800 }
    });

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
    }

    const page = await context.newPage();
    await page.goto('https://x.com/av_favorite_av', { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(7000);

    const title = await page.title();
    console.log('Page Title:', title);
    const url = page.url();
    console.log('Current URL:', url);

    await page.screenshot({ path: './page_debug.png' });
    console.log('Saved page_debug.png');

    await context.close();
    process.exit(0);
})();
