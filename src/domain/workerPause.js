// ============================================================================
// 🛌 作業者の「休止 / 復帰」— 消すのではなく、一旦しまう。戻せる。
// ----------------------------------------------------------------------------
// 清水さんの言葉(2026-08-31):
//   「作業者マスタに登録してある人材で休止中の人が出た場合に一旦画面から消す
//     っていうボタンも欲しいかな、復帰したら使えるからね」
//
// 🚨 ここが一番大事な線引き:
//   「画面から消す」のは **これから割り当てる先** の話。
//   **やった事の記録**(達成率・分析・日次実績・成績表・星取表・工程の中央値)は
//   1つも変わってはいけない。
//   → だから この道具は **「割り当てられる人」を絞る為だけ** に使う。
//     名前の逆引き(過去の記録に出る名前)には **絶対に使わない**。
//     休止した人の名前が「不明」になったら、それは使う場所を間違えている。
//
// 🚨 削除ではない:
//   workers の書類は残したまま **印を1つ足すだけ**。deleteData は呼ばない。
//   だから復帰した瞬間に、教育中の札も PIN も担当していたロットも元どおり使える。
//
// 🚨 印の持ち方(2026-07-17 の教訓):
//   ・端末ローカル(localStorage)に置かない。多端末で使うので共有の所(workers doc)へ置く。
//   ・**配列への追記にしない**。配列は後勝ちで他の端末の追記が消える。
//     → 人ごとの書類の中の **単一フィールド** `paused` で持つ。
//
// 🚨 復帰は「キーを消す」のではなく **false を書く**(2026-07-26 の教訓):
//   保存は merge:true なので「送らなかったキー」は残る。消すやり方だと
//   次の同期で休止に戻る。既存の 🎓trainee の卒業も同じ理由で false を書いている。
// ============================================================================

/** 休止中か。**true が入っている時だけ** 休止(未設定・null・'false' は在籍あつかい)。 */
export const isPaused = (w) => !!w && w.paused === true;

/** 在籍中(＝これから割り当てられる人)か。 */
export const isActiveWorker = (w) => !!w && !isPaused(w);

const asList = (list) => (Array.isArray(list) ? list.filter(Boolean) : []);

/**
 * 🚨 これから割り当てられる人だけ。
 *   画面の「担当を選ぶ」「マップのレーン」「まとめて開始の宛先」
 *   「操業シミュレーションの使える人」は **必ずこれ** を使う。
 */
export const activeWorkersOf = (list) => asList(list).filter(isActiveWorker);

/** 休止中の人だけ。「休止中 ◯人」の一覧に使う(黙って消さない為に必ず見せる)。 */
export const pausedWorkersOf = (list) => asList(list).filter(isPaused);

/** 休止中の人の名前の集合。名前でしか繋がっていない一覧(ロスター等)を絞る為。 */
export const pausedNamesOf = (list) => {
  const out = new Set();
  for (const w of pausedWorkersOf(list)) {
    const n = String(w.name ?? '').trim();
    if (n) out.add(n);
  }
  return out;
};

/**
 * 名前の一覧から休止中の人を外す。
 * ⚠ 最終検査のように「個人エリアの名前 ∪ workers の名前」を束ねてから使う画面がある。
 *   その場合は束ねた **後** にこれを通す。
 */
export const withoutPausedNames = (names, list) => {
  const gone = pausedNamesOf(list);
  return (Array.isArray(names) ? names : []).filter((n) => !gone.has(String(n ?? '').trim()));
};

/**
 * 休止にする時に書く物。**削除しない**。いつから休止かを残す(一覧に出す為)。
 * @param {number} nowMs 今の時刻(ms)
 * @param {string} byName 誰が休止にしたか
 */
export const pausePatch = (nowMs, byName = '') => ({
  paused: true,
  pausedAt: Number(nowMs) || 0,
  pausedBy: String(byName || ''),
});

/**
 * 復帰させる時に書く物。
 * 🚨 paused キーを **消さずに false を書く**(merge:true では消えない為)。
 *   pausedAt / pausedBy は残す。いつ休んで いつ戻ったかは記録として意味がある。
 */
export const resumePatch = (nowMs) => ({
  paused: false,
  resumedAt: Number(nowMs) || 0,
});

/** 既定の「まだ終わっていないロット」の見分け方。 */
const NOT_DONE = (l) => !!l && l.status !== 'completed' && l.location !== 'completed';

