// ============================================================================
// ⏱🚨 作業時間が「保存で消える」のを止める見張り
// ----------------------------------------------------------------------------
// 2026-08-17 清水さん:
//   「8/12に最終検査でした作業が、8/17でアプリで見たらタッチアップエリアにあった」
//   「作業した時間取りデータが全部なくなってるね」
//   「これは一番の問題だ。ここまでひどいのは初めて見た」
//   実データ(本番 final-inspection-v1): 指図1001456630 ほか計5ロットで
//   `tasks` が **空のマップ {}**。工程(steps)は60件そのまま残っているのに、
//   duration も firstStartTime も endTime も **1件も無い**。
//
// ----------------------------------------------------------------------------
// 🚨🚨 このアプリ全体が信じていた前提が **間違っていた**
// ----------------------------------------------------------------------------
//   コードの至る所にこう書いてある(src/data/provider.js:137 ほか):
//     「merge:true は 送らなかったキー を消さない」
//   これは **キーを送らなかった時** の話としては正しい。
//   ところが **空のマップ `{}` を送った時** は話が逆になる。
//
//   Firestore SDK の実装(この版で実測):
//     node_modules/@firebase/firestore/dist/common-091f2944.esm.js:20701-20706
//       function __PRIVATE_parseObject(e, t) {
//           const n = {};
//           return isEmpty(e) ?
//           // If we encounter an empty object, we explicitly add it to the update
//           // mask to ensure that the server creates a map entry.
//           t.path && t.path.length > 0 && t.fieldMask.push(t.path) : ...
//
//   つまり **空のマップは「送らなかったキー」ではなく「明示的に書き換えるキー」** として
//   フィールドマスクに載る。
//     setDoc(ref, { tasks: {} }, { merge: true })
//       → サーバ側の tasks が **丸ごと空に置き換わる**。1回の保存で全部消える。
//
//   ⚠⚠ **実測で確かめた**(2026-08-17・Firestoreエミュレータ。本番には触れていない)。
//     タッチアップ移動と同じ形の payload を、同じSDKで、本物のサーバへ投げた結果:
//       前  : tasks 2件 / 合計 304秒
//       ①{ status:'paused' } だけ送る            → tasks 2件（残る）
//       ②{ location:'zone_touchup', status:'paused', tasks:{} } を merge:true
//                                                → tasks **0件**
//                                                  tasks キーは在る(空のマップ)
//                                                  orderNo も location も無事
//     これは本番で見つかった5ロットの姿と **1つ残らず一致する**
//     (tasks は空のマップとして存在・他の項目は全部無事・location=zone_touchup・status=paused)。
//
//   このアプリはロットを保存するとき、ほぼ全ての経路で
//   **tasks のマップ全体** を送っている(手元の state をそのまま)。
//   だから「手元の tasks が空だった1回」で、サーバの時間取りが全部飛ぶ。
//   そして **その1回を止める仕掛けは、どこにも無かった**。
//
// ----------------------------------------------------------------------------
// この見張りがやる事
// ----------------------------------------------------------------------------
//   保存する直前に「今サーバに在るロット」と「これから送る payload」を突き合わせ、
//   **時間を持っている task が 消える／時間を失う** なら止める(または名指しで知らせる)。
//
//   ⚠正しい書き換えは通す。線引きは試験(__tests__/workTimeGuard.test.mjs)で固定する。
//     ・時間が増える／task が増える            … 通す
//     ・計測中の startTime が消えて duration に化ける … 通す(時計を止めただけ)
//     ・員数/一括のもどし(先頭に合計・他は0+印)  … 通す(**工程ぐるみの合計が減らない**から)
//     ・按分補正・手入力                        … 通す(元の値を控える印が付いているから)
//     ・記録が1つも無い task を名指しで消す      … 通す
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ⚠この見張りは **判定するだけ**。データは1バイトも書き換えない。
// ============================================================================

/** 保存payload に混ぜる「消したキー」の入れ物(src/data/sentinels.js と同じ名前)。 */
export const DELETE_KEYS = '__deleteMapKeys';

