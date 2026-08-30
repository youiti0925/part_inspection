// ============================================================================
// 💾🚨 保存の「順番」「送れたか」「画面とサーバの合わせ直し」「写真の置き場」
//      ＝ 2026-08-17 の事故(作業時間が5ロット分まるごと消えた)の根っこを1本に集めた道具箱。
// ----------------------------------------------------------------------------
// 事故の形(実測で確定):
//   ロットの保存は、写真/測定図を先に書いて **そのサーバ受領を await してから**
//   ロット本体(tasks=作業時間)を書いていた。
//     ① 写真を書く              → await(サーバの返事を待つ)
//     ② ロット本体(tasks)を書く  ← ①の返事が返ってこないと **ここへ来ない**
//
//   Firestore は setDoc を呼んだ瞬間に端末の待ち行列(IndexedDB)へ入れる。だから
//   **呼ばれた書き込みは電波が無くても後で必ず届く**。逆に言えば
//   **呼ばれなかった書き込みは永久に存在しない**。
//   通信が詰まっている間に画面を閉じると:
//     ・①は待ち行列に残るので、あとで通信が戻れば **届く**。
//     ・②は「await の続き」ごと消える。つまり **待ち行列に一度も入らない**。
//   → 写真だけ残って作業記録が無い。本番の指図1001456630 と完全に同じ形。
//
// ----------------------------------------------------------------------------
// 🚨 だからこの現場の決まりはこうなる。**記録が先・写真(図)が後。**
// ----------------------------------------------------------------------------
//   ⚠⚠ **人が二度と作れない物(検査の記録)を、作り直せる物(写真・図)より先に待ち行列へ入れる。**
//   ⚠⚠ **待ち行列へ入れる間に await を1つも挟まない。**
//
// ⚠「逆にすると記録の中の写真の参照(lotimg:xxx / diagram:xxx)が、写真より先に着く」。
//   これで壊れないかを自分で確かめた(2026-08-17):
//     ・参照の名前は **中身から決まる**(内容ハッシュ)。通信は1バイトも要らない。
//     ・読む側は、参照に対応する実体が **まだ無い時は参照のまま返す**('' に潰さない)。
//       → 他の端末では「写真が数百ミリ秒だけ出ない」だけで、消えない。
//   ⚠逆に、写真が先で記録が後だと **失うのは作業時間**。写真は撮り直せるが、
//     作業時間は撮り直せない(2026-08-17 に「復旧できない」ことを実測で確認済み)。
//   → 落とすなら写真。記録は落とさない。これがこのファイルの決め事。
//
// ⚠⚠ **例外を1つだけ明記しておく: バックアップの復元は逆(実体が先・札が後)。**
//   復元は「JSONファイルという原本が手元に在る」作業なので、途中で止まってもやり直せる。
//   守るべきは「一覧に並ぶのに開けない資料」を本番に残さない事なので、順番は逆が正しい。
//   (domain/backupBundle.js の RESTORE_COLLECTIONS。あちらを**この考えで書き換えない**)
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ⚠⚠ **このファイルは最終検査(golden)と製品検査(product)で同じ物を置く(md5一致)。**
//   片方だけ直すと、片方だけ記録が消える。
//
// ============================================================================
// 🔗 2026-08-17 統合メモ(**必読**)
// ----------------------------------------------------------------------------
// 最終検査と製品検査で **別々に** この道具箱を作ってしまい、`isRecordFirst` と
// `sameTaskValue` が **同じ名前・違う引数** で2つ存在した。
// このファイルは「片方だけ直して片方だけ消える」を防ぐ為の物なので、2つあると目的が裏返る。
// → 1本に統合した。同名の2つの始末は次のとおり(理由も残す)。
//
//  ① isRecordFirst … **1つにまとめた**(名前は分けない)。
//     理由: 聞いている事が全く同じ「記録が別置き(写真/図)より先に待ち行列へ入ったか」で、
//           違うのは **並びの書き表し方だけ** だった。
//             最終検査 … 文字の記録     ['enqueue:record', 'enqueue:image:xxx']
//             製品検査 … 書き込みの並び [{kind:'record'}, {kind:'blob'}]
//           答えが同じ問いに名前を2つ付けると、片方だけ直す事故がまた起きる。
//           → 並びの1要素を「記録 / 別置き / どちらでもない」へ読み替える writeKindOf を
//             1つ用意し、**どちらの書き表し方でも同じ判定**へ入る形にした。
//             writeLabel が作る 'record:xxx' / 'blob:xxx' の文字列もそのまま読める。
//
//  ② sameTaskValue … **1つにまとめた**(名前は分けない)。
//     理由: どちらも「task 1件の中身が同じか(鍵の並び順は見ない)」で、答えが違うのは
//           **undefined の項目の扱い** ただ1点だった。
//             最終検査 … undefined は「無い」と同じ   ← こちらを採用
//             製品検査 … undefined も1つの値として区別する
//           保存の直前に undefined は落とされる(cleanUndefined)ので、手元
//           `{workerName: undefined}` に対しサーバは `{}` を返す。これを「違う」と言うと
//           送り待ちの控えが **永久に外れず**、その鍵だけ新しい値を受け取れなくなる
//           (試験 S15b がこれを固定している)。厳しい側を残すと最終検査が壊れる。
//           ⚠製品検査側の試験(キー順を見ない / undefined 相手は false)は **全部そのまま通る**。
//           ⚠製品検査側の私的な文字列化 stable() は、この判定だけの為の道具なので一緒に外した。
//             (**公開している関数は1つも減らしていない**)
//             stable() が持っていた教訓は残す: 「無い」の印に **生のNULバイトを使わない**
//             (1個混ざるだけで grep/ripgrep が黙って途中でやめる)。統合後は文字列化を
//             しないので、印そのものが要らなくなった。
//
//  ③ 入口が2つある事について(runLotWrite / saveInOrder)。
//     名前はぶつかっていないので **どちらも手を入れずに持ってきた**。
//     どちらも守る決まりは同じ(記録が先・間に await を挟まない)で、違うのは返し方だけ:
//       runLotWrite … 全部入れてから **まとめて待つ**(写真の失敗を例外で知らせる)。最終検査。
//       saveInOrder … 待たずに **手綱(Promise)を返す**(呼ぶ側が好きに待つ)。製品検査。
//     ⚠どちらの入口も、順番の判定は上の isRecordFirst ただ1つを使う。
// ============================================================================

