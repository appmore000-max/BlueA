// 從 TDX 抓「路網靜態資料」存成 data/<系統>/<種類>.json（GitHub Actions 每週自動跑；本機：node scripts/fetch-static.js）
// 只有這支程式會用到 TDX 金鑰；每次執行約 70 次呼叫，遠低於 TDX 免費會員的額度。即時資料完全不經過 TDX。
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {                                                                       // 讀 .env（本機用；Actions 用 secrets）
  for (const line of fssync.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* 沒有 .env 也可以 */ }

const TOKEN_URL = process.env.TDX_TOKEN_URL || 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const API_BASE = process.env.TDX_API_BASE || 'https://tdx.transportdata.tw/api/basic/v2/';
const SYSTEMS = (process.env.TDX_SYSTEMS || 'TRTC,NTMC,NTDLRT,NTALRT,TYMC,TMRT,KRTC,KLRT').split(',').map(s => s.trim()).filter(Boolean);
const KINDS = ['Line', 'Station', 'StationOfRoute', 'StationOfLine', 'Shape', 'S2STravelTime', 'StationTimeTable', 'FirstLastTimetable', 'Frequency'];
const SKIP = { TRTC: ['StationTimeTable'] };                                // 臺北捷運用即時進站資料，不需要幾 MB 的站別時刻表
const OUT = path.join(root, 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getToken() {
  const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) throw new Error('請設定 TDX_CLIENT_ID / TDX_CLIENT_SECRET（GitHub → Settings → Secrets，或本機 .env）');
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  if (!res.ok) throw new Error(`TDX 取得 token 失敗 (${res.status}) ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}
const firstArray = d => Array.isArray(d) ? d : (d && typeof d === 'object' && Object.values(d).find(Array.isArray)) || [];

async function main() {
  const token = await getToken();
  await fs.mkdir(OUT, { recursive: true });
  const index = { generatedAt: new Date().toISOString(), source: 'TDX 運輸資料流通服務 https://tdx.transportdata.tw/', systems: {} };
  let calls = 0, failed = 0;
  for (const sys of SYSTEMS) {
    const dir = path.join(OUT, sys); await fs.mkdir(dir, { recursive: true }); index.systems[sys] = {};
    for (const kind of KINDS) {
      if ((SKIP[sys] || []).includes(kind)) continue;
      const file = path.join(dir, kind + '.json');
      const url = `${API_BASE}Rail/Metro/${kind}/${sys}?$format=JSON&$top=100000`;
      try {
        const res = await fetch(url, { headers: { authorization: 'Bearer ' + token, 'accept-encoding': 'gzip' } }); calls++;
        if (res.status === 404 || res.status === 204) { await fs.writeFile(file, '[]'); index.systems[sys][kind] = 0; console.log(`  ${sys}/${kind}: 無此資料`); }
        else if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
        else {
          const arr = firstArray(await res.json());
          await fs.writeFile(file, JSON.stringify(arr));
          index.systems[sys][kind] = arr.length; console.log(`  ${sys}/${kind}: ${arr.length} 筆`);
        }
      } catch (e) {
        failed++; index.systems[sys][kind] = 'error';                       // 失敗就保留上一版檔案
        console.log(`  ${sys}/${kind}: 失敗，保留舊檔 — ${e.message}`);
      }
      await sleep(250);
    }
  }
  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`完成：${calls} 次呼叫，${failed} 個失敗，寫入 ${OUT}`);
  if (failed && failed === calls) process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });
