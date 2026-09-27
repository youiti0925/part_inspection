// =============================================================================
//  knowledgeCourses.js — 📚知識標準(講座) の決めごと。純粋関数だけ(React も Firebase も import しない)
// -----------------------------------------------------------------------------
//  清水さんの依頼:
//    「基本基礎知識の勉強をさせるために、作業標準とは別の知識系の標準をメインでパワポ動画を
//      作成して、作業前に勉強させたりする機能もほしい。確認テストもあってもいい。
//      これだったら通常作業者に啓蒙も含めて使える」
//
//  ⚠⚠ **主役は「そのまま公開」(kind:'asis')**。Driveのファイルを選んで題名を付けるだけで一覧に出る。
//     章立て・確認テストは後から足せる(足しても asis の講座は壊れない = chapters が空でも成立する)。
//
//  ⚠⚠ 受講の記録は **人単位の共有データ**(Firestore の knowledge_records)。
//     端末ローカル(localStorage)には**絶対に置かない**。端末を変えると消える記録は、
//     「あの人はもう受けたのか？」に答えられない。
//     お知らせ(announcements)の confirmedBy(配列の読み→追記→丸ごと書き戻し)も真似しない。
//     2端末が同時に押すと後勝ちで片方の確認が消える(実害あり)。→ **1人1ドキュメント**にする。
//
//  ⚠⚠ 言葉の決めごと(清水さんの約束・画面にもそのまま出す):
//     ・この記録は教育のためだけに使う。人事評価には使わない。
//     ・点数で順位を付けない・一覧にしない。
//     ・**「不合格」という言葉を使わない。「未取得」と書く。**
// =============================================================================

// ---- コレクション名 --------------------------------------------------------
// ⚠ src/data/routes.js の COLLECTION_AREA と COLLECTION_APPS の**両方**に登録すること。
//   片方だけだと npm test(routes.test.mjs の R14/R15)が落ちる。
export const KNOWLEDGE_COURSES_COL = 'knowledge_courses';
export const KNOWLEDGE_RECORDS_COL = 'knowledge_records';

// ---- Drive の置き場所 ------------------------------------------------------
// ⚠アプリは Drive の**フォルダIDを持たない**。資料ルートからの「フォルダ名の道順」だけ。
//   だから新設に必要なのは「Driveでフォルダを作る」ことだけ(コードも Worker の secret も変更不要)。
//   ⚠アップロードすれば Worker が勝手に作るので、実際には何もしなくても始められる。
export const KNOWLEDGE_DRIVE_ROOT = Object.freeze(['製品', '講座']);

