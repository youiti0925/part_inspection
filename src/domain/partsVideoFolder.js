// 🎬 部品検査の動画の置き場所(Drive)。製品の productVideoFolder と同じ作りで、一番上だけ「部品」。
// ⚠ 入れる側(録画・スマホの撮影)と読む側(動画タブの棚)は必ずこれを通す。別の作り方をすると
//   「入れた場所と読む場所が違う」になる(製品で 2026-08-16 に実際に起きた)。
export const partsVideoFolder = (tplName) => ['部品', 'テンプレ', String(tplName == null ? '' : tplName).trim() || 'テンプレ'];