/**
 * 🚨 現場マップのレーンに出す人。
 *   ・在籍中の人 … 常に出す(これから割り当てる先だから)
 *   ・休止中の人 … **まだ盤にロットが残っている時だけ** 出す
 *
 * なぜ「ただ外す」ではいけないか(実測して分かった事):
 *   レーンの組み立てには「知らない担当IDのロットを拾う救済レーン」が付いている
 *   (MapViewLanes.jsx / MapViewTimeline.jsx)。休止した人を一覧から外すだけだと、
 *   その人のロットが **「不明(a1b2c3)」** という札のレーンへ落ちる。
 *   名前が消える＝行方不明。休止は「しまう」であって「無かった事にする」ではない。
 *   → 残っている間はレーンごと残し、🛌 を付けて「この人は休止中」と分かる形にする。
 *     付け替えが終われば、次の描き直しで自然に消える。
 */
export const laneWorkersOf = (list, lots, { workerIdOf = (l) => l && l.workerId, isOpen = NOT_DONE, keepIds = [] } = {}) => {
  const busy = new Set(
    (Array.isArray(lots) ? lots : []).filter(isOpen).map(workerIdOf).filter(Boolean).map(String),
  );
  // ⚠ いま開いている画面が名指ししている人(担当の切替えセレクトなど)も必ず残す。
  //   外すと欄が空になり「担当が消えた」ように見える。
  for (const k of (Array.isArray(keepIds) ? keepIds : [keepIds])) if (k) busy.add(String(k));
  return asList(list).filter((w) => isActiveWorker(w) || busy.has(String(w.id ?? '')));
};

/**
 * 名前でしか繋がっていない一覧(最終検査の「個人エリア ∪ workers」)向けのレーン絞り込み。
 *   ・休止中の名前は外す
 *   ・ただし busyNames(まだ盤に居る名前)に入っている人は残す = 行方不明にしない
 * @param {Array} rows {name} を持つ行
 * @param {Array} workersList 休止の印を持っている workers コレクション
 * @param {Array<string>} busyNames まだ作業が残っている人の名前
 */
export const laneNameRowsOf = (rows, workersList, busyNames = [], { nameOf = (r) => r && r.name } = {}) => {
  const gone = pausedNamesOf(workersList);
  if (gone.size === 0) return Array.isArray(rows) ? rows : [];
  const keep = new Set((Array.isArray(busyNames) ? busyNames : []).map((n) => String(n ?? '').trim()).filter(Boolean));
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    const n = String(nameOf(r) ?? '').trim();
    return !gone.has(n) || keep.has(n);
  });
};

/**
 * 名前を書類の id にする時の形。最終検査の worker_settings と同じ作り方に揃える
 * (Firestore の id に使えない文字を _ にして 200文字で切る)。
 * 🚨 同じ名前なら必ず同じ id になる = 二度押しても書類が2つに増えない。
 */
