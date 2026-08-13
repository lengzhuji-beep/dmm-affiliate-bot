require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';

(async () => {
    console.log('Launching browser to investigate real human replies on Twitter...');
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
    const targetUrls = [
        'https://x.com/yukina__0069/status/2085355415047684243',
        'https://x.com/yukina__0069/status/2082786406137815250'
    ];

    const collectedReplies = [];

    for (const url of targetUrls) {
        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        for (let s = 0; s < 5; s++) {
            const tweets = page.locator('[data-testid="tweet"]');
            const count = await tweets.count();
            for (let i = 1; i < count; i++) { // Skip the first post (parent)
                try {
                    const textEl = tweets.nth(i).locator('[data-testid="tweetText"]').first();
                    const text = await textEl.innerText().catch(() => '');
                    if (text && text.length > 3 && !text.includes('http')) {
                        collectedReplies.push(text.replace(/\n/g, ' '));
                    }
                } catch (e) {}
            }
            await page.mouse.wheel(0, 1500);
            await page.waitForTimeout(1500);
        }
    }

    console.log(`Collected ${collectedReplies.length} real human replies:`);
    console.log(JSON.stringify(collectedReplies.slice(0, 40), null, 2));

    await context.close();
    process.exit(0);
})();
