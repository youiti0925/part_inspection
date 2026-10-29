# 内部用: 社内版(部品検査)の通知と AI の設定

⚠ この紙は内部用です(社外へ出る通信の話)。情報課へ渡す資料には入れない(清水さん 2026-10-30)。
サーバの名前・置き場所の変え方は `docs/社内版_行き先の変え方.md`。

## 通知(決定 D4: 社内版でも使う)

- 送る道は本番と同じ: 連絡タブ → 宛先・公開設定 → 通知(プッシュ)の **VAPID 鍵** と **Worker URL**(設定 `settings.push`)→ 外の中継 `/fcm/send`。
- 端末の登録(push_tokens)は PocketBase に置く。
- 端末側は Firebase を **通知(Messaging)の為だけ** に起こす(Firestore・ログイン・Storage は起こさない)。コード: `src/onpremPush.js`。
- Service Worker は `index.html` の横の `onprem-sw.js`(相対・下の階層 `/parts/` でも動く)。本番の `firebase-messaging-sw.js` は社内版の出力から外す。
- 通知の公開設定は既定で本番と同じ公開値。変える・止める時だけ `onprem-config.json` に書く:
  - 変える: `"pushFirebase": { "apiKey": "…", "projectId": "…", "messagingSenderId": "…", "appId": "…" }`
  - 止める: `"pushFirebase": false`
- ⚠ 通知は https の入口から開いた時だけ使える(ブラウザの決まり)。

## AI(中継の行き先)

- `onprem-config.json` に `"aiProxyUrl": "https://…"` を書けば使える(ビルドし直さない)。書かなければ「AIサーバーが未設定」と出して止まる(落ちない)。
- Google Drive の中継(`VITE_DRIVE_PROXY_URL`)はまだ設定ファイルで変えられない(ビルドの時の値だけ・社内版のビルドでは空)。

## 確かめていない事

- 本物の https の入口の後ろで、通知の登録・受信を通して試していない(本番の通知の窓口へ繋がるため、試験では押していない)。
- 試験に使ったブラウザ(アプリ内のブラウザ)は Service Worker の登録そのものを受け付けなかった(サーバへ取りに来ない)。普通の Chrome での登録は未確認。
