// ============================================================================
// 🚦📉 読み取り量の見張り（出荷ゲート）
// ----------------------------------------------------------------------------
// 2026-08-17 14:36〜15:59 JST、本番の読み取りが全部 429 で落ちて現場が止まった。
// 原因は 1つではなく「**絞り込みの無い読み**が何十箇所も在る」という土台の形。
//   ・無料枠は **50,000回/日**。製品/最終/部品/司令塔③ の **4アプリで1枠を共有**
//     (projectId=inspection-time-c4fd3 が1個しか無い)。どれか1つが使い切れば4つ止まる。
//   ・`watch('lots', ...)` に where も limit も無い = **開くたびに今までの全ロットを読み直す**。
//     通信が切れて繋ぎ直すたびに、また全部読む。ロットが増えるほど毎日悪くなる。
//
// この見張りがする事:
//   ① 4アプリの実コードから **読みの口を全部** 洗い出す(購読も一括読みも)
//   ② 🚨 **where も limit も無い口を名指し** で出す
//   ③ 「1人が1回開くと何件読むか」を **実測件数** で出す(仮定は画面に全部出す)
//   ④ **4アプリ合計** の1日見積りが 50,000 の何%かを出す
//   ⑤ 🚦 絞り込みの無い口が1つでも残っていれば **❌ で落ちる**
//      例外を認めるなら **理由を書かせる**(各アプリの scripts/read-budget-allow.json)
//
// ⚠この見張り自身も試験する: `node scripts/verify-read-budget.mjs --selftest`
//   わざと外した見本(理由が短い/前提が崩れた例外/絞り込み済みの口)で
//   ちゃんと落ちる・ちゃんと通る事を確かめてから、本番の判定に進む。
//
// 使い方:
//   node scripts/verify-read-budget.mjs            … 判定(❌なら終了コード1)
//   node scripts/verify-read-budget.mjs --selftest … 見張り自身の試験だけ
//   node scripts/verify-read-budget.mjs --list     … 一覧と見積りだけ(常に0で終わる)
//   node scripts/verify-read-budget.mjs --json     … 数字だけを JSON で
//   node scripts/verify-read-budget.mjs --manifest <manifest.json>
//
// ⚠この数字は **見積り**。本物は Firebase コンソールの使用量。食い違ったら実測を信じる事。
// ⚠この見張りは 4アプリ全部を見る。どのアプリから走らせても同じ判定になる。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FREE_READS_PER_DAY = 50_000;

export const APPS = [
  { key: 'final',   label: '最終検査(golden)', ns: 'final-inspection-v1',   dir: 'C:/Users/anrw3/.gemini/antigravity/playground/golden-meteoroid/src' },
  { key: 'product', label: '製品検査',          ns: 'product-inspection-v1', dir: 'C:/Users/anrw3/product-inspection-app/src' },
  { key: 'parts',   label: '部品検査',          ns: 'parts-inspection-v1',   dir: 'C:/Users/anrw3/parts-inspection-app/src' },
  { key: 'overview',label: '司令塔③',           dir: 'C:/Users/anrw3/factory-overview-app/src', ns: 'overview-app-v1' },
];

// ---------------------------------------------------------------------------
// 前提(見積りの入力)。🚨**ここに書いていない数字は使わない。必ず画面に出す。**
// ---------------------------------------------------------------------------
export const ASSUME = {
  openPerDay: {
    // 「1人が1日に何回アプリを開き直すか」(タブを開く・再読込・端末を替える・電波が戻る の合計)
    final: { people: 3, opens: 4, why: '最終検査の作業者 worker_settings 実測3人 × 朝/昼/再読込/予備 で4回' },
    product: { people: 4, opens: 4, why: '製品検査の workers 実測4人 × 4回' },
    parts: { people: 0, opens: 0, why: '部品検査の名前空間は実測0件(まだ本番で使っていない)' },
  },
  overview: {
    tabs: 2, hoursVisible: 9, autoMin: 5,
    // ⚠autoMin は「既定値」を書き写さない。③の実コードから取り出して上書きする(estimateOverview)。
    //   ここに数字を書き写すと、あちらを直した日にこの説明だけが古いまま残る。
    why: '③はモニター常時表示。自動更新の間隔は **③の実コードの既定値をその都度読んで** 使う。'
       + '画面が見えている間だけ走るので、朝7時〜夕方16時=9時間で数える。tabs=2 は事務所+現場の想定',
  },
  // ③の「工場別/モニター」タブは各アプリの実画面を iframe で抱える(?embed=map)。
  // ⚠⚠ 2026-08-30 訂正: ここには「?embed=map は購読を1つも止めない(見た目だけ)」と書いてあったが、
  //   **最終検査は止めている**(実コードで確認)。古い言い伝えのまま数えると ③のiframeぶんを
  //   実物より多く見積もる。止めている物は下の EMBED_STOPS に **実コードの証拠つき** で書き、
  //   checkEmbedFresh() が毎回そのコードが在るかを確かめる(証拠が消えたら赤)。
  overviewIframes: { apps: ['final', 'product', 'parts'], why: 'src/App.jsx の <iframe src={`${a.url}/?embed=map`}>' },
};

// ---------------------------------------------------------------------------
// 🚨 ?embed=map（③のiframe）で **読まなくなる物**。
//   ここに書いた分だけ「iframe 1回ぶんの読み」から引く = **見積りが小さくなる方に効く**。
//   だから書いたら必ず実コードで裏を取る。裏が取れない物を書けば checkEmbedFresh() が赤にする
//   (＝「実測より小さく見積もる」を、確かめずには通せない)。
//   ⚠書いてよいのは「その購読を張らない」事がコードで読める物だけ。見た目だけの分岐は数えない。
// ---------------------------------------------------------------------------
export const EMBED_STOPS = {
  // 写真(lot_images)の遅延購読は EMBED_MAP で張らない。⚠実測2,355件=いちばん大きい読み。
  final: [{ col: 'lot_images', file: 'App.firebase.jsx',
    evidence: /EMBED_MAP[^\n]*lotImagesWanted|lotImagesWanted[^\n]*EMBED_MAP/ }],
  product: [],
  parts: [],
};

/**
 * 🚨 EMBED_STOPS に書いた「読まなくなる物」が、本当に実コードに在るか。
 *   在れば見積りを小さくしてよい。無ければ **小さく見積もった嘘** なので赤にする。
 */
export const checkEmbedFresh = (apps, stops = EMBED_STOPS, srcOf = null) => {
  const bad = [];
  for (const [key, list] of Object.entries(stops)) {
    const app = apps.find((a) => a.key === key);
    if (!app || app.missing) continue;
    for (const st of list) {
      let src = null;
      if (srcOf) src = srcOf(key, st.file);
      else {
        const p = path.join(app.dir, st.file);
        src = fs.existsSync(p) ? stripComments(readSrc(p)) : null;
      }
      if (src == null) { bad.push({ key, col: st.col, why: `${st.file} が見つからない` }); continue; }
      if (!st.evidence.test(src)) {
        bad.push({ key, col: st.col,
          why: `?embed=map で ${st.col} を読まない、という証拠のコードが見つからない`
             + '(実物は読んでいる可能性がある＝iframeぶんを小さく見積もっている)' });
      }
    }
  }
  return bad;
};

