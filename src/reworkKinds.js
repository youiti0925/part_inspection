// 🔁 やり直し(再作業)の「種別」の語彙(製品 App.jsx の DEFAULT_REWORK_KIND_OPTIONS〜reworkKindOrder と同じ中身)。
import { UNKNOWN_CAUSE, UNKNOWN_KIND } from './domain/reworkAnalysis.js';

// 🔁 やり直し(再作業)の「種別」= 不良項目マスタ側に人が付ける札。
//   ⚠中身を見てこちらで勝手に分類しない。決めるのは現場(清水さん)。既定は必ず「未分類」。
//   ⚠「原因不明」は種別ではない。原因そのものが引けなかった行に自動で付く別枠で、
//     ここで選ばせてはいけない(選べてしまうと、無い物に名前を付けたことになる)。
//   ⚠語彙(何という種別があるか)も現場が決める物なので、⚙設定で足したり直したりできるようにしてある。
//     ここにあるのは「設定が空のときの既定」だけ。4つ目が要る時にコードを直す必要はない。
export const DEFAULT_REWORK_KIND_OPTIONS = ['直しが要った', '測り直しだけ', '作業環境'];
// 種別の色。原因不明(UNKNOWN_CAUSE)は「別枠」と一目で分かるよう灰色にする。
// ⚠現場が足した種別はここに色が無い。色が無い物は白のまま出す(勝手に既存の色を割り当てない)。
export const REWORK_KIND_COLOR = {
  '直しが要った': 'bg-rose-100 text-rose-700 border-rose-200',
  '測り直しだけ': 'bg-amber-100 text-amber-700 border-amber-200',
  '作業環境': 'bg-sky-100 text-sky-700 border-sky-200',
  [UNKNOWN_KIND]: 'bg-slate-100 text-slate-600 border-slate-200',
  [UNKNOWN_CAUSE]: 'bg-slate-200 text-slate-600 border-slate-300',
};
// ⚙設定で決めた種別の語彙。最後は必ず「未分類」(決めていない物の置き場所なので消せない)。
export const reworkKindOptions = (settings) => {
  const list = Array.isArray(settings?.reworkKindOptions) ? settings.reworkKindOptions : null;
  const base = (list && list.length ? list : DEFAULT_REWORK_KIND_OPTIONS)
    .map(s => String(s || '').trim())
    .filter(s => s && s !== UNKNOWN_KIND && s !== UNKNOWN_CAUSE); // 「原因不明」は種別ではないので選ばせない
  return [...new Set(base), UNKNOWN_KIND];
};
// 種別を並べる順(合計に混ぜないので、並びも毎回同じにして見比べられるようにする)。原因不明は必ず最後の別枠。
export const reworkKindOrder = (settings) => [...reworkKindOptions(settings), UNKNOWN_CAUSE];
