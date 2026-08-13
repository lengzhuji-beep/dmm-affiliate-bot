const axios = require('axios');

(async () => {
    const cid = '1hawa00373';
    const affiId = 'jonkimu-990';

    // Step1: litevideo/partページからmtypeを取得
    console.log('Step1: Fetching litevideo part page...');
    const res1 = await axios.get('https://www.dmm.co.jp/litevideo/-/part/=/cid=' + cid + '/size=720_480/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000
    });
    const m = res1.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) { console.log('No NEXT_DATA found'); return; }
    const d = JSON.parse(m[1]);
    const queries = d?.props?.pageProps?.dehydratedState?.queries || [];
    const mtypeQ = queries.find(q => Array.isArray(q.queryKey) && q.queryKey.includes('dmm-base64-encode'));
    const mtype = mtypeQ?.state?.data;
    console.log('mtype:', mtype);

    // Step2: html5_playerページを取得
    const playerUrl = `https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=${cid}/mtype=${mtype}/service=litevideo/mode=part/width=720/height=480/affi_id=${affiId}/`;
    console.log('Player URL:', playerUrl);
    const res2 = await axios.get(playerUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.dmm.co.jp/'
        },
        timeout: 10000
    });

    const html = res2.data;
    console.log('Player HTML length:', html.length);
    console.log('Has .mp4:', html.includes('.mp4'));

    // 各パターンで検索
    const argsM = html.match(/const\s+args\s*=\s*(\{[\s\S]*?\});/);
    if (argsM) {
        try {
            const a = JSON.parse(argsM[1]);
            console.log('args.src:', a.src);
        } catch (e) {
            console.log('args raw:', argsM[1].substring(0, 200));
        }
    } else {
        console.log('No const args found');
    }

    // mp4を含む行を探す
    const lines = html.split('\n');
    lines.forEach((line, i) => {
        if (line.includes('.mp4')) console.log(`Line ${i}: ${line.trim().substring(0, 150)}`);
    });

    // scriptタグの中身を表示
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
    console.log('Script tags count:', scripts.length);
    scripts.forEach((s, i) => {
        if (s.includes('.mp4') || s.includes('src')) {
            console.log(`Script ${i} (first 300):`, s.substring(0, 300));
        }
    });

})().catch(e => console.log('Error:', e.message));