// 起動時に必ず張る物。⚠どれが起動時かは実コードを読んで決めた(門を why に書く)。
// ⚠⚠ ここが実コードとずれたら見積りが黙って嘘になるので、下の checkStartupFresh() が突き合わせる。
export const STARTUP = {
  final: {
    always: ['lots', 'contact_requests', 'arrival_times', 'push_tokens', 'workers', 'worker_settings',
             'target_time_history', 'notes', 'announcements', 'indirectWork', 'field_reports', 'video_recipes',
             // ⭐星取表の指名の印+🎓教育の出来事(2026-08-29)。新しい順500件のみ購読(App側にlimit:500)
             'skill_marks', 'education_events'],
    docs: [['final-inspection-v1', 'settings'], ['contact-shared-v1', 'settings']],
    shared: [['contact-shared-v1', 'app_feedback'], ['contact-shared-v1', 'app_notices']],
    // 🚦 2026-08-30: 写真の購読を **開いているロットの分だけ**(where lotId in …)へ移した。
    //   ⚠ここに出る件数は棚ぜんぶ(実測2,355件)＝**上振れの見積り**。
    //     「開いた1台に何枚あるか」は書類の中身を見ないと数えられず、この見張りは件数の控えしか持たない。
    //     エミュレータのミラーでの実測は 1台あたり 1〜24枚(平均11.8枚)。数字を作らずに、ここは上限として残す。
    lazy: [['final-inspection-v1', 'lot_images',
      '🚦開いているロットの分だけ購読する形へ(2026-08-30)。ここの件数は棚ぜんぶ=**上振れ**。実測は1台あたり平均11.8枚']],
    why: 'src/App.firebase.jsx の unsubs 配列。?live= と ?renraku=1 は一部/全部を止める',
  },
  product: {
    always: ['lots', 'templates', 'workers', 'contact_requests', 'arrival_times', 'push_tokens',
             'controllers', 'order_motors', 'motor_ledger', 'spare_motors', 'logs', 'notes',
             'announcements', 'indirectWork', 'improvements', 'minor_reports', 'observationPlans',
             'video_recipes', 'model_templates',
             // ⭐星取表の指名の印+🎓教育の出来事(2026-08-29)。どちらも新しい順500件のみ購読(App.jsx側にlimit:500)
             'skill_marks', 'education_events'],
    docs: [['product-inspection-v1', 'settings'], ['contact-shared-v1', 'settings']],
    shared: [['contact-shared-v1', 'app_feedback'], ['contact-shared-v1', 'app_notices']],
    lazy: [],
    why: 'src/App.jsx の unsubs 配列。lots は limit:500 + 未完了だけの2本立て(=同じ doc を2回読む)',
  },
  parts: {
    always: ['lots', 'templates', 'workers', 'notes', 'announcements', 'observationPlans'],
    docs: [['parts-inspection-v1', 'settings']],
    shared: [],
    // 🚨 2026-08-30 直した: logs / indirectWork / improvements は起動時ではなく
    //   **開いた画面でだけ** 張る形(useLazyCollection)に移っている。実コードで確かめた:
    //     indirectWork … src/App.jsx:26985(lotHistoryNeededNow / 日次集計 / 引き継ぎ)
    //     improvements … src/App.jsx:26989(分析タブ / 作業最適化タブ)
    //     logs         … src/App.jsx:26993(分析タブ)
    //   always に置いたままだと **起動1回の見積りを 3コレクションぶん多く** 数える。
    //   ⚠「多い方に外れる」から安全、ではない。見積りが実物とずれた時点で
    //     どちらへ外れているか誰も言えなくなる(checkStartupFresh が赤で教えてくれた)。
    lazy: [['parts-inspection-v1', 'indirectWork', '日次集計/引き継ぎ/過去が要る画面を開いた時(src/App.jsx 26985)'],
           ['parts-inspection-v1', 'improvements', '分析タブ・作業最適化タブを開いた時(src/App.jsx 26989)'],
           ['parts-inspection-v1', 'logs', '分析タブを開いた時(src/App.jsx 26993)']],
    why: 'src/App.jsx の unsubs 配列。名前空間は実測0件',
  },
};

// ---------------------------------------------------------------------------
// 下ごしらえ
// ---------------------------------------------------------------------------
export const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

export const readSrc = (p) => fs.readFileSync(p, 'utf8').split(String.fromCharCode(0)).join('');

export const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, out); }
    else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
};

/** `(` から対応する `)` まで(文字列は飛ばす)。 */
const argsFrom = (src, openIdx) => {
  let depth = 0, q = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
};
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// ---------------------------------------------------------------------------
// ① 実コードから読みの口を列挙
// ---------------------------------------------------------------------------
export const KINDS = {
  watchCollection: { doc: false, live: true },
  watchQuery:      { doc: false, live: true },
  watchDoc:        { doc: true,  live: true },
  getAll:          { doc: false, live: false },
  getPage:         { doc: false, live: false },
  // 🚨🚨 2026-08-31 追加。ここが抜けていたので、**写真の全件読み2口を1件も見ていなかった**。
  //   `getPageFields(ns, col, fields, opts)` は「運ぶ項目」を選ぶだけで、**読む件数は1件も減らない**
  //   (Firestore は書類1件を1回として数える。項目を絞っても件数は同じ)。
  //   → 絞り込みの判定は fields ではなく **opts の where / limit だけ**で行う。
  getPageFields:   { doc: false, live: false },
  getOne:          { doc: true,  live: false },
  getDocs:         { doc: false, live: false },
};

