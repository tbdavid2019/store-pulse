# 更新日誌 (Changelog)

本專案遵循語意化版本與 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.0.0/) 格式，記錄 Store Pulse（888 商店脈搏）的重要更新與迭代歷史。

---

## [2026-10-20]

### 🧠 自備 AI 模型金鑰 (BYOK LLM Hub & Get Model List)
- **支援 5 大主流 AI 提供商**：使用者可於設定中填入個人的 API Key，直接使用 Google Gemini、Groq、OpenAI / ChatGPT、xAI Grok 或 Anthropic Claude，自由選用喜愛的大語言模型且不佔用站點每日配額。
- **動態取得模型清單 (Get Model List)**：填寫金鑰後點擊一鍵查詢，由後端安全端點 [`/api/llm-models`](file:///Users/david/Documents/git/tbdavid2019/store-pulse/src/index.ts) 代理查詢官方 API，即時動態抓取該金鑰支援的所有模型選單（如 Gemini 2.5 Flash / Pro、Llama 3.3 70B、GPT-4o、Claude 3.5 Sonnet 等）。
- **零知識儲存安全性**：AI 金鑰純存放於客戶端 `localStorage`，伺服器記憶體完成推論轉發後即時銷毀，絕不持久化儲存。

### ⚡ SerpApi 自備金鑰深度爬蟲 (BYOK Deep Review Extraction)
- **突破 Places API 5 則評論上限**：提供雙軌制資料擷取架構。未填寫金鑰時維持完全免費的 Google Places API（5 則即時精選）；填寫個人 SerpApi Key 時自動啟用多頁游標翻頁（`next_page_token`）升級至 `~25 則深度地圖爬蟲`。
- **首頁店家卡片直接載入 ~25 則深度評論**：
  - 店家卡片標題處新增 `[⚡ 載入 ~25 則深度評論]` 按鈕，點擊即時發送 [`/api/serpapi-reviews`](file:///Users/david/Documents/git/tbdavid2019/store-pulse/src/index.ts) 擷取並就地展開所有深度評論與負評標籤。
  - 搜尋店家時，系統自動為搜尋結果前 2 間分店自動載入深度評論，告別死板的 5 則限制。
  - 當開啟右側分析抽屜時，亦同步連動將所有萃取的真實佐證評論即時回繪至首頁卡片。
- **4 階加權萃取演算法 (TLDReview 4-Tier Curation)**：
  - 第一優先：在地嚮導（Local Guides）與高等級認證評論者。
  - 第二優先：1~3 星真實負評與爭議點（低分優先排序，精準捕捉避雷細節）。
  - 第三優先：獲得高度認同（Helpful votes）的優質評論。
  - 第四優先：具備客觀長文內容的顧客回饋。
- **零知識儲存安全性 (Zero-Knowledge Architecture)**：
  - 使用者金鑰僅存放於本機瀏覽器 `localStorage`，不入庫、不記錄至 Cloudflare KV 或後端日誌。
  - 呼叫後端分析時透過端對端加密 HTTPS Header (`X-SerpApi-Key`) 傳輸。
- **金鑰設定彈窗 (Settings Modal)**：
  - 頂部導航列新增模式狀態標籤（`5 則精選` / `⚡ 深度爬蟲 (~25則)`），點擊即開啟設定面板。
  - 提供即時測試連線按鈕（`🧪 測試連線與額度`），可直接查詢剩餘額度、本月使用量與帳號狀態。
  - 支援密碼顯示/隱藏切換、一鍵儲存與一鍵清除金鑰。
- **優雅降級容錯機制 (Graceful Fallback)**：
  - 若 SerpApi 額度耗盡或網路波動，後端分析管線自動無縫降級回 Google Places API 5 則評論，確保使用者隨時都能完成分析。
- **Impeccable 工藝標準達成**：
  - 符合 Impeccable Craft Floor，嚴格禁止彩光陰影與非對稱粗邊框，採用無障礙鍵盤焦點、中性光影與平滑動態。
  - Service Worker 快取版本推進至 `v9`。

### 🌐 網域與基礎建設 (Domain & Infrastructure)
- **正式自訂網域上線**：綁定 `https://storepulse.david888.com/`，於 `wrangler.jsonc` 配置 Cloudflare Workers 自訂路由，並設定 DNS 與 SSL 憑證。
- **SEO 與 Open Graph 完整支援**：新增 1200×630 OG 分享縮圖、canonical 標籤、Twitter Card 與 Schema.org JSON-LD 結構化資料。
- **AI 代理與搜尋引擎索引**：新增根目錄 `llms.txt`、`robots.txt` 與 `sitemap.xml`，健全 AI 代理與搜尋引擎的檢索導引。
- **WebMCP 唯讀搜尋工具**：公開 WebMCP 命令式 API，支援 AI 代理直接調用 Google Maps 店家資料（店名、地址、評分、評論數與地圖連結）。

### ⚡ AI 模型推論與穩定度 (AI Resilience & Performance)
- **45 秒推論逾時寬限**：分析請求逾時寬限由 25 秒拉長至 45 秒，避免尖峰期模型推論超時中斷。
- **22 秒智慧快速備援 (Smart Fallback)**：當首選模型 `@cf/openai/gpt-oss-20b` 延遲超過 22 秒時，自動切換至低延遲模型 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 完成分析。
- **徹底移除改善建議 (Drop `suggested_action`)**：從 System Prompt、JSON Schema、資料型別與前端 UI 全面移除「避雷建議 / 改善方針」等冗長陳腔濫調，100% 聚焦於消費者最在乎的真實發現（`finding`）。
- **嚴格全繁體中文輸出 (`zh-TW`)**：在 System Prompt 與 Schema 強制限制輸出為台灣繁體中文，徹底消除混雜英文或簡體中文詞彙的情況。
- **分析快取升級 v5**：因應 Schema 欄位精簡與語言鎖定，更新 KV / 記憶體快取版本至 `v5`。

### 🎨 介面與閱讀體驗 (UX & Interface Refinements)
- **品牌 Logo 點擊回首頁與即時狀態重置**：將頂部導航列與頁尾的品牌 Logo 重構為標準語意連結（`<a href="/">`），點擊後即刻一鍵重置搜尋關鍵字、清空分店卡片至初始導引狀態、清除地圖標記、關閉所有滑出抽屜與設定彈窗，並平滑滾動至頁面頂部自動聚焦搜尋輸入框；同時支援中鍵、CMD、CTRL 與 Shift 點擊另開新分頁。
- **解除評論展示限制**：移除店家卡片只顯示前 2 則評論的限制，完整展示所有擷取到的真實顧客評論。
- **醒目負評警示標記 (Negative Review Badges)**：為 1~3 星低分評論加上醒目的警示紅標 `🚨 負評 (1-3★)`，幫助使用者一眼識別真實地雷。
- **卡片評論分類頁籤 (Filter Tabs)**：店家卡片新增「全部評論」與「🚨 僅看負評」篩選按鈕，支援即時切換。
- **評論展開/收合功能**：長評論超過 140 字自動截斷，並提供「展開查看完整評論」與「收合」按鈕，保持介面整潔。
- **排版縮排修復**：修復 CSS `white-space: pre-wrap` 與模板字串縮排導致評論開頭出現數十格空白縮排的排版問題，改用 `white-space: pre-line` 與 `trim()` 修正。
- **頁尾品牌致敬**：於畫面底部加入精緻典雅的「技術提供 DAVID888.com」外連頁尾與微互動樣式。

### 🔒 資安防護與穩定度 (Security & Code Integrity)
- **快取污染防禦 (Cache Poisoning Defense)**：在快取鍵值中綁定 `source_sha`（SHA-256 評論內容驗證雜湊），杜絕不同內容共用陳舊快取的安全隱患。
- **DOM XSS 全面防禦**：針對評論作者名稱、評論內文、分析標籤與動態渲染文字全面實施 `escapeHtml()` 轉義。
- **距離排序競態條件防護 (Race Condition Mitigation)**：採用預留卡片槽位（pre-allocated card slots）機制，消除非同步 GPS 距離計算與快速連續點擊時產生的卡片渲染衝突。
- **無障礙 A11y 強化**：分析抽屜關閉時焦點正確回彈至觸發按鈕，並支援鍵盤 ESC 鍵即時關閉抽屜。
- **PWA 快取版本升級**：Service Worker 快取版本升級至 `v4`，全面採用 Network-First 策略，防止瀏覽器過度快取舊版前端資產。

---

## [2026-10-19]

### 🚀 新增功能 (Added)
- **右側滑入式分析抽屜 (Slide-over Drawer)**：將原本卡片內的分析體驗重構為右側滑入式的獨立「頁中頁抽屜」，提供全方位的店家脈搏分析面板。
- **評論時間範圍篩選**：支援「全部時間 (All Time)」與多種時間窗口分析。
- **佐證評論展開與預覽**：分析結果中的關鍵論據支援展開折疊，並提供懸停提示 (Tooltip) 預覽。
- **原生 Cloudflare Workers AI**：後端全面改用 Cloudflare Workers AI 原生綁定，無需外部第三方 API Key 即可穩定運行。

### 🎨 視覺與排版 (Visual & Typography)
- **2md.aiurl.tw 編輯室美學**：引入溫潤的自然米白底色、暖灰層次邊框與高對比閱讀配色。
- **高品質排版系統**：整合 Gen Jyuu Gothic（源柔黑體）與 JetBrains Mono 等寬字體，放大中文字體階層與行距。
- **Lucide SVG 向量圖標**：全面替換低解析度 Emoji，採用現代輕量化向量圖標體系。
- **搜尋欄自動聚焦**：開啟首頁時自動聚焦至搜尋輸入框，提升操作流暢度。

### 🛠️ 修復與重構 (Fixed & Refactored)
- **大模型相容與錯誤修復**：引入防禦型 JSON 解析器（Bulletproof JSON Parser），修復大模型包含 Markdown 標記或不完整 JSON 造成的解析失敗。
- **變數作用域修復**：修正 `analysisGeneration` 與 `analysisControllers` 未宣告導致的 JavaScript `ReferenceError`。
- **Service Worker 策略升級**：升級 Service Worker 為 Network-First 策略，解決首頁 HTML 被強烈快取導致改版延遲生效的問題。
- **Google Maps 網域授權降級保護**：提升地圖 API 在自訂網域與本地環境下的容錯彈性。

---

## [2026-10-01]

### 🎨 品牌識別 (Branding)
- **888 商店脈搏全新識別**：更新 Logo 與應用程式圖示，採用明亮溫暖的橘色底色搭配愛心脈搏 (Store Pulse) 視覺意象。

---

## [2026-04-02]

### 📜 授權協議 (License)
- **開源授權聲明**：正式加入 GNU Affero General Public License v3.0 (AGPL-3.0) 授權規範。

---

## [2025-10-27]

### 📍 地理位置與搜尋 (Location & Search)
- **GPS 距離計算與排序**：新增瀏覽器地理位置定位功能，根據使用者當前 GPS 座標即時計算與店家的直線距離，並支援距離排序與距離標籤顯示。

---

## [2025-10-19]

### 📱 PWA 與離線支援 (PWA & Offline)
- **PWA 漸進式網頁應用支援**：新增 `manifest.json`、Google Maps 風格應用程式圖示、Service Worker 離線快取與桌面/手機安裝提示。
- **架構純前端化重構**：移除中繼代理後端，直接在前端調用 Google Places API，大幅降低搜尋延遲。

---

## [2025-07-15]

### 🎉 初版發佈 (Initial Release)
- **Store Pulse 初代發佈**：提供 Google Maps 店家搜尋、顧客評論擷取與核心摘要分析的原型系統。