// ---------------------------------------------------------------------------
// 守り1: 保存の順番
// ---------------------------------------------------------------------------

/** 待ち行列へ入れた事の印(試験と、実際の順番の見張りで同じ文字を使う)。 */
export const ENQ_RECORD = 'enqueue:record';
export const ENQ_IMAGE = 'enqueue:image:';
export const OK_RECORD = 'ok:record';
export const FAIL_RECORD = 'fail:record';

/** 書き込みの種類。⚠この2つだけ。増やすなら順番の決まりも一緒に決める事。 */
export const WRITE_RECORD = 'record'; // 人が二度と作れない物(検査の記録・作業時間)
export const WRITE_BLOB = 'blob';     // 作り直せる物(写真・測定図・資料の実体)

/** 書き込み1件の見出し。試験と画面のログで「何を何番目に入れたか」を読めるようにする。 */
export const writeLabel = (w) => `${(w && w.kind) || '?'}:${(w && w.id) || ''}`;

/**
 * 並びの1要素を「記録 / 別置き / どちらでもない」へ読み替える。
 * ⚠統合の芯。**書き表し方が違うだけの同じ物** を、ここ1か所で同じ言葉に直す。
 *   受け取れる形(どれでも同じ答えになる):
 *     ・{ kind:'record'|'blob', … }          … orderWrites / saveInOrder の並び
 *     ・'enqueue:record' / 'enqueue:image:x' … runLotWrite が log に書く印
 *     ・'record:x' / 'blob:x'                … writeLabel(=saveInOrder の enqueued)の文字
 *   ⚠'ok:record' / 'fail:record' は **待ち行列へ入れた印ではない** ので どちらでもない。
 */
const writeKindOf = (w) => {
  if (w && typeof w === 'object') {
    if (w.kind === WRITE_RECORD) return WRITE_RECORD;
    if (w.kind === WRITE_BLOB) return WRITE_BLOB;
    return null;
  }
  if (typeof w !== 'string') return null;
  if (w === ENQ_RECORD) return WRITE_RECORD;
  if (w.startsWith(ENQ_IMAGE)) return WRITE_BLOB;
  if (w.startsWith(WRITE_RECORD + ':')) return WRITE_RECORD;
  if (w.startsWith(WRITE_BLOB + ':')) return WRITE_BLOB;
  return null;
};

/**
 * 記録が別置き(写真/図)より先に待ち行列へ入ったか。⚠ここが false の保存は事故と同じ形。
 * ⚠引数は「並び」。要素の書き表し方は writeKindOf が読めるものならどれでもよい。
 */
export const isRecordFirst = (order) => {
  const kinds = (Array.isArray(order) ? order : []).map(writeKindOf);
  const rec = kinds.indexOf(WRITE_RECORD);
  const blob = kinds.indexOf(WRITE_BLOB);
  if (rec < 0) return false;            // 記録が無い並びは「正しい順番」とは言わない
  if (blob < 0) return true;            // 別置きが無い保存はいつでも正しい
  return rec < blob;
};

/** 順番が違ったら、その場で名指しで落ちる(黙って通さない)。 */
export const assertRecordFirst = (order) => {
  if (isRecordFirst(order)) return true;
  throw new Error(`🚨 保存の順番が違います(写真が記録より先)。この形は作業時間が消えます: ${JSON.stringify(order)}`);
};

/**
 * 待ち行列へ入れる順番を決める。**記録が先・別置き(写真/図)が後。**
 *
 * ⚠ここで並べ替えているのは「入れる順番」だけ。中身は1バイトも変えない。
 * ⚠別置きの並びは渡された順のまま(安定)。勝手に並べ替えると、同じ絵を2度書く判定が狂う。
 */
export const orderWrites = ({ record, blobs = [] } = {}) => {
  const out = [];
  if (record) out.push({ ...record, kind: WRITE_RECORD });
  for (const b of (Array.isArray(blobs) ? blobs : [])) {
    if (b) out.push({ ...b, kind: WRITE_BLOB });
  }
  return out;
};

