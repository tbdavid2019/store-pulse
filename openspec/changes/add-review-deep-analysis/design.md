# Design

## Context

動機見 proposal.md。`index.html` 直接呼叫 PlacesService.textSearch/getDetails，卡片與地圖以 place_id 關聯；`service-worker.js` 對同源請求採用 cache-first。repository 尚無 Python 後端、資料庫或測試配置，README 宣告 Hugging Face `sdk: static`。

上游評估基準為 dryden/TLDReview commit `e7f99abc793f87cb872abf716e45541b620535e0`。Store Pulse 搜尋分店時已透過 Places Details 取得最多五則評論；分析 API 使用這批資料並呼叫可設定的模型 endpoint。使用者提供的 2md `llms.txt` 描述 URL-to-Markdown、搜尋、文件解析與 OCR，沒有 Google Maps Reviews 或通用文字生成 endpoint。對 Google Maps place URL 的實際請求只回傳 Maps 頁面標題與地圖圖片，未回傳評論內容，因此它不能充當評論擷取或摘要來源。

## Goals / Non-Goals

**Goals:** 以兩個 adapter 隔離評論來源與模型，建立可溯源的單店分析鏈路，並以持久化額度與快取控制外部請求。後端可由本地單程序服務啟動，前端亦可設定獨立 API base URL。

**Non-Goals:** 本期排除多店比較、排程、通知、完整歷史資料庫、帳號系統、照片上傳及 Vault。摘要只描述抽取樣本；統計趨勢與全店問題比例需另有完整資料設計。

## Decisions

### 1. Python HTTP API 加入現有靜態前端

採 Flask 提供 `POST /api/review-analysis` 與唯讀健康端點作為本地 reference implementation；Flask 呼應現有文件並便於測試。預定模組為 `backend/app.py`、`backend/reviews.py`、`backend/analysis.py`、`backend/storage.py`，附 requirements 與 `.env.example`。本地服務只提供首頁、manifest、service worker 與 icons 白名單；API 不得把 repository 根目錄當靜態目錄。HF Static 前端需設定 API base URL 與 CORS origin，免費 serverless 部署選項尚待落實。

分析 key 留在後端，前端只傳 Places 樣本和顯示用店家欄位。HF Static 沒有 server-side process，正式分析需設定外部 serverless API；免費方案需另行選定和部署。

### 2. 固定上游來源並抽離證據層

使用目前分店卡片已取得的 Place Details 回應，前端只傳 place ID/name/address/rating/Google Maps URL 及最多五筆 review fields。後端重新核對 place ID，不重新查詢評論來源。Google Places Legacy 評論使用 `time` Unix 秒作發表時間；缺時間的評論排除。評論來源連結回到分店 Maps URL，Google Places 未提供單筆評論 URL。`backend/vendor/tldreview/` 保留其 MIT LICENSE 與最小欄位相容 helper；目前尚未移植上游完整擷取／選樣引擎，對應任務維持未完成。

輸入以 Google place_id 為準；後端只接受 request 中 place ID 與所選店家 ID 一致的樣本。店名、地址、座標作為顯示資料，API 不會依使用者傳入文字重新搜尋或抓取 URL。

### 3. 可追溯樣本及摘要合約

Request: `{place_id, place, reviews[<=5], mode: recent|low_rating, window_days: 30|90}`。伺服器校驗 place ID，且不接受任意 URL、本機路徑或超過五筆評論。

Evidence: `{evidence_id, provider_review_id?, published_at, rating, text, is_excerpt, source_url, source_url_kind}`；Google Places 未提供 review ID 時，由店家、作者、時間與原文建立 deterministic hash，缺確切時間的評論排除。每次最多使用 5 則、8,000 字元；`recent` 依時間新到舊排序，`low_rating` 依星級低到高、同星級再依時間新到舊排序。

Response: `{status, request_id, place, sampling, evidence, summary, usage, fetched_at, analyzed_at, cache}`。`sampling` 包含各階段筆數、日期上下界、排除理由、截斷狀態；`summary.observations[]` 包含 `{category, finding, evidence_ids, suggested_action?}`。選樣策略、資料 schema、prompt、模型識別與設定版本皆進入分析版本。

近期模式依本次 Places 樣本內時間排序；低分模式先篩選 3 星以下再排序。Places 只提供最多五則評論，這是樣本覆蓋的硬上限；摘要必須明確顯示筆數，不推論為全店趨勢。

### 4. 模型隔離與輸出驗證

文字模型 adapter 由後端設定 endpoint、model、credential；第一版只實作一種可設定的 JSON HTTP 協定，具體供應商設定在試接時選定。模型只取得 evidence 及任務規則，具備零工具權限；先驗證輸出結構、類別、長度與 evidence ID，再回傳摘要。

