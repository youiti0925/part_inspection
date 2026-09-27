// ============================================================================
// 🏁 「このロットは いつ終わるか」の見込み
// ----------------------------------------------------------------------------
// ⚠⚠ この関数が守る一番大事な決まり（2026-07-10 の激怒より）:
//     **元データに無い物を推測で埋めない。**
//   ・材料が足りない時は { ok:false, reason:'…' } を返す。**それらしい数字を作らない。**
//   ・出せた時は必ず basis（何をもとに出したか）を一緒に返す。画面はこれをそのまま出す。
//   ・1点で言い切らず range（最短〜最長）も返す。ただし **幅も実データから出す**
//     （ばらつきの実測が無ければ幅は作らない＝earliest===latest と正直に言う）。
//
// ⚠⚠ 今まで何が嘘だったか（この関数を作った理由）:
//   連絡ポータルの「検査の今」に出ている 🏁 は
//     estEndTs = addWorkSeconds(now, 見積 − 経過)
//   で出していた。ここには3つの嘘がある。
//     ① 見積(目標時間)が 0 のロットだと 残り0秒 → addWorkSeconds は開始時刻をそのまま返すので
//        **🏁 が「いま」** と出る。＝「今すぐ終わります」という作り話。
//     ② **止まっているロットでも** 今から働き続ける前提で時刻を出していた。
//     ③ 画面に「何分残っているか」も「何をもとにしたか」も出ていなかった。
//   ここでは ①→ok:false、②→ok:false＋止まっている理由、③→basis と 式 で返す。
//
// ⚠⚠ **このファイルは 最終検査 と 製品検査 で同一（md5 一致）にする。**
//   片方だけ直すと必ずズレる（MISTAKES A8）。そのために:
//     ・import してよいのは workClock.js だけ（2アプリで md5 一致・両方に存在する）。
//     ・countStepTime.js / taskClock.js / tailParts.js は **最終検査にしか無い** ので import しない。
//     ・「ロットに1回だけの工程」の印が2アプリで違う
//         最終検査 = step.checkType === 'count'（員数/一括）
//         製品検査 = step.lotOnce === true    （段取り・片付け等）
//       → 下の isOncePerLotStep() で **両方** を見る。
//     ・工程の出し分け（本体/テール）は最終検査にしかないので、判定は stepApplies で注入する。
//
// ⚠ここには React も Firebase も import しない（node --test で回すため）。
// ============================================================================

import { addWorkSeconds } from './workClock.js';

/** 「これまでの実測」を目安として採用するのに要る最低本数。これ未満なら目標時間を使う。 */
export const MIN_REAL_SAMPLES = 3;

/**
 * ロットに1回だけの工程か。⚠**台数を掛けない**。
 * ⚠⚠ 印が2アプリで違うので両方見る（最終検査 checkType:'count' / 製品検査 lotOnce:true）。
 *   片方しか見ないと、員数/一括の工程を台数倍して「実際より遅い終了予定」を相手工程へ送る
 *   （2026-08-14 に実際に起きていた向きの誤り）。
 */
export const isOncePerLotStep = (step) =>
  String(step?.checkType || '') === 'count' || step?.lotOnce === true;

/**
 * 「人が実際に測った時間ではありません」の印。
 * ⚠⚠ この一覧は countStepTime.js の NOT_REAL_FLAGS と **同じ物**。
 *   最終検査には countStepTime.js が有るが製品検査には無く、このファイルを2アプリで
 *   md5 一致にする為にここへ写した。**印を足す時は必ず両方に足す。**
 */
export const NOT_REAL_FLAGS_ETA = Object.freeze([
  'targetFilled',    // まとめて完了などで目標秒をそのまま入れた
  'manualTime',      // 人が後から手で入れた
  'avgSplit',        // まとめ計測の按分値
  'groupMeasured',   // 同上
  'flowAuto',        // サイン/フローの自動完了
  'aiAutoCompleted', // AIの自動完了
  'plateEditNoTime', // 機番を人が打ち直して閉じた(時間を測っていない)
  'samplingSkipped', // 抜取で省略
  'autoNa',          // 外観図の該当なしで自動スキップ
]);

const numOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const intOf = (v, min = 0) => Math.max(min, Math.trunc(numOf(v)));

/**
 * 🚨 AIの自動完了が「目標時間をそのまま実績に書いた」記録か。**印ではなく記録の形**で見る。
 *
 * ⚠なぜ印(NOT_REAL_FLAGS_ETA)だけでは足りないか(2026-08-30 実測):
 *   最終検査の 2026-05-13(041a39c)〜2026-08-04(094f980) のAI自動完了は、目標秒を duration へ写し
 *   startTime を「終了 − 目標秒」の引き算で作っていた。**印は1つも付いていない**ので、
 *   印だけを見ていたここは その121件を「実測」として食っていた。
 *   食うと 見込みの時間と工程の中央値が、測ってもいない目標秒のぶんだけふくらむ。
 *   印は端末や経路で付き漏れるが、形は記録そのものから決まるので漏れない。
 *
 * 🚨拾う根拠は「完了しているのに startTime が残っている」こと。
 *   通常の完了・手入力・まとめて完了・按分は、すべて完了時に startTime を null にする。
 *   残っているのは「通常の完了経路を通っていない」証拠。
 * ⚠「作り物だと言い切れる形」だけを拾う。休止で実績秒が積み上がりえた形は
 *   **実測かもしれない**ので実測のまま残す。判別できない物を作り物に倒さない。
 *
 * ⚠⚠ この判定は 最終検査の timeRecordQuality.js(QUALITY.AI_TARGET_COPY)と**同じ物**。
 *   このファイルは2アプリで md5 一致にする為 timeRecordQuality.js を import できないので写した。
 *   **片方を直したら必ずもう片方も直す**(最終検査に、両者の答えが1件も食い違わない事を見る試験がある)。
 *
 * @param t          タスク1件
 * @param targetSec  その工程の目標秒。0 なら「目標秒の写し」とは言えないので必ず false
 */
export const isAiTargetCopyShape = (t, targetSec = 0) => {
  if (!t || typeof t !== 'object') return false;
  if (t.status !== 'completed' && t.status !== 'ng') return false;
  // 出どころの印が有る物は、その印のほうが確か。形で上書きしない。
  if (['targetFilled', 'manualTime', 'avgSplit', 'groupMeasured', 'flowAuto',
    'batchDivisionCorrected', 'aiAutoCompleted', 'plateEditNoTime'].some((k) => t[k])) return false;
  if (!(t.aiAnalysis || (Array.isArray(t.aiAnalyses) && t.aiAnalyses.length > 0))) return false;
  const tgt = numOf(targetSec), d = numOf(t.duration);
  if (!(tgt > 0) || d !== tgt) return false;
  const s = numOf(t.startTime), f = numOf(t.firstStartTime), e = numOf(t.endTime);
  if (!(s > 0)) return false;
  // ③終了時刻を書く前の版(2026-05-13〜2026-06-02 6b59d36)。完了しているのに終了時刻が無い。
  if (!e && !f) return true;
  if (!(e > 0)) return false;
  // ①未着手の台: 開始が「終了 − 目標秒」で作られ(誤差ちょうど0)、最初の着手より前にある(起こりえない形)
  if (e - s === d * 1000 && f > 0 && f === e && s < f) return true;
  // ②走っている台: 休止の跡が無い / 実績秒が「最初の着手〜最後の再開」より長く積み上がる余地が無い
  if (e - s !== d * 1000 && f > 0 && (s === f || d * 1000 > s - f)) return true;
  return false;
};

/** その台/その回は「もう時間がかからない」か。⚠該当なし・抜取も“終わり側”。 */
const isDoneTask = (t) => {
  if (!t) return false;
  if (t.status === 'skipped' || t.samplingSkipped || t.autoNa || t.profileSkipped) return true;
  return t.status === 'completed' || t.status === 'ng';
};

/** いま時計が動いている台か。 */
const isRunningTask = (t) =>
  !!t && t.status === 'processing' && Number.isFinite(Number(t.startTime)) && Number(t.startTime) > 0;