/** 人が読める順番の説明。画面のログ・検証スクリプトが同じ文字列を見る。 */
export const describeWriteOrder = (order) =>
  (Array.isArray(order) ? order : []).map(writeLabel).join(' → ');

/**
 * 【入口A・最終検査】ロット1件の保存。
 * **記録を先に、写真を後に、間に await を挟まずに** 待ち行列へ入れる。
 *
 * @param writeRecord ()=>Promise  ロット本体(tasks を含む)を書く。必須。
 * @param writeImage  (id, doc, job)=>Promise  写真1枚を書く。images が空なら要らない。
 * @param images      [{ id, doc, ...控え }]  別置きする写真。順番はこの配列のまま。
 * @param log         配列を渡すと、待ち行列へ入れた順番を書き足す(試験・監査用)。
 * @param onImageFail (job, err)=>void  写真が失敗した時に呼ぶ。
 *                    ⚠ここで「もう別置き済み」の控え(逆引き)を外す。外さないと
 *                      次の保存が「既に上げた写真」と勘違いして **二度と送らない**。
 *
 * 返り: { recordSaved:true, images:n }
 * 投げ: ①記録が失敗 → その例外をそのまま投げる(呼び元が「保存できた」と誤認しない)
 *       ②記録は成功・写真だけ失敗 → name='LotPhotoWriteError' で投げる。
 *         ⚠黙って握り潰さない。写真が抜けた事は本人にしか分からないので必ず出す。
 */
export const runLotWrite = async ({ writeRecord, writeImage = null, images = [], log = null, onImageFail = null } = {}) => {
  if (typeof writeRecord !== 'function') throw new Error('runLotWrite: writeRecord(記録の書き込み)がありません');
  const note = (s) => { if (Array.isArray(log)) log.push(s); };
  const jobs = (Array.isArray(images) ? images : []).filter((j) => j && j.id != null);
  if (jobs.length && typeof writeImage !== 'function') throw new Error('runLotWrite: 写真があるのに writeImage がありません');

  // ① 記録。**await しない**。ここを通った時点で端末の待ち行列に入っている。
  note(ENQ_RECORD);
  let recP;
  // ⚠同期で throw する保管庫もありうる。取り落とすと写真だけが飛んでいく。
  try { recP = Promise.resolve(writeRecord()); } catch (e) { recP = Promise.reject(e); }

  // ② 写真。記録の返事を **待たない**(待つと事故と同じ形に戻る)。
  const imgP = [];
  for (const job of jobs) {
    note(ENQ_IMAGE + job.id);
    try { imgP.push(Promise.resolve(writeImage(job.id, job.doc, job))); } catch (e) { imgP.push(Promise.reject(e)); }
  }

  // ③ 全部を待ち行列へ入れてから、はじめて待つ。
  //   ⚠allSettled を使う。記録の失敗で先に投げると、写真の Promise が
  //     「誰も見ていない失敗」になって、原因が console から消える。
  const res = await Promise.allSettled([recP, ...imgP]);
  const failed = [];
  jobs.forEach((job, i) => { const r = res[i + 1]; if (r.status === 'rejected') failed.push({ job, error: r.reason }); });
  // 失敗した写真の控えは、記録の成否にかかわらず必ず外す(次に送り直せるように)。
  if (failed.length && typeof onImageFail === 'function') failed.forEach((f) => { try { onImageFail(f.job, f.error); } catch { /* 控えの掃除で保存を止めない */ } });

  if (res[0].status === 'rejected') { note(FAIL_RECORD); throw res[0].reason; }
  note(OK_RECORD);

  if (failed.length) {
    const e = new Error(
      `検査記録は保存できました。写真 ${failed.length}枚 だけ保存できませんでした。\n`
      + `もう一度 同じ操作をすると、写真だけ送り直します。\n`
      + `（${String((failed[0].error && (failed[0].error.message || failed[0].error.code)) || failed[0].error || '原因不明')}）`);
    e.name = 'LotPhotoWriteError';
    e.recordSaved = true;
    e.failedImages = failed.map((f) => f.job.id);
    throw e;
  }
  return { recordSaved: true, images: jobs.length };
};

/**
 * 【入口B・製品検査】🚨 **同期で** 全部を待ち行列へ入れてから返る。await しない。
 *
 * ⚠⚠ この関数の中に `await` を書いてはいけない。1つでも挟むと、そこで画面が閉じた時に
 *   後ろの書き込みが待ち行列に入らない = 2026-08-12 の事故そのものに戻る。
 *   (だから async 関数にしていない。async にすると誰かが必ず await を足す)
 *
 * @param write (w) => Promise  1件を保管庫へ渡す関数。**呼んだ瞬間に待ち行列へ入る**物を渡すこと。
 * @returns {{ order, enqueued, record: Promise, blobs: Promise }}
 *   record … 記録の書き込み。呼ぶ側は今までどおり await して失敗を画面に出す。
 *   blobs  … 別置きの結果。**必ず resolve する**({ failedIds, errors })。
 *            別置きの失敗で記録の保存を落とさない(現場が止まる方が重い)。
 */
