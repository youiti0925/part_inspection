// 再作業(やり直し)を「何回目か」「なぜ起きたか」まで開いて数えるための純関数。
//
// なぜ作るか (2026-08-06 本番実測):
//   いまの日次集計 (dailyWork.js の reworkEntries / reworkSecondsInRange) は
//   再作業を「1行の時間」にまとめてしまい、回数と原因を捨てている。
//   何を直せば効くかを出すには「原因 × 型式 × テンプレ」まで開く必要がある。
//
// ⚠数え方は本番バックアップ (2026-08-06_0500 / product-inspection-v1 / lots.json)
//   で1件ずつ数え直して合わせてある。その時の実数はこれ:
//     ・reworks の記録            258件 (合計 132,606秒 = 36.84h)
//     ・うち duration が 0秒      3件  (押してすぐ閉じた記録。start→end が 0.8秒ほど)
//     ・何回目か                  1回目176 / 2回目55 / 3回目15 / 4回目以降12
//     ・原因(回ごと→NG理由の順)   バックラッシュ大108 / 傾きNG再測定66 / 分割精度不良27 /
//                                 バックラッシュ小21 / 分割隣接不良10 …／ 原因不明11
//   ⚠0秒の3件も「やり直しの記録」として数える。記録は元データに実在するので、
//     こちらの判断で黙って捨てない (捨てると画面の件数を誰も説明できなくなる)。
//     時間は0秒なので合計時間は1秒も変わらない。0秒だった件数は
//     reworkSummary().zeroSecondsCount で取り出せる → 画面に「うち0秒◯件」と添えること。
//   ⚠round(何回目か)は実データ258件すべてに入っていた。並び順で補う道は残してあるが
//     本番では一度も使われない (古い記録が出てきた時の保険)。
//
// ⚠この現場の絶対の決まり (ここでも必ず守る)
//   1. 元データに無い値は作らない。原因が引けない行は「原因不明」として別枠に出し、
//      他の原因には絶対に混ぜない (混ぜると「バックラッシュ大が本当は何時間か」が嘘になる)。
//   2. 束ねる単位は 原因 × 型式 × テンプレ。工程名だけで束ねない
//      (同じ工程名でも型式/テンプレが違えば別物。過去にこれで嘘の集計を出している)。
//   3. 時間の元は reworks[].duration(秒) だけ。endTime - startTime は当てにならない
//      (実測で 258件中 61件がズレていた)。
//
// ⚠この中では金額を出さない。金額を画面に出す担当は「出どころ」と
//   「実数の式 (時間 × ¥2,800)」を必ず並べて書くこと。

/** 回別のまとめ方。実測の回数分布に合わせて 4本だけにする (5回目・9回目もあるので上は開いておく) */
export const ROUND_LABELS = ['1回目', '2回目', '3回目', '4回目以降'];

/** 原因が引けなかった行につける名前。他の原因と同じ土俵に置かないための目印でもある */
export const UNKNOWN_CAUSE = '原因不明';

/** 種別が決められなかった原因につける名前 */
export const UNKNOWN_KIND = '未分類';

/** 何回目かを 4本のどれに入れるか */
const roundLabel = (round) => {
  const n = Number(round) || 0;
  if (n <= 1) return ROUND_LABELS[0];
  if (n === 2) return ROUND_LABELS[1];
  if (n === 3) return ROUND_LABELS[2];
  return ROUND_LABELS[3];
};

/** 空の回別入れ物 (4本を必ず同じ並びで作る。0件でも欠けさせない) */
const emptyRounds = () => ROUND_LABELS.map((label) => ({ label, count: 0, seconds: 0 }));

const addToRounds = (rounds, round, seconds) => {
  const label = roundLabel(round);
  const hit = rounds.find((r) => r.label === label);
  if (!hit) return;
  hit.count += 1;
  hit.seconds += seconds;
};

const text = (v) => String(v == null ? '' : v).trim();

/**
 * 🎓教育中(新人)の記録の扱い (2026-08-08)。
 *   'exclude' (既定) … 時間の集計から外す。新人の練習でかかった時間を「この原因は◯時間かかっている」
 *                       に混ぜると、対策の優先順位が実態からずれるため。
 *   'only'           … 教育の伸びを見る画面用。
 *   'all'            … 教育中も込みの実費を見たい時。
 * ⚠外した分は捨てない。reworkSummary が traineeCount / traineeSeconds で必ず返すので、
 *   画面に「教育中の再作業 N件 / X時間 (別掲)」と1行出すこと (ファイル冒頭の決まり 1 と同じ趣旨)。
 */
