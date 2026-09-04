# 台灣捷運即時位置圖（GitHub Pages 版，零費用）

單一 `index.html`（Leaflet 地圖，無 build step），放在 **GitHub Pages**。全部免費、不需要信用卡：

| 項目 | 用什麼 | 費用 |
|---|---|---|
| 網站 | GitHub Pages | 免費（公開 repo） |
| 路網資料（路線、車站、線型、時刻表） | GitHub Actions 每週從 TDX 抓一次存進 `data/` | Actions 公開 repo 免費；TDX 註冊免費，每週約 70 次呼叫，只用到免費額度的零頭 |
| 臺北捷運即時列車 | 臺北市資料大平臺的「臺北捷運列車到站站名」公開 JSON（免金鑰、每 30 秒） | 免費 |
| 幫即時資料加 CORS 的小代理 | Cloudflare Worker（貼一個檔案即可） | 免費方案每天 10 萬次請求，本站每個開著的分頁每 15 秒 1 次 |

之前的 Netlify Function 版本已整個拿掉。**為什麼要改**：TDX 從 2024 年起改成點數制（基礎服務 1 點＝1,500 次呼叫，超出免費點數就要買點），免費會員每月的點數很少；即時看板每 15 秒抓 4 個系統一天就兩萬多次，一定會超出，所以即時資料不能再走 TDX。這一版 TDX 只用來抓「路網靜態資料」，一週一次。

## 各系統能看到什麼

| 系統 | 列車位置來源 | 說明 |
|---|---|---|
| 臺北捷運（文湖、淡水信義、松山新店、中和新蘆、板南） | **真實進站資料** | 官方公開 JSON 每 30 秒列出「哪個月台有列車、往哪裡」；離站後用站間行駛時間推算，到下一站再被資料校正 |
| 新北捷運（環狀線等）、淡海輕軌、安坑輕軌、桃園捷運、高雄捷運、高雄輕軌 | 站別時刻表推估 | 這些系統沒有免費的即時資料；用 TDX 的站別時刻表算「現在應該有哪些車、在哪裡」（虛線框標示） |
| 臺中捷運 | 首末班車＋班距模擬 | TDX 沒有中捷的站別時刻表；有首末班車與班距資料就模擬，沒有就只畫路線（虛線框標示） |

實際哪些系統有時刻表／班距資料，以 Actions 抓下來的 `data/index.json` 為準；程式會依資料自動選擇模式，左側面板會寫清楚每個系統目前是哪一種。

## 部署（照順序做一次）

1. **建 GitHub repo（Public）**，把這個資料夾的檔案推到 `main`。
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 到 [TDX](https://tdx.transportdata.tw/) 註冊（免費）→ 會員中心 → 資料服務 → API 金鑰，取得 Client Id / Secret。
   **Settings → Secrets and variables → Actions → New repository secret** 新增 `TDX_CLIENT_ID`、`TDX_CLIENT_SECRET`。
4. **Actions → 「更新資料並部署」→ Run workflow**。跑完後 `data/` 會被 commit 進 repo，網站上線（網址在 Settings → Pages 看）。之後每週一凌晨會自動重抓一次。
5. **Cloudflare Worker**（臺北捷運即時資料用）：到 [Cloudflare](https://dash.cloudflare.com/) 註冊（免費、不用信用卡）→ Workers & Pages → Create → Start with Hello World → Deploy → Edit code → 把 `worker.js` 全部內容貼上取代 → Deploy → 複製網址（像 `https://xxx.你的帳號.workers.dev`）。
6. 打開 `index.html`，把網址填到最上面的 `CONFIG.liveProxy`，commit → Actions 會自動重新部署。

第 5、6 步可以先跳過：程式會先試著讓瀏覽器直接抓公開資料，若被 CORS 擋住，左側面板會告訴你要做這兩步。

## 本機測試（Node 18+，不用裝套件）

```bash
cp .env.example .env            # 填 TDX 金鑰（只有抓路網資料需要）
node scripts/fetch-static.js    # 產生 data/
node dev-proxy.js               # http://localhost:8888（/live 就是本機版的 worker）
```

不抓資料先看畫面：`http://localhost:8888/?mock=1`（三條模擬路線分別示範進站資料推算、時刻表推估、班距模擬；`&speed=5` 加速）。

## 臺北捷運的位置是怎麼算的

公開資料只說「此刻哪些月台有列車、往哪個方向」，沒有列車編號、也沒有站間位置。程式：

1. 用站名對回 TDX 的車站代碼與路線（同名轉乘站靠「往哪裡」分辨；忠孝復興往南港展覽館這種兩線都可能的，優先選正有列車要進站的那條線，並在詳細資料註記）。
2. 月台上的列車＝停靠中。它從資料裡消失時，代表已離站，開始以站間行駛時間（`S2STravelTime`）沿線型往下一站推進；資料每 30 秒一張，離站時間取中點。
3. 到達下一站後若資料尚未看到它，先顯示為停靠中；停靠時間過了還沒出現（剛好落在兩次更新之間），就當它已經過站繼續往前，最多推兩站，之後放棄等它再次被看到。
4. 同一列車從月台→行駛→下一站月台會維持同一個圖示，所以會連續移動而不是跳格。

誤差來源：資料 30 秒一更新（停靠狀態最多晚 30 秒）、站間時間是固定值。

## 網址參數

| 參數 | 說明 |
|---|---|
| `?sys=TRTC` | 載入後直接飛到指定系統（TRTC / NTMC / NTDLRT / NTALRT / TYMC / TMRT / KRTC / KLRT） |
| `?refresh=10` | 更新間隔秒數（最少 8） |
| `?proxy=https://…workers.dev` | 臨時指定代理網址（不用改檔案） |
| `?data=./data` | 靜態資料位置 |
| `?mock=1` | 示範資料；`&speed=5` 加速 |

## 檔案

```
index.html                  前端（CSS + 純邏輯 CORE + 地圖 APP，同一檔）；CONFIG 在 APP 段最上面
worker.js                   Cloudflare Worker：加 CORS 的小代理（只允許清單內的公開來源，10 秒快取）
scripts/fetch-static.js     從 TDX 抓路網資料存到 data/（Actions 每週跑）
.github/workflows/deploy.yml  抓資料 + commit + 部署 GitHub Pages
dev-proxy.js                本機預覽用靜態伺服器 + 本機版 worker
data/                       Actions 產生（路線、車站、線型、站間時間、時刻表、首末班車、班距、index.json）
.env.example                本機抓資料用的金鑰範本（.env 已在 .gitignore）
```

## 限制與注意

- 臺北捷運公開資料只涵蓋五條主線（含支線），環狀線屬新北捷運，走時刻表推估。
- 時刻表／班距推估不知道誤點與臨時調度，看起來永遠準點；國定假日依 TDX 資料的 ServiceDay 判斷。
- `data/` 每週會 commit 一次，repo 會慢慢長大（每次幾 MB，git 會壓縮）；不想留歷史可以偶爾 squash。
- 資料授權為「政府資料開放授權條款」，頁面右下角的臺北捷運／TDX 來源標示請保留。
- 想再加別的公開即時來源：`worker.js` 的 `SOURCES` 加一行，`index.html` 的 `SYSTEMS` 加 `live:'platform', src:'xxx'`，資料格式若也是「站名＋往哪裡」就直接能用；若是別種格式，把它整理成同樣欄位即可。
