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
