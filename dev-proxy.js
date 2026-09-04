// 本機預覽（Node 18+，不用裝任何套件）：node dev-proxy.js → http://localhost:8888
// 提供 index.html 與 data/，並把 /live?src=trtc 交給 worker.js 處理（等同線上的 Cloudflare Worker）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import('./worker.js')).default;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
const PORT = Number(process.env.PORT) || 8888;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/live' || u.pathname.startsWith('/live/')) {
    const r = await worker.fetch(new Request('http://worker' + u.pathname.replace(/^\/live/, '/') + u.search));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const f = path.normalize(path.join(root, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
  if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data);
  });
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}   （示範資料：http://localhost:${PORT}/?mock=1 ）`);
  if (!fs.existsSync(path.join(root, 'data', 'index.json'))) console.log('提示：還沒有 data/ 路網資料，請先執行 node scripts/fetch-static.js（需要 .env 裡的 TDX 金鑰），或先用 ?mock=1');
});