/** `(a, b, {x:1}, cb)` を最上位のカンマで分ける。 */
const splitArgs = (argsWithParens) => {
  const s = argsWithParens.slice(1, -1);
  const out = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

/** そのファイルの中の `const FOO = 'bar'` を集める(コレクション名の定数を解く為)。 */
export const constStrings = (src) => {
  const m = {};
  for (const x of src.matchAll(/\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g)) m[x[1]] = x[2];
  return m;
};

export const scanFile = (rawSrc, file, globalConsts = {}) => {
  const src = stripComments(rawSrc);
  const lines = src.split('\n');
  const consts = { ...globalConsts, ...constStrings(src) };
  const out = [];
  const seen = new Set();

  // ⚠ getPageFields は getPage より **先** に置く(後ろに置いても `getPage\s*\(` は
  //   `getPageFields(` に当たらないが、語彙の見落としを二度と作らない為に順番でも守る)。
  const RE = /\b(watchCollection|watchQuery|watchDoc|getAll|getPageFields|getPage|getOne|watch)\s*\(/g;
  let m;
  while ((m = RE.exec(src))) {
    const kindName = m[1];
    const open = src.indexOf('(', m.index);
    const args = argsFrom(src, open);
    // ⚠定義そのものは数えない。
    //   `const watch = (colName, cb) => ...` / `watchCollection: (ns, col, cb) => ...`
    //   / `watchCollection: call('watchCollection')`
    const after = src.slice(open + args.length, open + args.length + 6);
    if (/^\s*=>/.test(after)) continue;
    const before = src.slice(Math.max(0, m.index - 30), m.index);
    if (/[:=]\s*$/.test(before)) continue;
    // `watch(el, cb)`(ResizeObserver の道具)は Firestore ではない
    if (kindName === 'watch' && !/^\(\s*['"]/.test(args)) continue;

    const kind = kindName === 'watch' ? 'watchCollection' : kindName;
    if (!KINDS[kind]) continue;

    // コレクション名の在る場所: 別名 watch は0番目、窓口は1番目(第0は名前空間)
    const parts = splitArgs(args);
    const raw = (kindName === 'watch' ? parts[0] : parts[1]) || '';
    let col;
    const q = raw.match(/^['"]([^'"]+)['"]$/);
    if (q) col = q[1];
    else if (consts[raw]) col = consts[raw];
    else col = `(変数:${raw.slice(0, 24) || '?'})`;

    // 🚨名前空間も解く。**別のアプリの棚を読んでいる所がある**(製品検査が最終検査の lots を読む)。
    //   自分の棚だと決めつけると、そこに出る件数が嘘になる。
    const nsRaw = (kindName === 'watch' ? '(自分)' : (parts[0] || '')).trim();
    let ns = null;                                  // null = 自分の名前空間
    const nq = nsRaw.match(/^['"]([^'"]+)['"]$/);
    const dot = nsRaw.match(/^[A-Za-z_$][\w$]*\.([a-z]+)$/);   // DATA_NS.final など
    const NS_BY_KEY = { product: 'product-inspection-v1', final: 'final-inspection-v1',
                        parts: 'parts-inspection-v1', overview: 'overview-app-v1',
                        goals: 'goal-shared-v1', contact: 'contact-shared-v1' };
    if (nsRaw === '(自分)' || /APP_DATA_ID/.test(nsRaw)) ns = null;
    else if (nq) ns = nq[1];
    else if (dot && NS_BY_KEY[dot[1]]) ns = NS_BY_KEY[dot[1]];
    else if (consts[nsRaw]) ns = consts[nsRaw];
    else ns = '(不明)';

    const line = lineOf(src, m.index);
    // ⚠別名の定義そのものは口ではない。
    //   `const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb);`
    //   ここを数えると、実際の `watch('lots', cb)` と二重になり、しかも件数が分からない
    //   「(変数)」として並んで一覧を汚す。**コレクション名がその定義の引数名なら定義**。
    //   ⚠⚠ 2026-08-30: 定義が **改行で折り返されている** 形を見落としていた。
    //     const watch = (colName, cb, opts = {}) =>
    //       P.watchCollection(APP_DATA_ID, colName, cb, { ... });
    //     この形だと矢印の行と呼び出しの行が別になり、定義を「本物の読み口」と数えて
    //     **嘘の❌** が出る(実際に製品検査で出た。あちらが行を折り返しただけで門が赤くなった)。
    //     → 呼び出しの行だけでなく、**その少し上まで**見て定義かどうかを決める。
    const ALIAS_LOOKBACK = 3;
    const lineTxt = lines.slice(Math.max(0, line - 1 - ALIAS_LOOKBACK), line).join('\n');
    const aliasDef = /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*$/m.exec(lineTxt)
      || /\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(lines[line - 1] || '');
    if (aliasDef && aliasDef[1].split(',').map((x) => x.trim().split('=')[0].trim()).includes(raw)) continue;

    // 🚨🚨 絞り込みが **変数で渡されている** 時は、静的には中身が読めない。
    //   例: `getPage(ns, 'lots', s.spec, { map })` … where/limit は s.spec の中に居る。
    //   ここを「絞り込みが無い」と言い切ると **嘘の❌** になり、
    //   見張りが狼少年になって誰も見なくなる(それが一番危ない)。
    //   → 「無い」でも「有る」でもなく **「静的には確かめられない」** として別に出す。
    // ⚠ getPageFields の署名は (ns, col, fields, opts) なので opts は **3番目**。
    //   2番目(fields)を opts と読み違えると、項目の配列を「絞り込み」と見なして黙って通す。
    const OPT_AT = { watchCollection: 3, watchQuery: 2, getAll: 2, getPage: 2, getPageFields: 3, getDocs: 2 };
    const optAt = OPT_AT[kind] != null ? OPT_AT[kind] - (kindName === 'watch' ? 1 : 0) : null;
    const optRaw = optAt != null ? (parts[optAt] || '').trim() : '';
    const hasWhere = /\bwhere\s*:/.test(args);
    const hasLimit = /\blimit\s*:/.test(args);
    const optsVar = !hasWhere && !hasLimit && !!optRaw
      && !optRaw.startsWith('{') && /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(optRaw) ? optRaw : '';

    const key = `${file}:${line}:${col}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      file, line, kind, col, ns,
      live: KINDS[kind].live,
      singleDoc: KINDS[kind].doc,
      hasWhere,
      hasLimit,
      optsVar,                       // '' なら「引数を全部読めた」。文字が入っていれば「読めない」
      hasOrderBy: /\borderBy\s*:/.test(args),
      hasOnError: /\bonError\b/.test(args),
      code: (lines[line - 1] || '').trim().slice(0, 120),
    });
  }
  return out;
};

export const scanApp = (app) => {
  if (!fs.existsSync(app.dir)) return { ...app, sites: [], missing: true };
  const files = walk(app.dir);
  // ⚠コレクション名の定数は **別のファイル** に居る(`src/domain/appFeedback.js` の FEEDBACK_COL など)。
  //   1ファイルだけ見ると「(変数)」になって、その口が何件読むのか分からなくなる。
  const globalConsts = {};
  for (const f of files) Object.assign(globalConsts, constStrings(stripComments(readSrc(f))));
  const sites = [];
  for (const f of files) {
    // 窓口そのもの(src/data/*)は「口の定義」なので数えない。実際に呼ぶ画面だけを数える。
    if (/[\\/]src[\\/]data[\\/]/.test(f)) continue;
    const rel = path.relative(path.dirname(app.dir), f).split(path.sep).join('/');
    sites.push(...scanFile(readSrc(f), `src/${rel.replace(/^src\//, '')}`, globalConsts));
  }
  return { ...app, sites };
};

// ---------------------------------------------------------------------------
// 実測の件数(バックアップの manifest)
// ---------------------------------------------------------------------------
export const DEFAULT_MANIFEST = 'C:/Users/anrw3/inspection-audit-local/backups/2026-08-11_0530/manifest.json';

export const loadCounts = (manifestPath = DEFAULT_MANIFEST) => {
  if (!fs.existsSync(manifestPath)) return null;
  const j = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { stamp: j.stamp, ns: j.namespaces || {}, totals: j.totals, path: manifestPath };
};

/** その名前空間のそのコレクションの実測件数。無ければ0(推測で埋めない)。 */
export const docsOf = (counts, ns, col) => Number(((counts?.ns?.[ns] || {})[col] || {}).docs || 0);

// ---------------------------------------------------------------------------
// ② 例外(絞り込みを付けない事を認めてもらう)の読み込みと検分
//    🚨 例外は「理由を書かせる」だけでは腐る。**約束した件数(maxDocs)を実測で照合**して、
//       前提が崩れたら自動で例外を切る。「小さいから」は測れる約束にする。
// ---------------------------------------------------------------------------
export const ALLOW_MIN_WHY = 20;      // 理由の最低文字数。これ未満は「書いていない」と同じ。

export const allowPathOf = (app) => path.join(path.dirname(app.dir), 'scripts', 'read-budget-allow.json');

export const loadAllow = (app) => {
  const p = allowPathOf(app);
  if (!fs.existsSync(p)) return { path: p, entries: [], missing: true };
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { path: p, entries: [], broken: String(e && e.message || e) }; }
  const entries = Array.isArray(j) ? j : (Array.isArray(j.allow) ? j.allow : []);
  return { path: p, entries };
};

/**
 * 今日の日付(この端末の時計。UTC ではない)。
 * ⚠ toISOString() は UTC なので、日本の朝9時前は「昨日」になる。
 *   期限(until)の判定が1日ずれるので使わない。
 */
export const todayLocal = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const sameSite = (entry, s) => entry.app === s.appKey
  && entry.file === s.file
  && entry.col === s.col
  && (!entry.kind || entry.kind === s.kind);

/**
 * 🚦 判定の芯。**画面も実ファイルも触らない純粋な関数**にしてある(だから試験できる)。
 * @param sites  正規化済みの読み口 [{appKey,file,line,col,kind,live,singleDoc,hasWhere,hasLimit,docs,docsUnknown}]
 * @param allows { appKey: {path, entries:[]} }
 * @param today  'YYYY-MM-DD'
 */
export const judge = ({ sites, allows = {}, today = todayLocal() }) => {
  // 絞り込みの無い「コレクションの読み」= 件数が青天井の口。1件の doc を読む口(watchDoc/getOne)は数えない。
  // ⚠ 絞り込みが変数で渡されている口(optsVar)は **ここに入れない**。
  //   静的には「無い」と言えないので、❌にも✅にもせず、別の一覧に出して人に見てもらう。
  const collectionReads = sites.filter((s) => !s.singleDoc);
  const unverifiable = collectionReads.filter((s) => !s.hasWhere && !s.hasLimit && s.optsVar);
  const risky = collectionReads.filter((s) => !s.hasWhere && !s.hasLimit && !s.optsVar);
  const violations = [];
  const excused = [];
  const problems = [];
  const usedEntries = new Set();

  for (const s of risky) {
    const bag = allows[s.appKey] || { entries: [] };
    const idx = bag.entries.findIndex((e) => sameSite(e, s));
    if (idx < 0) { violations.push({ site: s, why: '例外の届け出が無い' }); continue; }
    const e = bag.entries[idx];
    usedEntries.add(`${s.appKey}#${idx}`);

    const whyLen = [...String(e.why || '')].length;
    const bad = [];
    if (whyLen < ALLOW_MIN_WHY) bad.push(`理由が短すぎる(${whyLen}文字 / ${ALLOW_MIN_WHY}文字以上)`);
    if (!Number.isFinite(Number(e.maxDocs)) || Number(e.maxDocs) < 0) bad.push('maxDocs(この件数までなら許す)が数字で書かれていない');
    if (e.until && String(e.until) < today) bad.push(`期限切れ(until=${e.until} / 今日=${today})`);
    if (!e.who) bad.push('who(誰が決めたか)が空');
    if (!bad.length && !s.docsUnknown && Number(s.docs) > Number(e.maxDocs)) {
      bad.push(`🚨前提が崩れた: 実測 ${s.docs}件 > 約束した上限 ${e.maxDocs}件`);
    }
    if (bad.length) {
      problems.push({ appKey: s.appKey, entry: e, site: s, path: bag.path, msgs: bad });
      violations.push({ site: s, why: '例外は在るが成り立っていない' });
    } else {
      excused.push({ site: s, entry: e, warnUnknown: !!s.docsUnknown });
    }
  }

  // 使われていない例外は消す。放っておくと「許されている物」が実体より増える。
  for (const [appKey, bag] of Object.entries(allows)) {
    bag.entries.forEach((e, i) => {
      if (usedEntries.has(`${appKey}#${i}`)) return;
      problems.push({ appKey, entry: e, site: null, path: bag.path,
        msgs: ['もう当てはまる読み口が無い(直った/移動した)。**この行を消す事**'] });
    });
  }
  return { risky, unverifiable, violations, excused, problems };
};

// ---------------------------------------------------------------------------
// ③ 1回開くと何件読むか / ④ 1日の見積り
// ---------------------------------------------------------------------------
export const estimatePerOpen = (counts) => {
  const perOpen = {};
  for (const [key, plan] of Object.entries(STARTUP)) {
    const app = APPS.find((a) => a.key === key);
    let sum = 0; const rows = [];
    for (const col of plan.always) {
      const n = docsOf(counts, app.ns, col);
      sum += n; if (n) rows.push([col, n]);
    }
    for (const [ns, col] of plan.docs) { sum += 1; rows.push([`${col}/config (${ns})`, 1]); }
    for (const [ns, col] of plan.shared) { const n = docsOf(counts, ns, col); sum += n; if (n) rows.push([`${col} (${ns})`, n]); }
    // 🚨🚨 2026-08-30 訂正: 製品の lots を「総数 × 2本」と数えていたのをやめた。
    //   実コード(src/domain/readBudget.js)の2本は **重なりが無い**:
    //     ①' where createdAt >= 窓の始まり (orderBy createdAt desc / limit 500)
    //     ②' where status != 'completed' かつ createdAt <  窓の始まり
    //   片方は「窓の中」、もう片方は「窓より古い」なので、同じ書類は2度読まれない。
    //   実測(本番の控え 2026-08-30・633件): ①316 + ②15 = **331件**。総数×2 = 1,266件は
    //   実物の 3.8倍で、いちばん大きな水増しだった。
    //   ⚠それでも下に残る `lots` の総数は **窓より多い**(391件 vs 実際に読むのは291件)。
    //     窓の中身は「書類の中身」を見ないと数えられず、この見張りは件数の控えしか持っていない。
    //     だから **上振れの見積り**として残す。数えられない物を作らない。
    let lazySum = 0; const lazyRows = [];
    for (const [ns, col, why] of plan.lazy) { const n = docsOf(counts, ns, col); lazySum += n; lazyRows.push([col, n, why]); }
    perOpen[key] = { startup: sum, lazy: lazySum, total: sum + lazySum, rows, lazyRows, why: plan.why };
  }
  return perOpen;
};

/**
 * 司令塔③の読み。
 * ⚠⚠ 一覧と間隔を **手で写さない**。③の実コードから取り出す。
 *   手で写すと、あちらを直した時にこの見積りが黙って嘘になる。
 */
export const estimateOverview = (counts, srcOverride = null) => {
  const ovApp = APPS.find((a) => a.key === 'overview');
  const ovSrcPath = path.join(ovApp.dir, 'App.jsx');
  const ovSrc = srcOverride !== null ? stripComments(srcOverride)
    : (fs.existsSync(ovSrcPath) ? stripComments(readSrc(ovSrcPath)) : '');
  const arrOf = (name) => {
    const m = ovSrc.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((x) => x[1]) : null;
  };
  const OV_FULL = arrOf('COLLECTIONS');
  // ⚠③の「毎回の軽い読み」の一覧は名前が変わる(2026-08-18 に LIGHT_→NORMAL_ へ改名された)。
  //   名前を1つだけ決め打つと、あちらを直した日に見積りが丸ごと出せなくなる。
  const lightName = ['LIGHT_COLLECTIONS', 'NORMAL_COLLECTIONS'].find((n) => arrOf(n));
  const OV_LIGHT = lightName ? arrOf(lightName) : null;
  const OV_NS = [...ovSrc.matchAll(/id:\s*['"]([a-z-]+-v1)['"]/g)].map((x) => x[1]);
  const autoDefault = (() => {
    const m = ovSrc.match(/overviewAutoRefreshMin['"]\)\s*;\s*return\s+v\s*==\s*null\s*\?\s*(\d+)/);
    return m ? Number(m[1]) : null;
  })();
  if (!OV_FULL || !OV_LIGHT || !OV_NS.length) return { unreadable: true };
  if (autoDefault !== null && autoDefault !== ASSUME.overview.autoMin) ASSUME.overview.autoMin = autoDefault;

  const ov = ASSUME.overview;
  const ovSum = (cols) => OV_NS.reduce((s, ns) => s + cols.reduce((t, c) => t + docsOf(counts, ns, c), 0), 0);
  const full = ovSum(OV_FULL), light = ovSum(OV_LIGHT);
  const refreshes = Math.floor(60 / ov.autoMin) * ov.hoursVisible;

  // 🚨「軽い読み」に lots が居ないのに、別口で窓を切って読んでいる形。
  //   窓の中に何件入るかは **手元の実測(manifest)からは数えられない**(日付や状態が要る)。
  //   → **数字を作らない。** 見積りを「少なくともこれだけ」に格下げして、何を数えていないかを名指しする。
  const lotsWindowed = !OV_LIGHT.includes('lots') && /readLotsWindow|lotWindowSpecs/.test(ovSrc);
  const uncounted = lotsWindowed
    ? [`司令塔③が自動更新のたびに読む「ロットの窓」(${lightName} に lots が無く、別口で絞って読んでいる)。`
       + '窓に何件入るかは手元の実測から数えられないので、0件として置いてある＝**実際はこれより多い**']
    : [];

  return { unreadable: false, OV_FULL, OV_LIGHT, OV_NS, lightName, autoDefault, full, light, refreshes,
           lotsWindowed, uncounted, perTabDay: full + light * refreshes };
};

export const estimateDay = (counts) => {
  const perOpen = estimatePerOpen(counts);
  const ov = estimateOverview(counts);
  if (ov.unreadable) return { unreadable: true, perOpen };
  const A = ASSUME.overview;
  let day = 0; const bill = [];
  for (const [key, a] of Object.entries(ASSUME.openPerDay)) {
    const app = APPS.find((x) => x.key === key);
    const n = (perOpen[key]?.total || 0) * a.people * a.opens;
    day += n;
    bill.push([`${app.label} ${a.people}人 × ${a.opens}回 × ${(perOpen[key]?.total || 0).toLocaleString('en-US')}件`, n, a.why]);
  }
  const ovDay = ov.perTabDay * A.tabs;
  day += ovDay;
  bill.push([`司令塔③ ${A.tabs}タブ × ${ov.perTabDay.toLocaleString('en-US')}件/日`, ovDay, A.why]);
  // 🚨 ③の iframe(?embed=map)。**止めている購読の分は引く**(EMBED_STOPS。実コードで裏を取ってある)。
  //   引ける根拠が消えたら checkEmbedFresh() が赤にするので、黙って小さい数字にはならない。
  const embedCut = [];
  const ifrPerOpen = ASSUME.overviewIframes.apps.reduce((s, k) => {
    const app = APPS.find((x) => x.key === k);
    let n = perOpen[k]?.total || 0;
    for (const st of (EMBED_STOPS[k] || [])) {
      const d = docsOf(counts, app.ns, st.col);
      if (d > 0) { n -= d; embedCut.push(`${app.label} の ${st.col} ${d.toLocaleString('en-US')}件`); }
    }
    return s + Math.max(0, n);
  }, 0);
  const ifr = ifrPerOpen * A.tabs;
  day += ifr;
  bill.push([`③の iframe(?embed=map) が抱える実アプリ ${ASSUME.overviewIframes.apps.length}本 × ${A.tabs}タブ`
    + (embedCut.length ? `（?embed=map で読まない ${embedCut.join(' / ')} は引いてある）` : ''), ifr, ASSUME.overviewIframes.why]);

  // 🚨数えられない読みが1つでも在れば、この合計は「合計」ではなく **下限** になる。
  //   下限だと分かるように印を立てる。「合計」の顔をした足りない数字を出さない。
  const uncounted = [...(ov.uncounted || [])];
  return { unreadable: false, perOpen, ov, day, bill, iframes: ifr, uncounted,
           lowerBound: uncounted.length > 0,
           pct: Math.round((day / FREE_READS_PER_DAY) * 100), over: day > FREE_READS_PER_DAY };
};

/**
 * 🚨 見積りの土台(STARTUP)が実コードとずれていないか。
 *   ここがずれると「1回開くと何件読むか」が **黙って小さくなる**。
 */
export const checkStartupFresh = (apps, counts = null) => {
  const gone = [];       // 見積りに書いてあるのに実コードに購読が無い → 見積りが **多すぎる** 方に嘘をつく
  const extra = [];      // 実コードに購読が在るのに見積りに入っていない → 見積りが **足りない** 方に嘘をつく
  for (const [key, plan] of Object.entries(STARTUP)) {
    const app = apps.find((a) => a.key === key);
    if (!app || app.missing) continue;
    const live = app.sites.filter((s) => s.live && !s.singleDoc && !s.col.startsWith('(変数'));
    const liveCols = new Set(live.map((s) => s.col));
    for (const col of plan.always) {
      if (liveCols.has(col)) continue;
      gone.push({ key, col, docs: docsOf(counts, app.ns, col), where: String(app.dir || '').replace(/\/src$/, '') });
    }
    const known = new Set([...plan.always, ...plan.lazy.map((x) => x[1]), ...plan.shared.map((x) => x[1])]);
    for (const col of liveCols) {
      if (known.has(col)) continue;
      const at = live.find((s) => s.col === col);
      extra.push({ key, col, docs: docsOf(counts, app.ns, col), at: at ? `${at.file}:${at.line}` : '' });
    }
  }
  return { gone, extra, extraDocs: extra.reduce((s, x) => s + x.docs, 0) };
};

// ---------------------------------------------------------------------------
// 🧪 見張り自身の試験
// ⚠⚠ 数字を出す道具・落とす道具は、必ず「わざと外した物」で試す。
//   過去に嘘の合格3件・実コードを食う誤検出1件があった(2026-08-16)。
// ---------------------------------------------------------------------------
export const selftest = () => {
  let bad = 0;
  const say = (ok, what) => { console.log(`${ok ? '  ✅' : '  ❌'} ${what}`); if (!ok) bad++; };
  console.log('🧪 見張り自身の試験');

  // --- (A) 数え方 ----------------------------------------------------------
  const FIX = `
const FEEDBACK_COL = 'app_feedback';
const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb);
watch('lots', (rows) => setLots(rows)),
watch(headerElRef.current, setHeaderH);
P.watchCollection(APP_DATA_ID, FEEDBACK_COL, (rows) => setAppFeedback(rows)),
Q.watchQuery(APP_DATA_ID, 'lots', { orderBy: [['createdAt','desc']], limit: 500 }, cb, { includeMetadataChanges: true }),
Q.watchQuery(APP_DATA_ID, 'lots', { where: [['status','!=','completed']] }, cb),
DATA(db).getAll(DATA_NS.final, 'lots', { map: ROW_DATA_WINS }),
DATA(db).watchCollection(APP_DATA_ID, 'help_images', cb, { onError: (e) => warn(e) }),
// watch('notes', cb)   ← コメントの中の例示
`;
  const r = scanFile(FIX, '(memory)');
  const at = (col, kind) => r.filter((x) => x.col === col && x.kind === kind);

  say(!r.some((x) => x.col.startsWith('(変数:colName)') && x.line === 3),
    '別名の定義行(const watch = ... => P.watchCollection)を口として数えない');
  // 🚨 2026-08-30: 定義が改行で折り返されていても「定義」と読む(嘘の❌を出さない)。
  //   実際に製品検査が2行に折り返した日、門が別名の定義を本物の読み口として赤にした。
  const WRAPPED = `
const watch = (colName, cb, opts = {}) =>
  P.watchCollection(APP_DATA_ID, colName, cb, { onError: readFailed(colName), ...opts });
watch('lots', (rows) => setLots(rows)),
`;
  const rw = scanFile(WRAPPED, '(memory)');
  say(!rw.some((x) => x.col.startsWith('(変数')), '🚨 別名の定義が改行で折り返されていても、口として数えない');
  say(rw.filter((x) => x.col === 'lots').length === 1, '折り返した別名でも、実際の watch(\'lots\', cb) は1件として数える');
  say(!r.some((x) => x.line === 5), 'watch(el, cb)(ResizeObserver)を Firestore の口と数えない');
  say(at('app_feedback', 'watchCollection').length === 1,
    '別のファイルに在る定数(FEEDBACK_COL)を解いてコレクション名にする');
  say(at('lots', 'watchQuery').some((x) => x.hasLimit && !x.hasWhere),
    'limit だけの購読を「limit 有り・where 無し」と読む');
  say(at('lots', 'watchQuery').some((x) => x.hasWhere && !x.hasLimit),
    'where だけの購読を「where 有り・limit 無し」と読む');
  say(at('lots', 'getAll').some((x) => x.ns === 'final-inspection-v1'),
    '別のアプリの棚(DATA_NS.final)を読んでいる所を、自分の棚だと決めつけない');
  say(at('help_images', 'watchCollection').every((x) => x.hasOnError),
    'onError が在る口を「無い」と言わない');
  say(!r.some((x) => x.col === 'notes'), 'コメントの中の例示を実コードとして数えない');
  say(at('lots', 'watchCollection').length === 1, "別名 watch('lots', cb) を1件として数える");

  // --- (A2) 🚨項目を選ぶ読み(getPageFields)を語彙に持っているか ---------------
  //   2026-08-31: ここが走査の正規表現から抜けていた。実コードには絞り込みの無い
  //   getPageFields が2口(写真のメタ読み・容量の手当て)在るのに、見張りは **1件も見ずに
  //   ✅ 合格**を出していた(＝緑なのに何も守っていない見張り)。
  //   ⚠ **fields を絞っても件数は1件も減らない。** 絞り込みは opts の where/limit だけ。
  const PF = `
DATA(db).getPageFields(APP_DATA_ID, 'lot_images', ['lotId', 'kind', 'at', 'bytes'], { getToken: () => user.getIdToken() });
DATA(db).getPageFields(APP_DATA_ID, 'lot_images', [], { where: [['lotId', 'in', chunk]] });
DATA(db).getPageFields(APP_DATA_ID, 'lot_images', [], {});
DATA(db).getPageFields(APP_DATA_ID, 'lot_images', ['lotId'], spec);
`;
  const pf = scanFile(PF, '(memory)').map((s) => ({ ...s, appKey: 'final', docs: 941, docsUnknown: false }));
  say(pf.length === 4 && pf.every((x) => x.kind === 'getPageFields' && x.col === 'lot_images'),
    '🚨 getPageFields を読みの口として数える(2026-08-31 まで1件も見ていなかった)');
  say(pf.filter((x) => x.hasWhere).length === 1,
    'where で絞った getPageFields は「絞り込み有り」と読む');
  const pfj = judge({ sites: pf, allows: {}, today: '2026-08-18' });
  say(pfj.violations.length === 2,
    '🚨 わざと絞り込みの無い getPageFields を書いたら ❌ になる（項目を絞っても件数は絞れない）');
  say(pfj.unverifiable.length === 1 && pfj.unverifiable[0].optsVar === 'spec',
    '🚨 opts が変数の getPageFields は「静的には確かめられない」に置く（fields の配列を opts と読み違えない）');
  say(scanFile(`  getPageFields: async (ns, col, fields = [], opts = {}) => {`, '(memory)').length === 0,
    '窓口そのものの定義(getPageFields: async (…) =>)を口として数えない');

  // --- (B) 🚨わざと壊した見本で **落ちる** 事 -------------------------------
  const site = (over = {}) => ({
    appKey: 'final', file: 'src/App.firebase.jsx', line: 100, col: 'lots', kind: 'watchCollection',
    live: true, singleDoc: false, hasWhere: false, hasLimit: false, docs: 235, docsUnknown: false, ...over,
  });
  const allowOf = (over = {}) => ({ final: { path: '(memory)', entries: [{
    app: 'final', file: 'src/App.firebase.jsx', col: 'lots', who: '清水',
    why: '完了ロットも分析画面が全部使うので絞れない。件数の上限を約束して見張る事にした。', maxDocs: 300, ...over }] } });

  const g0 = judge({ sites: [site()], allows: {}, today: '2026-08-18' });
  say(g0.violations.length === 1, '🚨 where も limit も無い購読を、届け出が無ければ ❌ にする');

  const gOk = judge({ sites: [site()], allows: allowOf(), today: '2026-08-18' });
  say(gOk.violations.length === 0 && gOk.excused.length === 1,
    '理由と上限をきちんと書いた例外は通す');

  const gShort = judge({ sites: [site()], allows: allowOf({ why: '重いけど要る' }), today: '2026-08-18' });
  say(gShort.violations.length === 1 && /理由が短すぎる/.test(gShort.problems[0].msgs.join()),
    '🚨 理由が短い例外は通さない(判子だけの例外を作らせない)');

  const gNoWho = judge({ sites: [site()], allows: allowOf({ who: '' }), today: '2026-08-18' });
  say(gNoWho.violations.length === 1, '🚨 誰が決めたか(who)が空の例外は通さない');

  const gGrew = judge({ sites: [site({ docs: 400 })], allows: allowOf({ maxDocs: 300 }), today: '2026-08-18' });
  say(gGrew.violations.length === 1 && /前提が崩れた/.test(gGrew.problems[0].msgs.join()),
    '🚨 約束した件数を実測が追い越したら、例外は自動で切れる');

  const gExp = judge({ sites: [site()], allows: allowOf({ until: '2026-08-01' }), today: '2026-08-18' });
  say(gExp.violations.length === 1 && /期限切れ/.test(gExp.problems[0].msgs.join()),
    '🚨 期限切れの例外は通さない');

  // ⚠日付は端末の時計(日本時間)で見る。UTC で見ると朝9時前は「昨日」になり期限判定が1日ずれる。
  say(todayLocal(new Date(2026, 7, 18, 6, 0, 0)) === '2026-08-18',
    '期限の判定に使う「今日」は端末の時計（UTC ではない。朝でも1日ずれない）');

  const gNoMax = judge({ sites: [site()], allows: allowOf({ maxDocs: undefined }), today: '2026-08-18' });
  say(gNoMax.violations.length === 1, '🚨 上限件数(maxDocs)を書いていない例外は通さない');

  const gDead = judge({ sites: [site({ hasLimit: true })], allows: allowOf(), today: '2026-08-18' });
  say(gDead.violations.length === 0 && gDead.problems.some((p) => /もう当てはまる読み口が無い/.test(p.msgs.join())),
    '直った後に残った例外を「消せ」と言う(許可の数が実体より増えない)');

  // --- (C) 🚨見張りが緩くない事(直した形は通る・1件の doc は数えない) -------
  say(judge({ sites: [site({ hasLimit: true })], allows: {}, today: '2026-08-18' }).violations.length === 0,
    'limit を付けた購読は通す');
  say(judge({ sites: [site({ hasWhere: true })], allows: {}, today: '2026-08-18' }).violations.length === 0,
    'where を付けた購読は通す');
  say(judge({ sites: [site({ singleDoc: true, kind: 'watchDoc', docs: 1 })], allows: {}, today: '2026-08-18' }).violations.length === 0,
    '1件だけ読む口(watchDoc/getOne)は「絞り込みが無い」と言わない');
  const FIXED = `Q.watchQuery(APP_DATA_ID, 'lots', { where: [['status','!=','completed']], limit: 200 }, cb),`;
  const fixedSites = scanFile(FIXED, '(memory)').map((s) => ({ ...s, appKey: 'final', docs: 235, docsUnknown: false }));
  say(judge({ sites: fixedSites, allows: {}, today: '2026-08-18' }).violations.length === 0,
    '🚨 直した形(where+limit の lots 購読)を、まだ ❌ と言わない');

  // --- (C2) 🚨嘘の❌を出さない: 絞り込みが変数の中に居る時 ------------------
  const VAR_OPTS = `
const rows = await DATA(db).getPage(nsId, 'lots', s.spec, { map: mapRow });
Q.watchQuery(APP_DATA_ID, 'lots', LOTS_SPEC, cb),
watch('lots', (rows) => setLots(rows)),
DATA(db).getAll(ns, 'lots', { map: ROW_DATA_WINS }),
`;
  const vs = scanFile(VAR_OPTS, '(memory)').map((s) => ({ ...s, appKey: 'final', docs: 235, docsUnknown: false }));
  const vj = judge({ sites: vs, allows: {}, today: '2026-08-18' });
  say(vj.unverifiable.length === 2 && vj.unverifiable.every((s) => s.kind === 'getPage' || s.kind === 'watchQuery'),
    "🚨 絞り込みが変数(s.spec / LOTS_SPEC)の口を「静的には確かめられない」として別に出す");
  say(vj.violations.length === 2,
    '🚨 それでも、引数を全部読めた上で絞り込みが無い口(watch / getAll)は ❌ のまま');
  say(vs.find((s) => s.kind === 'getAll').optsVar === '',
    '🚨 { map: ... } のような **中身の見える** 引数を「変数だから分からない」と逃げない');

  // --- (D) 枠の判定 --------------------------------------------------------
  say(FREE_READS_PER_DAY === 50_000, '無料枠は 50,000回/日（4アプリで1枠）');
  const over = (n) => n > FREE_READS_PER_DAY;
  say(over(50_001) && !over(50_000), '50,000 ちょうどは超過にしない / 1回でも超えたら超過');

  // --- (E) 見積りの土台のずれ検出 ------------------------------------------
  const fakeApps = [{ key: 'final', missing: false, sites: [
    { col: 'lots', live: true, singleDoc: false }, { col: 'zzz_new', live: true, singleDoc: false },
  ] }];
  const savedFinal = STARTUP.final;
  STARTUP.final = { always: ['lots', 'kieta_col'], docs: [], shared: [], lazy: [], why: '(試験)' };
  const fresh = checkStartupFresh(fakeApps);
  STARTUP.final = savedFinal;
  say(fresh.gone.some((x) => x.col === 'kieta_col'),
    '🚨 見積りに書いてあるのに実コードに無い購読を見つける(数字が黙って減るのを防ぐ)');
  say(fresh.extra.some((x) => x.col === 'zzz_new'),
    '🚨 実コードに在るのに見積りに入っていない購読を見つける(数字が黙って足りないのを防ぐ)');

  // --- (E2) 🚨 ?embed=map で「読まない」と書いた物の裏取り ----------------------
  //   ここは **見積りを小さくする** 側の申告なので、裏が取れない申告は必ず赤にする。
  const embedApps = [{ key: 'final', missing: false, dir: '(memory)' }];
  const withCode = (code) => () => code;
  const stopOf = (re) => ({ final: [{ col: 'lot_images', file: 'App.firebase.jsx', evidence: re }] });
  say(checkEmbedFresh(embedApps, stopOf(/EMBED_MAP[^\n]*lotImagesWanted/),
    withCode('if (RENRAKU_PORTAL || LIVE_CODE || EMBED_MAP || lotImagesWanted) return;')).length === 0,
    '?embed=map で読まない証拠が実コードに在れば通す');
  say(checkEmbedFresh(embedApps, stopOf(/EMBED_MAP[^\n]*lotImagesWanted/),
    withCode('if (RENRAKU_PORTAL || LIVE_CODE || lotImagesWanted) return;')).length === 1,
    '🚨 証拠が消えたら赤（＝iframeぶんを小さく見積もったまま通さない）');
  say(checkEmbedFresh(embedApps, stopOf(/EMBED_MAP[^\n]*zzz_never_exists/),
    withCode('const embedActiveOnly = EMBED_MAP;')).length === 1,
    '🚨 実コードに無い物を「読まない」と書いたら赤（申告だけでは見積りを小さくさせない）');
  say(EMBED_STOPS.product.length === 0 && EMBED_STOPS.parts.length === 0,
    '製品・部品の ?embed=map は購読を止めない（見た目だけ）ので、引く物は無い');

  // --- (F) 司令塔③の読み取り方が変わっても、数字を作らない/黙って落とさない ---------
  const OV_OLD = `const COLLECTIONS = ['lots','settings','workers'];
const LIGHT_COLLECTIONS = ['lots','settings','workers'];
const APPS=[{ id: 'final-inspection-v1' }];`;
  const OV_NEW = `const COLLECTIONS = ['lots','settings','workers'];
const NORMAL_COLLECTIONS = ['settings','workers'];
const readLotsWindow = async () => {};
const APPS=[{ id: 'final-inspection-v1' }];`;
  const OV_GONE = `const COLLECTIONS = ['lots','settings','workers'];
const APPS=[{ id: 'final-inspection-v1' }];`;
  const fakeCounts = { ns: { 'final-inspection-v1': { lots: { docs: 235 }, settings: { docs: 1 }, workers: { docs: 4 } } } };

  const oOld = estimateOverview(fakeCounts, OV_OLD);
  say(!oOld.unreadable && oOld.lightName === 'LIGHT_COLLECTIONS' && oOld.light === 240
      && oOld.lotsWindowed === false && oOld.uncounted.length === 0,
    '③の軽い読みが LIGHT_COLLECTIONS の形（今まで）を読める（lots 込みで 240件）');

  const oNew = estimateOverview(fakeCounts, OV_NEW);
  say(!oNew.unreadable && oNew.lightName === 'NORMAL_COLLECTIONS' && oNew.light === 5,
    '🚨 ③が名前を変えても(NORMAL_COLLECTIONS)、見積りが丸ごと出せなくならない');
  say(oNew.lotsWindowed && oNew.uncounted.length === 1,
    '🚨 ③がロットを「窓」で読むようになったら、窓の件数を **作らずに** 「数えていない」と名指しする');

  const oGone = estimateOverview(fakeCounts, OV_GONE);
  say(oGone.unreadable === true,
    '🚨 ③の軽い読みの一覧がどこにも無い時は、数字を出さずに「当てにするな」と言う');

  console.log(bad === 0 ? '🧪 見張り自身の試験: 合格\n' : `🧪 見張り自身の試験: ❌ ${bad}件 失敗\n`);
  return bad === 0;
};

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
const pad = (s, n) => { const w = [...String(s)].reduce((t, c) => t + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0); return String(s) + ' '.repeat(Math.max(0, n - w)); };
const num = (n) => Number(n).toLocaleString('en-US');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };

export const main = () => {
  const wantJson = process.argv.includes('--json');
  const listOnly = process.argv.includes('--list');
  if (process.argv.includes('--selftest')) return selftest() ? 0 : 1;
  // ⚠壊れた物差しで測って、合格も不合格も出さない。
  if (!selftest()) { console.error('❌ 見張り自身が壊れているので、判定は出しません。'); return 1; }

  const counts = loadCounts(arg('manifest', DEFAULT_MANIFEST));
  const apps = APPS.map(scanApp);
  const today = todayLocal();

  // --- 正規化(件数を付ける) ------------------------------------------------
  const sites = [];
  for (const app of apps) {
    if (app.missing) continue;
    for (const s of app.sites) {
      const useNs = s.ns || app.ns;
      const unknownNs = s.ns === '(不明)';
      const unknownCol = s.col.startsWith('(変数');
      sites.push({ ...s, appKey: app.key, appLabel: app.label,
        docs: s.singleDoc ? 1 : (unknownNs || unknownCol ? 0 : docsOf(counts, useNs, s.col)),
        docsUnknown: !s.singleDoc && (unknownNs || unknownCol) });
    }
  }
  const allows = {};
  for (const app of apps) allows[app.key] = loadAllow(app);

  const est = estimateDay(counts);
  const fresh = checkStartupFresh(apps, counts);
  const embedBad = checkEmbedFresh(apps);
  const verdict = judge({ sites, allows, today });

  if (wantJson) {
    console.log(JSON.stringify({
      today, manifest: counts?.path || null, manifestStamp: counts?.stamp || null,
      perOpen: Object.fromEntries(Object.entries(est.perOpen || {}).map(([k, v]) => [k, v.total])),
      overviewPerTabDay: est.ov?.perTabDay ?? null,
      day: est.day ?? null, dayIsLowerBound: !!est.lowerBound, uncounted: est.uncounted || [],
      overviewLightName: est.ov?.lightName ?? null,
      freeQuota: FREE_READS_PER_DAY, pct: est.pct ?? null,
      unfiltered: verdict.risky.length, violations: verdict.violations.length,
      unverifiable: verdict.unverifiable.length,
      excused: verdict.excused.length, allowProblems: verdict.problems.length,
      startupStale: fresh.gone.length, startupMissingFromEstimate: fresh.extra.length,
    }, null, 2));
  }

  console.log('==========================================================================');
  console.log('🚦 読み取り量の見張り（出荷ゲート）');
  console.log(`   無料枠 ${num(FREE_READS_PER_DAY)}回/日 ・ 🚨**製品/最終/部品/司令塔③ の4アプリで1枠を共有**`);
  console.log(`   (projectId=inspection-time-c4fd3 が1個。どれか1つが使い切れば4つ全部が止まる)`);
  console.log(counts
    ? `   件数の出どころ: ${counts.path}\n                   = 実測 ${counts.stamp}（合計 ${num(counts.totals?.docs || 0)}件）`
    : `   ⚠件数の実測が見つからない。件数は全部0として扱う（推測で埋めない）。`);
  console.log('==========================================================================\n');

  // --- 仮定を全部画面に出す（🚨隠れた前提を作らない） -----------------------
  console.log('■ この見積りが置いている仮定（🚨全部ここに出す。変えるなら scripts/verify-read-budget.mjs の ASSUME）');
  console.log('   🚨🚨 下の「何人が・1日何回開くか」「③は何タブ・何時間」は **実測ではありません**。置いた前提です。');
  console.log('        実測なのは ①コレクションごとの件数(控え) ②実コードから取り出した絞り込み・一覧 の2つだけ。');
  console.log('        本当の数は Firebase コンソールの使用量か、③画面の「📊 …件」(その端末の実測)で見る事。');
  for (const [k, a] of Object.entries(ASSUME.openPerDay)) {
    const app = APPS.find((x) => x.key === k);
    console.log(`   ${pad(app.label, 20)} ${a.people}人 × 1日 ${a.opens}回 開き直す`);
    console.log(`     ↳ ${a.why}`);
  }
  console.log(`   ${pad('司令塔③', 20)} ${ASSUME.overview.tabs}タブ × ${ASSUME.overview.hoursVisible}時間 × 自動更新 ${ASSUME.overview.autoMin}分ごと`);
  console.log(`     ↳ ${ASSUME.overview.why}`);
  console.log(`   ${pad('③の中の iframe', 20)} ${ASSUME.overviewIframes.apps.join('/')} を ?embed=map で抱える`);
  console.log(`     ↳ ${ASSUME.overviewIframes.why}`);
  console.log('   ⚠端末に控え(キャッシュ)が在る時はこれより少ない。**その分は測っていない**。');
  console.log('     新しい端末・別ブラウザ・シークレット窓・控えを消した後・別の住所は毎回この数。\n');

  // --- ① 1回開くと何件読むか ----------------------------------------------
  console.log('--------------------------------------------------------------------------');
  console.log('① 1人が1回開くと何件読むか（冷たい状態=端末の控えが無い時の上限）');
  console.log('--------------------------------------------------------------------------');
  for (const [key, v] of Object.entries(est.perOpen || {})) {
    const app = APPS.find((a) => a.key === key);
    console.log(`\n  ${app.label}: 起動時 ${num(v.startup)}件 + 遅れて張る ${num(v.lazy)}件 = **${num(v.total)}件/回**`);
    console.log(`    (${v.why})`);
    v.rows.slice().sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([c, n]) => console.log(`      ${String(num(n)).padStart(6)}  ${c}`));
    const rest = v.rows.slice().sort((a, b) => b[1] - a[1]).slice(5);
    if (rest.length) console.log(`      ${String(num(rest.reduce((s, r) => s + r[1], 0))).padStart(6)}  その他 ${rest.length}コレクション`);
    v.lazyRows.forEach(([c, n, why]) => console.log(`      ${String(num(n)).padStart(6)}  ${c} … ${why}`));
  }
  if (!est.unreadable) {
    const ov = est.ov;
    console.log(`\n  司令塔③: 開いた時 ${num(ov.full)}件 ・ 自動更新1回 ${num(ov.light)}件`);
    console.log(`    (③の実コードから取り出した: 名前空間 ${ov.OV_NS.length}個 × ${ov.OV_FULL.length}コレクション / 軽い読み ${ov.lightName} = ${ov.OV_LIGHT.join(',')})`);
    console.log(`    自動更新 ${ASSUME.overview.autoMin}分 × ${ASSUME.overview.hoursVisible}時間 = ${ov.refreshes}回/日`);
    console.log(`    → 1タブで ${num(ov.full)} + ${num(ov.light)}×${ov.refreshes} = **${num(ov.perTabDay)}件/日**`);
    console.log('    ⚠③は端末の控えを持たない作り(getFirestore のまま)。getAll は毎回サーバから全件読む。');
  } else {
    console.log('\n  ❌ 司令塔③の実コードから COLLECTIONS / LIGHT_COLLECTIONS を取り出せませんでした。');
    console.log('     あちらの書き方が変わっています。**この見積りは当てにしないこと。**');
  }

  // --- ② 4アプリ合計 ------------------------------------------------------
  console.log('\n--------------------------------------------------------------------------');
  console.log(`② 4アプリ合計の1日見積り  ／  無料枠 ${num(FREE_READS_PER_DAY)}`);
  console.log('--------------------------------------------------------------------------');
  if (!est.unreadable) {
    for (const [what, n] of est.bill.slice().sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(num(n)).padStart(8)}  ${what}`);
    }
    console.log(`   ${'-'.repeat(62)}`);
    console.log(`   ${String(num(est.day)).padStart(8)}  ${est.lowerBound ? '**少なくとも**/日（合計ではない）' : '合計/日'}`);
    console.log(`   ${String(est.pct + '%').padStart(8)}  🚨**無料枠(${num(FREE_READS_PER_DAY)})に対する割合**${est.lowerBound ? '（これも下限）' : ''}`);
    if (est.lowerBound) {
      console.log('\n   ⚠ 数えていない読みが在るので、上の数字は **下限** です（実際はこれより多い）。');
      for (const u of est.uncounted) console.log(`     ・${u}`);
      console.log('     → 本当の数は Firebase コンソールの使用量か、③画面の「実測」で見る事。');
    }
    if (est.over) console.log(`\n   ❌ 無料枠を ${num(est.day - FREE_READS_PER_DAY)}回 超えている＝昼過ぎに使い切って以後は全部 429。`);
  }

  // --- ③ 見積りの土台がずれていないか -------------------------------------
  if (fresh.gone.length || fresh.extra.length) {
    console.log('\n--------------------------------------------------------------------------');
    console.log('③ 見積りの土台(STARTUP)と実コードのずれ  🚨ここがずれると数字が黙って嘘になる');
    console.log('--------------------------------------------------------------------------');
    for (const g of fresh.gone) {
      console.log(`   ❌ 見積りに在るが実コードに購読が無い: ${g.key} / ${g.col}（実測 ${num(g.docs)}件ぶん**多く**数えている）`);
      console.log(`      → 直った/遅延に移したなら、scripts/verify-read-budget.mjs の STARTUP.${g.key}.always から ${g.col} を外す`);
    }
    for (const e of fresh.extra) {
      console.log(`   ⚠ 起動時の見積りに入っていない購読: ${e.key} / ${e.col}（実測 ${num(e.docs)}件・${e.at}）`);
    }
    if (fresh.extra.length) {
      console.log(`   ⚠ 合計 ${num(fresh.extraDocs)}件ぶんが「その画面を開いた時の上振れ」。`);
      console.log('     起動時に張るようになったら、STARTUP.<app>.always に足す事（足さないと見積りが黙って足りなくなる）。');
    }
  }

  // --- ④ 🚨絞り込みの無い読み口を名指し ------------------------------------
  console.log('\n--------------------------------------------------------------------------');
  console.log(`④ 🚨 where も limit も無い読み口 ${verdict.risky.length}箇所（件数が青天井＝増えるほど毎日悪くなる）`);
  console.log('--------------------------------------------------------------------------');
  console.log(`   ${pad('件数(実測)', 12)} ${pad('アプリ', 20)} ${pad('コレクション', 24)} ${pad('種類', 16)} 場所`);
  const byWeight = verdict.risky.slice().sort((a, b) => (b.docs - a.docs) || a.col.localeCompare(b.col));
  const shown = byWeight.filter((s) => s.docs > 0 || s.docsUnknown);
  for (const s of shown) {
    const n = s.docsUnknown ? '?' : num(s.docs);
    console.log(`   ${pad(n, 12)} ${pad(s.appLabel, 20)} ${pad(s.col, 24)} ${pad(s.kind, 16)} ${s.file}:${s.line}`);
  }
  const zero = byWeight.filter((s) => !s.docsUnknown && s.docs === 0);
  console.log(`   ── いま実測0件だが、増えたらそのまま全件読む物 ${zero.length}箇所 ──`);
  for (const s of zero) console.log(`   ${pad('0', 12)} ${pad(s.appLabel, 20)} ${pad(s.col, 24)} ${pad(s.kind, 16)} ${s.file}:${s.line}`);

  // 🚨 静的には確かめられない口（絞り込みが変数の中に居る）
  if (verdict.unverifiable.length) {
    console.log('');
    console.log(`   ⚠ 絞り込みが **変数で渡されている** 読み口 ${verdict.unverifiable.length}箇所`);
    console.log('     ここは中身が静的に読めないので ❌ にも ✅ にもしません。**現物を人が見て確かめる事。**');
    console.log('     （「無い」と言い切ると嘘の❌になり、見張りが信用されなくなります）');
    for (const s of verdict.unverifiable.sort((a, b) => b.docs - a.docs)) {
      console.log(`     ${pad(s.docsUnknown ? '?' : num(s.docs), 8)} ${pad(s.appLabel, 20)} ${pad(s.col, 22)} ${pad(s.kind, 14)} 絞り込み=${s.optsVar}  ${s.file}:${s.line}`);
    }
  }

  // 読めていない事に気づけるか(件数は減らないが、事故の元)
  const noOnError = sites.filter((s) => !s.hasOnError);
  console.log(`\n   ⚠ おまけ: onError が無い読み口 ${noOnError.length}箇所（429で死んでも誰も気づかない）`);
  console.log('     ※ここは件数を1件も減らさないが、**これが無いと「読めていないのに動く」が続く**。');

  // --- ⑤ 例外の検分 --------------------------------------------------------
  if (verdict.excused.length || verdict.problems.length) {
    console.log('\n--------------------------------------------------------------------------');
    console.log('⑤ 例外（絞り込みを付けない事を、理由つきで認めてもらった物）');
    console.log('--------------------------------------------------------------------------');
    for (const x of verdict.excused) {
      console.log(`   ✅ ${pad(x.site.appLabel, 18)} ${pad(x.site.col, 22)} 上限 ${x.entry.maxDocs}件 / 実測 ${x.site.docs}件 / ${x.entry.who}`);
      console.log(`      理由: ${x.entry.why}`);
      if (x.warnUnknown) console.log('      ⚠この口は棚(名前空間)が実行時に決まるので、実測で照合できない。上限は**約束**であって実測ではない。');
    }
    for (const p of verdict.problems) {
      console.log(`   ❌ ${pad(p.appKey, 18)} ${pad(p.entry.col || '(col無し)', 22)} ${p.entry.file || ''}`);
      for (const m of p.msgs) console.log(`      → ${m}`);
      console.log(`      直す所: ${p.path}`);
    }
  }

  // --- 🚦 判定 -------------------------------------------------------------
  console.log('\n==========================================================================');
  const reasons = [];
  // 🚨壊れた例外ファイルを黙って無視しない（無視すると「例外が全部消えた」に気づけない）
  for (const [k, a] of Object.entries(allows)) {
    if (a.broken) reasons.push(`例外の紙が読めない(${k}): ${a.path} … ${a.broken}`);
  }
  if (verdict.violations.length) reasons.push(`絞り込みの無い読み口が ${verdict.violations.length}箇所 残っている`);
  if (verdict.problems.length) reasons.push(`成り立っていない例外が ${verdict.problems.length}件 ある`);
  if (fresh.gone.length) reasons.push(`見積りの土台が実コードとずれている(${fresh.gone.length}件)`);
  // 🚨「?embed=map で読まない」は **見積りを小さくする** 側の申告。裏が取れない申告は通さない。
  for (const b of embedBad) reasons.push(`?embed=map で読まない、と書いてあるのに実コードに証拠が無い: ${b.key} / ${b.col} … ${b.why}`);
  if (est.unreadable) reasons.push('司令塔③の実コードを読めず、見積りが出せない');
  if (!est.unreadable && est.over) reasons.push(`1日の見積り ${num(est.day)}件 が無料枠 ${num(FREE_READS_PER_DAY)} を超えている(${est.pct}%)`);

  if (listOnly) {
    console.log('（--list なので判定は出しません。上の一覧と見積りだけです）');
    console.log('==========================================================================');
    return 0;
  }
  if (!reasons.length) {
    console.log('🚦 ✅ 合格。絞り込みの無い読み口は無く、見積りも無料枠の中です。');
    console.log('==========================================================================');
    return 0;
  }
  console.log('🚦 ❌ 不合格。出荷しないでください。');
  reasons.forEach((r, i) => console.log(`   ${i + 1}. ${r}`));
  console.log('');
  console.log('   直し方は2つだけです。');
  console.log('   (A) 読みに絞り込みを付ける（where / limit）。');
  console.log('       🚨ただし **過去のロットを使う画面（分析・達成率・日次実績・成績表・完了履歴）が');
  console.log('          空になったり数字が減ったりしてはいけません。**');
  console.log('          「普段は最近の分だけ購読し、過去が要る画面を開いた時だけ読む」形にする事。');
  console.log('          直す前と直した後で **画面の数字を突き合わせて、1つも変わらない事を示す** 事。');
  console.log('   (B) どうしても絞れないなら、理由を書いて例外にする。');
  for (const app of APPS) {
    const a = allows[app.key];
    if (a) console.log(`       ${pad(app.label, 20)} ${a.path}`);
  }
  console.log('       1件につき { app, file, col, who, why(20文字以上), maxDocs, until(任意) }。');
  console.log('       🚨maxDocs は「この件数までなら許す」という約束。実測が追い越したら例外は自動で切れます。');
  console.log('==========================================================================');
  return 1;
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(main());
