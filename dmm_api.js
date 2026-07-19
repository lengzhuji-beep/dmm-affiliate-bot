require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DMM_API_ID = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const TEMP_DIR = path.join(__dirname, 'temp_videos');

// テンポラリディレクトリの作成
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

/**
 * DMM APIから商品情報を取得する
 */
async function fetchDmmProduct(keyword = '') {
    if (!DMM_API_ID || !DMM_AFFILIATE_ID) {
        throw new Error('DMM_API_ID or DMM_AFFILIATE_ID is not set in .env');
    }

    try {
        const url = `https://api.dmm.com/affiliate/v3/ItemList`;
        const params = {
            api_id: DMM_API_ID,
            affiliate_id: DMM_AFFILIATE_ID,
            site: 'DMM.R18',
            service: 'digital',
            floor: 'videoa',
            hits: 100,
            sort: 'rank',
            output: 'json'
        };
        if (keyword) params.keyword = keyword;

        const response = await axios.get(url, { params });
        const items = response.data.result.items;

        if (!items || items.length === 0) {
            throw new Error('No items found.');
        }

        // 過去の投稿履歴を読み込む
        const postedIdsFile = path.join(__dirname, 'posted_ids.json');
        let postedIds = [];
        if (fs.existsSync(postedIdsFile)) {
            try {
                postedIds = JSON.parse(fs.readFileSync(postedIdsFile, 'utf8'));
            } catch (e) {
                console.warn('Could not parse posted_ids.json:', e.message);
            }
        }

        // サンプル動画がある未投稿商品を抽出
        const itemsWithVideo = items.filter(item => {
            const contentId = item.content_id || item.product_id;
            return item.sampleMovieURL && item.sampleMovieURL.size_720_480 && !postedIds.includes(contentId);
        });

        if (!itemsWithVideo || itemsWithVideo.length === 0) {
            console.log('No new items found in current results. Consider broadening search or wait.');
            throw new Error('All fetched items have been posted already.');
        }

        // 発売日が新しい順に並び替えて上位20件からランダム選択
        const sortedByDate = itemsWithVideo.sort((a, b) => {
            return new Date(b.date.replace(' ', 'T')) - new Date(a.date.replace(' ', 'T'));
        });
        const recentPopularCandidates = sortedByDate.slice(0, 20);
        const itemWithVideo = recentPopularCandidates[Math.floor(Math.random() * recentPopularCandidates.length)];

        const contentId = itemWithVideo.content_id || itemWithVideo.product_id || '';
        const rawUrl = `https://www.dmm.co.jp/litevideo/-/detail/=/cid=${contentId}/`;
        const customAffiliateUrl = `https://al.fanza.co.jp/?lurl=${encodeURIComponent(rawUrl)}&af_id=${DMM_AFFILIATE_ID}&ch=link_ag`;

        // 説明文の取得（IPブロックされても無視する）
        let productText = '';
        try {
            const liteVideoUrl = `https://www.dmm.co.jp/litevideo/-/part/=/cid=${contentId}/size=720_480/`;
            const htmlRes = await axios.get(liteVideoUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
                    'Referer': 'https://www.dmm.co.jp/',
                },
                timeout: 10000,
            });
            const dataMatch = htmlRes.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (dataMatch) {
                const jsonData = JSON.parse(dataMatch[1]);
                const queries = jsonData?.props?.pageProps?.dehydratedState?.queries || [];
                const contentQuery = queries.find(q => q.state?.data?.videoContent);
                const text = contentQuery?.state?.data?.videoContent?.text || '';
                productText = text.replace(/<br\s*\/?>/gi, ' ')
                                  .replace(/\r?\n|\r/g, ' ')
                                  .replace(/\s+/g, ' ')
                                  .replace(/<\/?[^>]+(>|$)/g, '')
                                  .trim();
            }
        } catch (e) {
            console.warn('Failed to fetch description (may be IP-blocked):', e.message);
        }

        // ハッシュタグの生成 (女優名を最優先にするため、配列の先頭に配置)
        const actressTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.actress ? itemWithVideo.iteminfo.actress.map(a => `#${a.name}`) : [];
        const keywordTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.keyword ? itemWithVideo.iteminfo.keyword.map(k => `#${k.name}`) : [];
        const genreTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.genre ? itemWithVideo.iteminfo.genre.map(g => `#${g.name}`) : [];
        const allTags = [...new Set([...actressTags, ...keywordTags, ...genreTags])].join(' ');

        return {
            contentId: contentId,
            title: itemWithVideo.title,
            affiliateUrl: customAffiliateUrl,
            sampleVideoUrl: itemWithVideo.sampleMovieURL.size_720_480,
            url: rawUrl,
            tags: allTags,
            text: productText
        };

    } catch (error) {
        console.error('Error fetching DMM product:', error.message);
        throw error;
    }
}

