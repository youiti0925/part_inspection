// ============================================================================
// 📦 分納の山 — 1つの指図が数回に分かれて着く時、台数を便ごとに分ける
// ----------------------------------------------------------------------------
// いまの操業シミュレーションは「1回で全台が着く」前提で動いている。
//   normalizeInput.js は arrival_times/{lotId} の date/time を1つだけ読み(= 一番早い便)、
//   その1点を assignableFromMs にして **全台ぶんの仕事** を立てる。
// 現場は違う。1便目の2台だけ先に検査を始められる日が実在する。
//
// 本番の写しで実測(2026-09-10_0100 / product-inspection-v1):
//   arrival_times  86件(ロット603件のうち71件に対応する記録が在る)
//   ・分納(2便以上) …… **5件**。5件とも **2便**。3便以上は0件
//   ・1便だけ ………… 80件
//   ・到着時刻なし … 1件
//   ⚠ この 5/80/1 は **arrival_times の行**(86行)の内訳。**ロットで数えると別の数**になる
//     (分けられる5件 / 到着予定の記録はあるが1便 66件 / 到着の記録なし 532件 = 603件)。
//     下の見張り P11 が数えているのは **ロット** の方。分母を取り違えない事。
//   ・分納5件の便の合計台数は 5件とも lot.quantity と一致(4=4 / 2=2 / 5=5 / 4=4 / 4=4)
//   実物の中身(指図 1001506308・5台): 8/11 17:00 に4台 → 8/12 10:00 に1台。
//   1便目だけで4台ぶん(全体の8割)の検査に着手できるのに、いまは 8/11 17:00 に
//   5台まとめて着く形でしか計算していない。
//
// 🚨🚨 **入れても今日の盤は1ミリも動かない**(2026-09-10 に数え直した)。
//   分けられる5件は、5件とも **いまの盤に載っていない**。
//     ・dueDefense.isOpenLot が false(未完了ロット 176件の中に1件も無い)
//     ・4件は status も 'completed'。残る1件(指図 1001456631)は status:'paused' だが
//       location:'completed' で、やはり盤から外れている
//     ・便の日時も 2026-08-05 〜 **08-20** で全部 過去。今日の時点ではどの便も着き終えている
//       (⚠ 2026-09-10 の確かめ役が写しで数え直して 08-12 → 08-20 に直した。
//        いちばん遅い便は 指図 1001514395 の 2026-08-20 14:00。
//        この日付は下の見張り P11 が写しで数え直して突き合わせる)
//   つまり この計算は **これから分納が登録されるロットのために先に置いてある物** で、
//   繋いだ日に画面の数字が動く事は無い。動かない事を「効いていない」と読み違えない為に
//   ここへ書いておく。効き始めるのは、まだ検査が終わっていない指図に2便以上が入った時。
//
// 🚨 決め事(CONTRACT.md 0章):
//   ・React / Firebase を import しない。純関数だけ。
//   ・関数の中で現在時刻や乱数を取らない。時刻は必ず引数で受ける(同じ入力→同じ答え)。
//   ・推測で値を埋めない。分からない物は why に理由を書いて返す。
//
// 🚨🚨 **渡されなければ1行も動かない**。
//   分納の記録が無い(便が0)、または **全台がそろう1便** なら chunks は **空配列**。
//   呼ぶ側は `if (res.chunks.length) 分けて割り付ける; else 今までどおり` と書けばよく、
//   分納を登録していないロットは1ミリも計算が変わらない。
//   🚨 2026-09-22: 「1便 = 全台そろう」ではない。6台の指図に「2台だけ 9/21 に着く」1便が
//     登録されている事が在る。その時は chunks の長さが **1** になり、残る4台は
//     どの便にも乗らない(uncovered)。前は1便を丸ごと捨てて 6台ぜんぶ その時刻に着く形で
//     数えていたので、入荷の予定が無い4台まで割り付けていた。
//   → chunks の長さは 0 / 1 / 2以上。1になるのは「一部だけの1便」の時だけ。
//
// 🚨 合計台数がロットの台数と合わない時は、**合わない事を why に書くだけ**。
//   足りない分を最後の便へ足したり、多い分を削ったりしない。
//   (arrivalSplits.validateSplits は登録の入口で「多い」を止めるが、
//    昔に入った記録・後から台数が変わったロットは素通りする。ここは計算側の最後の砦)
//
// ⚠ 便の読み方(splitsOf / splitMs / splitTotalQty)は既存の src/domain/arrivalSplits.js
//   ただ1本。ここで生の splits 配列を自分で読み直さない(読み方が2つになると食い違う)。
// ============================================================================

import { splitsOf, splitMs, MAX_SPLITS } from '../arrivalSplits.js';

/** 分納の見立ての種類。 */
export const LOAD_KIND = Object.freeze({
  NONE: 'none',     // 到着の記録そのものが無い
  SINGLE: 'single', // 記録は在るが、分けられる便が1つ以下 = 今までどおり1回
  SPLIT: 'split',   // 2便以上に分かれている。台数を分けられる
});

