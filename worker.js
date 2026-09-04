// Cloudflare Worker（免費方案即可）：把免金鑰的公開即時資料加上 CORS，轉給 GitHub Pages 上的前端用。
// 部署：Cloudflare 後台 → Workers & Pages → Create → 貼上整個檔案 → Deploy，把網址填進 index.html 的 CONFIG.liveProxy。
// 沒有任何金鑰或環境變數要設定。
const SOURCES = {
  // 臺北捷運「列車進站站名」（臺北市資料大平臺，免費、免金鑰、每 30 秒更新）
  trtc: 'https://tcgmetro.blob.core.windows.net/stationnames/stations.json',
};
const TTL_MS = 10000;                   // 同一份來源 10 秒內只抓一次，多少人同時開都一樣
const memo = new Map();
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '86400' };

async function readJsonText(res) {
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = buf[0] === 0x1f && buf[1] === 0x8b                       // 來源若是 gzip 檔就解開
    ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder('utf-8').decode(buf);
  return text.replace(/^\uFEFF/, '');
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const src = url.searchParams.get('src') || url.pathname.replace(/^\/+|\/+$/g, '');
    const target = SOURCES[src];
    if (!target) return json({ error: '未知的 src', available: Object.keys(SOURCES) }, 404);
    const hit = memo.get(src);
    if (hit && Date.now() - hit.at < TTL_MS) return new Response(hit.body, { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'hit' } });
    let res;
    try { res = await fetch(target, { headers: { accept: 'application/json' }, cf: { cacheTtl: 10, cacheEverything: true } }); }
    catch (e) { return json({ error: '來源連線失敗：' + e.message }, 502); }
    if (!res.ok) return json({ error: `來源回應 HTTP ${res.status}` }, 502);
    const body = await readJsonText(res);
    try { JSON.parse(body); } catch (e) { return json({ error: '來源不是 JSON' }, 502); }
    memo.set(src, { at: Date.now(), body });
    return new Response(body, { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'miss' } });
  }
};
