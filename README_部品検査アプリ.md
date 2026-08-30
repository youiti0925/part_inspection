# 部品検査アプリ (parts-inspection-app)

製品検査アプリ(product-inspection-app)を改造して作る**部品検査アプリ**の雛形。
基本の集計/グルーピング単位を **型式 → 品目コード**(部品ごとの番号)に置換し、**品目テキスト**(品名)を併記する。

## 設計の核心(必ず守る)
1. **内部キー `lot.model` はそのまま流用。中身を品目コードにするだけ**(フィールド名・変数名は変えない=無駄に壊さない)。
2. **品目テキスト `lot.modelText` は表示専用の別フィールド。集計キーには絶対に混ぜない**(表記揺れでキーが割れる)。
3. **stepKey = `category_title` は検査項目側で決まり品目に非依存**。
4. 検査方法(品目コード×複数テンプレ)は製品の型式×テンプレと同構造を維持。分割測定連携は不採用。

詳細設計=セッションメモ리 `parts-inspection-app-design.md`。

## 現状(2026-06-27)
### ✅ できていること(ビルド通過済み)
- **独立アプリとして起動・ビルド可能**(`npm install` → `npm run build` OK)。
- アイデンティティ差し替え: `APP_DATA_ID = "parts-inspection-v1"` / package名 / index.htmlタイトル「部品検査」/ firebase target=parts。
- **Firebase設定は空のプレースホルダ**(製品のキーは削除済=新プロジェクトに繋ぐまで Firestore に接続しない)。
- **品目テキスト modelText のデータ層**: 入荷登録(handleAddLot)の新規・編集の両保存経路で `lot.modelText` を保持。空欄なら品目名簿(itemMaster)で補完(読み取り)。
- **登録フォーム**: 「型式」→「品目コード」、品目テキスト(品名)入力欄を追加、両方にオートコンプリート(datalist)。
- **検索**: 品目コード＋品目テキストの両方にマッチ。ラベル/プレースホルダを「品目」に。
- **ロットカード**: 品目コードの下に品名を小さく併記。

### ⬜ これからやること(段階4〜の残り)
- **ラベル一括置換の続き**: 分析画面(達成率/工程分析/重点工程/月次レポート/改善PDCA)・各種フィルタ・厳密モード等に残る「型式」表記を「品目コード」へ。内部キー(model)は据え置き。
- **CSV/Excel取込に品目テキスト列**: handleCsvUpload / Excel雛形に modelText 列を追加(空欄可、空なら itemMaster 補完)。列順は連番(機番)列より前に固定。
- **品目名簿 itemMaster の育成(書き込み)**: 登録/取込で名称が来たら `settings.itemMaster[品目コード]=名称` を更新(現状は読み取り補完のみ)。
- **分割測定(rotary)コードの除去**(不採用): rotaryLink/writeRotaryCommand/ステーション選択/RotaryMeasurementsPanel/rotaryEvents購読 等を撤去。
- **modelStandardMap → 品目コードキー化**(品質規格マッピングのキーを品目コードに)。

## 新Firebaseプロジェクトのセットアップ(ご本人の作業)
1. Firebaseコンソールで**新規プロジェクト作成**(例 `parts-inspection-app`)。
2. **Firestore / Authentication / Storage** を有効化(ルールは同梱の firestore.rules / storage.rules を流用)。
3. **Webアプリ登録** → firebaseConfig を取得 → `src/App.jsx` の `USER_DEFINED_CONFIG` の "" を全て埋める。
4. **`.firebaserc`** の `PARTS_PROJECT_ID_HERE` / `PARTS_HOSTING_SITE_HERE` を実際の値に。
5. デプロイ: **`npm run deploy` だけ**(ビルドも見張りも台帳付けも、この中でやる)。
   - 🚨 **`npx firebase deploy` を直に叩かない**(裏口)。門(`scripts/deploy.mjs` → `scripts/verify-deploy-safety.mjs`)を通らないと、
     ①古い部品を持ち越す仕掛け(`keep-old-assets.mjs`)が走らず、前の版の `assets/index-〇〇.js` が本番から消える
     ②何を出したかの台帳(`scripts/deploy-ledger.json`)が付かない。
     8/12 から画面を開きっぱなしだった端末が 8/17 に起動しなくなり、その端末に貯まっていた作業が消えた
     (詳しくは `docs/` のデプロイ事故の記録)。8/22 以降 実際にこの裏口が常用されて台帳が腐った。
   - 出した後の確認: `node scripts/verify-deploy-safety.mjs --after`(本番の部品が全部 生きているかを実測)。
   - **firebase.json の Cache-Control は設定済み**(index=no-store / assets=immutable)=「反映されない」防止。
   - **firebase.json の rewrites は `!/@(assets|notice-assets)/**`**(無い部品には 404 を返す)。`"**"` に戻さない。
6. (AI分析機能を使うなら)Geminiキーは .env をコミットせず Cloudflare Worker プロキシ経由。機番AI認識は無し。

## 注意
- **既存データ移行は不要**(新プロジェクト=過去データ無し。最初から品目コードで貯まる)。
- 機番AI認識(銘板読取)は**最終検査アプリ専用**で本アプリには無い。