/**
 * 「このキーを消す」印(src/data/sentinels.js の DATA_DELETE と同じ形)。
 *
 * ⚠⚠ 見張りは **withDeletions を通す前の生の payload** を見る。
 *   理由: withDeletions は `__deleteMapKeys` を本体から外して、消す場所へ印を置き換える。
 *   通した後の姿だけを見ると「名指しで消した」が見えなくなり、記録のある task の削除を
 *   『残る』と誤判定する。
 * ⚠それでも、呼び出し側が最初から DATA_DELETE を tasks の中へ置く書き方もある。
 *   印は「ただの素のオブジェクト」なので、素直に読むと **中身のある task** に見えてしまう。
 *   ここで形だけ見て「消す印」と分かるようにしておく(firebase も sentinels.js も import しない)。
 */
export const DELETE_SENTINEL_KEY = '__dataSentinel';

/** その値は「このキーを消す」印か。 */
export const isDeleteSentinel = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && v[DELETE_SENTINEL_KEY] === 'delete';

/**
 * 🚨 空のマップを merge:true で送ると、そのフィールドは丸ごと空になる。
 *    (上の SDK 実測。ここを false だと思って書かれたコードが本番を壊した)
 */
export const EMPTY_MAP_REPLACES_ON_MERGE = true;

/**
 * 「この変更は取り消せる／人が承知の上でやった」ことを示す印。
 * ⚠印を足すときは必ずここに足す。散らすと必ず片方だけ直る。
 *   countMergeFix.before … 員数/一括のもどし。元の秒数を控えてある
 *   origDuration         … 按分補正。元の秒数を控えてある
 *   manualTime           … 人が画面で秒数を打ち直した
 *   restoredFrom         … 復元で書き戻した(将来用)
 *   redoReset            … 人が「最初から作業」「該当なし解除」を押した。元の秒数と着手時刻を控えてある
 *                          ⚠この印が無いと、現場の正しい操作(やり直し)が見張りに止められる。
 */
export const RECOVERABLE_MARKS = Object.freeze(['countMergeFix', 'origDuration', 'manualTime', 'restoredFrom', 'redoReset']);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Firestore の Timestamp / 数値 / 文字列 を ミリ秒に。読めなければ 0。 */
export const msOf = (raw) => {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'object' && raw.seconds != null) return num(raw.seconds) * 1000;
  const d = new Date(raw).getTime();
  return Number.isNaN(d) ? 0 : d;
};

const isPlainMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * その task が持っている「作業の時間」。
 *
 * ⚠⚠ **startTime は入れない。** startTime は「いま動いている時計」で、
 *   一時停止・完了で消えるのが正しい(stopClock がそうしている)。
 *   これを「失った」と数えると、普通の完了操作が全部ひっかかって
 *   見張りが赤くなりっぱなしになり、誰も見なくなる。
 *
 * ⚠⚠ firstStartTime は **消えてはいけない**。アプリ自身がそう書いている
 *   (App.firebase.jsx「firstStartTime は維持 (最初に着手した時刻は不変)」)。
 *   今回消えた本番データで残っていた唯一の手掛かりが、この「いつ始めたか」だった。
 */
export const workTimeOf = (t) => {
  if (!isPlainMap(t)) return { duration: 0, firstStartTime: 0, endTime: 0, done: false };
  const st = String(t.status || '');
  return {
    duration: Math.max(0, num(t.duration)),
    firstStartTime: msOf(t.firstStartTime),
    endTime: msOf(t.endTime),
    // 「手が付いている」印。waiting 以外は何かしら人が触っている。
    done: !!st && st !== 'waiting',
  };
};

/** その task は作業の時間(または着手の跡)を持っているか。 */
export const hasWorkTime = (t) => {
  const w = workTimeOf(t);
  return w.duration > 0 || w.firstStartTime > 0 || w.endTime > 0 || w.done;
};

/** 取り消せる印が付いているか(元の値を控えてある／人が承知でやった)。 */
export const hasRecoverableMark = (t) => {
  if (!isPlainMap(t)) return false;
  return RECOVERABLE_MARKS.some((k) => {
    const v = t[k];
    if (v === undefined || v === null || v === false) return false;
    return true;
  });
};

