require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const SESSION_DIR = process.env.TWITTER_SESSION_PATH || './twitter_session';

(async () => {
    console.log('Launching browser to scrape deep history impressions for @av_favorite_av...');
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
    console.log('Navigating to x.com/av_favorite_av/with_replies...');
    await page.goto('https://x.com/av_favorite_av/with_replies', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-testid="tweet"]', { timeout: 30000 }).catch(() => {});

    const posts = [];
    const seenUrls = new Set();

    console.log('Deep scrolling and extracting posts...');

    for (let scrollCount = 0; scrollCount < 60; scrollCount++) {
        const tweetElements = page.locator('[data-testid="tweet"]');
        const count = await tweetElements.count();

        for (let i = 0; i < count; i++) {
            try {
                const tweet = tweetElements.nth(i);
                
                const link = tweet.locator('a[href*="/status/"]').first();
                const href = await link.getAttribute('href').catch(() => null);
                if (!href || seenUrls.has(href)) continue;

                seenUrls.add(href);

                const timeEl = tweet.locator('time').first();
                const datetime = await timeEl.getAttribute('datetime').catch(() => null);

                const textEl = tweet.locator('[data-testid="tweetText"]').first();
                const text = await textEl.innerText().catch(() => '');

                const analyticsEl = tweet.locator('a[href*="/analytics"]').first();
                let viewsText = await analyticsEl.innerText().catch(() => '');
                if (!viewsText) {
                    viewsText = await analyticsEl.getAttribute('aria-label').catch(() => '');
                }
                if (!viewsText) {
                    const groupEl = tweet.locator('[role="group"]').first();
                    viewsText = await groupEl.innerText().catch(() => '');
                }

                posts.push({
                    url: `https://x.com${href}`,
                    datetime: datetime || new Date().toISOString(),
                    text: text.substring(0, 40).replace(/\n/g, ' '),
                    viewsText: viewsText.trim()
                });
            } catch (e) {}
        }

        await page.mouse.wheel(0, 2500);
        await page.waitForTimeout(1500);
    }

    console.log(`Extracted total ${posts.length} posts.`);
    fs.writeFileSync('./impressions_raw.json', JSON.stringify(posts, null, 2));

    await context.close();
    process.exit(0);
})();
