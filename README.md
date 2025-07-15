---
title: Store Pulse
emoji: 🐠
colorFrom: purple
colorTo: red
sdk: static
pinned: false
short_description: 店面脈搏 即時監控多店面的google maps評價！
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference


---

# 多店面管理評價速查 �

專為連鎖店面管理而設計的評價監控工具，讓你快速掌握各分店的客戶評價狀況！

## � 核心功能
- 🔍 **店名搜尋**：直接輸入品牌名稱（如「麥當勞」、「星巴克」）即可找到所有分店
- 📍 **GPS 定位**：自動取得用戶位置，優先顯示附近的分店
- ⭐ **評論展示**：每間分店顯示最多 5 則最新評論，完整掌握顧客反饋
- 🚨 **低分警示**：3 星以下評論自動以橘色底色標示，快速識別問題分店
- 🗺️ **地圖整合**：結合 Google Maps 視覺化呈現，點擊卡片即可查看位置
- ⚡ **即時載入**：搜尋過程顯示動態載入效果，提升使用體驗

## 🛠️ 技術架構
- **前端**：HTML + CSS + JavaScript（原生）
- **後端**：Python Flask
- **API**：Google Maps Text Search API + Places Details API
- **安全性**：API Key 後端管理，前端不暴露敏感資訊

## 🚀 部署方式

### 本地開發
```bash
# 1. 安裝依賴
pip install -r requirements.txt

# 2. 設定環境變數
cp example.env .env
# 編輯 .env 檔案，填入你的 GOOGLE_MAPS_API_KEY

# 3. 啟動服務
python app.py
```

### Hugging Face Spaces 部署
1. Fork 此專案到你的 Hugging Face 帳號
2. 在 Space Settings → Repository secrets 中設定：
   - `GOOGLE_MAPS_API_KEY`: 你的 Google Maps API 金鑰
3. 系統會自動部署並啟動

## 🔐 API Key 申請
1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案或選擇現有專案
3. 啟用以下 API：
   - Maps JavaScript API
   - Places API
   - Geocoding API
4. 建立 API 金鑰並設定適當的使用限制

## 💡 使用建議
- 建議 API 金鑰設定每日使用量限制，避免超額費用
- 搜尋結果限制為 10 筆，在功能性與 API 用量間取得平衡
- 支援 Enter 鍵快速搜尋，提升操作效率
