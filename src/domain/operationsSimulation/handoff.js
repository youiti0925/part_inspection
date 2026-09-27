// ============================================================================
// 👥 分担の区切り —「1台の途中で人が替わらない」ようにする門と、替わった理由
// ----------------------------------------------------------------------------
// 清水さん(2026-09-10 添付の納期一覧を見て):
//   「分担って書いてあるけど、なんで分担したって書いてないからわかりづらい」
//   「分担するときはできたら一台毎で区切る感じじゃないとだめだからね、
//     区切りの良いところで分担ならOKね、こういう設定もいるからね、
//     各工程連続する感じもあるからね」
//
// ── いままでの作り ────────────────────────────────────────────────────────
//   割付(simulate.js tryAssign)は **台×工程** の仕事を1個ずつ、その時に空いている
//   人へ渡す。**同じ台の前の工程を誰が持ったかは1バイトも見ていない**。
//   だから 1台目の工程Aを片山さん・工程Bを村さん、が普通に起きる(区切りの悪い分担)。
//   画面(opsim/mainWorker.js)は **結果から** 分数の多い人を主担当にし、75%未満なら
//   「＋◯◯と分担」と書くだけで、**なぜ分かれたのかは持っていない**。
//
// ── ここで作る物 ──────────────────────────────────────────────────────────
//   ① 区切りの門(3通り)。🚨 渡されなければ 1行も動かない('none' が既定)。
//        'none' … 制約なし(2026-09-10 まで と 1バイトも同じ答え)
//        'soft' … できれば同じ人(その人を候補の一番前へ置くだけ。空いていなければ替わる)
//        'unit' … 台ごとに同じ人(その人が空くまで **待つ**)
//      🚨 'soft' は 順番だけ を変える。できる人の顔ぶれ(候補)は1人も減らさない。
//        (「個人設定のこのテンプレを優先」と同じ作法。能力に混ぜない)
//   ② 替わった理由。**どの区切りでも必ず残す**。
//      「片山さんが別の仕事(TWA-100 中間分割)をしているので 3台目から村さんへ」
//
// ⚠ ここは純関数だけ。React も firebase も import しない(node --test で回す)。
// ⚠ 今の時刻・乱数を読まない。時刻は引数で受け取る。
// ⚠ 文言はここ1本から出す(呼ぶ側で書き直さない)。
// ============================================================================

/** 区切りの決め方。⚠ 既定は OFF('none')＝いままでと同じ答え。 */
export const HANDOFF_MODE = Object.freeze({
  OFF: 'none',
  SOFT: 'soft',
  UNIT: 'unit',
});

/** 画面に出す言い方(設定の札と根拠の札で同じ言葉を使う)。 */
export const HANDOFF_LABEL = Object.freeze({
  none: '区切らない（いままでどおり）',
  soft: 'できれば1台を同じ人で（空いていなければ替わる）',
  unit: '1台は同じ人が最後まで（空くまで待つ）',
});

/** 待たせた時の合図。⚠ simulate の decisions と idleReason.js が同じ字を見る。 */
export const HANDOFF_WAIT_KIND = 'wait-unit-owner';

/** 待ちの理由の頭。⚠ idleReason.js は startsWith で種類を決めるので、頭は変えない。 */
export const HANDOFF_WAIT_LABEL = '同じ台を続ける人の手が空くのを待っています';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 設定の字を読む。**読める字だけ** 通す。
 * 🚨 'true' や 1 を「はい」と読み替えない。読めない物は 'none'(＝何もしない)。
 * @param {unknown} raw
 * @returns {'none'|'soft'|'unit'}
 */
export const normalizeHandoffMode = (raw) => {
  const s = str(raw);
  if (s === HANDOFF_MODE.SOFT || s === HANDOFF_MODE.UNIT) return s;
  return HANDOFF_MODE.OFF;
};

/**
 * 「その台」の鍵。ロットに1回だけの工程(員数・一括・段取り・片付け)は台に属さないので null。
 * 🚨 null の仕事にはこの門を掛けない(誰がやってもよい)。
 * @param {{lotId?:unknown, unitIndex?:unknown}|null} job
 * @returns {string|null}
 */
export const unitKeyOf = (job) => {
  if (!job || job.lotId == null) return null;
  const u = job.unitIndex;
  if (u === null || u === undefined || !Number.isInteger(Number(u))) return null;
  return `${String(job.lotId)}#${Number(u)}`;
};

/** 「3台目」の言い方。⚠ unitIndex は 0 から数える。 */
export const unitLabelOf = (unitIndex) => (
  Number.isInteger(Number(unitIndex)) ? `${Number(unitIndex) + 1}台目` : 'この台'
);

/**
 * その仕事を、前の工程と同じ人に続けさせるか。
 *
 * @param {object} o
 * @param {'none'|'soft'|'unit'} o.mode      区切りの決め方
 * @param {string} o.owner                   その台を前の工程で持っていた人('' なら まだ誰も)
 * @param {string[]} o.candidates            いま空いていて この工程を任せられる人(名前の並び)
 * @returns {{
 *   kind:'free'|'prefer'|'must'|'wait',
 *   only:string|null, first:string|null, waitFor:string|null, reason:string|null
 * }}
 *   free   … 門を掛けない(区切らない設定 / まだ誰も持っていない / ロットに1回の工程)
 *   prefer … first の人を候補の一番前へ('soft'。顔ぶれは減らさない)
 *   must   … only の1人だけに絞る('unit' で その人が空いている)
 *   wait   … 誰にも渡さない('unit' で その人の手が塞がっている)。reason を必ず持つ
 * 🚨 wait を返す時は必ず reason を返す(理由を言えない待機を作らない)。
 */