export const saveInOrder = ({ record, blobs = [], write } = {}) => {
  if (!record) throw new Error('saveInOrder: record(記録)が渡されていません');
  if (typeof write !== 'function') throw new Error('saveInOrder: write(書き込む関数)が渡されていません');
  const order = orderWrites({ record, blobs });
  const enqueued = [];
  const jobs = [];
  // ⚠⚠ この for の中に await を足さない。ここが唯一の肝。
  for (const w of order) {
    let p;
    try {
      p = write(w);
    } catch (e) {
      p = Promise.reject(e); // 呼んだ時点で投げた物も「失敗」として同じ道に乗せる
    }
    enqueued.push(writeLabel(w));
    jobs.push({ w, p: Promise.resolve(p) });
  }
  const recordJob = jobs[0]; // orderWrites の約束: 記録は必ず先頭
  const blobJobs = jobs.slice(1);
  // ⚠allSettled にする = 別置きが1件失敗しても他の別置きと記録の扱いを変えない。
  //   ⚠ここで reject させると「誰も待っていない Promise の失敗」になり、
  //     ブラウザのコンソールにだけ出て人には見えない(黙って握り潰すのと同じ)。
  const blobsDone = Promise.allSettled(blobJobs.map((j) => j.p)).then((rs) => {
    const failedIds = [];
    const errors = [];
    rs.forEach((r, i) => {
      if (r.status === 'rejected') {
        failedIds.push(blobJobs[i].w.id);
        errors.push(r.reason);
      }
    });
    return { failedIds, errors };
  });
  return { order, enqueued, record: recordJob.p, blobs: blobsDone };
};

/**
 * 別置きが失敗した分だけ、元の中身(絵そのもの)へ戻した配列を作る。
 *
 * なぜ要るか: 記録を先に書くという事は、記録の中には **まだ書けていない札**
 *   ('diagram:xxx')が入る。ふつうは同じ待ち行列に並んでいるので数ミリ秒で追いつくが、
 *   別置きが **拒否された**(容量・権限)時だけ「札は在るのに絵が無い」が残る。
 *   その工程の図は二度と出ない = 黙って消える証拠になる。だから元の絵に戻して書き直す。
 *
 * ⚠並びが1:1で対応している事が前提(dehydrate は同じ順で写す)。
 *   長さが違う時は **何もしない**(でたらめに戻す方が危ない)。
 * @param refIdOf (item) => その項目が指している別置きID(札でなければ null)
 */
export const restoreFailedRefs = (after, before, failedIds, refIdOf) => {
  const bad = new Set((failedIds || []).filter(Boolean));
  if (!bad.size) return after;
  if (!Array.isArray(after) || !Array.isArray(before)) return after;
  if (after.length !== before.length) return after;
  let changed = false;
  const out = after.map((item, i) => {
    let id = null;
    try { id = refIdOf ? refIdOf(item) : null; } catch { id = null; }
    if (!id || !bad.has(id)) return item;
    if (before[i] === undefined) return item;
    changed = true;
    return before[i];
  });
  return changed ? out : after;
};

// ---------------------------------------------------------------------------
// 守り3: 画面の tasks を サーバと合わせ直す
// ---------------------------------------------------------------------------
// 事故を **見えなくしていた** のがここ。作業画面の tasks は開いた瞬間に lot.tasks から
// 1度だけ作られ、以後サーバと合わせ直さない(interruptions には合わせ直しが在るのに
// tasks には無かった)。だから **送れていなくても画面はずっと「済み」に見える**。
//
// ⚠⚠ ただし、合わせ直しで **人がいま打ち込んだ物を上書きしたら大事故**。
//   区別のしかたは2通り作ってある(どちらも「触っていない物だけサーバを採る」で同じ考え)。
//     ・送り待ち方式(mergeServerTasks / notePendingTasks / dropSettledTasks) … 最終検査
//     ・3方向の突き合わせ方式(reconcileTasks + runningTaskKeys)             … 製品検査
//   ⚠どちらも中身の比べ方は下の sameTaskValue ただ1つを使う(統合の芯)。

/**
 * task 1件が同じ中身か(鍵の並び順は見ない)。
 *
 * ⚠⚠ **undefined の項目は「無い」と同じに扱う。** ここを厳しくすると事故になる:
 *   保存の直前に undefined の項目は落とされる(cleanUndefined)。だから
 *   手元 `{ workerName: undefined }` に対しサーバは `{}` で返ってくる。
 *   これを「違う」と言うと送り待ちの控えが **永久に外れず**、その鍵だけ
 *   サーバの新しい値を受け取れなくなる(画面に古い値が貼り付く)。
 * ⚠null は「無い」ではない(意図して入れた値なので区別する)。
 * ⚠2026-08-17 統合: 製品検査にあった「JSON文字列にして比べる版」はこの1点だけが違った。
 *   厳しい側を残すと最終検査の控えが外れなくなるので、こちらへ寄せた。
 */
export const sameTaskValue = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const real = (o) => Object.keys(o).filter((k) => o[k] !== undefined).sort();
  const ka = real(a), kb = real(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const va = a[ka[i]], vb = b[kb[i]];
    if (va && vb && typeof va === 'object' && typeof vb === 'object') { if (!sameTaskValue(va, vb)) return false; }
    else if (va !== vb) return false;
  }
  return true;
};

/** tasks まるごと同じか。 */
export const sameTasks = (a, b) => {
  const A = a || {}, B = b || {};
  const ka = Object.keys(A), kb = Object.keys(B);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!(k in B) || !sameTaskValue(A[k], B[k])) return false; }
  return true;
};