const pickRows = (rows, traineeMode = 'exclude') => {
  const list = (rows || []).filter(Boolean);
  if (traineeMode === 'all') return list;
  if (traineeMode === 'only') return list.filter((r) => r.trainee === true);
  return list.filter((r) => r.trainee !== true);
};

/**
 * 原因の束を見分けるキー。
 * ⚠「原因が引けたかどうか」を必ずキーに混ぜる。理由は人が自由に打てるので、
 *   理由に「原因不明」と打った行と、本物の原因不明の行が、同じ文字になり得るため。
 *   文字だけでキーを作ると、この2つが1つの束に潰れて別枠の意味が消える。
 * JSON にするのは区切り文字を自分で決めないため (理由の文字に何が入っていても壊れない)。
 */
const causeKeyOf = (unknown, cause) => JSON.stringify([unknown ? 'unknown' : 'known', cause]);

/**
 * 作業のキー (taskKey) から工程名を引く。
 * App.jsx の titleForKey と同じ規則:
 *   ①工程IDが頭に付いていればそれ (`s1-2` や `s1-lot-3`)
 *   ②`0-3` のような数字なら steps の並び順
 *   ③どちらでもなければ「全体」
 */
const stepTitleOf = (steps, key) => {
  const k = String(key || '');
  for (const s of steps) {
    if (s && s.id && k.startsWith(`${s.id}-`)) return s.title || '全体';
  }
  const m = /^(\d+)-/.exec(k);
  if (m && steps[+m[1]]) return steps[+m[1]].title || '全体';
  return '全体';
};

/**
 * 再作業を「1回 = 1行」に開く。
 *
 * 1行に入るもの:
 *   lotId / orderNo / model / templateName / taskKey / stepTitle / round /
 *   seconds(= reworks[].duration) / zeroSeconds / cause / causeFrom / endedAt
 *
 * causeFrom は原因をどこから持ってきたか:
 *   '回ごと'        … その修正回に付いていた理由 (一番確かな物)
 *   'NG理由の代用'  … 回に理由が無いので、その作業のNG理由で代用した
 *                     ⚠NG理由はタスクに1個しかなく次のNGで上書きされる。
 *                       「たぶんこれ」であって確定ではない、と画面に必ず書くこと。
 *   '原因不明'      … どちらも無い。値を作らずここへ落とす。
 *
 * 日付 (endedAt) は endTime → startTime + duration。どちらも無ければ 0 (作らない)。
 */
export const reworkRows = ({ lots, templates } = {}) => {
  const tplName = new Map();
  (Array.isArray(templates) ? templates : []).forEach((t) => {
    if (t && t.id) tplName.set(String(t.id), String(t.name || ''));
  });

  const out = [];
  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    if (!lot || typeof lot !== 'object') return;
    const steps = Array.isArray(lot.steps) ? lot.steps : [];
    const tasks = lot.tasks && typeof lot.tasks === 'object' ? lot.tasks : {};
    // テンプレ名は ①マスタから引く ②ロットに直接書いてあればそれ ③無ければ空のまま
    const templateName = tplName.get(String(lot.templateId || '')) || String(lot.templateName || '');

    Object.entries(tasks).forEach(([taskKey, task]) => {
      if (!task || typeof task !== 'object') return;
      const list = Array.isArray(task.reworks) ? task.reworks : [];
      if (!list.length) return;
      const ngReason = text(task.ngReason);
      const stepTitle = stepTitleOf(steps, taskKey);

      list.forEach((rw, idx) => {
        if (!rw || typeof rw !== 'object') return;
        // 0秒の記録も1件として数える。やり直しが起きた事実は元データに書いてある。
        // ⚠マイナスの時間だけは足し算を狂わせるので 0秒 として扱う (記録自体は残す)。
        const raw = Number(rw.duration) || 0;
        const seconds = raw > 0 ? raw : 0;

        const end = Number(rw.endTime) || 0;
        const st = Number(rw.startTime) || 0;
        const endedAt = end > 0 ? end : (st > 0 ? st + seconds * 1000 : 0);

        const own = text(rw.reason);
        let cause = '';
        let causeFrom = '原因不明';
        if (own) { cause = own; causeFrom = '回ごと'; }
        else if (ngReason) { cause = ngReason; causeFrom = 'NG理由の代用'; }

        out.push({
          lotId: String(lot.id || ''),
          orderNo: String(lot.orderNo || ''),
          model: String(lot.model || ''),
          templateName,
          taskKey: String(taskKey),
          stepTitle,
          // round が抜けている古い記録は並び順で補う (飛んでいる番号はそのまま活かす)
          round: Number(rw.round) || (idx + 1),
          seconds,
          // 時間が0秒だった記録の目印。件数には入れるが「時間の話」には出せない、を画面で言うため
          zeroSeconds: seconds === 0,
          cause,
          causeFrom,
          endedAt,
          // 🎓その作業が教育中(新人)の記録か。時間の集計からは既定で外すが、行としては必ず残す。
          trainee: task.trainee === true,
        });
      });
    });
  });
  return out;
};

