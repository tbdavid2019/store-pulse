# Tasks

## 1. API 基礎與上游來源

- [x] 1.1 建立 Flask API、Python dependencies、環境設定範例與健康端點；以本地啟動命令及 health response 驗證可執行，缺少外部金鑰仍能開啟靜態搜尋頁。
- [ ] 1.2 固定 TLDReview commit，抽取並驗證本期實際重用的解析／選樣模組至 vendor，保留 MIT LICENSE、來源 SHA 與修改紀錄；目前只有文字／ID helper，需完成來源程式比對或明確縮小此項目範圍。
- [x] 1.3 定義 request/response/evidence schema、錯誤碼與設定驗證；以 API contract 測試覆蓋無效 place_id、mode、window、CORS 及錯誤訊息憑證遮蔽。
- [x] 1.4 更新 README 架構與本地啟動文件，說明 static hosting 搭配 API 的方式；依文件在本地重現頁面及健康端點。

## 2. 評論證據與取樣

- [x] 2.1 核對送入分析 API 的 place_id 與所選 Google Places 分店一致；使用同品牌不同分店 fixture 驗證 place_mismatch 停止流程。
- [x] 2.2 接收 Places Details 的最多五則評論，依 recent／low_rating 與 30／90 天排序篩選；以 fixture 驗證時序、星級、分店 ID 與空樣本。
- [x] 2.3 保留評論 ID、時間、原文與來源連結，加入穩定 fallback ID、去重與 30／90 天篩選；測試跨語言重複、UTC 邊界、缺時間、舊評論及低分條件，確認空樣本不補舊資料。
- [x] 2.4 實作最多 5 則／8,000 字元的模型 evidence 預算、階段計數與排除理由；以 fixture 核對 fetched／deduplicated／eligible／used counts、excerpt 標記及來源 fallback。
- [x] 2.5 記錄 evidence schema、五則樣本限制與 Places fixture 的匿名化方式；檢查文件示例可對照測試輸出，空樣本明確顯示資料不足。

## 3. 快取、額度與期限

- [x] 3.1 建立 SQLite 持久化 cache、模型／prompt 版本 key、TTL 與清理；測試相同參數命中、模式／期間／版本隔離、過期重抓、無樣本短快取及程序重啟後延續。
- [x] 3.2 建立 model call cap、每 client 限流與全站每日 model budget，使用交易原子保留；以並行及 UTC 換日測試確認額度上限，cache hit 不產生模型請求。
- [x] 3.3 建立同 key in-flight lease、過期回收及整體 deadline；以並行／逾時測試確認相同分析共用結果、舊 owner 不會釋放新 lease，45 秒 deadline 會限制各上游呼叫。
- [x] 3.4 文件化 TTL、預算、proxy client identity、持久卷及單 instance 部署限制；以設定範例檢查所有數值可調且日誌不輸出 key 或完整評論。

## 4. 營運摘要

- [x] 4.1 建立可設定 endpoint/model 的文字模型 adapter 與單次 JSON 呼叫協定；以 mock server 驗證 timeout、無隱含 retry、usage 記錄、缺少設定及服務故障處理，文件記錄所支援的 HTTP 合約。
- [x] 4.2 建立繁體中文 prompt 與 observation schema，分開 finding 與 suggested_action；以固定 evidence 測試無證據類別省略、有效 evidence ID 及不受評論內指令改變工具權限。
- [x] 4.3 加入摘要 JSON 驗證及 evidence-only 降級；測試 malformed JSON、未知引用、空樣本、模型失敗與逾時，確認空樣本不呼叫模型且降級後仍可檢視證據。
- [x] 4.4 實作評論誘因訊號、發生筆數及證據引用；以送贈品描述 fixture 驗證保守措辭，確認回應與文件示例排除真偽認證及 organic_score 展示。

## 5. 分店卡片整合

- [x] 5.1 依 Impeccable setup 讀取既有介面脈絡，新增深度分析入口、期間／模式控制及可展開摘要；以桌面、手機寬度及鍵盤操作檢查層級、可讀性、焦點與狀態提示。
- [x] 5.2 串接 API 狀態、重複點擊控制、generation ID 與取消／重試互動；以瀏覽器驗證新搜尋不觸發分析、舊回應不附至新卡片、按鈕互動不觸發卡片地圖點擊。
- [x] 5.3 呈現證據、樣本資訊、cache 時間與錯誤／offline 狀態，評論以安全 DOM 呈現並校驗來源 URL；以惡意 markup、無直接連結及 evidence-only fixtures 驗證畫面。
- [x] 5.4 更新 Service Worker 排除非 GET 與 `/api/` 並更新 cache version；以線上／離線及舊版 cache 升級情境確認 API 結果不由 PWA cache 冒充新分析。
- [x] 5.5 將現有評論標題調整為「評論摘錄」，補上單店分析操作及狀態說明；依 README 操作核對搜尋、地圖、低分標示與 PWA 基本流程。

## 6. 整合驗收與試接

- [x] 6.1 以本地 fake Places data/model 執行跨層驗收，涵蓋成功、分店不符、空樣本、額度耗盡、timeout 及摘要降級；記錄對應 spec scenarios 的結果。
- [ ] 6.2 選定 3 家可核對分店、模型設定與免費 serverless hosting，確認持久儲存、來源標示及資料保留設定；交付可重現的部署設定與試接清單，credentials 留在後端。
- [ ] 6.3 在已設定模型額度內進行三店真實試接，逐條人工核對摘要與原文支持程度；交付分店匹配、Places 樣本期間／數量、模型用量、延遲、快取及語意錯誤紀錄。
- [x] 6.4 驗證停用分析設定與回退流程；確認停用後停止外部分析請求且搜尋仍可使用，將結果及後續多店比較／監控建議加入驗收紀錄。