/**
 * 目安に使ってよい「実測」か。⚠印が1つでも付いていたら使わない（目標値のコピーが実測に混ざる）。
 * 🚨印だけでは足りない。印の無い作り物は **形** で外す（isAiTargetCopyShape の註釈を読むこと）。
 *   その為に目標秒を受け取る。目標秒を渡し忘れると、印の無い作り物がまた実測に混ざる。
 */
const isRealMeasureTask = (t, targetSec = 0) => {
  if (!t) return false;
  if (t.status !== 'completed' && t.status !== 'ng') return false;
  if (NOT_REAL_FLAGS_ETA.some((f) => t[f])) return false;
  if (isAiTargetCopyShape(t, targetSec)) return false;   // 🚨印が無い作り物を形で外す
  if (t.countCovered) return false;              // 一括計測に含まれる台（0秒）は実測ではない
  return numOf(t.duration) > 0;
};

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
};

/**
 * 項目マスタを引く索引。
 * ⚠⚠ **工程の鍵が2アプリで違う**（最終検査＝カテゴリ__項目名 / 製品検査＝step.id）。
 *   どちらでも引けるように id・`カテゴリ__項目名`・項目名 の3通りで入れる。
 */
const buildMasterIndex = (masterItems) => {
  const idx = new Map();
  (Array.isArray(masterItems) ? masterItems : []).forEach((m) => {
    if (!m) return;
    const put = (k) => { const s = String(k || '').trim(); if (s && !idx.has(s)) idx.set(s, m); };
    put(m.id);
    if (m.category && m.title) put(`${m.category}__${m.title}`);
    put(m.title);
    put(m.name);
  });
  return idx;
};

/** その工程の「1回あたりの目標秒」。ロット側に無ければ項目マスタを引く。無ければ 0（＝根拠なし）。 */
const targetSecOfStep = (step, masterIdx) => {
  const own = numOf(step?.targetTime);
  if (own > 0) return own;
  const keys = [step?.id, (step?.category && step?.title) ? `${step.category}__${step.title}` : '', step?.title];
  for (const k of keys) {
    const s = String(k || '').trim();
    if (!s) continue;
    const m = masterIdx.get(s);
    const t = numOf(m?.targetTime);
    if (t > 0) return t;
  }
  return 0;
};

/**
 * その工程の台（回）を集める。
 * ⚠鍵の決まりは既存の画面と同じにする（違う鍵で数えると画面の進捗%と食い違う）:
 *     通常     : `${step.id}-${台}`（古いロット用に `${工程の並び順}-${台}` も見る）
 *     ロット1回: `${step.id}-lot-${回}`（製品検査の段取り工程。台数では数えない）
 */
const unitsOfStep = (tasks, step, stepIdx, qty) => {
  const onceKeys = Object.keys(tasks || {})
    .filter((k) => k.startsWith(`${step?.id}-lot-`))
    .sort((a, b) => intOf(a.slice(a.lastIndexOf('-') + 1)) - intOf(b.slice(b.lastIndexOf('-') + 1)));
  if (onceKeys.length) return onceKeys.map((k) => tasks[k]);
  const out = [];
  for (let u = 0; u < qty; u++) out.push(tasks[`${step?.id}-${u}`] || tasks[`${stepIdx}-${u}`]);
  return out;
};

/**
 * その工程で「いま動いている ひとまとまり」の経過秒。
 * ⚠⚠ **まとめて開始の時刻の持ち主は1つだけ**。5台まとめて開始すると全台が同じ startTime を持つ。
 *   台ごとに now−startTime を足すと、1回の作業が5倍に化ける。**一番早い開始から1本だけ**数える。
 */
const runningElapsedSec = (units, now) => {
  let earliest = null;
  (units || []).forEach((t) => {
    if (!isRunningTask(t)) return;
    const st = numOf(t.startTime);
    if (earliest == null || st < earliest) earliest = st;
  });
  if (earliest == null) return 0;
  return Math.max(0, Math.floor((numOf(now) - earliest) / 1000));
};