/**
 * 古い鍵(`工程の並び順-台`)を今の鍵(`工程id-台`)へ写す。
 * ⚠作業画面が開いた時にやっている事と **同じ**。合わせ直しでも同じ写しをしないと、
 *   古いロットを開くたびに記録が消えたり復活したりする。
 * ⚠古い鍵は **消さない**(今までの動きを1バイトも変えない)。
 */
export const migrateTaskKeys = (tasks, steps, quantity) => {
  const out = { ...(tasks || {}) };
  const list = Array.isArray(steps) ? steps : [];
  const qty = Number(quantity) || 0;
  list.forEach((step, idx) => {
    if (!step) return;
    for (let i = 0; i < qty; i++) {
      const oldKey = `${idx}-${i}`;
      const newKey = `${step.id}-${i}`;
      if (out[oldKey] && !out[newKey]) out[newKey] = out[oldKey];
    }
  });
  return out;
};

/** 送り待ちへ控える。⚠戻りは新しい Map(元は壊さない)。at は「いつ頼んだか」。 */
export const notePendingTasks = (pending, tasks, at = Date.now()) => {
  const m = new Map(pending instanceof Map ? pending : Object.entries(pending || {}));
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return m;
  for (const [k, v] of Object.entries(tasks)) m.set(k, { value: v, at });
  return m;
};

/** サーバに届いた(=同じ値になった)控えを外す。⚠失敗した物は外さない(呼び元が消さないため)。 */
export const dropSettledTasks = (pending, serverTasks) => {
  const m = pending instanceof Map ? pending : new Map(Object.entries(pending || {}));
  const srv = serverTasks || {};
  let changed = false;
  const out = new Map();
  for (const [k, v] of m) {
    if (k in srv && sameTaskValue(srv[k], v && v.value)) { changed = true; continue; }
    out.set(k, v);
  }
  return changed ? out : m;
};

/**
 * サーバの tasks を土台に、送り待ちの分だけ手元の値を残した「画面に出す tasks」。
 * ⚠中身が変わらない時は **手元の物をそのまま返す**(React の描き直しを増やさない)。
 * @param opts.steps/opts.quantity 古い鍵の写しに使う(作業画面と同じ)。
 * @param opts.onDropped 落とした鍵を知らせる(記録を持つ物が落ちた時に気づくため)。
 */
export const mergeServerTasks = (local, server, pending, opts = {}) => {
  const base = migrateTaskKeys(server || {}, opts.steps, opts.quantity);
  const out = { ...base };
  const m = pending instanceof Map ? pending : new Map(Object.entries(pending || {}));
  for (const [k, v] of m) { if (v && v.value !== undefined) out[k] = v.value; }
  if (typeof opts.onDropped === 'function') {
    const dropped = Object.keys(local || {}).filter((k) => !(k in out));
    if (dropped.length) opts.onDropped(dropped);
  }
  return sameTasks(local, out) ? (local || {}) : out;
};

/** 記録(時間)を持っている task か。⚠落とす前に「本当に空か」を見るために使う。 */
export const taskHasTime = (t) => !!(t && typeof t === 'object'
  && ((Number(t.duration) || 0) > 0 || t.firstStartTime || t.endTime || t.startTime
    || (Array.isArray(t.reworks) && t.reworks.some((r) => (Number(r && r.duration) || 0) > 0))));

// ----------------------------------------------------------------------------
// 合わせ直し(3方向の突き合わせ版)。⚠上の送り待ち方式と考えは同じ。
//   base   … 前にサーバから受け取った姿(＝この端末が把握している「送れている姿」)
//   local  … いま画面が持っている姿
//   server … 今届いた姿
//   ・local が base と同じ  → この端末は触っていない → **server を採る**(他端末の記録が入る)
//   ・local が base と違う  → この端末が触った(まだ送れていない/関所で止められた) → **local を残す**
//   ・両方が変わった        → ぶつかった → **local を残して conflicts に載せる**(黙って消さない)
//   ・keepKeys(進行中・編集中の台) → 何が来ても **local を残す**(動いている時計を取り上げない)
//
// ⚠Firestore の購読は「サーバの姿 ⊕ この端末の送信待ち」を返す。つまり送信待ちの分は
//   server にも入っている。だから ふつうの保存直後は local===server で何も起きない。
//   local だけが違うのは「まだ待ち行列にも入っていない」時 = 守るべき時だけになる。
// ----------------------------------------------------------------------------

