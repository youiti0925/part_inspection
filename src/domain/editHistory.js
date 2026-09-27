// ============================================================================
// 📋 編集メモ — 「何秒に何を作ったか」を1本の並びにする
//
// なぜ作ったか(2026-08-15 清水さん):
//   「**要点はどこいったの**って感じ、編集室で〇とかの要点みたいなのいじってたけど、
//     結局、**要点履歴作っていったのにない**」
//   「**編集履歴みたいなのまとめて作っておいてそこで確認すればいい**かなと思う、
//     **何秒に〇とか何秒に→とか見れる場所**があったらそこで分かるかなって感じ」
//
// ⚠⚠ 編集室には、作った物が並ぶ場所が **どこにも無かった**。
//   あるのは ✂タブの「1 0:00〜0:02」「⏸ 0:02〜0:05」だけで、**名前も急所も印も出ない**。
//   だから10個作っても「作った覚えはあるのに、どこにあるか分からない」になる。
//   → 印(〇/→/□)・文字・目隠し・止め絵・挟んだ画像・章 を **秒つきで1本に並べる**。
//
// ⚠この関数は「見る為の並び」を作るだけ。**中身は書き換えない**(純関数)。
//   消す/直すは、この行が指している ref を使って呼び出し側がやる。
// ============================================================================

import { timelineOf } from './videoProject.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const txt = (v) => (typeof v === 'string' ? v.trim() : '');
const r2 = (n) => Math.round(n * 100) / 100;

