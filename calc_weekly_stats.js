const fs = require('fs');

const raw = JSON.parse(fs.readFileSync('./impressions_raw.json', 'utf8'));

// 自アカウントのポストのみを抽出 (重複除外)
const seen = new Set();
const myPosts = raw.filter(p => {
    if (!p.url.includes('av_favorite_av')) return false;
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
});

function parseViews(viewsStr) {
    if (!viewsStr) return 0;
    viewsStr = viewsStr.replace(/,/g, '').trim();
    if (viewsStr.includes('万')) {
        const num = parseFloat(viewsStr.replace('万', ''));
        return Math.round(num * 10000);
    }
    if (viewsStr.includes('K') || viewsStr.includes('k')) {
        const num = parseFloat(viewsStr.replace(/[Kk]/, ''));
        return Math.round(num * 1000);
    }
    if (viewsStr.includes('M') || viewsStr.includes('m')) {
        const num = parseFloat(viewsStr.replace(/[Mm]/, ''));
        return Math.round(num * 1000000);
    }
    const parsed = parseInt(viewsStr, 10);
    return isNaN(parsed) ? 0 : parsed;
}

function getWeekLabel(dateStr) {
    const d = new Date(dateStr);
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(d);
    monday.setUTCDate(diff);
    const year = monday.getUTCFullYear();
    const month = String(monday.getUTCMonth() + 1).padStart(2, '0');
    const date = String(monday.getUTCDate()).padStart(2, '0');
    return `${year}/${month}/${date}週`;
}

const weeklyData = {};

myPosts.forEach(post => {
    const views = parseViews(post.viewsText);
    const week = getWeekLabel(post.datetime);

    if (!weeklyData[week]) {
        weeklyData[week] = {
            postCount: 0,
            totalViews: 0,
            maxViews: 0,
            posts: []
        };
    }

    weeklyData[week].postCount += 1;
    weeklyData[week].totalViews += views;
    if (views > weeklyData[week].maxViews) {
        weeklyData[week].maxViews = views;
    }
    weeklyData[week].posts.push({ ...post, views });
});

console.log('=== @av_favorite_av 週別インプレッション集計レポート ===');
console.log(`集計対象ポスト数: ${myPosts.length}件\n`);

const sortedWeeks = Object.keys(weeklyData).sort().reverse();

sortedWeeks.forEach(week => {
    const data = weeklyData[week];
    const avgViews = Math.round(data.totalViews / data.postCount);
    console.log(`【${week}】`);
    console.log(`  投稿数: ${data.postCount}件`);
    console.log(`  合計インプレッション: ${data.totalViews.toLocaleString()} 回`);
    console.log(`  平均インプレッション: ${avgViews.toLocaleString()} 回/投稿`);
    console.log(`  最高インプレッション: ${data.maxViews.toLocaleString()} 回\n`);
});

fs.writeFileSync('./weekly_report.json', JSON.stringify({ myPostsCount: myPosts.length, weeklyData }, null, 2));
