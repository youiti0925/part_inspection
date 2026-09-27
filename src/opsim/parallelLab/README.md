# 並列作業ラボ（本番未接続）

製品検査の独立実験・引継ぎ用。既存ファイルを変更せず、このフォルダとdocsだけを追加。

- `parallel-lab.html` をブラウザーで開く（通信・本番書込なし）。
- `python src/opsim/parallelLab/build.py` で画面再生成。
- `node --test src/opsim/parallelLab/engine.test.mjs src/opsim/parallelLab/contracts.test.mjs` で25試験。
- `inspectionInput.mjs`：正規化済み検査ロットから型式/台/テンプレ/実測根拠を保持する選択データ。
- `fieldMode.mjs`：将来の現場指示の表示契約。サーバーの承認権限や本番配線は含まない。

具体的な接続点・未実装・受入条件は `docs/parallel-work-handoff.md`。計算範囲は `docs/parallel-work-design.md`。

このHTMLはOSの日本語フォントを使用。外部CDNや本番サービスを読み込まない。実際の検査リストの読込み、全体再割付、承認保存、現場配信は未接続。

組み立てた `parallel-lab.html` は `public/parallel-lab-sample.html` へ写して配る。
アプリでは「🧪 並列作業の見本(ChatGPT作)」として表示(操業シミュレーション → 計画管理の横)。