/**
 * task の鍵 → 工程の身元。
 *   `<stepId>-<台番号>` と `<stepId>-lot-<台番号>` の2通りがある
 *   (seedItemGuard.orphanTaskKeys と同じ切り方)。
 */
export const stepIdOfTaskKey = (k) => {
  const s = String(k == null ? '' : k);
  if (s.includes('-lot-')) return s.slice(0, s.lastIndexOf('-lot-'));
  const i = s.lastIndexOf('-');
  return i > 0 ? s.slice(0, i) : s;
};

/**
 * 保存payload の `__deleteMapKeys` から「tasks の下で消される鍵」を取り出す。
 * 形は2通り(sentinels.splitDeletions と同じ)。
 *   ① { tasks: ['s_a-0'] }
 *   ② [['tasks','s_a-0'], ['tasks','s_a-1','inputs','x']]
 * ⚠ ② で 3段以上の物(inputs の1個を消す等)は **task 自体は消えない** ので数えない。
 */
export const deletedTaskKeysOf = (patch) => {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const del = p[DELETE_KEYS];
  const out = new Set();
  // ⚠ここで isPlainMap を使わない。②の形は **配列** なので弾かれてしまう
  //   (弾くと「名指しで消した」が見えなくなり、消えた task を『理由不明の消失』と誤報する)。
  if (del && typeof del === 'object') {
    if (Array.isArray(del)) {
      del.forEach((q) => {
        if (Array.isArray(q) && q.length === 2 && String(q[0]) === 'tasks' && q[1]) out.add(String(q[1]));
      });
    } else {
      const keys = del.tasks;
      if (Array.isArray(keys)) keys.forEach((k) => { if (k) out.add(String(k)); });
    }
  }
  // ③ tasks の中に「消す印」を直接置く形。
  //   ⚠印は素のオブジェクトなので、これを読まないと「中身のある task」に見える。
  const t = p.tasks;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    for (const [k, v] of Object.entries(t)) if (isDeleteSentinel(v)) out.add(String(k));
  }
  return out;
};

/**
 * task 1件ぶんの再帰マージ。
 * ⚠中の項目に「消す印」が入っていたら **その項目を落とす**。
 *   `tasks: { 'a-0': { duration: DATA_DELETE } }` は秒数が消える保存で、
 *   素直に上書きすると duration が印のオブジェクトになり「時間は在る」と誤読する。
 */
const mergeTaskFields = (beforeTask, patchTask) => {
  const out = { ...(isPlainMap(beforeTask) ? beforeTask : {}) };
  for (const [k, v] of Object.entries(patchTask)) {
    if (isDeleteSentinel(v)) { delete out[k]; continue; }
    out[k] = v;
  }
  return out;
};

/**
 * Firestore の merge:true と **同じ結果** の tasks を作る。
 *
 * ⚠ここが見張りの心臓。ここを間違えると「大丈夫」と言って通してしまう。
 *   ① payload に tasks が無い            … 何も変わらない
 *   ② payload の tasks が空のマップ {}   … 🚨 **丸ごと空に置き換わる**(今回の事故)
 *   ③ payload の tasks が {鍵: 値}       … 鍵ごとに再帰マージ(送らなかった鍵は残る)
 *   ④ ある鍵の値が空のマップ {}          … 🚨 その task が空に置き換わる
 *   ⑤ __deleteMapKeys                    … 名指しの鍵を消す
 *   ⑥ merge:false                        … doc ごと置き換え(tasks が無ければ全部消える)
 *
 * @param beforeTasks いまサーバに在る tasks
 * @param patch       これから送る保存payload(ロット1件ぶん)
 * @param opts        { merge: true|false }
 */