// ⚠⚠ 2026-08-23: 判定の本体は **平らなマップ全部** に効く物 (reconcileValueMap) へ出した。
//   作業画面には tasks 以外にも「開いた瞬間の写しを1回作るだけ」の物が在った:
//     ・measurementResults (測定値・確認チェック)  ・stepTimes (工程ごとの合計)
//   同じ危険(他端末の直しを古い写しで戻す)なのに、判定を写して2本にすると必ずズレる。
//   → reconcileTasks は **名前だけ**(戻りの鍵が tasks)。中身は1本。
export const reconcileValueMap = ({ local = {}, server = {}, base = {}, keepKeys = [] } = {}) => {
  const L = local && typeof local === 'object' ? local : {};
  const S = server && typeof server === 'object' ? server : {};
  const B = base && typeof base === 'object' ? base : {};
  const keep = new Set(Array.isArray(keepKeys) ? keepKeys : []);
  const keys = [...new Set([...Object.keys(L), ...Object.keys(S)])];
  const out = {};
  const adopted = [];   // サーバの姿を採った(他端末の記録が入った)
  const removed = [];   // サーバで消えていたので消した
  const kept = [];      // この端末の姿を残した(まだ送れていない)
  const conflicts = []; // 両方が変わっていた
  for (const k of keys) {
    const hasL = Object.prototype.hasOwnProperty.call(L, k);
    const hasS = Object.prototype.hasOwnProperty.call(S, k);
    const localChanged = !sameTaskValue(hasL ? L[k] : undefined, Object.prototype.hasOwnProperty.call(B, k) ? B[k] : undefined);
    const serverChanged = !sameTaskValue(hasS ? S[k] : undefined, Object.prototype.hasOwnProperty.call(B, k) ? B[k] : undefined);
    if (keep.has(k)) {
      if (hasL) out[k] = L[k];
      if (hasL) kept.push(k);
      if (serverChanged) conflicts.push(k);
      continue;
    }
    if (!localChanged) {
      // この端末は触っていない → サーバが正
      if (hasS) { out[k] = S[k]; if (serverChanged) adopted.push(k); }
      else if (hasL) { removed.push(k); }
      continue;
    }
    // この端末が触った → 消さない
    if (hasL) out[k] = L[k];
    kept.push(k);
    if (serverChanged) conflicts.push(k);
  }
  const changed = !sameTaskValue(out, L);
  return { map: changed ? out : L, changed, adopted, removed, kept, conflicts };
};

/** tasks 用の呼び方(戻りの鍵が `tasks`)。⚠判定は reconcileValueMap ただ1本。 */
export const reconcileTasks = (args) => {
  const r = reconcileValueMap(args);
  return { tasks: r.map, changed: r.changed, adopted: r.adopted, removed: r.removed, kept: r.kept, conflicts: r.conflicts };
};

/** 進行中・修正中の台は「動いている時計」なので合わせ直しの対象から外す。 */
export const runningTaskKeys = (tasks) => {
  const t = tasks && typeof tasks === 'object' ? tasks : {};
  return Object.keys(t).filter((k) => {
    const v = t[k];
    if (!v || typeof v !== 'object') return false;
    return v.status === 'processing' || v.status === 'reworking' || !!v.startTime || !!v.reworkStartTime;
  });
};

// ----------------------------------------------------------------------------
// 「人がいま入力中の鍵」(measurementResults / stepTimes 用の keepKeys)
// ----------------------------------------------------------------------------
// tasks には `status:'processing'` という **動いている時計の印** が中身に在るので、
// runningTaskKeys が見分けられた。測定値には印が無い(ただの数字と ✓)。
// → 「この端末で **さっき** 触った鍵」を控えて、それを keepKeys にする。
//
// ⚠窓(時間)を切るのは わざと。ずっと守ると、他端末が直した値が
//   その鍵だけ **一生入ってこない**(画面に古い値が貼り付く)。
// ⚠3方向の突き合わせは「まだ送れていない分」を既に守っている。この窓が効くのは
//   **送れた後**、つまり「もう保存できたが、まだ同じ欄を触っている」間だけ。
// ----------------------------------------------------------------------------

/** 人がいま入力中とみなす長さ(ミリ秒)。 */
export const EDITING_WINDOW_MS = 120_000;

/**
 * prev → next で中身が変わった鍵に「いつ触ったか」を付けて控える。
 * ⚠元の Map は壊さない(新しい Map を返す)。
 */
export const noteEditedKeys = (touched, prev, next, at = Date.now()) => {
  const m = new Map(touched instanceof Map ? touched : Object.entries(touched || {}));
  const P = prev && typeof prev === 'object' ? prev : {};
  const N = next && typeof next === 'object' ? next : {};
  for (const k of new Set([...Object.keys(P), ...Object.keys(N)])) {
    if (!sameTaskValue(P[k], N[k])) m.set(k, at);
  }
  return m;
};

/** まだ窓の中に居る鍵(=人がいま入力中)。⚠古い物は返さない。 */
export const recentlyEditedKeys = (touched, now = Date.now(), windowMs = EDITING_WINDOW_MS) => {
  const m = touched instanceof Map ? touched : new Map(Object.entries(touched || {}));
  const w = Number(windowMs) || 0;
  const out = [];
  for (const [k, at] of m) { if (now - (Number(at) || 0) < w) out.push(k); }
  return out;
};

/** 控えが際限なく太らないように、窓から出た鍵を落とす。⚠変わらない時は同じ Map を返す。 */
export const pruneEditedKeys = (touched, now = Date.now(), windowMs = EDITING_WINDOW_MS) => {
  const m = touched instanceof Map ? touched : new Map(Object.entries(touched || {}));
  const w = Number(windowMs) || 0;
  const out = new Map();
  for (const [k, at] of m) { if (now - (Number(at) || 0) < w) out.set(k, at); }
  return out.size === m.size ? m : out;
};

