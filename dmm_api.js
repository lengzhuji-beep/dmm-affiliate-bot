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

        // サンプル動画がある、かつ、未投稿の商品を抽出
        const itemsWithVideo = items.filter(item => {
            const contentId = item.content_id || item.product_id;
            return item.sampleMovieURL && item.sampleMovieURL.size_720_480 && !postedIds.includes(contentId);
        });
        
        if (!itemsWithVideo || itemsWithVideo.length === 0) {
            console.log('No new items found in current results. Consider broadening search or wait.');
            // 全て投稿済みだった場合、古いものから再投稿することも可能ですが、
            // 今回はエラーを投げるか、または一番古い投稿を返すなどの処理が考えられます。
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

        // 商品の紹介文（説明文）をlitevideoページから取得
        let productText = '';
        try {
            const liteVideoUrl = `https://www.dmm.co.jp/litevideo/-/part/=/cid=${contentId}/size=720_480/`;
            const htmlRes = await axios.get(liteVideoUrl);
            const dataMatch = htmlRes.data.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
            if (dataMatch) {
                const jsonData = JSON.parse(dataMatch[1]);
                const queries = jsonData?.props?.pageProps?.dehydratedState?.queries || [];
                const contentQuery = queries.find(q => q.state?.data?.videoContent);
                const text = contentQuery?.state?.data?.videoContent?.text || '';
                productText = text.replace(/<br\s*\/?>/gi, ' ')
                                  .replace(/\r?\n|\r/g, ' ')
                                  .replace(/\s+/g, ' ')
                                  .replace(/<\/?[^>]+(>|$)/g, "")
                                  .trim();
            }
        } catch (e) {
            console.warn('Failed to fetch detailed description, skipping...', e.message);
        }

        // ハッシュタグの生成
        const keywordTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.keyword ? itemWithVideo.iteminfo.keyword.map(k=>`#${k.name}`) : [];
        const genreTags = itemWithVideo.iteminfo && itemWithVideo.iteminfo.genre ? itemWithVideo.iteminfo.genre.map(g=>`#${g.name}`) : [];
        const allTags = [...new Set([...keywordTags, ...genreTags])].join(' ');

        return {
            contentId: contentId, // あとで保存するために追加
            title: itemWithVideo.title,
            affiliateUrl: customAffiliateUrl,
            sampleVideoUrl: contentId, // content IDを渡してCDN URLを直接構築する
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

    // Step2: html5_player ページから args.src を取得
    const playerUrl = `https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=${cid}/mtype=${mtype}/service=litevideo/mode=part/width=720/height=480/affi_id=${DMM_AFFILIATE_ID}/`;
    console.log(`Step2: Fetching html5_player page...`);
    const res2 = await axios.get(playerUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Referer': partUrl,
        },
        timeout: 15000
    });

    const playerHtml = res2.data;

    // args.src を抽出（複数行対応のため /s フラグは不要だが念のため試行する）
    const argsMatch = playerHtml.match(/const\s+args\s*=\s*(\{[^;]+\});/);
    if (argsMatch) {
        try {
            const args = JSON.parse(argsMatch[1]);
            if (args.src) {
                const mp4Url = args.src.startsWith('//') ? 'https:' + args.src : args.src;
                console.log(`Step2 OK: args.src=${mp4Url}`);
                return mp4Url;
            }
        } catch (e) {
            console.warn('Failed to parse args JSON:', e.message);
        }
    }

    // フォールバック: .mp4 を含むURL を直接検索
    const mp4Match = playerHtml.match(/(\/\/cc\d+\.dmm\.co\.jp\/[^\s"'<>]+\.mp4[^\s"'<>]*)/);
    if (mp4Match) {
        const mp4Url = 'https:' + mp4Match[1];
        console.log(`Step2 OK (fallback): ${mp4Url}`);
        return mp4Url;
    }

    throw new Error(`Could not extract MP4 URL from html5_player page for cid=${cid}`);
}

/**
 * 動画ファイルをローカルにダウンロードする
 * @param {string} videoUrl ダウンロードする動画のURL（またはcontent ID）
 * @returns {Promise<string>} ダウンロードしたファイルのローカルパス
 */
async function downloadVideo(videoUrl) {
    let mp4Url = null;

    // content IDが渡された場合（litevideo URLではなくIDそのもの）はMP4 URLを解決する
    const isContentId = !videoUrl.startsWith('http');
    const isLitevideoUrl = videoUrl.includes('/litevideo/-/part/');

    if (isContentId || isLitevideoUrl) {
        let cid = videoUrl;
        if (isLitevideoUrl) {
            const m = videoUrl.match(/cid=([^/&]+)/);
            cid = m ? m[1] : videoUrl;
        }
        console.log(`Resolving MP4 URL for content ID: ${cid}`);
        mp4Url = await getMp4UrlByContentId(cid);
        videoUrl = mp4Url;
    }


    console.log(`Downloading direct MP4 from: ${videoUrl}`);
    const fileName = `sample_${Date.now()}.mp4`;
    const filePath = path.join(TEMP_DIR, fileName);

    const writer = fs.createWriteStream(filePath);

    try {
        const response = await axios({
            url: videoUrl,
            method: 'GET',
            responseType: 'stream'
        });

        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        console.log(`Downloaded to ${filePath}. Trimming the black screen...`);
        
        // ffmpegパッケージの読み込み
        const ffmpeg = require('fluent-ffmpeg');
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);
        
        const processedFileName = `processed_${Date.now()}.mp4`;
        const processedFilePath = path.join(TEMP_DIR, processedFileName);
        
        // 最初の8秒をカットし、実際のシーンをサムネイル（最初のフレーム）にする
        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .setStartTime(8)
                .outputOptions('-c copy')
                .save(processedFilePath)
                .on('end', () => {
                    // 元の動画を削除
                    cleanupVideo(filePath);
                    resolve();
                })
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
    cleanupVideo
};