export const mergeTasksLikeFirestore = (beforeTasks, patch, opts = {}) => {
  const before = isPlainMap(beforeTasks) ? beforeTasks : {};
  const p = isPlainMap(patch) ? patch : {};
  const merge = opts.merge !== false;

  // ⑥ 丸ごと置き換え
  if (!merge) {
    const t = p.tasks;
    return isPlainMap(t) ? { ...t } : {};
  }

  let next;
  if (!('tasks' in p) || p.tasks === undefined) {
    next = { ...before };                                   // ①
  } else if (p.tasks === null) {
    next = {};                                              // null も「消える」側。中身は残らない
  } else if (!isPlainMap(p.tasks)) {
    next = {};                                              // 配列や文字列を入れたら map ではなくなる
  } else if (Object.keys(p.tasks).length === 0) {
    next = EMPTY_MAP_REPLACES_ON_MERGE ? {} : { ...before }; // ② 🚨
  } else {
    next = { ...before };                                   // ③
    for (const [k, v] of Object.entries(p.tasks)) {
      // ⚠「消す印」は素のオブジェクトなので、isPlainMap より **先に** 見る。
      //   後にすると印そのものが task の中身として残り、消えるのに『残る』と読む。
      if (isDeleteSentinel(v)) { delete next[k]; continue; } // ⑦ 名指しの削除(印を直接置く形)
      if (!isPlainMap(v)) { next[k] = v; continue; }
      if (Object.keys(v).length === 0) { next[k] = {}; continue; }  // ④ 🚨
      next[k] = mergeTaskFields(before[k], v);
    }
  }

  // ⑤ 名指しの削除
  for (const k of deletedTaskKeysOf(p)) delete next[k];
  return next;
};

/** 工程ごと(stepId ごと)の秒数の合計。⚠員数/一括のもどしを「正しい」と判定する土台。 */
export const durationByStep = (tasks) => {
  const out = new Map();
  for (const [k, t] of Object.entries(isPlainMap(tasks) ? tasks : {})) {
    const sid = stepIdOfTaskKey(k);
    out.set(sid, (out.get(sid) || 0) + Math.max(0, num(t && t.duration)));
  }
  return out;
};

/** 損失の重さ。数字が大きいほど重い(並べ替えと出荷ゲートに使う)。 */
export const LOSS_LEVEL = Object.freeze({
  // 🚨🚨 空の tasks を送る事そのもの。**前の姿を知らなくても止める**。
  //   知らないから通す、では 2026-08-17 と同じ事が起きる(あの時も手元は空だった)。
  //   だから一番重い。`allow` では絶対に通らない(通すには allowEmptyTasks:true が要る)。
  blank: 5,
  wipe: 4,    // 🚨 tasks が丸ごと空になる(2026-08-17 に本番で起きた形)
  drop: 3,    // 時間を持つ task が消える
  erase: 2,   // task は残るが「いつ始めたか」が消える
  shrink: 1,  // 時間が減る(工程ぐるみでも減る・控えの印も無い)
});

const LEVEL_LABEL = {
  blank: '🚨 検査記録(tasks)を空にする保存です',
  wipe: '🚨 時間取りデータが丸ごと消えます',
  drop: '🚨 時間を持つ検査項目が消えます',
  erase: '⚠ 「いつ始めたか」が消えます',
  shrink: '⚠ 記録した時間が減ります',
};

/**
 * 🚨 これから送る保存で、作業時間を失うか。
 *
 * @param before いまサーバに在るロット({ id, tasks, steps, ... })。null/未取得なら判定しない
 * @param patch  これから送る保存payload
 * @param opts   { merge:true, allowEmptyWhenBeforeEmpty:true }
 * @returns {
 *   lost:      失うなら true
 *   level:     'wipe'|'drop'|'erase'|'shrink'|null
 *   levelRank: 数字(LOSS_LEVEL)
 *   reason:    人が読む一言
 *   lostKeys:  [{ key, what, before:{duration,firstStartTime,endTime}, after:{...} }]
 *   lostSec:   失う秒数の合計
 *   counts:    { beforeTasks, afterTasks, beforeWithTime, afterWithTime }
 * }
 *
 * ⚠ before が無い(まだ読めていない/新しいロット)ときは **判定しない**(lost:false)。
 *   知らない事を「危ない」と言うと、新規登録が全部止まる。
 */