export const handoffGate = ({ mode = HANDOFF_MODE.OFF, owner = '', candidates = [] } = {}) => {
  const m = normalizeHandoffMode(mode);
  const who = str(owner);
  const list = Array.isArray(candidates) ? candidates.map(str).filter(Boolean) : [];
  if (m === HANDOFF_MODE.OFF || !who) {
    return { kind: 'free', only: null, first: null, waitFor: null, reason: null };
  }
  const free = list.includes(who);
  if (m === HANDOFF_MODE.SOFT) {
    // できれば同じ人。空いていなければ **黙って替わる**(理由は splitWhy が残す)。
    return { kind: free ? 'prefer' : 'free', only: null, first: free ? who : null, waitFor: null, reason: null };
  }
  // 'unit' … 1台は同じ人が最後まで
  if (free) return { kind: 'must', only: who, first: who, waitFor: null, reason: null };
  return {
    kind: 'wait',
    only: null,
    first: null,
    waitFor: who,
    reason: `${HANDOFF_WAIT_LABEL}（${who}さん）`,
  };
};

/** 替わった訳の種類。🚨 言えない事を「別の仕事」に丸めない為に分ける。 */
export const SPLIT_KIND = Object.freeze({
  BUSY: 'busy',        // 前の人が別の仕事をしている
  AWAY: 'away',        // 前の人がこの時いない(休み・勤務時間外)
  NO_SKILL: 'noSkill', // 前の人に **この工程の記録が無い**(候補に入っていない)
  OUTRUN: 'outrun',    // 前の人の手は空いていたが、順番で別の人が先に取った
});

/**
 * 人が替わった理由の1行。**画面にそのまま出す文**。
 * @param {object} o
 * @param {string} o.from        前の工程まで持っていた人
 * @param {string} o.to          これから持つ人
 * @param {number|null} o.unitIndex
 * @param {string} [o.kind]      SPLIT_KIND のどれか。既定は busy
 * @param {{model?:string, stepTitle?:string}|null} [o.busyWith]  from が今している仕事
 * @param {boolean} [o.away]     (古い呼び方) kind:'away' と同じ
 * @param {string} [o.stepTitle] kind:'noSkill' の時に「どの工程の記録が無いか」を言う
 * @returns {string}
 * 🚨 分からない事は書かない。何をしているか読めなければ「別の仕事」で止める。
 *   🚨 2026-09-10 の確かめ役の指摘: 前は busy と away の2通りしか言えず、
 *     「順番で先を越された」台と「その工程の記録が無い」台は **理由が空のまま** 残っていた。
 *     清水さんが見たいのは まさにその「なんで分担したか」なので、言い方を4つにする。
 */
export const splitWhy = ({
  from = '', to = '', unitIndex = null, kind = SPLIT_KIND.BUSY,
  busyWith = null, away = false, stepTitle = '',
} = {}) => {
  const a = str(from) || '前の人';
  const b = str(to) || '次の人';
  const unit = unitLabelOf(unitIndex);
  const k = away ? SPLIT_KIND.AWAY : String(kind || SPLIT_KIND.BUSY);
  if (k === SPLIT_KIND.AWAY) return `${a}さんがこの時いないので、${unit}から ${b}さんへ`;
  if (k === SPLIT_KIND.NO_SKILL) {
    const t = str(stepTitle) || str(busyWith && busyWith.stepTitle);
    return t
      ? `${a}さんには ${t} の記録が無いので、${unit}から ${b}さんへ`
      : `${a}さんにはこの工程の記録が無いので、${unit}から ${b}さんへ`;
  }
  if (k === SPLIT_KIND.OUTRUN) return `${a}さんの手は空いていましたが、順番で ${b}さんが先に取りました（${unit}）`;
  const model = str(busyWith && busyWith.model);
  const title = str(busyWith && busyWith.stepTitle);
  const what = model && title ? `${model} の${title}` : (model || title || '別の仕事');
  return `${a}さんが ${what} をしているので、${unit}から ${b}さんへ`;
};

/**
 * ロットの中で人が替わった記録をまとめる(画面の「＋◯◯と分担」の横に出す1行)。
 * @param {Array<{unitIndex:number|null, from:string, to:string, why:string, atMs:number|null}>} splits
 * @returns {{count:number, first:string|null, people:string[]}}
 */
export const summarizeSplits = (splits) => {
  const list = Array.isArray(splits) ? splits.filter((s) => s && str(s.to)) : [];
  const people = [];
  list.forEach((s) => {
    [str(s.from), str(s.to)].forEach((n) => { if (n && !people.includes(n)) people.push(n); });
  });
  // 🚨 先頭の why が空でも、後ろに言える理由が在れば それを出す
  //   (前は splits[0] をそのまま使っていたので、先頭が空だと札が丸ごと消えていた)。
  const firstWhy = list.map((s) => str(s.why)).find(Boolean) || null;
  return { count: list.length, first: firstWhy, people };
};

export default handoffGate;