export const workerDocIdOfName = (name) => String(name ?? '').replace(/[/.#$[\]]/g, '_').slice(0, 200) || '_';

/** レーン・札に出す名前。休止中の人には 🛌 を付ける(なぜ普段と違うのかが分かる形)。 */
export const laneNameOf = (w, base = '') => {
  const name = String(base || w?.name || '');
  return isPaused(w) ? `🛌${name}` : name;
};

/**
 * 🚨 その人にまだ残っている作業。黙って消して行方不明にしない為に、休止の前に必ず数える。
 * @param {Array} lots ロット一覧
 * @param {string} workerId 作業者の id
 * @param {object} opts.isOpen 「まだ終わっていない」の判定(アプリごとに違う時だけ渡す)
 * @returns {{count:number, lots:Array}}
 */
export const remainingWorkOf = (lots, workerId, { isOpen = NOT_DONE } = {}) => {
  const id = String(workerId ?? '');
  if (!id) return { count: 0, lots: [] };
  const hit = (Array.isArray(lots) ? lots : []).filter((l) => l && String(l.workerId ?? '') === id && isOpen(l));
  return { count: hit.length, lots: hit };
};

/**
 * 休止の確認文。残っている作業が有る時は **先に件数を言う**。
 * ⚠ 背景タップで消える窓では出さない事(2026-08-21 の教訓)。window.confirm を使う。
 */
export const pauseConfirmText = (name, remainingCount = 0) => {
  const head = `「${name}」さんを🛌休止にします。\n\n`
    + '・担当を選ぶ所・現場マップのレーン・操業シミュレーションの「使える人」から外れます。\n'
    + '・過去の記録と数字は1つも変わりません(達成率・分析・成績表・星取表はそのまま)。\n'
    + '・消えません。「休止中」の一覧からいつでも復帰できます。\n';
  if (remainingCount > 0) {
    return `⚠この人に、まだ終わっていない作業が ${remainingCount}件 残っています。\n`
      + '休止にしても作業は消えませんが、担当を選ぶ所からこの人が出なくなるので\n'
      + '**別の人に付け替えるのは、休止の前にやる方が楽です**。\n\n'
      + head + '\nこのまま休止にしますか？';
  }
  return `${head}\nよろしいですか？`;
};

/** 復帰の確認文。 */
export const resumeConfirmText = (name) => `「${name}」さんを復帰させます。\n\n`
  + '担当を選ぶ所・現場マップのレーン・操業シミュレーションの「使える人」に、元どおり出るようになります。\n\n'
  + 'よろしいですか？';

/** 「休止中 ◯人」の見出し。0人の時も存在が分かる形で出す。 */
export const pausedSummaryLabel = (list) => `🛌 休止中 ${pausedWorkersOf(list).length}人`;

/** 休止の開始日の表示(一覧で「いつから休止か」を出す為)。 */
export const pausedSinceLabel = (w) => {
  const ms = Number(w?.pausedAt) || 0;
  if (!ms) return '休止した日は記録がありません';
  return `${new Date(ms).toLocaleDateString('ja-JP')} から休止`;
};

// ============================================================================
// 名前で人を持つアプリ(最終検査)向け。
// ⚠ ここに置いてある理由:
//   画面の部品(WorkerPausePanelFI.jsx)と同じファイルに置くと
//   「部品と一緒に別の物を輸出している」で eslint(react-refresh/only-export-components)が赤になる。
//   純関数はこちらへ寄せる = 画面を読み込まなくても試験できる。
// ============================================================================

/**
 * 名簿を組み立てる。最終検査には「作業者マスタ」という画面が無く、
 * 実体は `settings.mapZones` の **個人エリア(isPersonal)** と workers コレクションの2つに分かれている
 * (本番の写しで実測: 個人エリアが人・workers は 0件)。その2つを1つの名簿に束ねる。
 * 🚨 束ねる鍵は **名前**。同じ名前は1行にまとめる(個人エリア側を先に採り、workers の書類を後から結ぶ)。
 * @param {Array} zones settings.mapZones
 * @param {Array} workers workers コレクション
 * @returns {Array<{name:string, zoneId:string|null, workerId:string|null, doc:object|null, source:'zone'|'worker'}>}
 */
export const buildNameRoster = (zones, workers) => {
  const rows = new Map(); // name -> row
  for (const z of (Array.isArray(zones) ? zones : [])) {
    if (!z || !z.isPersonal) continue;
    const n = String(z.name ?? '').trim();
    if (!n || rows.has(n)) continue;
    rows.set(n, { name: n, zoneId: z.id, workerId: null, doc: null, source: 'zone' });
  }
  for (const w of (Array.isArray(workers) ? workers : [])) {
    const n = String(w?.name ?? '').trim();
    if (!n) continue;
    const cur = rows.get(n);
    if (cur) { cur.workerId = w.id; cur.doc = w; }
    else rows.set(n, { name: n, zoneId: null, workerId: w.id, doc: w, source: 'worker' });
  }
  return [...rows.values()];
};

/**
 * その名簿の行の人に、まだ終わっていない作業が何件残っているか。
 * 🚨 人の持ち方が2通り(個人エリア / workers の書類)なので **両方で数える**。
 *   片方だけで数えると「残り0件」と嘘を言って、黙って休止させてしまう。
 */
export const remainingOfRosterRow = (lots, row) => {
  if (!row) return 0;
  return (Array.isArray(lots) ? lots : []).filter((l) => {
    if (!l) return false;
    if (!NOT_DONE(l)) return false;
    if (row.zoneId && l.mapZoneId === row.zoneId) return true;
    if (row.workerId && l.workerId === row.workerId) return true;
    return false;
  }).length;
};

/** 名簿のうち、これから割り当てられる人(休止していない人)。 */
export const activeRosterOf = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && !isPaused(r.doc));

/** 名簿のうち、休止中の人。「休止中 ◯人」の一覧に使う。 */
export const pausedRosterOf = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && isPaused(r.doc));
