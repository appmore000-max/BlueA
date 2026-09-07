// Cloudflare Worker（免費方案即可）：把免金鑰的公開即時資料加上 CORS，轉給 GitHub Pages 上的前端用。
// 部署：Cloudflare 後台 → Workers & Pages → Create → 貼上整個檔案 → Deploy，把網址填進 index.html 的 CONFIG.liveProxy。
// 沒有任何金鑰或環境變數要設定。
const SOURCES = {
  // 臺北捷運「列車進站站名」（臺北市資料大平臺，免費、免金鑰、每 30 秒更新）
  trtc: 'https://tcgmetro.blob.core.windows.net/stationnames/stations.json',
  // 臺中捷運官網首頁的「捷運營運狀態：全線正常營運（目前班距 9 分鐘）」→ 整理成 JSON（每分鐘最多抓一次）
  tmrt_status: { url: 'https://www.tmrt.com.tw/', parse: 'tmrt_status', ttl: 60000 },
  // 臺北市／新北市公車動態（公車動態資訊系統公開檔，免金鑰）：整包 gzip 原樣轉給瀏覽器解壓，Worker 不花 CPU
  bus_tpe:  { url: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetBusData.gz',  raw: true, ttl: 15000 },
  bus_ntpc: { url: 'https://tcgbusfs.blob.core.windows.net/ntpcbus/GetBusData.gz', raw: true, ttl: 15000 },
  // 臺北捷運「會員專屬 API」：車廂擁擠度（高運量 6 節、文湖線 4 節，每 30 秒）。需要向北捷申請 API 會員（免費）後，
  // 在 Cloudflare 的 Worker 設定 → Variables and Secrets 加上 TRTC_USER、TRTC_PASS；沒設定就回 404，前端會自動略過。
  // 端點與方法名稱若與北捷給你的規格不同，可用 TRTC_CW_URL / TRTC_CW_METHOD / TRTC_CWBR_URL / TRTC_CWBR_METHOD 覆蓋。
  trtc_carweight: { special: 'trtc_carweight', ttl: 25000 },
};
const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function soapCall(url, method, params) {
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://tempuri.org/">${Object.entries(params).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</${method}></soap:Body></soap:Envelope>`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `http://tempuri.org/${method}` }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  const m = text.match(new RegExp(`<${method}Result[^>]*>([\\s\\S]*?)</${method}Result>`));
  const inner = (m ? m[1] : text).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
  try { return JSON.parse(inner); } catch (e) { throw new Error('回應不是 JSON：' + inner.slice(0, 160)); }
}
// 把各種可能的欄位名整理成 { trainNo, station, dir, cars:[等級…], time }
function normalizeCarWeight(list, lineHint) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : (list && (list.data || list.Data || Object.values(list).find(Array.isArray))) || [])) {
    if (!r || typeof r !== 'object') continue;
    const cars = Object.keys(r).filter(k => /^cart?\s*\d+/i.test(k)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0])).map(k => Number(String(r[k]).replace(/\D/g, '')) || null);
    if (!cars.length) continue;
    out.push({ trainNo: String(r.TrainNumber ?? r.TrainNo ?? r.TrainID ?? r.TrainId ?? ''), station: String(r.StationID ?? r.StationName ?? r.Station ?? r.StaName ?? r.StationCode ?? ''), dir: String(r.CID ?? r.Direction ?? r.Dir ?? r.UpDown ?? ''), cars, time: r.UpdateTime ?? r.DataTime ?? r.NowDateTime ?? r.Time ?? null, line: lineHint });
  }
  return out;
}
async function trtcCarWeight(env) {
  if (!env || !env.TRTC_USER || !env.TRTC_PASS) return { status: 404, body: { error: '未設定 TRTC_USER / TRTC_PASS（需向臺北捷運申請 API 會員）' } };
  const params = { userName: env.TRTC_USER, passWord: env.TRTC_PASS };
  const jobs = [
    { url: env.TRTC_CW_URL || 'https://api.metro.taipei/metroapi/CarWeight.asmx', method: env.TRTC_CW_METHOD || 'getCarWeightByInfo', line: 'HC' },
    { url: env.TRTC_CWBR_URL || 'https://api.metro.taipei/metroapi/CarWeightBR.asmx', method: env.TRTC_CWBR_METHOD || 'getCarWeightBRInfo', line: 'BR' },
  ];
  const trains = [], errors = [], samples = [];
  for (const j of jobs) {
    try { const data = await soapCall(j.url, j.method, params); const arr = Array.isArray(data) ? data : (data && Object.values(data).find(Array.isArray)) || []; samples.push(...arr.slice(0, 1)); trains.push(...normalizeCarWeight(data, j.line)); }
    catch (e) { errors.push(`${j.line}: ${e.message}`); }
  }
  return { status: 200, body: { updated: new Date().toISOString(), trains, errors, sample: samples } };
}
function parseTmrtStatus(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/營運狀態\s*[:：]\s*([^（(]{2,40}?)\s*[（(]\s*目前班距\s*(\d+)\s*分鐘?\s*[）)]/);
  const m2 = !m && text.match(/營運狀態\s*[:：]\s*([^\s（(]{2,40})/);
  return { status: m ? m[1].trim() : m2 ? m2[1].trim() : null, headwayMin: m ? Number(m[2]) : null, fetchedAt: new Date().toISOString() };
}
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
// gzip 檔原樣轉送：標 content-encoding，瀏覽器會自己解壓；encodeBody:'manual' 告訴 Cloudflare 內容已經壓縮過
function rawResponse(bytes, cache) {
  const u8 = new Uint8Array(bytes), isGz = u8[0] === 0x1f && u8[1] === 0x8b;
  const headers = { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': cache };
  if (isGz) headers['content-encoding'] = 'gzip';
  return new Response(bytes, { headers, encodeBody: isGz ? 'manual' : 'automatic' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const src = url.searchParams.get('src') || url.pathname.replace(/^\/+|\/+$/g, '');
    const entry = SOURCES[src];
    if (!entry) return json({ error: '未知的 src', available: Object.keys(SOURCES) }, 404);
    const target = typeof entry === 'string' ? entry : entry.url, ttl = (typeof entry === 'object' && entry.ttl) || TTL_MS;
    if (typeof entry === 'object' && entry.special === 'trtc_carweight') {
      const hit0 = memo.get(src); if (hit0 && Date.now() - hit0.at < ttl) return new Response(hit0.body, { status: hit0.status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'hit' } });
      const r = await trtcCarWeight(env); const body = JSON.stringify(r.body);
      memo.set(src, { at: Date.now(), body, status: r.status });
      return new Response(body, { status: r.status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'miss' } });
    }
    const hit = memo.get(src);
    if (hit && Date.now() - hit.at < ttl) return hit.raw ? rawResponse(hit.body, 'hit') : new Response(hit.body, { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'hit' } });
    let res;
    try { res = await fetch(target, { headers: { accept: 'application/json, text/html', 'user-agent': 'tw-mrt-live (github pages; personal project)' }, cf: { cacheTtl: 10, cacheEverything: true } }); }
    catch (e) { return json({ error: '來源連線失敗：' + e.message }, 502); }
    if (!res.ok) return json({ error: `來源回應 HTTP ${res.status}` }, 502);
    if (typeof entry === 'object' && entry.raw) {                       // 大檔：不解析，原樣（gzip）轉送
      const bytes = await res.arrayBuffer();
      memo.set(src, { at: Date.now(), body: bytes, raw: true });
      return rawResponse(bytes, 'miss');
    }
    let body = await readJsonText(res);
    if (typeof entry === 'object' && entry.parse === 'tmrt_status') body = JSON.stringify(parseTmrtStatus(body));
    try { JSON.parse(body); } catch (e) { return json({ error: '來源不是 JSON' }, 502); }
    memo.set(src, { at: Date.now(), body });
    return new Response(body, { headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'miss' } });
  }
};