/** 台数の読み方。⚠ 0・負・小数・文字は「入っていない」として捨てる(黙って丸めない)。 */
export const qtyOf = (v) => {
  // 🚨 true は Number(true)===1 になる。数でも数の文字でもない物は先に外す。
  const n = (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 0;
};

/** そのロットの台数。分からなければ 0(= 台数の帳尻を合わせる話をしない)。 */
export const lotQuantityOf = (lot) => qtyOf(lot && lot.quantity);

/**
 * 分納の山を作る。
 *
 * @param {object}  o
 * @param {object|null} o.lot     ロット(quantity と orderNo だけ見る)
 * @param {object|null} o.arrival arrival_times/{lotId} の中身。splits を持つ事が在る
 * @param {Array|null}  o.splits  便の配列を直接渡す時だけ。渡すと arrival より優先する
 * @returns {{
 *   kind: 'none'|'single'|'split',
 *   chunks: {atMs:number, qty:number, date:string, time:string}[],
 *   covered: number, uncovered: number, over: number,
 *   quantity: number, recorded: number,
 *   dropped: {noTime:number, noQty:number, duplicated:number},
 *   why: string[],
 * }}
 *   chunks   … 早い順。**長さは 0 か 2以上**。atMs は実時刻(epoch ms)
 *   covered  … chunks が抱えている台数の合計(記録のまま。多くても減らさない)
 *   uncovered… ロットの台数のうち、どの便にも乗っていない台数
 *   over     … 便の合計がロットの台数を超えている分
 *   why      … 人が読む一言。**辻褄が合わない時は必ず1行入る**
 */
export const splitArrivalLoad = ({ lot = null, arrival = null, splits = null } = {}) => {
  const quantity = lotQuantityOf(lot);
  const why = [];
  const dropped = { noTime: 0, noQty: 0, duplicated: 0 };

  // 便の一覧。直接渡された配列が在ればそれ、無ければ到着予定の記録から読む。
  const raw = Array.isArray(splits) ? splits : splitsOf(arrival);
  const recorded = raw.length;

  // ⚠ 主な理由を必ず why[0] にする(画面が1行だけ出す時に、落とした便の注意書きが先頭に来ないように)。
  const none = (kind, line) => {
    why.unshift(line);
    if (quantity === 0) why.push('この指図の台数が記録にありません。台数の帳尻は数えていません');
    return {
      kind,
      chunks: [],
      covered: 0,
      uncovered: quantity,
      over: 0,
      quantity,
      recorded,
      dropped,
      why,
    };
  };

  if (recorded === 0) return none(LOAD_KIND.NONE, '分納の記録がありません。今までどおり1回で全台が着く形のままです');

  // 読める便だけを残す。⚠ 落とした物は必ず数えて why に出す(黙って消さない)。
  const seen = new Set();
  const chunks = [];
  for (const s of raw) {
    const atMs = splitMs(s);
    if (atMs == null) { dropped.noTime += 1; continue; }
    const qty = qtyOf(s && s.qty);
    if (qty === 0) { dropped.noQty += 1; continue; }
    const key = `${atMs}`;
    if (seen.has(key)) dropped.duplicated += 1;   // ⚠ 消さずに残す。記録どおりに返す
    seen.add(key);
    chunks.push({ atMs, qty, date: String((s && s.date) || ''), time: String((s && s.time) || '') });
  }
  chunks.sort((a, b) => a.atMs - b.atMs);

  if (dropped.noTime) why.push(`日時が読めない便が ${dropped.noTime}件 あります。その台数はどの便にも乗せていません`);
  if (dropped.noQty) why.push(`台数が入っていない便が ${dropped.noQty}件 あります。その便では1台も着かない形で数えています`);
  if (dropped.duplicated) why.push(`同じ日時の便が ${dropped.duplicated}件 あります。記録のまま2つの便として残しています`);

  // 🚨 分けられる便が0 = 分納として扱わない。呼ぶ側の計算を1行も変えない。
  if (chunks.length === 0) {
    const line = recorded >= 2
      ? `到着予定は ${recorded}件 ありますが、台数と日時が読める便は1件もありません。分けずに今までどおり1回として扱います`
      : '到着予定は1便だけですが、台数か日時が読めません。今までどおり1回で全台が着く形のままです';
    return none(LOAD_KIND.SINGLE, line);
  }

  // 🚨 2026-09-22 便が1つの時は「全台そろうか」で分かれる。
  //   ・全台そろう(または台数が分からない) … 今までどおり分けない。計算は1行も変わらない
  //   ・ロットの台数に足りない           … 分ける。残りは「いつ着くか記録に無い台」として残す
  //   前は一部だけの1便も捨てていたので、6台の指図に「2台だけ」の便が在っても
  //   6台ぜんぶが その時刻に着く形で数えていた(入荷の予定が無い4台まで割り付けていた)。
  if (chunks.length === 1) {
    const one = qtyOf(chunks[0].qty);
    if (quantity === 0 || one >= quantity) {
      return none(LOAD_KIND.SINGLE, quantity === 0
        ? '到着予定は1便だけです。この指図の台数が記録にないので、今までどおり1回で全台が着く形のままです'
        : '到着予定は1便で、全台がそろいます。今までどおり1回で全台が着く形のままです');
    }
  }

  if (chunks.length > MAX_SPLITS) {
    why.push(`便が ${chunks.length}件 あります(登録の上限は ${MAX_SPLITS}件)。記録のまま全部返しています`);
  }

  const covered = chunks.reduce((n, c) => n + c.qty, 0);
  const over = quantity > 0 ? Math.max(0, covered - quantity) : 0;
  const uncovered = quantity > 0 ? Math.max(0, quantity - covered) : 0;

  if (quantity === 0) {
    why.push(`この指図の台数が記録にありません。便の合計 ${covered}台 をそのまま返しています`);
  } else if (over > 0) {
    // 🚨 削らない。多い事を言うだけ。
    why.push(`便の合計 ${covered}台 が この指図の ${quantity}台 より ${over}台 多いです。台数は記録のまま返しています`);
  } else if (uncovered > 0) {
    // 🚨 最後の便へ足さない。いつ着くか分からない台数として残す。
    why.push(`便の合計 ${covered}台 は この指図の ${quantity}台 に ${uncovered}台 足りません。残りがいつ着くかは記録にありません`);
  } else {
    why.push(`${quantity}台 を ${chunks.length}便 に分けて受け取ります`);
  }

  return { kind: LOAD_KIND.SPLIT, chunks, covered, uncovered, over, quantity, recorded, dropped, why };
};

/**
 * その時刻までに手元へ着いている台数。
 * ⚠ ちょうどその時刻に着く便は「着いている」として数える(atMs <= atOrBeforeMs)。
 * @param {Array} chunks splitArrivalLoad の chunks
 */
export const readyQtyAt = (chunks, atOrBeforeMs) => {
  const t = Number(atOrBeforeMs);
  if (!Number.isFinite(t)) return 0;
  let n = 0;
  for (const c of (chunks || [])) { if (c && c.atMs <= t) n += qtyOf(c.qty); }
  return n;
};

/**
 * その台が着く実時刻。
 *
 * 🚨🚨 台番号は **0から数える**。このアプリの台番号がそうだから(2026-09-10 の指摘で直した)。
 *   ・buildJobs.js の `for (let u = 0; u < quantity; u++) … unitIndex: u`
 *   ・作業の記録の鍵も `工程id-0` から始まる(`${stepId}-${u}`)
 *   以前ここは 1から数える作りだったので、job.unitIndex をそのまま渡すと **必ず1つずれ**、
 *   5台のうち最後の1台だけ遅れて着くロットで「4台目が遅れる」形になっていた。
 *   ⚠ 直した後に数え方を1へ戻したら、split-arrival-load.test.mjs の P7 が赤くなる
 *     (buildJobs が本当に 0 から作る事も、その試験の中で確かめている)。
 *
 * 割付側が「この台はいつから触れるか」を1台ずつ引くための口。
 * @param {Array} chunks splitArrivalLoad の chunks
 * @param {number} unitIndex 台番号。**0が1台目**。job.unitIndex をそのまま渡してよい
 * @returns {number|null} 便に乗っていない台は null(= いつ着くか記録にない)
 */
export const unitReadyAtMs = (chunks, unitIndex) => {
  const k = Number(unitIndex);
  if (!Number.isInteger(k) || k < 0) return null;
  let acc = 0;
  for (const c of (chunks || [])) {
    acc += qtyOf(c && c.qty);
    if (k < acc) return c.atMs;   // 0が1台目なので「< 累計」。1から数えていた頃は「<= 累計」
  }
  return null;
};

/**
 * 分納の記録から「この時刻より前に着手できる台数」を、割付の入口へ渡す形にする。
 * 🚨 chunks が空(分納の記録が無い)なら **null を返す**。
 *   呼ぶ側は null の時だけ今までの assignableFromMs をそのまま使う。
 * @returns {{firstMs:number, lastMs:number, steps:{atMs:number, ready:number}[]}|null}
 */
export const arrivalLadder = (load) => {
  const chunks = (load && load.chunks) || [];
  if (chunks.length < 2) return null;
  let acc = 0;
  const steps = chunks.map((c) => { acc += c.qty; return { atMs: c.atMs, ready: acc }; });
  return { firstMs: chunks[0].atMs, lastMs: chunks[chunks.length - 1].atMs, steps };
};

/** 画面に出す1行。⚠ 数字は splitArrivalLoad が数えた物だけを使う(ここで数え直さない)。 */
export const splitLoadLine = (load) => {
  if (!load) return '';
  if (load.kind !== LOAD_KIND.SPLIT) return load.why[0] || '';
  const head = load.chunks.map((c) => `${c.time || '—'}×${c.qty}台`).slice(0, 4).join(' / ');
  const more = load.chunks.length > 4 ? ` ほか${load.chunks.length - 4}件` : '';
  return `${head}${more}（${load.why[load.why.length - 1]}）`;
};