/**
 * 原因ごとに 件数・合計秒・回別内訳 を出す。時間の大きい順。
 * kindOf(cause) は「その原因の種別」を返す関数。中で決め打ちせず外から渡す
 *   (何を機械の問題と呼ぶかは現場が決めることで、この関数が決めることではない)。
 * ⚠原因不明は他の原因に混ぜず、時間がどれだけ長くても必ず最後の別枠に置く。
 *
 * ⚠束ねるキーは「文字」ではなく「原因が引けたか(unknown)＋文字」で作る。
 *   理由は人が自由に打てる (NG理由の入力欄) ので、誰かが理由に「原因不明」と
 *   打ち込むと、本物の原因不明と同じ束に混ざってしまうため。
 *   混ざると、先に入った方の札で束全体の扱いが決まり、
 *   本物の原因不明に種別が付いて別枠から出てしまう = 作り話になる。
 *   → 文字が同じでも別の束にして、unknown の札で必ず見分けられるようにする。
 *   画面では unknown:true の行に「(原因が引けなかった分)」と添えて、
 *   同じ「原因不明」という文字の2行を取り違えないようにすること。
 *   開いた時の内訳の突き合わせには cause の文字ではなく key を使うこと
 *   (byCauseModelTemplate の causeKey と同じ文字列になる)。
 */
export const byCause = (rows, { kindOf, traineeMode = 'exclude' } = {}) => {
  const map = new Map();
  pickRows(rows, traineeMode).forEach((r) => {
    const unknown = r.causeFrom === '原因不明' || !text(r.cause);
    const cause = unknown ? UNKNOWN_CAUSE : r.cause;
    const key = causeKeyOf(unknown, cause);
    if (!map.has(key)) {
      map.set(key, { key, cause, kind: UNKNOWN_KIND, count: 0, seconds: 0, unknown, rounds: emptyRounds() });
    }
    const hit = map.get(key);
    hit.count += 1;
    hit.seconds += Number(r.seconds) || 0;
    addToRounds(hit.rounds, r.round, Number(r.seconds) || 0);
  });

  const list = [...map.values()];
  list.forEach((x) => {
    // 原因不明に種別は付けない (何か付けたら、それは作り話になる)
    if (x.unknown) { x.kind = UNKNOWN_KIND; return; }
    const k = typeof kindOf === 'function' ? text(kindOf(x.cause)) : '';
    x.kind = k || UNKNOWN_KIND;
  });

  // 原因不明は最後。それ以外は時間の大きい順 (同じなら件数、さらに同じなら名前順で毎回同じ並びに)
  return list.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    if (b.seconds !== a.seconds) return b.seconds - a.seconds;
    if (b.count !== a.count) return b.count - a.count;
    return a.cause.localeCompare(b.cause);
  });
};

/**
 * 原因 × 型式 × テンプレ の内訳。時間の大きい順 (原因不明は最後の別枠)。
 * ⚠工程名では束ねない。同じ工程名でも型式/テンプレが違えば中身は別物になる。
 * ⚠ここも byCause と同じで「原因が引けたか(unknown)」をキーに混ぜる。
 *   自由入力の「原因不明」と本物の原因不明が1つに潰れないようにするため。
 *   causeKey は byCause の key と同じ文字列。画面で原因の行を開いた時は
 *   cause の文字ではなく causeKey === key で突き合わせること。
 * ⚠この関数の合計は byCause の合計と1件・1秒までピタリ一致する (テストで固定)。
 */
