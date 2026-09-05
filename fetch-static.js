// 從 TDX 抓「路網靜態資料」存成 data/<系統>/<種類>.json（GitHub Actions 每週自動跑；本機：node scripts/fetch-static.js）
// 只有這支程式會用到 TDX 金鑰；每次執行約 70 次呼叫，遠低於 TDX 免費會員的點數。即時資料完全不經過 TDX。
// TDX 免費會員每分鐘只能呼叫 5 次，所以每次呼叫之間等 13 秒，整個跑完約 16 分鐘（Actions 免費額度足夠）；遇到 429 會等一分鐘再重試。
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {                                                                       // 讀 .env（本機用；Actions 用 secrets）
  for (const line of fssync.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* 沒有 .env 也可以 */ }

const TOKEN_URL = process.env.TDX_TOKEN_URL || 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE = process.env.TDX_API_BASE || 'https://tdx.transportdata.tw/api/basic/v2/';
const SYSTEMS = (process.env.TDX_SYSTEMS ?? 'TRTC,NTMC,NTDLRT,NTALRT,TYMC,TMRT,KRTC,KLRT').split(',').map(s => s.trim()).filter(Boolean);
const KINDS = ['Line', 'Station', 'StationOfRoute', 'StationOfLine', 'Shape', 'S2STravelTime', 'StationTimeTable', 'FirstLastTimetable', 'Frequency', 'StationExit'];
const SKIP = { TRTC: ['StationTimeTable'] };                                // 臺北捷運用即時進站資料，不需要幾 MB 的站別時刻表
// 台鐵（v3）與高鐵（v2）：路網 + 定期時刻表（整理成精簡的 Trains.json 給前端模擬列車位置）
const RAIL = (process.env.TDX_RAIL ?? 'TRA,THSR').split(',').map(s => s.trim()).filter(Boolean);
const RAIL_KINDS = {
  TRA:  { base: 'v3/Rail/TRA/',  kinds: ['Station', 'Line', 'StationOfLine', 'Shape', 'TrainType', 'GeneralTrainTimetable'] },
  THSR: { base: 'v2/Rail/THSR/', kinds: ['Station', 'Shape', 'GeneralTimetable'] },
};
// 公車（臺北市／新北市公車動態資訊系統的公開檔，免金鑰）：路線、站牌、線型 → data/bus/<城市>/
const BUS = (process.env.BUS_CITIES ?? 'TPE,NTPC').split(',').map(s => s.trim()).filter(Boolean);
const BUS_BLOB = { TPE: process.env.BUS_BLOB_TPE || 'https://tcgbusfs.blob.core.windows.net/blobbus/', NTPC: process.env.BUS_BLOB_NTPC || 'https://tcgbusfs.blob.core.windows.net/ntpcbus/' };
const OUT = path.join(root, 'data');
const DELAY_MS = Number(process.env.TDX_DELAY_MS) || 13000;             // 免費會員：每分鐘 5 次
const RETRY_WAIT_MS = Number(process.env.TDX_RETRY_WAIT_MS) || 65000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getToken() {
  const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) throw new Error('請設定 TDX_CLIENT_ID / TDX_CLIENT_SECRET（GitHub → Settings → Secrets，或本機 .env）');
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  if (!res.ok) throw new Error(`TDX 取得 token 失敗 (${res.status}) ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}
const firstArray = d => Array.isArray(d) ? d : (d && typeof d === 'object' && Object.values(d).find(Array.isArray)) || [];

// 行事曆：政府行政機關辦公日曆（社群整理的 JSON 鏡像），存成 data/holidays.json 給前端判斷假日班表
async function fetchCalendar() {
  const year = new Date().getFullYear(), holidays = [], workdays = [], years = [];
  for (const y of [year, year + 1]) {
    let data = null;
    for (const url of [`https://raw.githubusercontent.com/ruyut/TaiwanCalendar/master/data/${y}.json`, `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${y}.json`]) {
      try { const res = await fetch(url); if (res.ok) { data = await res.json(); break; } } catch (e) { /* 換下一個來源 */ }
    }
    if (!Array.isArray(data)) continue;
    years.push(y);
    for (const d of data) {
      const key = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}`;
      const dow = new Date(key + 'T12:00:00').getDay(), weekend = dow === 0 || dow === 6;
      if (d.isHoliday && !weekend) holidays.push(key);
      if (!d.isHoliday && weekend) workdays.push(key);
    }
  }
  if (!years.length) { console.log('  行事曆：抓不到，保留舊檔'); return; }
  await fs.writeFile(path.join(OUT, 'holidays.json'), JSON.stringify({ years, holidays, workdays, source: 'https://github.com/ruyut/TaiwanCalendar（行政院人事總處辦公日曆表）', fetchedAt: new Date().toISOString() }, null, 1));
  console.log(`  行事曆：${years.join('、')} 年，平日的國定假日 ${holidays.length} 天、週末補班 ${workdays.length} 天`);
}

// ---------- 台鐵／高鐵定期時刻表 → 精簡格式 ----------
// { trains: [{ no, type, dir, days:{Monday..}, eff, exp, stops: [[stationId, 到站分, 離站分], ...] }] }（跨午夜的站會 +1440）
const toMin = t => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function compactTrains(raw) {
  const out = [];
  for (const r of firstArray(raw)) {
    const g = r.GeneralTimetable || r;
    const info = r.TrainInfo || g.GeneralTrainInfo || g.TrainInfo || r;
    const stopsRaw = r.StopTimes || g.StopTimes || [];
    const days = r.ServiceDay || g.ServiceDay || null;
    const stops = []; let prev = -1;
    for (const st of stopsRaw.slice().sort((a, b) => (a.StopSequence || 0) - (b.StopSequence || 0))) {
      let arr = toMin(st.ArrivalTime), dep = toMin(st.DepartureTime); if (arr == null && dep == null) continue;
      if (arr == null) arr = dep; if (dep == null) dep = arr;
      if (arr < prev - 60) arr += 1440; if (dep < arr) dep += 1440;   // 跨午夜
      prev = dep; stops.push([st.StationID, arr, dep]);
    }
    if (stops.length < 2 || !info.TrainNo) continue;
    const type = (info.TrainTypeName && (info.TrainTypeName.Zh_tw || info.TrainTypeName)) || info.TrainTypeCode || '';
    out.push({ no: String(info.TrainNo), type: String(type).replace(/\(.*\)$/, ''), dir: info.Direction ?? null, days, eff: r.EffectiveDate || null, exp: r.ExpiringDate || null, stops });
  }
  return out;
}

async function tdxGet(token, url, label, stats) {
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, { headers: { authorization: 'Bearer ' + token, 'accept-encoding': 'gzip' } }); stats.calls++;
    if (res.status !== 429 || attempt >= 4) break;
    console.log(`  ${label}: 被限流 (429)，等 ${Math.round(RETRY_WAIT_MS / 1000)} 秒再試（第 ${attempt} 次）`);
    await sleep(RETRY_WAIT_MS);
  }
  return res;
}
async function fetchKind(token, url, file, label, index, stats, transform) {
  try {
    const res = await tdxGet(token, url, label, stats);
    if (res.status === 404 || res.status === 204) { await fs.writeFile(file, '[]'); index[label.split('/')[1]] = 0; console.log(`  ${label}: 無此資料`); }
    else if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    else {
      const raw = await res.json();
      const data = transform ? transform(raw) : firstArray(raw);
      await fs.writeFile(file, JSON.stringify(data));
      const n = Array.isArray(data) ? data.length : (data.trains ? data.trains.length : 1);
      index[label.split('/')[1]] = n; console.log(`  ${label}: ${n} 筆`);
    }
  } catch (e) {
    stats.failed++; index[label.split('/')[1]] = 'error: ' + e.message.slice(0, 80);   // 失敗就保留上一版檔案
    console.log(`  ${label}: 失敗，保留舊檔 — ${e.message}`);
  }
  await sleep(DELAY_MS);
}

// ---------- 公車靜態資料（臺北市／新北市公開檔，不經 TDX） ----------
async function fetchGzJson(url) {
  const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8').replace(/^\uFEFF/, '');
  return firstArray(JSON.parse(text));
}
async function fetchBusCity(city, index) {
  const base = BUS_BLOB[city]; if (!base) return;
  const dir = path.join(OUT, 'bus', city); await fs.mkdir(path.join(dir, 'route'), { recursive: true });
  const [routes, stops, shapes] = await Promise.all([fetchGzJson(base + 'GetRoute.gz'), fetchGzJson(base + 'GetStop.gz'), fetchGzJson(base + 'GetBusShape.gz').catch(() => [])]);
  // routes.json：附屬路線 ID（車機回報的）→ 主路線 ID、名稱、起迄
  const list = routes.map(r => ({ id: String(r.Id), sub: String(r.pathAttributeId ?? r.Id), name: r.nameZh || String(r.Id), subName: r.pathAttributeName || '', from: r.departureZh || '', to: r.destinationZh || '', genus: r.genus || '' }));
  await fs.writeFile(path.join(dir, 'routes.json'), JSON.stringify(list));
  // route/<主路線 ID>.json：兩方向站牌 + 線型
  const byRoute = new Map();
  for (const st of stops) {
    const rid = String(st.routeId); if (!byRoute.has(rid)) byRoute.set(rid, { stops: { 0: [], 1: [] }, shape: {} });
    const gb = String(st.goBack) === '1' ? 1 : 0;
    byRoute.get(rid).stops[gb].push({ id: String(st.Id), name: st.nameZh || '', seq: Number(st.seqNo) || 0, lat: Number(st.latitude), lon: Number(st.longitude) });
  }
  for (const sh of shapes) {
    const rid = String(sh.RouteID); const r = byRoute.get(rid); if (!r || !sh.wkt) continue;
    const gb = String(sh.GoBack) === '1' ? 1 : 0, isMain = String(sh.SubRouteID) === '-1';
    if (!r.shape[gb] || isMain) r.shape[gb] = sh.wkt;
  }
  let files = 0;
  for (const [rid, r] of byRoute) {
    for (const k of [0, 1]) r.stops[k].sort((a, b) => a.seq - b.seq);
    await fs.writeFile(path.join(dir, 'route', rid + '.json'), JSON.stringify(r)); files++;
  }
  index[city] = { routes: list.length, stops: stops.length, shapes: shapes.length, files };
  console.log(`  公車 ${city}：${list.length} 條路線、${stops.length} 站牌、${shapes.length} 筆線型，寫入 ${files} 個路線檔`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await fetchCalendar().catch(e => console.log('  行事曆失敗：' + e.message));
  const index = { generatedAt: new Date().toISOString(), source: 'TDX 運輸資料流通服務 https://tdx.transportdata.tw/ ＋ 臺北市公車動態資訊系統公開檔', systems: {}, bus: {} };
  for (const city of BUS) await fetchBusCity(city, index.bus).catch(e => { index.bus[city] = 'error: ' + e.message.slice(0, 80); console.log(`  公車 ${city} 失敗，保留舊檔 — ${e.message}`); });
  if (!SYSTEMS.length && !RAIL.length) { await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1)); return; }
  const token = await getToken();
  const stats = { calls: 0, failed: 0 };
  for (const sys of SYSTEMS) {
    const dir = path.join(OUT, sys); await fs.mkdir(dir, { recursive: true }); index.systems[sys] = {};
    for (const kind of KINDS) {
      if ((SKIP[sys] || []).includes(kind)) continue;
      await fetchKind(token, `${API_BASE}Rail/Metro/${kind}/${sys}?$format=JSON&$top=100000`, path.join(dir, kind + '.json'), `${sys}/${kind}`, index.systems[sys], stats);
    }
  }
  for (const sys of RAIL) {
    const cfg = RAIL_KINDS[sys]; if (!cfg) continue;
    const dir = path.join(OUT, sys); await fs.mkdir(dir, { recursive: true }); index.systems[sys] = {};
    const railBase = API_BASE.replace(/v2\/$/, '');                            // API_BASE 預設以 v2/ 結尾；台鐵用 v3
    for (const kind of cfg.kinds) {
      const isTT = /Timetable$/.test(kind);
      await fetchKind(token, `${railBase}${cfg.base}${kind}?$format=JSON&$top=100000`, path.join(dir, (isTT ? 'Trains' : kind) + '.json'), `${sys}/${isTT ? 'Trains' : kind}`, index.systems[sys], stats,
        isTT ? raw => ({ generatedAt: new Date().toISOString(), trains: compactTrains(raw) }) : null);
    }
  }
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`完成：${stats.calls} 次呼叫，${stats.failed} 個失敗，寫入 ${OUT}`);
  if (stats.failed && stats.failed === stats.calls) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
