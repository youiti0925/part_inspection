# PocketBase 移行手順（“いつでも逃げられるお守り”）

Firebase の容量が将来きつくなったとき、3つの検査アプリ（製品 / 部品 / 最終）のデータを
**データを一切落とさずに** PocketBase へ移すための手順とツールです。普段は何も起きません。

## 全体像

1. 各アプリの画面から **「PocketBase移行用」ボタン**でデータを書き出す（JSON）。
2. PocketBase を用意して起動、管理者を作成。
3. `pb_import.mjs` で JSON を PocketBase に取り込む（`{ fbId, appData }` 形式で丸ごと保存＝無損失）。

> 取り込み後は「1コレクション = `appData`(JSON) に元のドキュメント全体 + `fbId`(元のID)」という形になります。
> まずは**確実に移す**ことを優先した設計です。後から型付きスキーマ（`setup_db_v3.mjs` の発展）へ整える事も可能。

## 手順

### 1) データ書き出し（各アプリ）
- 製品 / 部品 / 最終 それぞれの **データ書き出しセンター**にある **「PocketBase移行用」** を押す。
- `pocketbase移行_製品検査_YYYY-MM-DD.json` のようなファイルが保存されます（3アプリ分それぞれ）。
- 書き出されるコレクションは各アプリが使う全コレクション（settings/lots/templates/workers/… など）。

### 2) PocketBase 準備
- https://pocketbase.io/ から実行ファイルを入手し起動: `./pocketbase serve`
- 管理画面（http://127.0.0.1:8090/_/）で**管理者(superuser)**を作成。
- このリポジトリで一度だけ: `npm i pocketbase`

### 3) 取り込み
```sh
# 製品検査
node pb_import.mjs --export "pocketbase移行_製品検査_2026-06-29.json" --email <admin> --password <pass>
# 部品検査・最終検査も同様に（同じ PocketBase に入れてOK＝アプリごとに名前空間化されます）
node pb_import.mjs --export "pocketbase移行_部品検査_2026-06-29.json" --email <admin> --password <pass>
node pb_import.mjs --export "pocketbase移行_最終検査_2026-06-29.json" --email <admin> --password <pass>
```
- `--dry` を付けると**実際には書き込まず計画だけ**表示（安全確認用）。
- 既定では `appDataId` を接頭辞にしてコレクションを名前空間化（例: `product_inspection_v1_lots`）。
  1つの PocketBase に3アプリ分を入れても衝突しません。
- **冪等**: 同じ JSON を再取り込みしても重複せず更新されます（`fbId` で照合）。
- 単一アプリ用にベア名（`lots` など）で入れたいときは `--prefix ""`。

## 注意・既知の前提
- 画像（`help_images`、不良写真など）は base64 文字列のまま `appData` に入ります。1レコード上限 5MB（`maxSize`）。
  大きすぎる画像がある場合はそのレコードだけ失敗としてログに出ます（他は成功）。必要なら PocketBase のファイルフィールド方式へ後日移行。
- これは**保存データの移行**です。Firebase の認証ユーザーや Storage のファイル実体は別管理（必要時に別途）。
- `setup_db_v3.mjs` は最終検査の旧 PocketBase 版用の初期化（`appData` 方式）。`pb_import.mjs` は同方式に揃えています。

## 関連ファイル
- `pb_import.mjs` … 取り込みスクリプト（本ツール）
- `setup_db_v3.mjs` … PocketBase コレクション初期化の参考（appData 方式）
- 各アプリの「PocketBase移行用」エクスポート … `exportForPocketBase()`