// ⚠道順は '/' で区切って Worker に渡す。フォルダ名に '/' が混ざると道順が壊れる。
//   講座名は自由入力なので、**フォルダ名にはそのまま使わない**。ここで削る。
export const safeFolderName = (s) => String(s == null ? '' : s)
  .replace(/[/\\?%*:|"<>#]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 60);

/** 講座のDriveフォルダの道順。sub が空なら共通の「製品/講座」を見る。 */
export const knowledgeFolderPath = (sub) => {
  const s = safeFolderName(sub);
  return s ? [...KNOWLEDGE_DRIVE_ROOT, s] : [...KNOWLEDGE_DRIVE_ROOT];
};

// ---- 画面に常時出す約束の文言(F) ------------------------------------------
// ⚠ここを1か所にしておく。管理画面と受講画面で言い回しが割れると、約束として読まれなくなる。
export const KNOWLEDGE_PRIVACY_TEXT = Object.freeze([
  'この記録は教育のためだけに使います。人事評価には使いません。',
  '点数で順位を付けたり、一覧にしたりしません。',
]);

// 取得/未取得。⚠「不合格」とは書かない。
export const PASS_LABEL = '取得';
export const FAIL_LABEL = '未取得';

/** 確認テストの合格ライン。⚠画面には必ずこの式も併記する(「8割以上」だけでは何問か分からない)。 */
export const QUIZ_PASS_RATIO = 0.8;

// ---- ID -------------------------------------------------------------------
// docId は決め打ちで作る。⚠配列に追記していく形にすると、多端末で後勝ちで消える。
export const newCourseId = (now = Date.now(), rnd = Math.random()) =>
  `kc_${Number(now).toString(36)}_${Math.floor(rnd * 1e6).toString(36)}`;

export const newChapterId = (now = Date.now(), rnd = Math.random()) =>
  `ch_${Number(now).toString(36)}_${Math.floor(rnd * 1e6).toString(36)}`;

export const newQuizId = (now = Date.now(), rnd = Math.random()) =>
  `q_${Number(now).toString(36)}_${Math.floor(rnd * 1e6).toString(36)}`;

/** 受講する人の見分け方。workers に居ない人(名前だけ)でも記録が残るように名前へ倒す。 */
export const workerKeyOf = (worker) => {
  if (!worker) return '';
  if (typeof worker === 'string') return worker;
  return String(worker.id || worker.name || '');
};

/**
 * 受講記録の docId。⚠「1人 × 1講座 = 1ドキュメント」。
 *   こうしておけば、2人が同時に修了しても互いの記録を消し合わない。
 *   ⚠名前は自由入力なので encodeURIComponent する(スラッシュや空白でパスが壊れる)。
 */
export const knowledgeRecordDocId = (courseId, workerKey) =>
  `${encodeURIComponent(String(courseId || ''))}__${encodeURIComponent(String(workerKey || ''))}`;

// ---- 形をそろえる ----------------------------------------------------------

const asArray = (v) => (Array.isArray(v) ? v : []);
const asStr = (v) => String(v == null ? '' : v);
const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** ○×の答えを true/false にそろえる('o'/'×'/'true'/1 などが混ざっても読めるように)。 */
export const normalizeOxAnswer = (v) => {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const s = asStr(v).trim().toLowerCase();
  if (['o', '○', '◯', 'まる', 'true', '1', 'yes'].includes(s)) return true;
  if (['x', '×', '✕', 'ばつ', 'false', '0', 'no'].includes(s)) return false;
  return null; // 決められない = 採点しない(推測で正解を作らない)
};

export const normalizeQuiz = (raw, i = 0) => {
  const type = raw?.type === 'ox' ? 'ox' : 'choice';
  const choices = type === 'choice' ? asArray(raw?.choices).map(asStr) : [];
  return {
    id: asStr(raw?.id) || `q${i}`,
    type,
    q: asStr(raw?.q),
    choices,
    // choice は選択肢の番号(0〜)、ox は true/false。
    answer: type === 'ox' ? normalizeOxAnswer(raw?.answer) : (Number.isInteger(Number(raw?.answer)) ? Number(raw.answer) : null),
    explain: asStr(raw?.explain),
    // 「どこに書いてあるか」。⚠間違えた時にこれが無いと、直しようがない。
    sourceNote: asStr(raw?.sourceNote),
  };
};

export const normalizeChapter = (raw, i = 0) => ({
  id: asStr(raw?.id) || `ch${i}`,
  title: asStr(raw?.title),
  min: asNum(raw?.min),
  body: asStr(raw?.body),
  keyPoints: asArray(raw?.keyPoints).map(asStr).filter(Boolean),
  driveId: asStr(raw?.driveId),
  page: asNum(raw?.page),
  startSec: asNum(raw?.startSec),
  endSec: asNum(raw?.endSec),
  quiz: asArray(raw?.quiz).map(normalizeQuiz),
});

export const normalizeCourseFile = (raw) => ({
  driveId: asStr(raw?.driveId || raw?.id),
  name: asStr(raw?.name),
  mime: asStr(raw?.mime || raw?.mimeType),
});

/**
 * 講座1件の形をそろえる。⚠壊れた値でも**必ず何か返す**(1件の壊れで一覧が真っ白になるのを防ぐ)。
 * ⚠kind の既定は 'asis'(そのまま公開)。主役の方を既定にする。
 */
export const normalizeCourse = (raw) => {
  const chapters = asArray(raw?.chapters).map(normalizeChapter);
  return {
    id: asStr(raw?.id),
    title: asStr(raw?.title),
    kind: raw?.kind === 'built' ? 'built' : 'asis',
    audience: normalizeAudience(raw?.audience),
    estMin: asNum(raw?.estMin),
    order: asNum(raw?.order),
    files: asArray(raw?.files).map(normalizeCourseFile).filter(f => f.driveId),
    chapters,
    monthlyPick: raw?.monthlyPick === true,
    publishedAt: asNum(raw?.publishedAt),
    updatedAt: asNum(raw?.updatedAt),
    note: asStr(raw?.note),
  };
};

/**
 * 章が見せる資料と、その中の場所(ページ/開始秒/終了秒)を **一緒に** 決める。
 * 戻り: { file, dropped, page, startSec, endSec }
 *
 * ⚠⚠ **ひも付けた資料が講座から外されている時に「1本目の資料」へ落とさない。**
 *   落とすと、章1が B.pdf を開いたうえで「12ページ目を見てください」と出す
 *   = **別の資料の別のページを事実として指示する**(確認テストの根拠 sourceNote とも食い違う)。
 *   見つからない時は file:null / dropped:true を返し、呼ぶ側は資料を開かせずに理由を出す。
 * ⚠ ひも付けが空(=この講座の1本目を既定で見せる)時は、page/startSec/endSec は
 *   **その資料に対して付けた数字ではない**ので 0 にする。
 */
export const chapterTarget = (files, chapter) => {
  const list = asArray(files).map(normalizeCourseFile).filter(f => f.driveId);
  const driveId = asStr(chapter?.driveId);
  if (!driveId) return { file: list[0] || null, dropped: false, page: 0, startSec: 0, endSec: 0 };
  const f = list.find(x => x.driveId === driveId) || null;
  if (!f) return { file: null, dropped: true, page: 0, startSec: 0, endSec: 0 };
  return { file: f, dropped: false, page: asNum(chapter?.page), startSec: asNum(chapter?.startSec), endSec: asNum(chapter?.endSec) };
};

// ---- 誰に出すか ------------------------------------------------------------
// 'all'(全員) / 'trainee'(教育中の人だけ = 必修) / 名前の配列(その人たちだけ)

export const normalizeAudience = (a) => {
  if (Array.isArray(a)) {
    const names = a.map(asStr).map(s => s.trim()).filter(Boolean);
    return names.length ? names : 'all';
  }
  return a === 'trainee' ? 'trainee' : 'all';
};

export const audienceLabel = (a) => {
  const v = normalizeAudience(a);
  if (v === 'all') return '全員';
  if (v === 'trainee') return '教育中の人（必修）';
  return `指名 ${v.length}名`;
};

/**
 * この講座がこの人に出るか。
 * ⚠worker は **今の状態**(workers[].trainee)を見る。記録に焼いた印(task.trainee)ではない。
 * ⚠worker が null(まだ使用者を選んでいない)の時は false。推測で「たぶん新人」と決めない。
 */
export const courseAppliesTo = (course, worker) => {
  if (!course) return false;
  const a = normalizeAudience(course.audience);
  if (a === 'all') return true;
  if (!worker) return false;
  if (a === 'trainee') return worker.trainee === true;
  const nm = asStr(worker.name || worker);
  return a.some(x => x === nm);
};

/** 必修 = 教育中の人だけに出す講座。工程開始の案内はこれだけを対象にする。 */
export const isRequiredCourse = (course) => normalizeAudience(course?.audience) === 'trainee';

// ---- 公開・並び ------------------------------------------------------------

/** 公開済み = publishedAt が入っている。0/未設定は下書き(作業者には出さない)。 */
export const isPublished = (course) => asNum(course?.publishedAt) > 0;

/** 「今月の1本」。⚠1つだけ。2つ立っていたら**新しい方**を採る(古い印の消し忘れで2本出さない)。 */
export const monthlyPickOf = (courses) => {
  const picks = asArray(courses).map(normalizeCourse)
    .filter(c => c.monthlyPick && isPublished(c))
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return picks[0] || null;
};

/** 管理画面の並び: order(小さい順) → 新しい順。order は管理者が上下ボタンで振る。 */
export const sortCoursesForAdmin = (courses) => asArray(courses).map(normalizeCourse)
  .sort((a, b) => (a.order - b.order) || ((b.updatedAt || b.publishedAt || 0) - (a.updatedAt || a.publishedAt || 0)) || a.title.localeCompare(b.title));

// ---- 受講の記録 ------------------------------------------------------------

export const normalizeRecord = (raw) => ({
  courseId: asStr(raw?.courseId),
  workerId: asStr(raw?.workerId),
  workerName: asStr(raw?.workerName),
  viewedAt: asNum(raw?.viewedAt),
  quizTries: asNum(raw?.quizTries),
  lastScore: Number.isFinite(Number(raw?.lastScore)) ? Number(raw.lastScore) : null,
  passedAt: asNum(raw?.passedAt),
});

/** その人のその講座の記録を1件引く。 */
export const recordOf = (records, courseId, workerKey) => {
  const cid = asStr(courseId);
  const wk = asStr(workerKey);
  const hit = asArray(records).find(r => asStr(r?.courseId) === cid
    && (asStr(r?.workerId) === wk || asStr(r?.workerName) === wk));
  return hit ? normalizeRecord(hit) : null;
};

/**
 * 修了したか。
 *  ・確認テストがある講座 → passedAt が入っていること(取得)。
 *  ・確認テストが無い講座 → 資料を見た(viewedAt)ら修了。
 * ⚠「たぶん見たはず」で埋めない。記録が無ければ未受講のまま出す。
 */
export const isCourseDone = (course, record) => {
  if (!record) return false;
  if (courseQuestionCount(course) > 0) return asNum(record.passedAt) > 0;
  return asNum(record.viewedAt) > 0;
};

// ---- 確認テスト ------------------------------------------------------------

/** 章にぶら下がった問題を1本の並びにする。qid は章とセットで作る(章をまたいで重複しないように)。 */
export const courseQuestions = (course) => {
  const c = normalizeCourse(course);
  const out = [];
  c.chapters.forEach(ch => {
    ch.quiz.forEach(q => {
      // ⚠答えが決まっていない問題は出さない(採点できない物を出すと、必ず「なぜ間違いなの」になる)。
      if (q.type === 'choice' && !(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length)) return;
      if (q.type === 'ox' && q.answer === null) return;
      if (!q.q) return;
      out.push({ ...q, qid: `${ch.id}::${q.id}`, chapterId: ch.id, chapterTitle: ch.title });
    });
  });
  return out;
};

export const courseQuestionCount = (course) => courseQuestions(course).length;

/** 合格に必要な正答数。⚠画面にはこの数をそのまま出す(「8割」だけだと何問か分からない)。 */
export const passNeeded = (total, ratio = QUIZ_PASS_RATIO) => (total > 0 ? Math.ceil(total * ratio) : 0);

/**
 * 採点。answers は { [qid]: 選んだ値 }。
 * 戻り: { total, correct, needed, ratio, passed, wrong:[{...question, given}] }
 * ⚠問題が0問の講座は「見たら修了」なので passed:true を返す(テストが無いことを失敗にしない)。
 * ⚠間違えた問題には解説と根拠(sourceNote)をそのまま持たせて返す。ここで作文しない。
 */
export const gradeQuiz = (course, answers, ratio = QUIZ_PASS_RATIO) => {
  const qs = courseQuestions(course);
  const total = qs.length;
  if (total === 0) return { total: 0, correct: 0, needed: 0, ratio: 1, passed: true, wrong: [] };
  const a = answers || {};
  const wrong = [];
  let correct = 0;
  qs.forEach(q => {
    const givenRaw = a[q.qid];
    const given = q.type === 'ox' ? normalizeOxAnswer(givenRaw)
      : (Number.isInteger(Number(givenRaw)) ? Number(givenRaw) : null);
    if (given !== null && given === q.answer) correct += 1;
    else wrong.push({ ...q, given });
  });
  const needed = passNeeded(total, ratio);
  return { total, correct, needed, ratio: correct / total, passed: correct >= needed, wrong };
};

/** 正解の文字。○×は「○/×」、選択は選択肢の文言。 */
export const answerText = (q, v) => {
  if (!q) return '';
  if (q.type === 'ox') return v === true ? '○' : v === false ? '×' : '（未回答）';
  if (!Number.isInteger(v) || v < 0 || v >= (q.choices || []).length) return '（未回答）';
  return q.choices[v];
};

/**
 * 保存する受講記録を作る。⚠既存の記録に**足す**(quizTries を数え続ける)。
 * ⚠passedAt は一度入ったら消さない(あとで間違えても「取得を取り消す」ことはしない)。
 */
export const buildRecordSave = ({ course, worker, prev, now = Date.now(), grade = null }) => {
  const p = prev ? normalizeRecord(prev) : null;
  const body = {
    courseId: asStr(course?.id),
    workerId: workerKeyOf(worker),
    workerName: asStr(worker?.name || worker),
    viewedAt: p?.viewedAt || now,
    quizTries: (p?.quizTries || 0) + (grade && grade.total > 0 ? 1 : 0),
    lastScore: grade && grade.total > 0 ? grade.correct : (p ? p.lastScore : null),
    passedAt: p?.passedAt || 0,
  };
  if (grade && grade.passed) body.passedAt = p?.passedAt || now;
  // テストの無い講座は「見た」だけで修了 → passedAt は 0 のまま(isCourseDone が viewedAt を見る)。
  return body;
};

// ---- 一覧の作り方 ----------------------------------------------------------

/**
 * 作業者に見せる並び。⚠未受講が上・「今月の1本」が一番上。
 * 戻り: [{ course, record, done, required, pick }]
 */
export const learnerCourseList = ({ courses, records, worker }) => {
  const list = asArray(courses).map(normalizeCourse)
    .filter(isPublished)
    .filter(c => courseAppliesTo(c, worker));
  const wk = workerKeyOf(worker);
  const rows = list.map(course => {
    const record = wk ? recordOf(records, course.id, wk) : null;
    return {
      course, record,
      done: isCourseDone(course, record),
      required: isRequiredCourse(course),
      pick: course.monthlyPick === true,
    };
  });
  // 今月の1本(未修了) → 必修(未修了) → その他の未修了 → 修了済み。同じ段は order → 新しい順。
  const rank = (r) => (r.done ? 3 : (r.pick ? 0 : (r.required ? 1 : 2)));
  return rows.sort((a, b) => rank(a) - rank(b)
    || (a.course.order - b.course.order)
    || ((b.course.publishedAt || 0) - (a.course.publishedAt || 0)));
};

/** まだ修了していない必修(教育中の人向け)。工程開始の案内はこれが1件以上ある時だけ。 */
export const pendingRequiredCourses = ({ courses, records, worker }) =>
  learnerCourseList({ courses, records, worker })
    .filter(r => r.required && !r.done)
    .map(r => r.course);

/**
 * 「新着」の数。⚠数えるのは **前に開いた時より後に公開されたもの**だけ(未読バッジの規約)。
 *   まだ終わっていない件数は数字バッジにしない(消えない数字は意味が2つになって信用されなくなる)。
 */
export const newCourseCount = ({ courses, worker, seenMs }) => {
  const s = Number.isFinite(seenMs) ? seenMs : 0;
  return asArray(courses).map(normalizeCourse)
    .filter(isPublished)
    .filter(c => courseAppliesTo(c, worker))
    .filter(c => c.publishedAt > s)
    .length;
};

// ---- 管理側の受講状況 ------------------------------------------------------

/**
 * この講座の受講状況。
 * ⚠⚠ **個人の点数は返さない。** 清水さんへの約束(画面にも常時出している):
 *    「点数で順位を付けたり、一覧にしたりしません。」
 *    管理者が知りたいのは「まだ受けていないのは誰か」なので、それだけを返す。
 * 戻り: { targets, doneNames, notDoneNames, doneCount, targetCount, scored, scoreSum, scoreMax }
 *   scored/scoreSum/scoreMax は **講座単位の平均正答率**を出すための材料(教材の直しどころを見るため)。
 *   ⚠平均を出す時は必ず「何人分か」も一緒に画面へ出す(n=1の平均を成績のように見せない)。
 */
export const courseAudienceStatus = ({ course, records, workers }) => {
  const c = normalizeCourse(course);
  const targets = asArray(workers).filter(w => courseAppliesTo(c, w));
  const total = courseQuestionCount(c);
  const doneNames = [];
  const notDoneNames = [];
  let scored = 0; let scoreSum = 0;
  targets.forEach(w => {
    const rec = recordOf(records, c.id, workerKeyOf(w));
    if (isCourseDone(c, rec)) doneNames.push(w.name); else notDoneNames.push(w.name);
    if (rec && Number.isFinite(rec.lastScore) && total > 0) { scored += 1; scoreSum += rec.lastScore; }
  });
  return {
    targets, doneNames, notDoneNames,
    doneCount: doneNames.length, targetCount: targets.length,
    scored, scoreSum, scoreMax: total,
  };
};

// ---- 再作業の原因から講座の下書きを作る ------------------------------------

/**
 * 原因ランキングの1行から講座の下書きを作る。
 * ⚠⚠ 数字は**渡された物をそのまま**書く。ここで割ったり掛けたりして新しい数字を作らない。
 * ⚠ c.unknown(原因が引けなかった分)からは作らせない → 呼ぶ側でボタンを出さないこと。
 *   ここでも null を返して二重に止める。
 */
export const courseDraftFromRework = (row, { now = Date.now(), hours = null } = {}) => {
  if (!row || row.unknown === true) return null;
  const cause = asStr(row.cause).trim();
  if (!cause) return null;
  const h = hours != null ? hours : (asNum(row.seconds) / 3600);
  return {
    id: newCourseId(now),
    title: `${cause} をなくすための基礎`,
    kind: 'asis',
    audience: 'all',
    estMin: 0,
    order: 0,
    files: [],
    chapters: [],
    monthlyPick: false,
    publishedAt: 0, // 下書き。資料を選んでから公開する。
    updatedAt: now,
    // ⚠出どころと式を本文に残す。あとで「この数字どこから？」にならないように。
    note: `再作業の原因ランキングから作りました。\n`
      + `・原因: ${cause}（種別: ${asStr(row.kind) || '—'}）\n`
      + `・件数: ${asNum(row.count)}件 / やり直しの時間: ${h.toFixed(1)}h\n`
      + `・出どころ: 分析 → 再作業 の原因ランキング（式: この原因の再作業時間の合計 ÷ 3600 = ${h.toFixed(1)}h）\n`
      + `※この講座の中身はまだ空です。Driveの資料を選んで公開してください。`,
  };
};