/** 0:03 / 1:05:03 の形。⚠現場は秒を数えないので必ず分:秒で出す。 */
export const atLabel = (sec) => {
  const s = Math.max(0, Math.floor(num(sec, 0)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(ss).padStart(2, '0')}`;
};

/** 印の形 → 現場の言葉。⚠「マーク」「シェイプ」等の横文字を出さない。 */
export const markLabel = (m) => {
  const s = m && m.shape;
  if (s === 'arrow2' || s === 'arrow') return '➡ 矢印';
  if (s === 'rect') return '⬜ 四角';
  if (s === 'line') return '／ 線';
  return '⭕ 丸';
};

const OVERLAY_LABEL = {
  mark: '⭕ 印（流したまま）',
  text: '💬 文字',
  mosaic: '▩ 隠す',
  spot: '🔦 ここを見て',
};

/**
 * 作った物を全部、時刻順に1本へ。
 *
 * @param input.project  編集の中身
 * @param input.chapters [{name, atOut}] 章(区切り)
 * @returns [{ key, at, atText, icon, title, sub, kind, ref, secText, marks }]
 *   ref … 消す/選ぶ為の身元
 *     {type:'clip', id}                     … ⏸止め絵 / 🖼挟んだ画像
 *     {type:'mark', clipId, markIndex}      … その止め絵に付けた印
 *     {type:'overlay', id}                  … 流したままの印・文字・目隠し
 *     {type:'chapter', index}               … 章
 */
export const editHistory = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const p = src.project && typeof src.project === 'object' ? src.project : {};
  const tl = timelineOf(p);
  const rows = [];

  tl.forEach((r) => {
    const c = p.clips[r.index] || {};
    const at = r2(num(r.outStart, 0));
    const secText = `${r2(num(r.outSec, 0))}秒`;

    if (c.type === 'freeze' || c.type === 'image') {
      // ⚠名前が無い物こそ出す。空欄のままだと 🔎言葉で探す にも作業標準にも載らない。
      const name = txt(c.step) || txt(c.point) || txt(c.caption);
      const marks = Array.isArray(c.marks) ? c.marks.length : 0;
      rows.push({
        key: `clip:${c.id}`,
        at, atText: atLabel(at), secText, marks,
        icon: c.type === 'freeze' ? '⏸' : '🖼',
        kind: c.type === 'freeze' ? 'freeze' : 'image',
        title: name || '（名前なし）',
        sub: [
          c.type === 'freeze' ? `止めて出す ${secText}` : `画像 ${secText}`,
          marks ? `印 ${marks}個` : '',
          txt(c.point) && txt(c.step) ? `急所: ${txt(c.point)}` : '',
        ].filter(Boolean).join(' / '),
        noName: !name,
        ref: { type: 'clip', id: c.id },
      });
      // その止め絵に付けた印を、1つずつ出す(「何秒に〇」が分かるように)
      (Array.isArray(c.marks) ? c.marks : []).forEach((m, mi) => {
        rows.push({
          key: `mark:${c.id}:${mi}`,
          at, atText: atLabel(at), secText: '', marks: 0,
          icon: '　└', kind: 'mark',
          title: markLabel(m),
          sub: txt(m && m.text) || '（ひと言なし）',
          noName: !txt(m && m.text),
          ref: { type: 'mark', clipId: c.id, markIndex: mi },
        });
      });
    }
  });

  // 流したまま出す物(印・文字・目隠し・ここを見て)
  (Array.isArray(p.overlays) ? p.overlays : []).forEach((o) => {
    if (!o) return;
    const at = r2(num(o.from, 0));
    const sec = r2(Math.max(0, num(o.to, 0) - num(o.from, 0)));
    const isMark = o.kind === 'mark';
    rows.push({
      key: `ov:${o.id}`,
      at, atText: atLabel(at), secText: `${sec}秒`, marks: 0,
      icon: isMark ? '⭕' : o.kind === 'text' ? '💬' : o.kind === 'mosaic' ? '▩' : '🔦',
      kind: `overlay:${o.kind}`,
      title: isMark ? markLabel(o.mark) : (OVERLAY_LABEL[o.kind] || '重ね'),
      sub: [
        txt(o.text) || txt(o.mark && o.mark.text) || '',
        `${sec}秒 出す`,
      ].filter(Boolean).join(' / '),
      noName: isMark ? !txt(o.mark && o.mark.text) : (o.kind === 'text' ? !txt(o.text) : false),
      ref: { type: 'overlay', id: o.id },
    });
  });

  // 📍章(区切り)
  (Array.isArray(src.chapters) ? src.chapters : []).forEach((ch, i) => {
    if (!ch) return;
    const at = r2(num(ch.atOut, 0));
    rows.push({
      key: `ch:${i}`,
      at, atText: atLabel(at), secText: '', marks: 0,
      icon: '📍', kind: 'chapter',
      title: txt(ch.name) || '（名前なし）',
      sub: 'ここで区切る（工程ごとに別ファイルにできます）',
      noName: !txt(ch.name),
      ref: { type: 'chapter', index: i },
    });
  });

  // ⚠時刻順。同じ秒なら 止め絵 → その印 → 重ね → 章 の順で読める並びにする。
  const order = { freeze: 0, image: 0, mark: 1, chapter: 3 };
  const rank = (r) => (r.kind.startsWith('overlay') ? 2 : (order[r.kind] ?? 2));
  return rows.sort((a, b) => (a.at - b.at) || (rank(a) - rank(b)));
};

/** 名前が空のまま残っている件数。⚠空だと 🔎言葉で探す にも作業標準にも載らない。 */
export const noNameCount = (rows) => (Array.isArray(rows) ? rows.filter(r => r && r.noName).length : 0);

// ---------------------------------------------------------------------------
// ▶ 要点だけ見るモード
//   清水さん「**要点だけ見せる専用モード**でそれ以外は倍速(自分で決めれる)が必要かな」
//   「そこで**一旦停止で押したら続く**と」
//
//   ⚠動画そのものは作り変えない(**見せ方だけ**)。書き出した動画は今までどおり。
//   ⚠止まる所 = ⏸止め絵 と 🖼挟んだ画像 と 📍章。流したままの印や文字では止めない
//     (数が多く、止まってばかりで見ていられない)。
// ---------------------------------------------------------------------------

/** 早送りの選べる速さ。⚠等速(1)も入れる(「速くしたくない」人が必ずいる)。 */
export const SKIP_SPEEDS = [1, 1.5, 2, 3, 4];

export const normSkipSpeed = (v) => {
  const n = num(v, 2);
  let best = SKIP_SPEEDS[0];
  for (const s of SKIP_SPEEDS) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
};

/** 止まる所だけを取り出す。 */
export const keyMoments = (rows) => (Array.isArray(rows) ? rows : [])
  .filter(r => r && (r.kind === 'freeze' || r.kind === 'image' || r.kind === 'chapter'))
  .map(r => ({ at: r.at, atText: r.atText, title: r.title, icon: r.icon, ref: r.ref }))
  .sort((a, b) => a.at - b.at);

/**
 * いまの再生位置から見て、**次に止まる所**。
 * ⚠いま止まっている所ちょうどでは止め直さない(押しても進まなくなる)。
 */
export const nextMoment = (moments, nowSec, eps = 0.05) => {
  const list = Array.isArray(moments) ? moments : [];
  const now = num(nowSec, 0);
  for (const m of list) if (num(m.at, 0) > now + eps) return m;
  return null;
};

/**
 * いま何倍速で流すべきか。
 * 止まる所の手前 preSec 秒からは **等速に戻す**(飛ばしたまま突入すると何が起きたか分からない)。
 */
export const speedAt = (moments, nowSec, skipSpeed = 2, preSec = 1.5) => {
  const nx = nextMoment(moments, nowSec);
  if (!nx) return normSkipSpeed(skipSpeed);
  return (num(nx.at, 0) - num(nowSec, 0) <= Math.max(0, num(preSec, 1.5))) ? 1 : normSkipSpeed(skipSpeed);
};

/**
 * いま何番目の要点まで来たか(0始まり。まだ最初の要点より前なら -1)。
 * ⚠画面には +1 して「3 / 7」と出す(現場は0から数えない)。
 */
export const momentIndexAt = (moments, nowSec, eps = 0.05) => {
  const list = Array.isArray(moments) ? moments : [];
  const now = num(nowSec, 0);
  let i = -1;
  for (let k = 0; k < list.length; k++) if (num(list[k].at, 0) <= now + eps) i = k;
  return i;
};

/**
 * fromSec → toSec の間に **跨いだ最初の止まる所**。無ければ null。
 * from は1コマ前の位置、to はいまの位置。止めるのは `from < at <= to` の物。
 *
 * @param doneAt さっき止まった所の秒(null なら無し)
 *
 * ⚠⚠ これが「押したら続く」の要。2つの取りこぼしを両方ふさぐ:
 *   ① 止まった所ちょうどから ▶ を押した時に、また同じ所で止めない
 *      → `at > from` (ぴったり同じ所では止めない)
 *   ② <video> の時刻はわずかに戻る事がある(1コマ前が 3.999 に見える)。
 *      そのままだと 4.0秒の要点で **押しても押しても止まり続ける**
 *      → doneAt から eps 以内の要点は飛ばす
 *   ⚠ここを nextMoment の eps だけで作ると、1コマ前が要点の 0.02秒手前だった時に
 *     **その要点を丸ごと素通り**する(2026-08-16 の試験で実際に出た)。
 * ⚠1コマで複数の要点を跨いだ時は **手前の1つ**で止める。残りは次の▶で順に出る。
 */
export const crossedMoment = (moments, fromSec, toSec, doneAt = null, eps = 0.05) => {
  const list = Array.isArray(moments) ? moments : [];
  const from = num(fromSec, 0);
  const to = num(toSec, 0);
  const done = (doneAt === null || doneAt === undefined) ? null : num(doneAt, 0);
  for (const m of list) {
    const at = num(m.at, 0);
    // もう居る所・通り過ぎた所。⚠ここの余裕は **ごく小さく**(1e-6)。
    //   大きくすると「1コマ前が要点の少し手前だった」時に、その要点を素通りする。
    //   時刻がわずかに戻る件は doneAt の方で受ける(役割を分ける)。
    if (at <= from + 1e-6) continue;
    if (done !== null && Math.abs(at - done) <= Math.max(0, num(eps, 0.05))) continue;  // さっき止まった所
    if (at <= to + 1e-6) return m;
    return null;                                                      // 次の要点はまだ先
  }
  return null;
};