// ----------------------------------------------------------------------------
// 「送るのは手元にしか無い鍵だけ」
// ----------------------------------------------------------------------------
// 直す前の自動保存は 60秒ごとに **マップまるごと** を送り返していた。
// setDoc(merge:true) は送らなかった鍵を消さないので「鍵が消える」事故にはならないが、
// **送った鍵は上書きする**。だから古い写しを丸ごと送ると、他端末が直した値が戻る。
// → 送るのは「前に受け取ったサーバの姿と違う鍵」= この端末が変えた分だけにする。
// ⚠1件も無い時は **その項目ごと送らない**(空マップ `{}` を送ると丸ごと消える)。
// ----------------------------------------------------------------------------

/** 手元にしか無い(まだサーバへ届いていない)鍵。 */
export const unsentMapKeys = (local, base) => {
  const L = local && typeof local === 'object' ? local : {};
  const B = base && typeof base === 'object' ? base : {};
  return Object.keys(L).filter((k) =>
    !sameTaskValue(L[k], Object.prototype.hasOwnProperty.call(B, k) ? B[k] : undefined));
};

/** その鍵だけを抜き出した新しいマップ。⚠無い鍵は入れない(undefined を送らない)。 */
export const pickMapKeys = (map, keys) => {
  const M = map && typeof map === 'object' ? map : {};
  const out = {};
  for (const k of (Array.isArray(keys) ? keys : [])) {
    if (Object.prototype.hasOwnProperty.call(M, k)) out[k] = M[k];
  }
  return out;
};

/**
 * 自動保存に載せる差分。1件も無ければ **null**(=その項目を payload に入れない)。
 * @returns {{ patch: object, keys: string[] }|null}
 */
export const unsentPatch = (local, base) => {
  const keys = unsentMapKeys(local, base);
  return keys.length ? { patch: pickMapKeys(local, keys), keys } : null;
};

// ---------------------------------------------------------------------------
// 守り5: 写真の置き場を **1か所で** 数える
// ---------------------------------------------------------------------------
// なぜ要るか(2026-08-17 実測):
//   別置き(lot_images へ逃がす)が面倒を見ていたのは 荷姿写真 と AI認識画像 の2か所だけ。
//   **不具合写真(interruptions[].photos / interruptionsMap[].photos)は対象外**だった。
//   不具合写真は1枚300KBなので **4枚でロット1件の上限(1MB)を超える**。
//   超えると保存が恒久エラーで捨てられ、しかも再読込した後は
//   「Mutations restored from persistence won't have callbacks」で **alert すら出ない**。
//   = 現場は「保存したつもり」で作業時間を失う。事故と同じ出口。
//
// ⚠置き場が複数あるのに数える場所が複数あると必ずズレる(2026-07-28 の
//   「移せると数えたのに移せない」= 90秒ごとに全端末を書き直し続けた事故)。
//   → **場所の一覧はこの関数ただ1つ**。逃がす・戻す・掃除・バックアップの4つが同じ物を見る。

/** 写真の在り処。kind は lot_images の doc に残す種類の印(既存の 'pkg'/'ai' と揃える)。 */
export const PHOTO_KINDS = Object.freeze({ pkg: 'pkg', ai: 'ai', defect: 'defect' });

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * ロット(または保存 payload)の中の写真を、場所つきで全部数える。
 * @param isPhoto (v)=>boolean  拾う条件。'data:image…' でも 'lotimg:…' でも同じ道具で歩ける。
 * 戻り: [{ path, kind, label, value }]
 */
export const collectPhotoSlots = (obj, isPhoto) => {
  const out = [];
  if (!isMap(obj) || typeof isPhoto !== 'function') return out;
  const eat = (v, path, kind, label) => { if (isPhoto(v)) out.push({ path, kind, label, value: v }); };

  // ① 荷姿写真: { トピック: 写真 } か { トピック: [写真…] }
  if (isMap(obj.packagingPhotos)) {
    for (const [topic, ph] of Object.entries(obj.packagingPhotos)) {
      if (Array.isArray(ph)) ph.forEach((p, i) => eat(p, ['packagingPhotos', topic, i], PHOTO_KINDS.pkg, `${topic} (${i + 1})`));
      else eat(ph, ['packagingPhotos', topic], PHOTO_KINDS.pkg, topic);
    }
  }
  // ② 機番AI認識の保存画像
  if (isMap(obj.tasks)) {
    for (const [k, t] of Object.entries(obj.tasks)) {
      if (isMap(t) && isMap(t.aiAnalysis)) eat(t.aiAnalysis.imageUrl, ['tasks', k, 'aiAnalysis', 'imageUrl'], PHOTO_KINDS.ai, k);
    }
  }
  // ③ 不具合写真(古い形=配列)。⚠新しい記録はもう配列へは足さない(interruptionsMap 側)。
  //    だが 8/17 時点の本番にはこの形が残っているので必ず見る。
  if (Array.isArray(obj.interruptions)) {
    obj.interruptions.forEach((e, i) => {
      if (!isMap(e) || !Array.isArray(e.photos)) return;
      e.photos.forEach((p, j) => eat(p, ['interruptions', i, 'photos', j], PHOTO_KINDS.defect, `不具合 ${e.label || e.type || i} (${j + 1})`));
    });
  }
  // ④ 不具合写真(今の形=マップ。多端末で壊れないように1件ずつ書く場所)
  if (isMap(obj.interruptionsMap)) {
    for (const [key, e] of Object.entries(obj.interruptionsMap)) {
      if (!isMap(e) || !Array.isArray(e.photos)) continue;
      e.photos.forEach((p, j) => eat(p, ['interruptionsMap', key, 'photos', j], PHOTO_KINDS.defect, `不具合 ${e.label || e.type || key} (${j + 1})`));
    }
  }
  return out;
};