export const wouldLoseWorkTime = (before, patch, opts = {}) => {
  const beforeTasks = isPlainMap(before && before.tasks) ? before.tasks : {};
  const beforeKeys = Object.keys(beforeTasks);
  const none = {
    lost: false, level: null, levelRank: 0, reason: '', lostKeys: [], lostSec: 0,
    counts: { beforeTasks: beforeKeys.length, afterTasks: beforeKeys.length, beforeWithTime: 0, afterWithTime: 0 },
  };
  if (!isPlainMap(before)) return none;                 // 前の姿を知らない → 判定しない
  if (!beforeKeys.length) return none;                  // 元から空 → 失う物が無い

  const afterTasks = mergeTasksLikeFirestore(beforeTasks, patch, opts);
  const deleted = deletedTaskKeysOf(patch);
  const beforeStepSec = durationByStep(beforeTasks);
  const afterStepSec = durationByStep(afterTasks);

  const beforeWithTime = beforeKeys.filter((k) => hasWorkTime(beforeTasks[k]));
  const afterWithTime = Object.keys(afterTasks).filter((k) => hasWorkTime(afterTasks[k]));

  const lostKeys = [];
  let worst = null;
  const bump = (lv) => { if (!worst || LOSS_LEVEL[lv] > LOSS_LEVEL[worst]) worst = lv; };

  for (const k of beforeKeys) {
    const b = beforeTasks[k];
    if (!hasWorkTime(b)) continue;                      // 元から何も無い → 失いようがない
    const wb = workTimeOf(b);
    const a = afterTasks[k];

    // --- 消える -------------------------------------------------------------
    if (a === undefined) {
      lostKeys.push({ key: k, what: deleted.has(k) ? '名指しで消された(記録があるのに)' : '消えた', before: wb, after: null });
      bump('drop');
      continue;
    }
    const wa = workTimeOf(a);

    // --- 「いつ始めたか」が消える -------------------------------------------
    //   ⚠アプリ自身の決まり:「firstStartTime は維持 (最初に着手した時刻は不変)」
    //   ⚠ただし **控えの印が付いている時は通す**。「最初から作業」「該当なし解除」は
    //     人がその場で押した作り直しで、元の時刻は印の中に控えてある(戻せる)。
    //     ここを止めると現場の正しい操作が全部止まり、見張りごと外される。
    if (wb.firstStartTime > 0 && wa.firstStartTime <= 0 && !hasRecoverableMark(a)) {
      lostKeys.push({ key: k, what: '着手時刻(firstStartTime)が消えた', before: wb, after: wa });
      bump('erase');
    }

    // --- 秒数が減る ---------------------------------------------------------
    if (wa.duration < wb.duration) {
      const sid = stepIdOfTaskKey(k);
      const groupKept = (afterStepSec.get(sid) || 0) >= (beforeStepSec.get(sid) || 0);
      // 員数/一括のもどし: 先頭へ寄せただけで **工程ぐるみの合計は減っていない** → 正しい
      // 按分補正・手入力: 元の値を控える印がある → 取り消せるので通す
      if (!groupKept && !hasRecoverableMark(a)) {
        lostKeys.push({ key: k, what: `秒数が ${wb.duration} → ${wa.duration} に減った`, before: wb, after: wa });
        bump('shrink');
      }
    }
  }

  // --- 丸ごと空 -------------------------------------------------------------
  // 🚨 これが 2026-08-17 に本番で起きた形。個別の理由より先に、いちばん重い印を付ける。
  if (beforeWithTime.length > 0 && afterWithTime.length === 0) worst = 'wipe';

  const lostSec = lostKeys.reduce((a, x) => a + Math.max(0, x.before.duration - (x.after ? x.after.duration : 0)), 0);
  if (!worst) {
    return {
      ...none,
      counts: {
        beforeTasks: beforeKeys.length, afterTasks: Object.keys(afterTasks).length,
        beforeWithTime: beforeWithTime.length, afterWithTime: afterWithTime.length,
      },
    };
  }
  return {
    lost: true,
    level: worst,
    levelRank: LOSS_LEVEL[worst],
    reason: `${LEVEL_LABEL[worst]}（${lostKeys.length}件・${lostSec}秒）`,
    lostKeys,
    lostSec,
    counts: {
      beforeTasks: beforeKeys.length, afterTasks: Object.keys(afterTasks).length,
      beforeWithTime: beforeWithTime.length, afterWithTime: afterWithTime.length,
    },
  };
};

