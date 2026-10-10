# food-log v1 build 後小修（v1.0.1）
- 品項頁照 DESIGN v0.5 §6.13 做：
  - 「我的品項」：點列會開編輯；刪除是獨立的 44px 按鈕，用 muted 色，刪除後出現 toast，可以復原。
  - 收藏：點列的主體會開份量 Sheet；取消收藏是獨立的 44px 按鈕，按了出現 toast，可以復原，不跳確認。
- 上線前：Ningning 跑全家營養素的抓取腳本。
- 上線後：把 Sheet 的位置和欄位說明給 Kazuha（交給 Kyujin）。

# v1.1（下一版）P2，來自 Winter 第二輪走查
- 趨勢頁兩張圖補 y 軸數字和單位；體重圖補日期刻度和 aria-label。
- 切到趨勢分頁時回到最上面。
- 每日消耗輸入框加 inputmode="numeric"，並過濾非數字。
- 份量 Sheet 頂部加「還剩」。
- 份量 Sheet 按收藏後，星號要馬上變成實心。
- 待真機驗證：iOS Safari 和加到主畫面的 PWA（safe area、日期選擇器、鍵盤會不會擋住）、VoiceOver、從編輯 Sheet 刪除紀錄、編輯自建品項。

- （Ningning，2026-10-10）體重 Sheet 補記選完日期後按 Esc 關不掉（e2e 改用重新整理繞過），待查是 app 還是測試工具的行為。

# 下一輪 grok（Kazuha 2026-10-11）
- deploy-gas.sh：DEPLOY_ID="${FOODLOG_DEPLOY_ID:-AKfycbzkkNiqeHeFF7i0qgC8V8vTApGuvLgCgobEsDI_63c1ZUpftEf2tqYCjO57L64nlqwffQ}"，不要再自動偵測。
- deploy-gas.sh：執行任何 clasp 指令（包括 deployments）之前，都要先 cd "$CLASP_DIR"。
- 預設帶入 deploy/gas-url，讓使用者只需要填密鑰。
- 店家 Sheet 品項第二行拿掉「店家 ·」，只留「上次 10/11 · 1 份」。（Winter P2）
- 確認「Kyujin麵」12:30 的時間是 e2e 假資料還是時區錯誤；如果是時區錯誤，升級為 P1。