每筆觀察至少引用一個有效 evidence ID；結構驗證只保證引用有效，語意支持程度另由 3 店人工試接檢查。模型故障或驗證失敗時回傳 evidence 及 summary_unavailable，不自動追加付費修復呼叫。評論誘因以規則提示加原文證據呈現，排除上游 organic_score 的產品展示。

### 5. 快取、額度與並行

第一版採單程序 API instance（支援 threaded requests）、SQLite 持久卷，存放 Places 樣本快取、結果與全站模型額度；in-flight lease 保存在該程序記憶體。預設 TTL 6 小時、每次最多 1 次 model call、單 client 每分鐘 5 次 cache-miss 分析、全站每日 100 次 model calls；皆可設定。每次實際模型呼叫前以 SQLite `BEGIN IMMEDIATE` 原子保留額度，UTC 換日。每個 HTTP request timeout 受同一 monotonic deadline 限制；替換過期 lease 時，舊 owner 只可釋放自己的 lease。多程序／多副本部署前，必須把 in-flight lease 移到共享儲存。

快取 key 包含 place_id、mode、window、language、analysis version、model endpoint 與 model name；相同 key 用程序內 lease 合併進行中請求，過期 lease 可回收。成功結果與 evidence 使用同一 TTL，無樣本結果短暫快取 10 分鐘；失敗不做成功快取，過期資料不自動回退。每次分析總期限預設 45 秒，個別網路 timeout 受剩餘期限限制。模型逾時時保留已擷取 evidence 並回報 timeout 狀態。

相較於沿用上游檔案快取，自訂 cache 可修正取樣及版本 key 的不足。若部署改用多實例或無持久磁碟，需先更換支援交易與 lease 的共享儲存，才能維持預算上限。

### 6. 卡片互動與網路策略

卡片新增分析按鈕、期間與模式選擇，以及可展開的結果區；互動阻止事件冒泡，鍵盤與螢幕閱讀器可讀取進度。每次搜尋使用 generation ID，避免前次回應附到新卡片。既有評論標題改為「評論摘錄」，分析區另標示實際排序及期間。新增區域以 textContent 等安全 DOM API 呈現，來源連結限制 http/https。

Service Worker 明確略過非 GET 與 `/api/`，更新 cache version；API 快取由後端管理。API 設定缺失時以簡短狀態說明，搜尋與地圖仍可使用。相較於全站重寫，此方案將改動集中在分店分析流程。實作介面時依 Impeccable 載入既有設計脈絡與對應 references。

## Risks / Trade-offs

- [抽樣偏差與低分模式稀疏] → 顯示取樣方式、日期及截斷狀態，對空樣本只報告資料不足。
- [有效引用仍可能存在語意誤讀] → 以原文展開與人工核對驗收；逐條檢查三店摘要，記錄錯誤案例。
- [公開 API 被濫用] → client 限流加全站持久化 budget；CORS 只限制瀏覽器來源，成本底線由全站 budget 保證。
- [Places 最多只回傳五則評論] → 顯示樣本期間、筆數與來源，不把小樣本當成趨勢或全量負評比例。
- [模型服務延遲與故障] → 明確 timeout、evidence-only 降級及既有搜尋獨立運作。
- [上游變動及單檔耦合] → 固定 SHA、vendor 最小範圍、adapter fixture 與授權紀錄。

## Migration Plan

1. 建立 API、資料 schema、adapter 與 fixture 驗證，本地同源運行，使用 Places review fixtures 檢查完整狀態。
2. 串接前端單店互動與 Service Worker 規則，更新 README 的實際架構及啟動方式。
3. 選定可免費承載 server-side API 的 serverless hosting 與持久儲存方案；配置模型 secrets、allowed origins 與保守 budget。提供停用分析功能的設定。
4. 指定 3 家真實分店，記錄匹配、Places 樣本筆數、每筆摘要證據、模型用量、端到端延遲及 cache hit。
5. 驗收通過後逐步開啟；回退時停用分析入口並停止 API 外部呼叫，原有靜態搜尋保留，資料可依 TTL 清理。

## Open Questions

- 試接採用的 3 家分店、Python hosting 及模型供應商／model ID；這些選擇沿用既定 API 與 adapter 合約。
- 正式使用頻率及月預算，用於調整 TTL、client rate limit 與每日 cap；初始值依本文件執行。

## References

- https://github.com/dryden/TLDReview/tree/e7f99abc793f87cb872abf716e45541b620535e0
- https://developers.google.com/maps/documentation/javascript/legacy/places
- https://developers.google.com/maps/documentation/javascript/reference/place#PlaceReview
