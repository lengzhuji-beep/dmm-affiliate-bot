const axios = require('axios');

async function testExtraction() {
    let videoUrl = 'https://www.dmm.co.jp/litevideo/-/part/=/cid=mvsd00687/size=720_480/affi_id=jonkimu-990/';

    if (videoUrl.includes('/litevideo/-/part/')) {
        const res1 = await axios.get(videoUrl);
        const iframeMatch = res1.data.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        if (iframeMatch) {
            videoUrl = iframeMatch[1];
            videoUrl = videoUrl.replace(/&amp;/g, '&');
            console.log('Found iframe URL:', videoUrl);
        }
    }

    if (videoUrl.includes('/html5_player/')) {
        const res2 = await axios.get(videoUrl);
        const argsMatch = res2.data.match(/const args = ({.*?});/);
        if (argsMatch) {
            try {
                const args = JSON.parse(argsMatch[1]);
                if (args.src) {
                    videoUrl = 'https:' + args.src;
                    console.log('Found MP4 URL:', videoUrl);
                }
            } catch (e) {
                console.error('Failed to parse args:', e.message);
            }
        } else {
             console.log('Args not found in iframe HTML.');
        }
    }
}
testExtraction();