const emptyBasis = () => ({
  残り台数: 0,
  残り工程: 0,
  残り回数: 0,
  '1台あたりの目安分': 0,
  '1回あたりの目安分': 0,
  '1人あたりの分': 0,
  使った目安: '',
  人数: 0,
  効いている人数: 0,
  止まっている: false,
  止まっている理由: '',
  目安が無い工程: 0,
  いま測っている工程: '',
  経過を差し引いた分: 0,
  今までの進み具合: null,
  ばらつきの根拠: '',
  残業を見込む: false,
  式: '',
  見込みである: true,      // 🚨画面に「見込み」と必ず書かせる為の印
});

const minOf = (sec) => Math.round(numOf(sec) / 60);

/**
 * 🏁 そのロットが いつ終わるかの見込み。
 *
 * @param lot          ロット（steps / tasks / quantity / status / pauseReason）
 * @param masterItems  項目マスタ（ロット側に目標時間が無い時だけ引く）
 * @param now          いま（ミリ秒）
 * @param schedule     勤務時間（workClock.js の形。`includeOvertimeInCapacity:true` の時だけ残業を見込む）
 * @param calendar     📅 工場の暦(祝日・全社休業・休日出勤)。渡すと休みの日を跨がなくなる。
 *                     ⚠ 渡さなければ今までと1ミリも同じ(土日だけ飛ばす)。
 * @param workers      いまこのロットに付ける人（配列 or 人数）。0人なら ok:false
 * @param stepApplies  (step, lot) => その工程はこのロットに出るか。最終検査は stepShowsForLot を渡す
 *
 * @returns {{ok, reason, finishAt, remainMin, basis, confidence, range}}
 *   ⚠ ok:false の時 finishAt は必ず null。**出せない時に時刻を作らない。**
 */
