require('dotenv').config();
const https = require('https');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in .env');
    process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

console.log('Fetching available Gemini models...');
https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.error) {
                console.error('API Error:', json.error);
            } else {
                console.log('Available Models:');
                if (json.models) {
                    json.models.forEach(m => {
                        console.log(`- ${m.name} (supports: ${m.supportedGenerationMethods.join(', ')})`);
                    });
                } else {
                    console.log('No models list found:', json);
                }
            }
        } catch (e) {
            console.error('Parse error:', e.message, 'Raw data:', data);
        }
    });
}).on('error', (e) => {
    console.error('Request error:', e.message);
});