/**
 * 工程を作り直した結果、どの task が迷子になるか(テンプレ再焼付・特注リセット)。
 * ⚠ step.id はロットごとに採番し直される。id が変われば tasks の鍵は二度と繋がらない。
 * @returns [{ key, stepId, duration }]
 */
export const orphanedByStepRekey = (beforeLot, nextSteps) => {
  const tasks = isPlainMap(beforeLot && beforeLot.tasks) ? beforeLot.tasks : {};
  const ids = new Set((Array.isArray(nextSteps) ? nextSteps : []).map((s) => s && s.id).filter(Boolean));
  const out = [];
  for (const [k, t] of Object.entries(tasks)) {
    if (!hasWorkTime(t)) continue;
    const sid = stepIdOfTaskKey(k);
    if (!ids.has(sid)) out.push({ key: k, stepId: sid, duration: Math.max(0, num(t && t.duration)) });
  }
  return out;
};

/** 人が読む説明(alert / console / 見張りの出力で使い回す)。 */
export const describeLoss = (res, lot = null) => {
  if (!res || !res.lost) return '';
  const who = lot ? `指図 ${lot.orderNo || lot.id || '(不明)'}` : 'このロット';
  const head = `${who}: ${res.reason}`;
  const rows = res.lostKeys.slice(0, 10).map((x) => `  ・${x.key} … ${x.what}（前: ${x.before.duration}秒）`);
  const more = res.lostKeys.length > 10 ? `  …ほか ${res.lostKeys.length - 10}件` : '';
  const tail = `  検査項目 ${res.counts.beforeTasks}件 → ${res.counts.afterTasks}件 / 時間を持つ物 ${res.counts.beforeWithTime}件 → ${res.counts.afterWithTime}件`;
  return [head, ...rows, more, tail].filter(Boolean).join('\n');
};

// ===========================================================================
// 🚨 空の tasks を送る事そのものを止める
// ---------------------------------------------------------------------------
// ⚠⚠ wouldLoseWorkTime は「前の姿」と突き合わせる判定なので、**前の姿を知らない時は
//   何も言えない**(知らない事を危ないと言うと新規登録が全部止まる)。
//   ところが 2026-08-17 の事故は、まさに「手元が空・前の姿は分からない」状態で起きた。
//   → 突き合わせとは **別に**、`tasks: {}` という形そのものを禁じる。
//
// ⚠正しく全部消したい時の道は1本だけ用意する: **opts.allowEmptyTasks === true**。
//   ・`allow:'wipe'` では通らない(重さの許可とは別の鍵)。人が明示しないと通らない。
//   ・工程を全部消した等で本当に空にする時は、呼ぶ側がこの鍵を書く=grepで一覧できる。
// ===========================================================================

/** tasks を空にしてしまう payload か。{ blank, reason, kind } */
export const blankTasksRisk = (patch, opts = {}) => {
  const no = { blank: false, reason: '', kind: '' };
  const p = isPlainMap(patch) ? patch : {};
  if (!('tasks' in p) || p.tasks === undefined) return no;   // 送っていない = 何も変わらない
  if (opts.allowEmptyTasks === true) return no;              // ⚠明示の道(呼ぶ側が承知している)
  const t = p.tasks;
  if (t === null) {
    return { blank: true, kind: 'null', reason: '🚨 tasks に null を送ろうとしています（検査記録が丸ごと消えます）' };
  }
  if (!isPlainMap(t)) {
    return { blank: true, kind: 'notmap', reason: '🚨 tasks にマップ以外の値を送ろうとしています（検査記録が丸ごと消えます）' };
  }
  if (Object.keys(t).length === 0) {
    return { blank: true, kind: 'empty', reason: '🚨 tasks が空です（merge:true でもサーバの検査記録が丸ごと空になります）' };
  }
  return no;
};