export const finishEta = ({
  lot = null,
  masterItems = [],
  now = Date.now(),
  schedule = null,
  calendar = null,
  workers = null,
  stepApplies = null,
} = {}) => {
  const basis = emptyBasis();
  const nowMs = numOf(now);
  const deny = (reason) => ({
    ok: false, reason: String(reason || ''),
    finishAt: null, remainMin: 0, basis,
    confidence: 'low', range: { earliest: null, latest: null },
  });

  if (!lot || typeof lot !== 'object') return deny('検査の記録がありません。いつ終わるかは出せません');
  if (!Number.isFinite(nowMs) || nowMs <= 0) return deny('いまの時刻が分からないので、いつ終わるかは出せません');
  if (lot.status === 'completed' || lot.location === 'completed') return deny('この検査はもう終わっています');

  const steps = Array.isArray(lot.steps) ? lot.steps : [];
  if (!steps.length) return deny('この製品の検査項目が登録されていません。いつ終わるかは出せません');

  const tasks = lot.tasks || {};
  const qty = Math.max(1, intOf(lot.quantity, 0) || 1);
  const masterIdx = buildMasterIndex(masterItems);
  const applies = typeof stepApplies === 'function' ? stepApplies : () => true;

  // ---- 1) 工程ごとに「あと何回・1回あたり何秒」を出す -------------------------------
  //   ⚠残りは「見積 − 経過」では出さない。止まっていた時間は経過に入らないので、
  //     23/29台まで終わっていても“ほぼ手つかず”に見える（2026-08-11 清水さんの指摘）。
  //     **終わっていない回の目安を足す**。
  let roundsLeft = 0;          // 残りの回数（員数/ロット1回は1回）
  let stepsLeft = 0;           // まだ終わっていない工程の数
  let noBasisSteps = 0;        // 目安（実測も目標時間も）が無い工程
  let typicalSec = 0, fastSec = 0, slowSec = 0;
  let cutSec = 0;              // もう測った分（いま動いているひとまとまりの経過）として引いた秒
  let realSec = 0, targetOnlySec = 0;   // 目安の出どころの内訳（confidence 用）
  let paceRealSec = 0, paceTargetSec = 0;   // 「今までの進み具合」を出す材料（実測 ÷ 同じ回の目標）
  const runningTitles = [];
  const perStep = [];

  steps.forEach((step, sIdx) => {
    if (!step || !applies(step, lot)) return;
    const once = isOncePerLotStep(step);
    const units = unitsOfStep(tasks, step, sIdx, qty);
    const target = targetSecOfStep(step, masterIdx);

    // 実測（この工程で人が実際に測った秒）。⚠目標秒を必ず渡す（印の無い作り物を形で外す為）
    const reals = units.filter((t) => isRealMeasureTask(t, target)).map((t) => numOf(t.duration));
    reals.forEach((s) => { paceRealSec += s; if (target > 0) paceTargetSec += target; });

    // 残りの回数。⚠員数/ロット1回は 何台残っていても『あと1回』。
    const notDone = units.filter((t) => !isDoneTask(t)).length;
    const running = units.filter(isRunningTask).length;
    const left = once ? (notDone > 0 ? 1 : 0) : notDone;
    if (left <= 0) return;

    stepsLeft += 1;
    roundsLeft += left;
    if (running > 0) runningTitles.push(String(step.title || step.name || step.id || ''));

    // 1回あたりの目安。実測が十分あれば実測、無ければ目標時間。**どちらを使ったかを必ず残す。**
    let typ = 0, fast = 0, slow = 0, src = 'none';
    if (reals.length >= MIN_REAL_SAMPLES) {
      typ = median(reals); fast = Math.min(...reals); slow = Math.max(...reals); src = 'real';
    } else if (target > 0) {
      typ = target; fast = target; slow = target; src = 'target';
    }
    if (src === 'none') { noBasisSteps += 1; perStep.push({ step, left, src, typ: 0 }); return; }

    // いま動いているひとまとまりは、その経過ぶんを引く（二重に数えない）。
    const inflight = once ? Math.min(1, running) : Math.min(running, left);
    const waiting = Math.max(0, left - inflight);
    const elapsed = inflight > 0 ? runningElapsedSec(units, nowMs) : 0;
    const cut = Math.min(elapsed, inflight * typ);
    cutSec += cut;

    const addTyp = Math.max(0, inflight * typ - cut) + waiting * typ;
    const addFast = Math.max(0, inflight * fast - cut) + waiting * fast;
    const addSlow = Math.max(0, inflight * slow - cut) + waiting * slow;
    typicalSec += addTyp; fastSec += addFast; slowSec += addSlow;
    if (src === 'real') realSec += addTyp; else targetOnlySec += addTyp;
    perStep.push({ step, left, src, typ });
  });

  // 残り台数（画面に出す用）。⚠ロット1回の工程は台に紐づかないので数えない。
  let unitsLeft = 0;
  for (let u = 0; u < qty; u++) {
    const anyLeft = steps.some((step, sIdx) => {
      if (!step || !applies(step, lot) || isOncePerLotStep(step)) return false;
      const t = tasks[`${step.id}-${u}`] || tasks[`${sIdx}-${u}`];
      return !isDoneTask(t);
    });
    if (anyLeft) unitsLeft += 1;
  }

  basis.残り台数 = unitsLeft;
  basis.残り工程 = stepsLeft;
  basis.残り回数 = roundsLeft;
  basis.目安が無い工程 = noBasisSteps;
  basis.いま測っている工程 = runningTitles.join('・');
  basis.経過を差し引いた分 = minOf(cutSec);

  // ---- 2) いま止まっているか（先に決めて、出せる時も出せない時も basis に必ず入れる）----
  const anyRunning = runningTitles.length > 0;
  const everStarted = Object.values(tasks).some((t) => t && (isDoneTask(t) || isRunningTask(t) || numOf(t.duration) > 0 || numOf(t.firstStartTime) > 0));
  basis.止まっている = !anyRunning;
  if (!anyRunning) {
    basis.止まっている理由 = lot.pauseReason?.label
      ? String(lot.pauseReason.label) + (lot.pauseReason?.note ? `（${lot.pauseReason.note}）` : '')
      : (lot.status === 'paused' ? '検査一旦停止'
        : !everStarted ? 'まだ誰も手を付けていません'
          : 'いま動いている作業がありません');
  }

  // ---- 3) 人数 ----------------------------------------------------------------------
  const people = Array.isArray(workers)
    ? workers.filter((w) => w != null && w !== '' && w !== false).length
    : intOf(workers, 0);
  basis.人数 = people;

  // ---- 4) 出せない場合をここで全部returnする。**時刻を作らない。**--------------------
  if (roundsLeft <= 0) {
    // 検査そのものは終わっている（完了の操作がまだ）。これは見込みでなく事実なので時刻を返す。
    basis.使った目安 = '—';
    basis.式 = '残っている検査はありません（完了の操作待ち）';
    basis.見込みである = false;
    return {
      ok: true, reason: '', finishAt: nowMs, remainMin: 0, basis,
      confidence: 'high', range: { earliest: nowMs, latest: nowMs },
    };
  }
  if (people <= 0) {
    return deny(`この検査に付く人がいません（残り ${roundsLeft}回）。誰が見るか決まるまで、いつ終わるかは出せません`);
  }
  if (noBasisSteps > 0 && typicalSec <= 0) {
    return deny(`目安の時間（目標時間も実測も）が1つも登録されていないので、いつ終わるかは出せません（残り ${stepsLeft}工程）`);
  }
  if (!anyRunning) {
    return deny(`いま止まっています（${basis.止まっている理由}）。残り ${minOf(typicalSec)}分ぶんの仕事がありますが、動き出すまで終わりの時刻は出せません`);
  }
  if (typicalSec <= 0) {
    // 動いてはいるが、目安の時間をもう使い切っている＝あと何分かは分からない。
    // ⚠ここで「いま終わる」と返すのが、今まで 🏁 が“いま”になっていた欠陥そのもの。
    return deny(`目安の時間をもう使い切っています（あと ${roundsLeft}回 残っています）。いつ終わるかは出せません`);
  }

  // ---- 5) 何人で分けるか -------------------------------------------------------------
  // ⚠残り1回の仕事を5人で1/5にはできない。効く人数は残り回数で頭打ちにする。
  const effN = Math.max(1, Math.min(people, roundsLeft));
  basis.効いている人数 = effN;

  // ---- 6) 幅（最短〜最長）。⚠幅も実データから出す。無ければ作らない。-----------------
  // 目標時間しか無い工程は、**このロット自身の進み具合**（実測 ÷ 同じ回の目標）で振る。
  let pace = null;
  if (paceTargetSec > 0 && paceRealSec > 0) pace = paceRealSec / paceTargetSec;
  basis.今までの進み具合 = pace == null ? null : Math.round(pace * 100) / 100;
  if (pace != null && targetOnlySec > 0) {
    const lo = Math.min(1, pace), hi = Math.max(1, pace);
    fastSec = fastSec - targetOnlySec + targetOnlySec * lo;
    slowSec = slowSec - targetOnlySec + targetOnlySec * hi;
    basis.ばらつきの根拠 = `このロットの今までの実測（目標の${basis.今までの進み具合}倍）`;
  } else if (realSec > 0 && slowSec > fastSec) {
    basis.ばらつきの根拠 = 'これまでの実測のばらつき（一番速い回〜一番遅い回）';
  } else if (realSec > 0) {
    basis.ばらつきの根拠 = 'これまでの実測にばらつきがありません（1点だけ）';
  } else {
    basis.ばらつきの根拠 = '実測がないので幅は出せません（1点だけ）';
  }
  if (fastSec > typicalSec) fastSec = typicalSec;
  if (slowSec < typicalSec) slowSec = typicalSec;

  // ---- 7) 目安の出どころ ------------------------------------------------------------
  basis.使った目安 = realSec > 0 && targetOnlySec > 0 ? '実測と目標時間の両方'
    : realSec > 0 ? 'これまでの実測' : '目標時間';

  // ---- 8) 勤務時間（休憩・定時・休みの日）を跨いだ実際の時刻 -------------------------
  // 📅 2026-09-01 工場の暦(祝日表)を繋いだ。祝日を勤務時間として数えなくなる。
  // ⚠⚠ **残業を見込むかは既定 false**。まだ決まっていない残業2時間を勘定に入れて相手工程へ
  //   早い時刻を送るのは、元データに無い物を足すのと同じ。設定で明示された時だけ見込む。
  const withOvertime = schedule?.includeOvertimeInCapacity === true;
  basis.残業を見込む = withOvertime;

  const perPersonSec = typicalSec / effN;
  const finishAt = addWorkSeconds(nowMs, perPersonSec, schedule, withOvertime, calendar);
  if (!Number.isFinite(finishAt)) {
    return deny(`残り ${minOf(typicalSec)}分ぶんありますが、勤務時間で数えると先が長すぎて出せません`);
  }
  const earliest = addWorkSeconds(nowMs, fastSec / effN, schedule, withOvertime, calendar);
  const latest = addWorkSeconds(nowMs, slowSec / effN, schedule, withOvertime, calendar);

  // ---- 9) 確からしさ。⚠低い時は画面で幅を出す --------------------------------------
  const realShare = (realSec + targetOnlySec) > 0 ? realSec / (realSec + targetOnlySec) : 0;
  const confidence = (noBasisSteps === 0 && realShare >= 0.5) ? 'high' : 'low';

  // ---- 10) 画面にそのまま出す「式」。⚠数字には出どころと実数の式を付ける -------------
  // 🚨⚠⚠ **式は必ず計算が合う事**(2026-08-16に合っていなかった)。
  //   前は「1回あたり」を **もう測った分を引いた後**の秒から出していたので、
  //     残り3回 × 1回8.3分 −もう測った5分 ＝ 25分   (3×8.3−5＝19.9。合わない)
  //   と、画面に出る式が算数として成り立っていなかった。相手工程は式で確かめるので、
  //   合わない式は数字ごと信用されない。**引く前の目安**で出して、引き算は式の中で1回だけ行う。
  //     残り3回 × 1回10分 −もう測った5分 ＝ 25分   (3×10−5＝25。合う)
  //   ⚠ typicalSec は「引いた後」、rawSec は「引く前」。cut は必ず inflight×typ 以下なので
  //     rawSec = typicalSec + cutSec が秒の単位でぴたり一致する(丸めだけがズレ得る)。
  const rawSec = typicalSec + cutSec;
  const perRoundMin = Math.round((rawSec / roundsLeft) / 6) / 10;   // 小数1桁
  basis['1回あたりの目安分'] = perRoundMin;
  basis['1台あたりの目安分'] = unitsLeft > 0 ? Math.round((rawSec / unitsLeft) / 6) / 10 : 0;
  basis['1人あたりの分'] = minOf(perPersonSec);
  basis.式 = `残り${roundsLeft}回 × 1回${perRoundMin}分（${basis.使った目安}）`
    + (cutSec > 0 ? ` −もう測った${basis.経過を差し引いた分}分` : '')
    + ` ＝ ${minOf(typicalSec)}分 ÷ ${effN}人 ＝ ${minOf(perPersonSec)}分`
    + `／${withOvertime ? '残業まで' : '定時まで'}の勤務時間で数える`;

  return {
    ok: true,
    reason: '',
    finishAt,
    remainMin: minOf(typicalSec),      // ⚠純粋な作業ぶん（人数で割る前・休憩を含まない）
    basis,
    confidence,
    range: {
      earliest: Number.isFinite(earliest) ? earliest : null,
      latest: Number.isFinite(latest) ? latest : null,
    },
  };
};