/** path の先を差し替えた新しい入れ物を返す(元は1バイトも壊さない)。 */
export const setAtPath = (obj, path, value) => {
  if (!Array.isArray(path) || !path.length) return value;
  const [k, ...rest] = path;
  if (Array.isArray(obj)) { const a = [...obj]; a[k] = setAtPath(obj[k], rest, value); return a; }
  return { ...(isMap(obj) ? obj : {}), [k]: setAtPath(isMap(obj) || Array.isArray(obj) ? obj[k] : undefined, rest, value) };
};

/**
 * collectPhotoSlots で見つけた場所を、新しい値へ置き換える。
 * @param changes [{ path, value }]
 * ⚠置き換えが0件なら **同じオブジェクトをそのまま返す**。
 *   全ロットを毎回作り直すと React.memo が全部剥がれて描き直しが増える
 *   (hydrateLotImages が元から守っている作法)。
 */
export const applyPhotoSlots = (obj, changes) => {
  const list = (Array.isArray(changes) ? changes : []).filter((c) => c && Array.isArray(c.path));
  if (!list.length) return obj;
  let out = obj;
  for (const c of list) out = setAtPath(out, c.path, c.value);
  return out;
};

// ----------------------------------------------------------------------------
// 守り4: 「まだ送れていない」を人に見せるための言葉と判定。
//   ⚠分からない状態を作らない = 送れていない時も、全部送れた時も、必ず言う。
// ----------------------------------------------------------------------------

/**
 * 送れていない保存の件数。
 * @param inflight    この画面が投げて、まだ返事が来ていない保存の数(この読み込み中の分)
 * @param pendingDocs Firestore が「この端末に送信待ちがある」と言っている件数
 *                    (hasPendingWrites。**再読み込みしても消えない**ので、前回開いた時の
 *                     送信待ちもこれで見える)
 * ⚠足し算にしない。同じ1件が両方に数えられる(投げた直後は inflight でも pendingDocs でもある)。
 *   多い方を出す = 二重に数えず、どちらかが取りこぼしても0にはならない。
 */
export const pendingWriteCount = ({ inflight = 0, pendingDocs = 0 } = {}) =>
  Math.max(Number(inflight) || 0, Number(pendingDocs) || 0);

export const SAVED_LABEL = '✓ すべて保存済み';
export const pendingLabel = (n) =>
  `⏳ まだ送れていません（${n}件）— 電波が戻ると自動で送られます。送れるまで画面を閉じないでください。`;

// ⚠⚠ 言葉を正確にする。**嘘の警告は次から誰も読まない。**
//   実測で分かっている事:
//     ・待ち行列は端末(IndexedDB)に残るので、タブを閉じても「ふつうは」次に開いた時に送られる。
//     ・ただし **利用者(匿名ログインの身元)が変わる・端末の記憶が消える** と、その待ち行列は
//       二度と送られない(2026-08-17 の調査で「永久に送られなくなる唯一の道」として確定)。
//   だから「閉じたら消えます」と断言しない。「戻せなくなる事がある」と言う。
/** タブ/ブラウザを閉じようとした時。⚠文面はブラウザが出す(近年のブラウザは独自の文にする)。 */
export const UNLOAD_WARNING =
  'まだ送れていない保存があります。閉じると、電波が戻っても送られないことがあります。';
export const shouldBlockUnload = (n) => (Number(n) || 0) > 0;
/** 作業画面を閉じようとした時。⚠タブを閉じるのとは違う(アプリが開いていれば送信は続く)。 */
export const closeWarning = (n) =>
  `⏳ まだ送れていない保存が ${n}件 あります。\n\n`
  + 'この画面を閉じても送信は続きます（アプリは開いたままにしてください）。\n'
  + '⚠アプリのタブを閉じると、ふつうは次に開いた時に送られますが、\n'
  + '　使う人が変わる・端末の記憶が消えると 二度と送られません。\n\n'
  + '閉じますか？';
/** 帯の【なぜ？】を押した時に出す説明。⚠現場の人が読む文。専門用語を出さない。 */
export const pendingHelpText = (n) =>
  `⏳ まだ送れていない保存が ${n}件 あります。\n\n`
  + '【何が起きているか】\n'
  + '押した操作はこの端末に貯めてあります。まだサーバへ届いていません。\n'
  + '電波が戻れば自動で送られます。作業はそのまま続けられます。\n\n'
  + '【してほしい事】\n'
  + '・この帯が消える（「✓ すべて保存済み」になる）まで、アプリのタブを閉じない\n'
  + '・電波の届く所へ移動する\n'
  + '・急ぐ時は、電波の在る所で画面を開いたまま少し待つ\n\n'
  + '【してはいけない事】\n'
  + '・使う人を切り替える / 端末の記憶(ブラウザのデータ)を消す\n'
  + '　→ 貯めてある分が二度と送られなくなります。';