export const byCauseModelTemplate = (rows, { traineeMode = 'exclude' } = {}) => {
  const map = new Map();
  pickRows(rows, traineeMode).forEach((r) => {
    const unknown = r.causeFrom === '原因不明' || !text(r.cause);
    const cause = unknown ? UNKNOWN_CAUSE : r.cause;
    const model = String(r.model || '');
    const templateName = String(r.templateName || '');
    // ⚠束ねるキーは4つ(引けたか・原因・型式・テンプレ)を JSON にして作る。
    //   区切り文字を自分で決めると、型式名やテンプレ名にその文字が入っていた時に
    //   別の束が1つに潰れる。
    const causeKey = causeKeyOf(unknown, cause);
    const key = JSON.stringify([causeKey, model, templateName]);
    if (!map.has(key)) map.set(key, { causeKey, cause, model, templateName, count: 0, seconds: 0, unknown });
    const hit = map.get(key);
    hit.count += 1;
    hit.seconds += Number(r.seconds) || 0;
  });

  return [...map.values()].sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    if (b.seconds !== a.seconds) return b.seconds - a.seconds;
    if (b.count !== a.count) return b.count - a.count;
    return (a.cause + a.model + a.templateName).localeCompare(b.cause + b.model + b.templateName);
  });
};

/** 1回目 / 2回目 / 3回目 / 4回目以降 の 件数・合計秒。0件でも4本そろえて返す */
export const byRound = (rows, { traineeMode = 'exclude' } = {}) => {
  const out = emptyRounds();
  pickRows(rows, traineeMode).forEach((r) => {
    addToRounds(out, r.round, Number(r.seconds) || 0);
  });
  return out;
};

/**
 * まとめた合計と、原因不明の件数・秒。
 * 「合計 = 回別の合計 = 原因別の合計 = 原因×型式×テンプレの合計」が必ず一致する
 * (テストで固定してある)。
 * hours は秒から割るだけ。丸めた値を足し算に使わない。
 * zeroSecondsCount = 時間が0秒だった記録の件数。件数には入っているが時間には効いていない。
 *   ⚠画面には「◯件 (うち0秒◯件)」と添えて出すこと。黙って落とすのも黙って混ぜるのも駄目。
 *
 * 🎓traineeCount / traineeSeconds / traineeHours = 教育中(新人)で外した分。
 *   合計(count/seconds)には入っていない。⚠画面には必ず
 *   「教育中の再作業 N件 / X時間 (別掲)」を1行出すこと。件数と原因を黙って捨てない。
 */
export const reworkSummary = (rows, { traineeMode = 'exclude' } = {}) => {
  const list = pickRows(rows, traineeMode);
  const traineeList = traineeMode === 'exclude' ? pickRows(rows, 'only') : [];
  let seconds = 0;
  let unknownCount = 0;
  let unknownSeconds = 0;
  let zeroSecondsCount = 0;
  const byCauseFrom = {
    '回ごと': { count: 0, seconds: 0 },
    'NG理由の代用': { count: 0, seconds: 0 },
    '原因不明': { count: 0, seconds: 0 },
  };

  list.forEach((r) => {
    const sec = Number(r.seconds) || 0;
    seconds += sec;
    if (!(sec > 0)) zeroSecondsCount += 1;
    const from = byCauseFrom[r.causeFrom] ? r.causeFrom : '原因不明';
    byCauseFrom[from].count += 1;
    byCauseFrom[from].seconds += sec;
    if (from === '原因不明') { unknownCount += 1; unknownSeconds += sec; }
  });

  const count = list.length;
  const traineeSeconds = traineeList.reduce((s, r) => s + (Number(r.seconds) || 0), 0);
  return {
    count,
    seconds,
    hours: seconds / 3600,
    unknownCount,
    unknownSeconds,
    zeroSecondsCount,
    // 🎓別掲 (合計には入っていない)。画面に1行必ず出すこと。
    traineeCount: traineeList.length,
    traineeSeconds,
    traineeHours: traineeSeconds / 3600,
    // 原因が引けた分 (画面で「原因別」の表に出せるのはここまで、という線引き)
    knownCount: count - unknownCount,
    knownSeconds: seconds - unknownSeconds,
    byCauseFrom,
  };
};