// ============================================================================
// 🖥 画面に出す言葉を作る。**ここでは1つも計算しない**（finishEta の答えを人の言葉に直すだけ）。
// ----------------------------------------------------------------------------
// ⚠⚠ なぜ関数にするか: 画面(JSX)は 最終検査 と 製品検査 で別ファイルなので、
//   言い回しを画面側に書くと必ず片方だけ直って**同じロットが2つの言い方をされる**。
//   言葉はこの1か所で作り、画面は受け取った文字を並べるだけにする。
//
// ⚠⚠ 守る決まり（2026-07-10 の激怒「元データに無い値を推測で埋めて事実として出すな」より）:
//   ① 出せた時は必ず「（見込み）」と付ける。断定の言い方をしない。
//   ② 出どころ（basis）を必ず一緒に返す。画面はそれを出す。
//   ③ 幅（最短〜最長）が有れば幅で言う。**無い時に幅を作らない**（1点のまま言う）。
//   ④ 出せない時は headline を「分かりません」にして、whyText に **なぜ** を入れる。
//      🚨ここで代わりの時刻を作らない。
//   ⑤ 止まっている時は pausedText を必ず埋める。画面はこれを **時刻より先に** 出す。
//
// @param eta      finishEta() の戻り
// @param fmtTime  時刻(ms)→文字。画面と同じ書式を注入する（既定は HH:MM）
// @returns {{kind,paused,pausedText,headline,headlineNote,whyText,basisLines,nowText,low}}
//   kind: 'eta'(見込みが出た) / 'done'(残り無し＝事実) / 'unknown'(出せない)
// ============================================================================
const hhmmOf = (ts) => {
  const t = numOf(ts);
  if (!t) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const finishEtaView = (eta = null, { fmtTime = null } = {}) => {
  const f = typeof fmtTime === 'function' ? fmtTime : hhmmOf;
  const v = {
    kind: 'unknown',
    paused: false,
    pausedText: '',
    headline: '分かりません',
    headlineNote: '',
    whyText: '',
    basisLines: [],
    nowText: '',
    low: false,
  };
  if (!eta || typeof eta !== 'object') {
    v.whyText = '見込みを出すもとの記録がありません';
    return v;
  }

  const b = eta.basis || {};
  v.nowText = String(b.いま測っている工程 || '');
  v.paused = b.止まっている === true;
  if (v.paused) v.pausedText = `⏸ いま止まっています（${b.止まっている理由 || '理由は分かりません'}）`;

  // ---- 出せない時。🚨時刻を作らない ------------------------------------------------
  if (eta.ok !== true) {
    v.whyText = String(eta.reason || '') || '材料が足りないので出せません';
    // ⚠二度書きだけを機械的に落とす（**言い換え・要約はしない**）。
    //   止まっている事は pausedText で先に出しているので、理由の文の頭に同じ一文が付いていたら
    //   その一文ぶんだけ取り除く。取り除けない形なら何もしない＝1文字も捨てない。
    const head = `いま止まっています（${b.止まっている理由 || ''}）。`;
    if (v.pausedText && v.whyText.startsWith(head)) v.whyText = v.whyText.slice(head.length);
    return v;
  }

  // ---- 残っている検査が無い（＝見込みではなく事実）----------------------------------
  if (b.見込みである === false) {
    // ⚠「止まっています」とは言わない。**やる事がもう無い**のであって、止まっているのではない。
    v.paused = false;
    v.pausedText = '';
    v.kind = 'done';
    v.headline = '残っている検査はありません';
    v.headlineNote = '（完了の操作待ち）';
    // ⚠basis.式 は headline と同じ言葉なので出さない（同じ文を2回出さない）。
    return v;
  }

  // ---- 見込みが出た ------------------------------------------------------------------
  const e = eta.range?.earliest;
  const l = eta.range?.latest;
  const hasRange = Number.isFinite(e) && Number.isFinite(l) && e !== l;
  v.kind = 'eta';
  v.headline = hasRange ? `${f(e)} 〜 ${f(l)} ごろ` : `${f(eta.finishAt)} ごろ`;
  v.headlineNote = '（見込み）';            // 🚨必ず付ける。断定しない
  v.low = eta.confidence !== 'high';

  const remain = numOf(b.残り台数) > 0
    ? `残り ${b.残り台数}台・${b.残り工程}工程（${b.残り回数}回）`
    : `残り ${b.残り工程}工程（${b.残り回数}回）`;
  v.basisLines.push(remain);
  if (b.式) v.basisLines.push(String(b.式));
  if (b.ばらつきの根拠) v.basisLines.push(`幅の出どころ: ${b.ばらつきの根拠}`);
  if (numOf(b.目安が無い工程) > 0) {
    v.basisLines.push(`⚠ 目安の時間が登録されていない工程が ${b.目安が無い工程}個あります（そのぶんは入っていません）`);
  }
  if (v.low) v.basisLines.push('⚠ 実測が少ないので、この見込みの確からしさは低めです');
  return v;
};
