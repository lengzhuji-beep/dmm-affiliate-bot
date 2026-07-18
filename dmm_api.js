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
            sampleVideoUrl: itemWithVideo.sampleMovieURL.size_720_480 || itemWithVideo.sampleMovieURL.size_476_306 || itemWithVideo.sampleMovieURL.size_sm,
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
 * 動画ファイルをローカルにダウンロードする
 * @param {string} videoUrl ダウンロードする動画のURL
 * @returns {Promise<string>} ダウンロードしたファイルのローカルパス
 */
async function downloadVideo(videoUrl) {
    // Step 1: /litevideo/-/part/ ページから html5_player URL を取得する
    if (videoUrl.includes('/litevideo/-/part/')) {
        console.log(`Fetching litevideo part page: ${videoUrl}`);
        const res1 = await axios.get(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept-Language': 'ja,en;q=0.9',
            }
        });
        const html = res1.data;

        // 方法A: __NEXT_DATA__ から mtype トークンを取得して html5_player URL を直接構築
        let html5PlayerUrl = null;
        try {
            const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
            if (nextDataMatch) {
                const nextData = JSON.parse(nextDataMatch[1]);
                const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
                // mtype トークンは queryKey が ["dmm-base64-encode", "guest"] のクエリに格納されている
                const mtypeQuery = queries.find(q => Array.isArray(q.queryKey) && q.queryKey.includes('dmm-base64-encode'));
                const mtype = mtypeQuery?.state?.data;
                // contentId は URL または __NEXT_DATA__ から取得
                const contentIdFromData = nextData?.props?.pageProps?.contentId
                    || nextData?.query?.dmmParams?.find(p => p.startsWith('cid='))?.replace('cid=', '');
                // affi_id を URL から抽出
                const affiIdMatch = videoUrl.match(/affi_id=([^\/&]+)/);
                const affiId = affiIdMatch ? affiIdMatch[1] : DMM_AFFILIATE_ID;

                if (mtype && contentIdFromData) {
                    html5PlayerUrl = `https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=${contentIdFromData}/mtype=${mtype}/service=litevideo/mode=part/width=720/height=480/affi_id=${affiId}/`;
                    console.log(`Built html5_player URL from __NEXT_DATA__: ${html5PlayerUrl}`);
                }
            }
        } catch (e) {
            console.warn('Failed to extract mtype from __NEXT_DATA__:', e.message);
        }

        // 方法B: iframe の src を正規表現で直接取得（フォールバック）
        if (!html5PlayerUrl) {
            const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']*html5_player[^"']*)['"]/i)
                             || html.match(/<iframe[^>]+src=["']([^"']*service\/digitalapi[^"']*)['"]/i);
            if (iframeMatch) {
                html5PlayerUrl = iframeMatch[1].replace(/&amp;/g, '&');
                console.log(`Extracted html5_player URL from iframe: ${html5PlayerUrl}`);
            }
        }

        if (!html5PlayerUrl) {
            throw new Error('Could not extract html5_player URL from litevideo part page. Page structure may have changed.');
        }
        videoUrl = html5PlayerUrl;
    }

    // Step 2: html5_player ページから実際の MP4 URL を取得する
    if (videoUrl.includes('/html5_player/') || videoUrl.includes('/digitalapi/')) {
        console.log(`Fetching html5_player page: ${videoUrl}`);
        const res2 = await axios.get(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Referer': 'https://www.dmm.co.jp/',
            }
        });
        const playerHtml = res2.data;

        let mp4Url = null;

        // パターンA: const args = { src: "//..." }; 形式
        const argsMatch = playerHtml.match(/const\s+args\s*=\s*(\{[\s\S]*?\});/);
        if (argsMatch) {
            try {
                const args = JSON.parse(argsMatch[1]);
                if (args.src) {
                    mp4Url = (args.src.startsWith('//') ? 'https:' : '') + args.src;
                    console.log(`Extracted MP4 URL from args.src: ${mp4Url}`);
                }
            } catch (e) {
                console.warn('Failed to parse player args JSON:', e.message);
            }
        }

        // パターンB: src: "..." の文字列形式（JSON解析失敗時）
        if (!mp4Url) {
            const srcMatch = playerHtml.match(/"src"\s*:\s*"(\/\/[^"]+\.mp4[^"]*)"/);
            if (srcMatch) {
                mp4Url = 'https:' + srcMatch[1];
                console.log(`Extracted MP4 URL from src string: ${mp4Url}`);
            }
        }

        // パターンC: .mp4 を含む URL を直接検索
        if (!mp4Url) {
            const directMp4Match = playerHtml.match(/(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/);
            if (directMp4Match) {
                mp4Url = directMp4Match[1];
                console.log(`Extracted MP4 URL from direct match: ${mp4Url}`);
            }
        }

        if (!mp4Url) {
            throw new Error('Could not extract MP4 URL from html5_player page. Player format may have changed.');
        }
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