/** blankTasksRisk の結果を、wouldLoseWorkTime と同じ形の答えにそろえる。 */
const blankResult = (before, risk) => {
  const beforeTasks = isPlainMap(before && before.tasks) ? before.tasks : {};
  const keys = Object.keys(beforeTasks);
  const withTime = keys.filter((k) => hasWorkTime(beforeTasks[k]));
  const sec = withTime.reduce((a, k) => a + workTimeOf(beforeTasks[k]).duration, 0);
  return {
    lost: true, level: 'blank', levelRank: LOSS_LEVEL.blank, blank: true, blankKind: risk.kind,
    // ⚠「止めました」だけでは何が起きたか分からない。**件数と秒数**まで出す。
    reason: `${risk.reason}（前: 検査項目 ${keys.length}件・時間を持つ物 ${withTime.length}件・${sec}秒）`,
    lostKeys: withTime.map((k) => ({ key: k, what: 'tasks を空にする保存で消える', before: workTimeOf(beforeTasks[k]), after: null })),
    lostSec: withTime.reduce((a, k) => a + workTimeOf(beforeTasks[k]).duration, 0),
    counts: { beforeTasks: keys.length, afterTasks: 0, beforeWithTime: withTime.length, afterWithTime: 0 },
  };
};

// ===========================================================================
// 🚨 読み込みの門
// ---------------------------------------------------------------------------
// ⚠⚠ 読めていない時に保存すると「手元が空」＝そのまま消す保存になる。
//   購読が 429 や権限で死んでも画面は何も言わないので(2026-08-17 の土台の欠陥)、
//   **読めていない事が分かった時点で保存を止める**。
// ===========================================================================
export const LOTS_NOT_LOADED_MSG =
  'データが読めていません。保存できません。\n（検査記録を空で上書きしてしまうため、保存を止めました。画面を再読み込みしてください）';

/** 読めていなければ投げて止める。⚠無言で return しない。 */
export const assertLotsLoaded = (loaded, opts = {}) => {
  if (loaded) return true;
  const res = {
    lost: true, level: 'notloaded', levelRank: LOSS_LEVEL.blank, reason: LOTS_NOT_LOADED_MSG,
    lostKeys: [], lostSec: 0, counts: { beforeTasks: 0, afterTasks: 0, beforeWithTime: 0, afterWithTime: 0 },
  };
  if (typeof opts.onBlock === 'function') opts.onBlock(res);
  const e = new Error(LOTS_NOT_LOADED_MSG);
  e.name = 'LotsNotLoadedError';
  e.detail = res;
  throw e;
};

/**
 * 保存の直前に呼んで、失うなら **投げて止める**。
 *
 * ⚠⚠ 握り潰さない。無言で return もしない。
 *   呼び出し側が「保存できた」と受け取ると、画面を閉じて入力が消える
 *   (saveError-swallow の教訓 2026-07-26 と同じ形)。
 *
 * @param opts.allow  'wipe'|'drop'|'erase'|'shrink' のうち、通してよい重さの上限。
 *                    既定は何も通さない(全部止める)。
 *                    ⚠'blank'(空の tasks)は **これでは通らない**。allowEmptyTasks が要る。
 * @param opts.allowEmptyTasks true の時だけ「tasks を空にする保存」を通す。
 * @param opts.onBlock 止めた時に呼ばれる(記録を残す用)。
 */
export const assertSafeLotSave = (before, patch, opts = {}) => {
  // ① 形そのものが危ない物(前の姿を知らなくても止める)
  const risk = blankTasksRisk(patch, opts);
  if (risk.blank) {
    const res = blankResult(before, risk);
    if (typeof opts.onBlock === 'function') opts.onBlock(res);
    const e = new Error(`作業の記録が消えるので保存を止めました。\n${describeLoss(res, before)}`);
    e.name = 'WorkTimeLossError';
    e.detail = res;
    throw e;
  }
  // ② 前の姿と突き合わせる判定
  const res = wouldLoseWorkTime(before, patch, opts);
  if (!res.lost) return res;
  const allowRank = opts.allow ? (LOSS_LEVEL[opts.allow] || 0) : 0;
  if (res.levelRank <= allowRank) return res;
  if (typeof opts.onBlock === 'function') opts.onBlock(res);
  const e = new Error(`作業の記録が消えるので保存を止めました。\n${describeLoss(res, before)}`);
  e.name = 'WorkTimeLossError';
  e.detail = res;
  throw e;
};
