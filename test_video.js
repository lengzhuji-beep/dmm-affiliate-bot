const axios = require('axios');
const fs = require('fs');

async function test() {
    try {
        const res = await axios.get('https://www.dmm.co.jp/litevideo/-/part/=/cid=mvsd00687/size=720_480/affi_id=jonkimu-990/');
        fs.writeFileSync('temp_html.txt', res.data);
        console.log('Saved temp_html.txt');
    } catch (e) {
        console.error(e.message);
    }
}
test();
