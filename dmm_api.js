require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DMM_API_ID = process.env.DMM_API_ID;
const DMM_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID;
const TEMP_DIR = path.join(__dirname, 'temp_videos');

// テンポラリディレクトリの作成
if (!fs.existsSync(TEMP_DIR)){
    fs.mkdirSync(TEMP_DIR);
}

/**
 * DMM APIから商品情報を取得する
 * @param {string} keyword 検索キーワード（任意）
 * @returns {Promise<Object>} 商品情報（タイトル、アフィリエイトリンク、動画URLなど）
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
            hits: 100, // 人気上位100件を取得
            sort: 'rank', // 人気順（ランキング）で取得
            output: 'json'
        };
        if (keyword) params.keyword = keyword;

        const response = await axios.get(url, { params });
        const items = response.data.result.items;

        if (!items || items.length === 0) {
            throw new Error('No items found.');
        }

        // --- 過去の投稿履歴を読み込む ---
        const postedIdsFile = path.join(__dirname, 'posted_ids.json');
        let postedIds = [];
        if (fs.existsSync(postedIdsFile)) {
            try {
                postedIds = JSON.parse(fs.readFileSync(postedIdsFile, 'utf8'));
            } catch (e) {
                console.warn('Failed to parse posted_ids.json, starting fresh.');
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

        // --- 人気かつ新しい商品を選ぶロジック ---
        // 1. 取得した未投稿の人気商品を、発売日が新しい順に並び替える
        const sortedByDate = itemsWithVideo.sort((a, b) => {
            const dateA = new Date(a.date.replace(' ', 'T'));
            const dateB = new Date(b.date.replace(' ', 'T'));
            return dateB - dateA;
        });

        // 2. その中の上位20件（人気100位以内かつ未投稿の最新20本）を候補とする
        const recentPopularCandidates = sortedByDate.slice(0, 20);

        // 3. 候補の中からランダムに1つ選ぶ
        const randomIndex = Math.floor(Math.random() * recentPopularCandidates.length);
        const itemWithVideo = recentPopularCandidates[randomIndex];

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

        // ハッシュタグの生成
        const keywordTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.keyword ? itemWithVideo.iteminfo.keyword.map(k=>`#${k.name}`) : [];
        const genreTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.genre ? itemWithVideo.iteminfo.genre.map(g=>`#${g.name}`) : [];
        const allTags = [...new Set([...keywordTags, ...genreTags])].join(' ');

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
 * content IDからDMMサンプル動画のMP4 URLを取得する
 * __NEXT_DATA__ → html5_player → args.src の3ステップで取得
 * @param {string} contentId DMM商品のcontent ID
 * @returns {Promise<string>} MP4ファイルのURL
 */
async function getMp4UrlByContentId(contentId) {
    const cid = contentId;

    // Step1: litevideo/partページから mtype トークンを取得
    console.log(`Step1: Fetching litevideo part page for cid=${cid}...`);
    const partUrl = `https://www.dmm.co.jp/litevideo/-/part/=/cid=${cid}/size=720_480/`;
    const res1 = await axios.get(partUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
            'Referer': 'https://www.dmm.co.jp/',
        },
        timeout: 15000
    });

    const nextDataMatch = res1.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nextDataMatch) {
        throw new Error(`__NEXT_DATA__ not found in litevideo part page for cid=${cid}`);
    }
    const nextData = JSON.parse(nextDataMatch[1]);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
    const mtypeQuery = queries.find(q => Array.isArray(q.queryKey) && q.queryKey.includes('dmm-base64-encode'));
    const mtype = mtypeQuery?.state?.data;
    if (!mtype) {
        throw new Error(`mtype token not found in __NEXT_DATA__ for cid=${cid}`);
    }
    console.log(`Step1 OK: mtype=${mtype}`);

/**
 * サンプル画像URLリストからスライドショー動画を生成する
 * pics.dmm.co.jp はIP制限がなく海外からもアクセス可能
 * @param {string[]} imageUrls 画像URLの配列
 * @returns {Promise<string>} 生成した動画ファイルのパス
 */
async function createSlideshowVideo(imageUrls) {
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);

    if (!imageUrls || imageUrls.length === 0) {
        throw new Error('No image URLs provided for slideshow creation.');
    }

    console.log(`Creating slideshow from ${imageUrls.length} images...`);

    // 画像をダウンロード
    const imageFiles = [];
    for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        const imgPath = path.join(TEMP_DIR, `slide_${Date.now()}_${i}.jpg`);
        try {
            const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 10000 });
            const writer = fs.createWriteStream(imgPath);
            res.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            imageFiles.push(imgPath);
            console.log(`Downloaded image ${i + 1}/${imageUrls.length}`);
        } catch (e) {
            console.warn(`Failed to download image ${i + 1}: ${e.message}`);
        }
    }

    if (imageFiles.length === 0) {
        throw new Error('All image downloads failed.');
    }

    // ffmpegのconcat用ファイルリストを作成（1枚あたり3秒）
    const listPath = path.join(TEMP_DIR, `concat_${Date.now()}.txt`);
    const listContent = imageFiles.map(f => `file '${f.replace(/'/g, "\\'")}'\nduration 3`).join('\n')
        + `\nfile '${imageFiles[imageFiles.length - 1].replace(/'/g, "\\'")}'\n`;
    fs.writeFileSync(listPath, listContent);

    const outputPath = path.join(TEMP_DIR, `slideshow_${Date.now()}.mp4`);

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(listPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions([
                '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p',
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                '-movflags', '+faststart',
                '-r', '30',
            ])
            .save(outputPath)
            .on('end', () => {
                console.log(`Slideshow created: ${outputPath}`);
                // 一時ファイルを削除
                imageFiles.forEach(f => cleanupVideo(f));
                cleanupVideo(listPath);
                resolve();
            })
            .on('error', (err) => {
                console.error('FFmpeg slideshow error:', err.message);
                imageFiles.forEach(f => cleanupVideo(f));
                cleanupVideo(listPath);
                reject(err);
            });
    });

    return outputPath;
}

/**
 * 動画ファイルをURLからダウンロードしてffmpegで処理する
 * @param {string} videoUrl ダウンロードする動画のURL
 * @returns {Promise<string>} ダウンロードしたファイルのローカルパス
 */
async function downloadVideo(videoUrl) {
    console.log(`Downloading direct MP4 from: ${videoUrl}`);
    const fileName = `sample_${Date.now()}.mp4`;
    const filePath = path.join(TEMP_DIR, fileName);
    const writer = fs.createWriteStream(filePath);

    try {
        const response = await axios({
            url: videoUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000,
        });

        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`Downloaded to ${filePath}. Trimming the black screen...`);

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
                    console.error('FFmpeg processing error:', err.message);
                    reject(err);
                });
        });

        console.log(`Video processed. New path: ${processedFilePath}`);
        return processedFilePath;

    } catch (error) {
        console.error('Error downloading video:', error.message);
        throw error;
    }
}


/**
 * ダウンロードした動画ファイルを削除する
 * @param {string} filePath 削除するファイルのパス
 */
function cleanupVideo(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up temp video: ${filePath}`);
        }
    } catch (e) {
        console.error('Error cleaning up video:', e.message);
    }
}

module.exports = {
    fetchDmmProduct,
    downloadVideo,
    createSlideshowVideo,
    cleanupVideo
};