/**
 * content IDからMP4 URLを取得する（複数戦略）
 *
 * 戦略1: html5_playerに固定mtypeで直接アクセス（DMMのlitevideoページを経由しない）
 *        → mtype=AhRVShI_ はDMM litevideoのguestアクセス用固定トークン
 *        → html5_playerエンドポイントはlitevideoページと別のIP制限を持つ可能性がある
 *
 * 戦略2: PlaywrightでJSを実行してページをレンダリング
 *        → litevideoページがJSチャレンジ方式の場合はPlaywrightが突破できる
 *        → windowオブジェクトからmtypeを抽出してhtml5_playerへアクセス
 */
async function getMp4UrlForCid(cid) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': `https://www.dmm.co.jp/litevideo/-/part/=/cid=${cid}/size=720_480/`,
    };

    // ---- 戦略1: 固定mtype（AhRVShI_）でhtml5_playerに直接アクセス ----
    // mtype "AhRVShI_" はDMMのguest（非ログイン）向けlitevideoアクセス用の固定トークン
    console.log('[Strategy 1] Trying html5_player with fixed guest mtype...');
    const GUEST_MTYPE = 'AhRVShI_';
    try {
        const playerUrl = `https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=${cid}/mtype=${GUEST_MTYPE}/service=litevideo/mode=part/width=720/height=480/affi_id=${DMM_AFFILIATE_ID}/`;
        const res = await axios.get(playerUrl, { headers, timeout: 15000 });
        const html = res.data;
        console.log(`[Strategy 1] html5_player response: ${html.length} bytes, has args: ${html.includes('const args')}`);

        const argsMatch = html.match(/const\s+args\s*=\s*(\{[^;]+\});/);
        if (argsMatch) {
            const args = JSON.parse(argsMatch[1]);
            if (args.src) {
                const mp4Url = args.src.startsWith('//') ? 'https:' + args.src : args.src;
                console.log(`[Strategy 1] OK: ${mp4Url}`);
                return mp4Url;
            }
        }
        const mp4Match = html.match(/(\/\/cc\d+\.dmm\.co\.jp\/[^\s"'<>]+\.mp4[^\s"'<>]*)/);
        if (mp4Match) {
            console.log(`[Strategy 1] OK (fallback): https:${mp4Match[1]}`);
            return 'https:' + mp4Match[1];
        }
        console.warn('[Strategy 1] MP4 URL not found in html5_player response.');
    } catch (e) {
        console.warn(`[Strategy 1] Failed: ${e.message}`);
    }

    // ---- 戦略2: Playwrightでlitevideoページをレンダリングしてmtypeを取得 ----
    // litevideoページはJSチャレンジ方式（純粋なIPブロックでない可能性）
    console.log('[Strategy 2] Using Playwright to render litevideo page...');
    try {
        const mp4Url = await getMp4ViaPlaywright(cid);
        if (mp4Url) {
            console.log(`[Strategy 2] OK: ${mp4Url}`);
            return mp4Url;
        }
        console.warn('[Strategy 2] Playwright did not find MP4 URL.');
    } catch (e) {
        console.warn(`[Strategy 2] Failed: ${e.message}`);
    }

    throw new Error(`Could not get MP4 URL for cid=${cid}. Both strategies failed. DMM may be geo-blocking this IP.`);
}

/**
 * PlaywrightでDMMのlitevideoページをレンダリングしてMP4 URLを取得する
 * JSチャレンジを突破できる可能性がある
 */
async function getMp4ViaPlaywright(cid) {
    const { chromium } = require('playwright');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    let mp4Url = null;

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            locale: 'ja-JP',
        });
        const page = await context.newPage();

        // ネットワークインターセプトで.mp4 URLを捕捉
        page.on('request', req => {
            const url = req.url();
            if (url.includes('.mp4') && !mp4Url) {
                console.log(`[Playwright] Intercepted MP4 request: ${url}`);
                mp4Url = url;
            }
        });

        const partUrl = `https://www.dmm.co.jp/litevideo/-/part/=/cid=${cid}/size=720_480/`;
        await page.goto(partUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Next.jsのハイドレーション完了を待つ
        try {
            await page.waitForFunction(
                () => typeof window !== 'undefined' && window.__NEXT_DATA__ && window.__NEXT_DATA__.props,
                { timeout: 10000 }
            );
            console.log('[Playwright] Next.js data found in window!');
        } catch (e) {
            console.warn('[Playwright] Next.js did not hydrate:', e.message);
        }

        // window.__NEXT_DATA__からmtypeを抽出
        const mtype = await page.evaluate(() => {
            if (!window.__NEXT_DATA__) return null;
            const queries = window.__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries || [];
            const q = queries.find(q => Array.isArray(q.queryKey) && q.queryKey.includes('dmm-base64-encode'));
            return q?.state?.data || null;
        });

        console.log(`[Playwright] mtype from window: ${mtype}`);

        if (mtype && !mp4Url) {
            const playerUrl = `https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=${cid}/mtype=${mtype}/service=litevideo/mode=part/width=720/height=480/affi_id=${DMM_AFFILIATE_ID}/`;
            await page.goto(playerUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(5000);
        }

        // DOM内のvideo/sourceタグを確認
        if (!mp4Url) {
            mp4Url = await page.evaluate(() => {
                const video = document.querySelector('video[src*=".mp4"]');
                if (video) return video.src;
                const source = document.querySelector('source[src*=".mp4"]');
                if (source) return source.src;
                // scriptタグ内のsrcを検索
                for (const s of document.querySelectorAll('script')) {
                    const m = s.textContent.match(/"src"\s*:\s*"(\/\/cc\d+\.dmm\.co\.jp\/[^"]+\.mp4[^"]*)"/);
                    if (m) return 'https:' + m[1];
                }
                return null;
            });
        }

    } finally {
        await browser.close();
    }

    return mp4Url;
}

/**
 * 動画ファイルをローカルにダウンロードしてffmpegで処理する
 * @param {string} videoUrl litevideo URL または直接の MP4 URL
 */
async function downloadVideo(videoUrl) {
    let mp4Url = videoUrl;

    // litevideo URL の場合はMP4 URLを解決する
    if (videoUrl.includes('/litevideo/-/part/') || !videoUrl.startsWith('http')) {
        let cid = videoUrl;
        if (videoUrl.includes('/litevideo/-/')) {
            const m = videoUrl.match(/cid=([^/&]+)/);
            cid = m ? m[1] : videoUrl;
        }
        console.log(`Resolving MP4 URL for cid=${cid}...`);
        mp4Url = await getMp4UrlForCid(cid);
    }

    console.log(`Downloading MP4 from: ${mp4Url}`);
    const filePath = path.join(TEMP_DIR, `sample_${Date.now()}.mp4`);
    const { execSync } = require('child_process');
    try {
        const curlCommand = `curl -L --retry 5 --retry-delay 3 --connect-timeout 20 --max-time 300 -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -H "Referer: https://www.dmm.co.jp/" "${mp4Url.replace(/"/g, '\\"')}" -o "${filePath}"`;
        console.log(`Executing download: ${curlCommand}`);
        execSync(curlCommand, { stdio: 'inherit' });
    } catch (curlError) {
        console.error('Download failed via curl:', curlError);
        throw curlError;
    }

    console.log(`Downloaded to ${filePath}. Processing with ffmpeg...`);

    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);

    const processedFilePath = path.join(TEMP_DIR, `processed_${Date.now()}.mp4`);

    await new Promise((resolve, reject) => {
        ffmpeg(filePath)
            .setStartTime(8)
            .outputOptions('-c copy')
            .save(processedFilePath)
            .on('end', () => { cleanupVideo(filePath); resolve(); })
            .on('error', (err) => {
                console.error('FFmpeg error:', err.message);
                cleanupVideo(filePath);
                reject(err);
            });
    });

    console.log(`Video processed: ${processedFilePath}`);
    return processedFilePath;
}

/**
 * ダウンロードした動画ファイルを削除する
 */
function cleanupVideo(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up: ${filePath}`);
        }
    } catch (e) {
        console.error('Error cleaning up video:', e.message);
    }
}

module.exports = {
    fetchDmmProduct,
    downloadVideo,
    cleanupVideo
};
