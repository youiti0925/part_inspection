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
//
// 🚨🚨 2026-09-01 の直し（**この見張りは、いま直している中身を1バイトも見ていなかった**）:
//   ここには 4アプリぶんの `C:/Users/anrw3/…` という **決め打ちの道** が書いてあった。その為に
//     ・作業用の写しに「絞り込みの無い読み口」を足しても **合格**（写しを見ていない）
//     ・最終/製品/部品の src を丸ごと読めなくしても **合格**（決め打ちの本物を見ていた）
//     ・GitHub の CI は Linux なので、この道は **中身と関わりなく必ず赤**
//   → **走らせた場所（このファイルが入っているリポジトリ）の src を必ず見る** 形にした。
//   → 他の3アプリは「近所を探して、在れば見る」。**無ければ赤ではなく「見ていない」と出す**。
//      🚨 黙って合格にはしない。「4アプリ中 ◯アプリしか見ていません」を必ず画面に出す。
//   → 自分の src が読めない時は **赤**（見張りが何も食っていない、が一番危ない）。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FREE_READS_PER_DAY = 50_000;

// 走らせた場所 = このファイルの1つ上（scripts/ の親）。Windows でも Linux でも同じに出る。
export const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 4アプリの覚え書き。**道は書かない**（道は走らせた場所から探す）。
//   pkg    … package.json の name（走らせた場所がどのアプリかを決める手がかり）
//   where  … 近所を探す時の相対の置き場所（golden だけ深い所に居る）
//   marker … そのフォルダが本当にそのアプリである事の目印。これが無い所は見に行かない。
// ---------------------------------------------------------------------------
export const APP_DEFS = [
  { key: 'final',   label: '最終検査(golden)', ns: 'final-inspection-v1',   pkg: 'golden-meteoroid',
    where: ['golden-meteoroid', '.gemini/antigravity/playground/golden-meteoroid'], marker: 'src/App.firebase.jsx' },
  { key: 'product', label: '製品検査',          ns: 'product-inspection-v1', pkg: 'product-inspection-app',
    where: ['product-inspection-app'], marker: 'src/App.jsx' },
  { key: 'parts',   label: '部品検査',          ns: 'parts-inspection-v1',   pkg: 'parts-inspection-app',
    where: ['parts-inspection-app'], marker: 'src/App.jsx' },
  { key: 'overview',label: '司令塔③',           ns: 'overview-app-v1',       pkg: 'factory-overview-app',
    where: ['factory-overview-app'], marker: 'src/App.jsx' },
];

export const envKeyOf = (key) => `READ_BUDGET_DIR_${key.toUpperCase()}`;

/** 走らせた場所がどのアプリか。package.json の name → フォルダ名 の順で決める。 */
export const detectSelfKey = (root = SELF_ROOT, defs = APP_DEFS, readText = null) => {
  const read = readText || ((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });
  const txt = read(path.join(root, 'package.json'));
  let name = '';
  if (txt) { try { name = String(JSON.parse(txt).name || ''); } catch { name = ''; } }
  const byPkg = defs.find((d) => d.pkg === name);
  if (byPkg) return byPkg.key;
  const base = path.basename(root);
  const byDir = defs.find((d) => d.where.some((w) => w.split('/').pop() === base));
  return byDir ? byDir.key : null;
};

/** 近所を探す時に見る親フォルダ（上へ6段 ＋ ホーム）。Windows/Linux 共通。 */
export const searchBases = (root = SELF_ROOT, home = null) => {
  const out = [];
  let cur = path.resolve(root);
  for (let i = 0; i < 6; i++) {
    const up = path.dirname(cur);
    if (!up || up === cur) break;
    out.push(up); cur = up;
  }
  const h = home === null ? (() => { try { return os.homedir(); } catch { return ''; } })() : home;
  if (h && !out.includes(path.resolve(h))) out.push(path.resolve(h));
  return out;
};

/**
 * 4アプリの src の道を決める。
 *   ・自分（走らせた場所）… 必ず見る。無ければ **赤**（missing かつ self）
 *   ・他の3つ … 環境変数 → 近所 の順に探す。見つからなければ **見ていない**（赤にしない）
 * ⚠ファイルを触る所は差し替えられる（exists/readText）ので、この関数はそのまま試験できる。
 */
export const resolveApps = ({ selfRoot = SELF_ROOT, defs = APP_DEFS, env = process.env,
                              exists = fs.existsSync, readText = null, home = null } = {}) => {
  const selfKey = detectSelfKey(selfRoot, defs, readText);
  const join = (root, rel) => path.join(root, ...String(rel).split('/'));
  return defs.map((d) => {
    if (d.key === selfKey) {
      return { ...d, self: true, root: selfRoot, dir: path.join(selfRoot, 'src'), how: '走らせた場所（このリポジトリ）' };
    }
    const ev = String(env[envKeyOf(d.key)] || '').trim();
    if (ev) {
      return exists(join(ev, d.marker))
        ? { ...d, self: false, root: ev, dir: path.join(ev, 'src'), how: `環境変数 ${envKeyOf(d.key)}` }
        : { ...d, self: false, root: null, dir: null,
            notSeen: `環境変数 ${envKeyOf(d.key)} の指す ${ev} に ${d.marker} が無い` };
    }
    for (const base of searchBases(selfRoot, home)) {
      for (const rel of d.where) {
        const cand = path.join(base, ...rel.split('/'));
        if (exists(join(cand, d.marker))) {
          return { ...d, self: false, root: cand, dir: path.join(cand, 'src'), how: '近所を探して見つけた' };
        }
      }
    }
    return { ...d, self: false, root: null, dir: null,
      notSeen: `この端末に見つからない（${envKeyOf(d.key)} に置き場所を渡せば見ます）` };
  });
};

// ⚠他のスクリプト(report-read-budget.mjs など)がそのまま import している。形は変えない。
export const APPS = resolveApps();
export const SELF_KEY = detectSelfKey();

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

/**
 * そのファイルの中の `const LOTS_LIVE_LIMIT = 120` を集める(limit の数を解く為)。
 * ⚠ 実コードの limit は **ほとんどが名前付きの定数**(LOTS_LIVE_LIMIT / OPEN_LOTS_LIMIT …)で、
 *   しかも **別のファイル**(src/domain/readBudget.js)に居る。ここを解かないと、
 *   本物の絞り込みが全部「数が読めない」に落ちて、見張りが何も言えなくなる。
 */
export const constNumbers = (src) => {
  const m = {};
  for (const x of src.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*[;,\n]/g)) {
    m[x[1]] = Number(x[2]);
  }
  return m;
};

// ---------------------------------------------------------------------------
// 🚨🚨 2026-09-01 追加: 「絞ってある形か」ではなく「**絞りが効いているか**」を見る
// ---------------------------------------------------------------------------
//   この日の わざと壊す試験で、次の2つが **どちらも緑** で通った(実測):
//     M1  watchQuery(ns,'lots',{ where: [['id','!=','']] })   … 形は where。**必ず全件返る**
//     M2  getPage(ns,'lots',{ limit: 100000 })                … 棚ぜんぶより大きい limit
//   どちらも「読み口が1つ増えた」と数えた上で **絞り込み有り** として素通りしていた。
//   ＝ 見張りは `where:` `limit:` という **字面** しか見ていなかった。
//
//   ⚠ Firestore の `!=` は **その欄が無い書類を外す**。`['id','!=','']` は「全件返る」だけでなく
//     「欄の無い書類だけ黙って消える」という、意味の面でも危ない形。
// ---------------------------------------------------------------------------

/**
 * 1つの読み口が1回で読んでよい上限（件）。**これは実測ではなく、置いた線**。
 * 根拠(2026-08-30 の控えの実測): いちばん大きい棚は lot_images 2,355件、次が lots 633件。
 *   1つの画面が一度に使う件数は多くても数百。**1,000件を超える limit は「上限」として意味を成さない**。
 * ⚠ 棚が実測0件の物にだけ使う(まだ空なので「棚より小さいか」を測れない)。
 *   棚に中身が在る時は、線ではなく **実測の件数** と比べる。
 */
export const LIMIT_CEILING = 1000;

/** `{ where: [...], limit: 500 }` の中から、key の値の**字面**を括弧の対応を見て取り出す。 */
export const valueOfKey = (text, key) => {
  const re = new RegExp(`\\b${key}\\s*:`, 'g');
  let m;
  while ((m = re.exec(String(text)))) {
    const s = String(text);
    let i = m.index + m[0].length;
    while (i < s.length && /\s/.test(s[i])) i++;
    let depth = 0, q = null, out = '';
    for (; i < s.length; i++) {
      const c = s[i];
      if (q) { out += c; if (c === '\\') { out += s[++i] || ''; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
      if ('([{'.includes(c)) { depth++; out += c; continue; }
      if (')]}'.includes(c)) { if (depth === 0) break; depth--; out += c; continue; }
      if (c === ',' && depth === 0) break;
      out += c;
    }
    const v = out.trim();
    if (v) return v;
  }
  return '';
};

/** 字面が「その場で読み切れる値」なら中身を返す。変数や式なら lit:false。 */
export const literalOf = (raw) => {
  const t = String(raw == null ? '' : raw).trim();
  let mm;
  if ((mm = t.match(/^'([^']*)'$/)) || (mm = t.match(/^"([^"]*)"$/))) return { lit: true, v: mm[1] };
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return { lit: true, v: Number(t) };
  if (t === 'true' || t === 'false') return { lit: true, v: t === 'true' };
  if (t === 'null') return { lit: true, v: null };
  if (t === 'undefined') return { lit: true, v: undefined };
  if (t === 'Infinity') return { lit: true, v: Infinity };
  if (t === '-Infinity') return { lit: true, v: -Infinity };
  if (t === 'Number.MAX_SAFE_INTEGER') return { lit: true, v: Number.MAX_SAFE_INTEGER };
  if (t === 'Number.MIN_SAFE_INTEGER') return { lit: true, v: Number.MIN_SAFE_INTEGER };
  return { lit: false, v: undefined };
};

/**
 * `[['status','!=','completed'], ['a','==',1]]` を条件の一覧にほどく。
 * ほどけない形(変数・入れ子の式)は **null**(＝「静的には読めない」)。空配列は「条件が0個」。
 */
export const parseWhereClauses = (raw) => {
  const t = String(raw || '').trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const items = splitArgs(t);
  const out = [];
  for (const it of items) {
    const s = it.trim();
    if (!s.startsWith('[') || !s.endsWith(']')) return null;
    const p = splitArgs(s);
    if (p.length !== 3) return null;
    const f = literalOf(p[0]); const op = literalOf(p[1]); const v = literalOf(p[2]);
    if (!f.lit || !op.lit || typeof op.v !== 'string') return null;
    out.push({ field: String(f.v), op: op.v, value: v.v, valueLiteral: v.lit, valueRaw: p[2].trim() });
  }
  return out;
};

/**
 * その条件が **必ず真**(＝1件も外さない)なら、その理由の文。そうでなければ null。
 * 🚨 値が変数の時は null(＝「常に真とは言えない」)。決めつけて嘘の❌を出さない。
 */
export const alwaysTrueWhy = (c) => {
  if (!c || !c.valueLiteral) return null;
  const { op, value: v, field, valueRaw } = c;
  const isNum = typeof v === 'number';
  const empty = v === '' || v === null || v === undefined;
  if ((op === '!=' || op === 'not-in') && empty) {
    return `${field} ${op} ${valueRaw} … 空/null と違う書類しか無いので、必ず全件返る`;
  }
  if (op === '>=' && (v === 0 || v === '' || v === null || v === -Infinity || (isNum && v <= Number.MIN_SAFE_INTEGER))) {
    return `${field} >= ${valueRaw} … どの値もこれ以上なので、必ず全件返る`;
  }
  if (op === '>' && ((isNum && v <= -1) || v === -Infinity)) {
    return `${field} > ${valueRaw} … どの値もこれより大きいので、必ず全件返る`;
  }
  if (op === '<=' && (v === Infinity || (isNum && v >= Number.MAX_SAFE_INTEGER)
      || (typeof v === 'string' && /^9999/.test(v)) || v === '')) {
    return `${field} <= ${valueRaw} … どの値もこれ以下なので、必ず全件返る`;
  }
  if (op === '<' && (v === Infinity || (isNum && v >= Number.MAX_SAFE_INTEGER))) {
    return `${field} < ${valueRaw} … どの値もこれより小さいので、必ず全件返る`;
  }
  return null;
};

/** `limit: 500` / `limit: LOTS_LIVE_LIMIT` の数を解く。解けなければ null。 */
export const limitNumberOf = (raw, nums = {}) => {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (Object.prototype.hasOwnProperty.call(nums, t) && Number.isFinite(nums[t])) return nums[t];
  return null;
};

/**
 * 🚦 その読み口の絞り込みが **効いているか**。画面もファイルも触らない純粋な関数。
 * 返す物: { where, limit, effective, unknown, why, notes }
 *   where/limit … 'none'(書いていない) / 'effective'(効いている) / 'dead'(書いてあるが効かない)
 *                 / 'unknown'(静的に読めない) / 'unknownShelf'(棚の件数が分からない＝赤)
 */
export const filterEffect = (s, { ceiling = LIMIT_CEILING } = {}) => {
  const notes = [];
  let w = 'none'; let wWhy = '';
  if (s.hasWhere) {
    const cl = s.whereClauses === undefined ? null : s.whereClauses;
    if (cl == null) { w = 'unknown'; wWhy = `where の中身が静的に読めない（where: ${s.whereRaw || '?'}）`; }
    else if (!cl.length) { w = 'dead'; wWhy = 'where が空（条件が1つも入っていない＝全件返る）'; }
    else {
      const whys = cl.map(alwaysTrueWhy);
      if (whys.every((x) => x)) { w = 'dead'; wWhy = `🚨 where が常に真: ${whys.join(' / ')}`; }
      else w = 'effective';
    }
  }
  let l = 'none'; let lWhy = '';
  if (s.hasLimit) {
    const n = s.limitNum == null ? null : Number(s.limitNum);
    if (n == null || !Number.isFinite(n)) { l = 'unknown'; lWhy = `limit の数が静的に読めない（limit: ${s.limitRaw || '?'}）`; }
    else if (n <= 0) { l = 'dead'; lWhy = `limit ${n} … 1件以上を読む問い合わせになっていない`; }
    else if (s.docsUnknown) {
      l = 'unknownShelf';
      lWhy = `🚨 limit ${n} と書いてあるが、この棚の実測件数が分からない`
        + '（＝絞りが効いているか **確かめられません**。黙っては通しません）';
    } else if (Number(s.docs) > 0 && n >= Number(s.docs)) {
      l = 'dead'; lWhy = `🚨 limit ${n} ≧ 棚の実測 ${s.docs}件 … 1件も絞っていない`;
    } else if (Number(s.docs) === 0 && n > ceiling) {
      l = 'dead';
      lWhy = `🚨 limit ${n} … 棚は実測0件。${ceiling}件を超える limit は上限として意味を成さない`;
    } else {
      l = 'effective';
      if (Number(s.docs) === 0) notes.push(`いま棚は実測0件。limit ${n} は「増えた時の上限」としてだけ効く`);
    }
  }
  const effective = w === 'effective' || l === 'effective';
  const unknown = !effective && (w === 'unknown' || l === 'unknown');
  const why = [wWhy, lWhy].filter(Boolean).join(' / ')
    || (s.hasWhere || s.hasLimit ? '' : 'where も limit も無い');
  return { where: w, limit: l, effective, unknown, why, notes };
};

export const scanFile = (rawSrc, file, globalConsts = {}, globalNums = {}) => {
  const src = stripComments(rawSrc);
  const lines = src.split('\n');
  const consts = { ...globalConsts, ...constStrings(src) };
  // ⚠ limit の数は **別のファイルの定数**の事が多い(LOTS_LIVE_LIMIT など)。両方を混ぜて解く。
  const nums = { ...globalNums, ...constNumbers(src) };
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
    // 🚨🚨 2026-09-01: ここは `[:=]` だった。つまり **`const u = watchCollection(ns,'logs',cb)` を
    //   まるごと数えていなかった**（受け取り手の名前を付けただけの、ごく普通の読み口）。
    //   わざと絞り込みの無い口をこの形で足しても、門は緑のままだった（実測）。
    //   → 数えないのは **object の書き方(`watchCollection: …`)だけ** にする。
    //   ⚠ 4アプリの実コードにこの形は今のところ0箇所（＝この直しで判定は1つも動かない。
    //     動かないうちに塞ぐのが狙い。明日この形で書かれたら、今度は捕まえる）。
    if (/:\s*$/.test(before)) continue;
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
    // 🚨 ここから下が 2026-09-01 の追加。**字面ではなく中身**を取り出して持ち回る。
    const whereRaw = hasWhere ? valueOfKey(args, 'where') : '';
    const limitRaw = hasLimit ? valueOfKey(args, 'limit') : '';
    const whereClauses = hasWhere ? parseWhereClauses(whereRaw) : null;
    const limitNum = hasLimit ? limitNumberOf(limitRaw, nums) : null;
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
      whereRaw,                      // where の値の字面(そのまま)
      limitRaw,                      // limit の値の字面(そのまま)
      whereClauses,                  // ほどけた条件の一覧。null = 静的には読めない
      limitNum,                      // limit の数。null = 静的には読めない
      optsVar,                       // '' なら「引数を全部読めた」。文字が入っていれば「読めない」
      hasOrderBy: /\borderBy\s*:/.test(args),
      hasOnError: /\bonError\b/.test(args),
      code: (lines[line - 1] || '').trim().slice(0, 120),
    });
  }
  return out;
};

export const scanApp = (app) => {
  // 道が見つからなかった = **見ていない**（赤にはしない。ただし画面に必ず出す）
  if (!app.dir) return { ...app, sites: [], missing: true, files: 0 };
  // 🚨自分のリポジトリなのに src が無い/読めない = **赤**（判定は main 側。ここは印だけ付ける）
  if (!fs.existsSync(app.dir)) {
    return { ...app, sites: [], missing: true, files: 0,
      notSeen: app.notSeen || `${app.dir} が無い（フォルダごと読めない）` };
  }
  const files = walk(app.dir);
  if (!files.length) {
    return { ...app, sites: [], missing: true, files: 0,
      notSeen: `${app.dir} に .js/.jsx が1つも無い（読む物が無い）` };
  }
  // ⚠コレクション名の定数は **別のファイル** に居る(`src/domain/appFeedback.js` の FEEDBACK_COL など)。
  //   1ファイルだけ見ると「(変数)」になって、その口が何件読むのか分からなくなる。
  const globalConsts = {};
  const globalNums = {};
  for (const f of files) {
    const s = stripComments(readSrc(f));
    Object.assign(globalConsts, constStrings(s));
    Object.assign(globalNums, constNumbers(s));
  }
  const sites = [];
  for (const f of files) {
    // 窓口そのもの(src/data/*)は「口の定義」なので数えない。実際に呼ぶ画面だけを数える。
    if (/[\\/]src[\\/]data[\\/]/.test(f)) continue;
    const rel = path.relative(path.dirname(app.dir), f).split(path.sep).join('/');
    sites.push(...scanFile(readSrc(f), `src/${rel.replace(/^src\//, '')}`, globalConsts, globalNums));
  }
  return { ...app, sites, files: files.length };
};

// ---------------------------------------------------------------------------
// 実測の件数(バックアップの manifest)
// ---------------------------------------------------------------------------
// 🚨🚨 2026-09-01: ここも `C:/Users/anrw3/…/2026-08-11_0530/manifest.json` の決め打ちだった。
//   道が決め打ち = ①CI(Linux)では永久に見つからない ②**日付まで焼き込んであった**ので、
//   3週間前の件数をずっと見ていた（新しい控えを取っても見張りの数字は増えない）。
//   → 探し方だけを書く: 環境変数 → 近所の inspection-audit-local/backups の **いちばん新しい控え**。
//   ⚠見つからない時は「件数の実測が無い」と画面に出して 0件として数える（推測で埋めない）。
export const MANIFEST_ENV = 'READ_BUDGET_MANIFEST';

export const findManifest = ({ selfRoot = SELF_ROOT, env = process.env,
                               exists = fs.existsSync, listDirs = null, home = null } = {}) => {
  const ev = String(env[MANIFEST_ENV] || '').trim();
  if (ev) return exists(ev) ? ev : null;
  const ls = listDirs || ((p) => { try { return fs.readdirSync(p); } catch { return []; } });
  for (const base of searchBases(selfRoot, home)) {
    const backups = path.join(base, 'inspection-audit-local', 'backups');
    const dirs = ls(backups)
      .filter((d) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(d))
      .filter((d) => exists(path.join(backups, d, 'manifest.json')))
      .sort();
    if (dirs.length) return path.join(backups, dirs[dirs.length - 1], 'manifest.json');
  }
  return null;
};

export const DEFAULT_MANIFEST = findManifest();

export const loadCounts = (manifestPath = DEFAULT_MANIFEST) => {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null;
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

// ⚠ 道が見つからなかったアプリ(dir=null)は例外の紙も読めない。null を返す。
export const allowPathOf = (app) => {
  const root = app.root || (app.dir ? path.dirname(app.dir) : null);
  return root ? path.join(root, 'scripts', 'read-budget-allow.json') : null;
};

export const loadAllow = (app) => {
  const p = allowPathOf(app);
  if (!p) return { path: null, entries: [], missing: true };
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
  // 🚨🚨 2026-09-01: ここは `!hasWhere && !hasLimit` だった＝「絞ってある**形**か」しか見ていなかった。
  //   `where: [['id','!=','']]`(必ず全件返る) と `limit: 100000`(棚ぜんぶより大きい) が
  //   どちらも「絞り込み有り」として素通りしていた(実測)。
  //   → filterEffect で **効いているか** を見る。
  const collectionReads = sites.filter((s) => !s.singleDoc)
    .map((s) => ({ ...s, eff: filterEffect(s) }));
  // 静的に読めない物は ❌ にも ✅ にもしない(嘘の❌を出さない)。ただし必ず画面に出す。
  const unverifiable = collectionReads.filter((s) => !s.eff.effective && (s.optsVar || s.eff.unknown));
  const risky = collectionReads.filter((s) => !s.eff.effective && !s.optsVar && !s.eff.unknown);
  const violations = [];
  const excused = [];
  const problems = [];
  const usedEntries = new Set();

  for (const s of risky) {
    const bag = allows[s.appKey] || { entries: [] };
    const idx = bag.entries.findIndex((e) => sameSite(e, s));
    if (idx < 0) {
      violations.push({ site: s, why: `例外の届け出が無い（${s.eff ? s.eff.why : ''}）` });
      continue;
    }
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
export const estimateOverview = (counts, srcOverride = null, apps = APPS) => {
  const ovApp = apps.find((a) => a.key === 'overview');
  // 🚨 ③の置き場所が **この端末に無い** 時は「読めない(赤)」ではなく「見ていない」。
  //   道が無いだけで赤にすると、CI(Linux)も他アプリの手元も、中身と関わりなく永久に赤になる。
  if (srcOverride === null && (!ovApp || !ovApp.dir)) {
    return { unreadable: false, notSeen: true,
      why: (ovApp && ovApp.notSeen) || '司令塔③の置き場所がこの端末に無い' };
  }
  // ⚠試験用に中身を直接渡された時は、道を1つも触らない。
  const ovSrcPath = srcOverride !== null ? null : path.join(ovApp.dir, 'App.jsx');
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

export const estimateDay = (counts, apps = APPS) => {
  const perOpen = estimatePerOpen(counts);
  const ov = estimateOverview(counts, null, apps);
  if (ov.unreadable) return { unreadable: true, perOpen };
  const A = ASSUME.overview;
  let day = 0; const bill = [];
  const notCounted = [];
  // 🚨件数の実測(控え)が無い時は、全部0件で数えている＝この合計は **合計ではない**。
  if (!counts) notCounted.push('件数の実測(控え)がこの端末に無いので、全コレクションを0件として数えている（＝実際はもっと多い）');
  for (const [key, a] of Object.entries(ASSUME.openPerDay)) {
    const app = apps.find((x) => x.key === key);
    const n = (perOpen[key]?.total || 0) * a.people * a.opens;
    day += n;
    bill.push([`${app.label} ${a.people}人 × ${a.opens}回 × ${(perOpen[key]?.total || 0).toLocaleString('en-US')}件`, n, a.why]);
  }
  // 🚨③のコードを見ていない時は、③自身の読みを **数えない**（作り物の数字を足さない）。
  const ovDay = ov.notSeen ? 0 : ov.perTabDay * A.tabs;
  day += ovDay;
  if (ov.notSeen) {
    notCounted.push(`司令塔③のコードをこの端末で見ていないので、③自身の読み(1日ぶん)は0として数えている … ${ov.why}`);
  } else {
    bill.push([`司令塔③ ${A.tabs}タブ × ${ov.perTabDay.toLocaleString('en-US')}件/日`, ovDay, A.why]);
  }
  // 🚨 ③の iframe(?embed=map)。**止めている購読の分は引く**(EMBED_STOPS。実コードで裏を取ってある)。
  //   引ける根拠が消えたら checkEmbedFresh() が赤にするので、黙って小さい数字にはならない。
  const embedCut = [];
  const ifrPerOpen = ASSUME.overviewIframes.apps.reduce((s, k) => {
    const app = apps.find((x) => x.key === k);
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
  const uncounted = [...(ov.uncounted || []), ...notCounted];
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
  const notChecked = []; // 🚨そのアプリのコードを見ていない → 突き合わせを **していない**（黙って通さない為に出す）
  for (const [key, plan] of Object.entries(STARTUP)) {
    const app = apps.find((a) => a.key === key);
    if (!app || app.missing) { notChecked.push(key); continue; }
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
  return { gone, extra, notChecked, extraDocs: extra.reduce((s, x) => s + x.docs, 0) };
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

  // --- (A0) 🚨🚨 どこを見るか（2026-09-01。ここが決め打ちだったので何も見ていなかった）----
  //   ⚠ファイルには触らない。exists / readText を差し替えて、道の決め方だけを試す。
  {
    const sep = path.sep;
    const P = (...xs) => xs.join(sep);
    const HOME = P('C:', 'Users', 'taro');
    const GOLD = P(HOME, '.gemini', 'antigravity', 'playground', 'golden-meteoroid');
    const PROD = P(HOME, 'product-inspection-app');
    const PARTS = P(HOME, 'parts-inspection-app');
    const OVER = P(HOME, 'factory-overview-app');
    const world = new Set([
      P(GOLD, 'src', 'App.firebase.jsx'), P(PROD, 'src', 'App.jsx'),
      P(PARTS, 'src', 'App.jsx'), P(OVER, 'src', 'App.jsx'),
    ]);
    const exists = (p) => world.has(path.normalize(p));
    const pkgOf = (name) => (p) => (path.basename(p) === 'package.json'
      ? JSON.stringify({ name }) : null);

    const fromGold = resolveApps({ selfRoot: GOLD, exists, readText: pkgOf('golden-meteoroid'), home: HOME, env: {} });
    say(fromGold.find((a) => a.key === 'final').self === true
      && fromGold.find((a) => a.key === 'final').dir === path.join(GOLD, 'src'),
      '🚨 走らせた場所(golden)を「自分」として、そのリポジトリの src を見る');
    say(fromGold.every((a) => a.dir), '🚨 近所に他の3アプリが在れば、道を書かなくても見つける');

    const fromProd = resolveApps({ selfRoot: PROD, exists, readText: pkgOf('product-inspection-app'), home: HOME, env: {} });
    say(fromProd.find((a) => a.key === 'product').self === true
      && fromProd.find((a) => a.key === 'final').dir === path.join(GOLD, 'src'),
      '🚨 製品から走らせても、深い所に居る golden を見つける（どの場所からでも同じ）');

    // 🚨 負の対照①: 他アプリの道が無い時 → **赤ではなく「見ていない」**。合格の数が減る。
    const lonely = new Set([P(PROD, 'src', 'App.jsx')]);
    const alone = resolveApps({ selfRoot: PROD, exists: (p) => lonely.has(path.normalize(p)),
      readText: pkgOf('product-inspection-app'), home: HOME, env: {} });
    say(alone.filter((a) => a.dir).length === 1 && alone.find((a) => a.key === 'product').self,
      '🚨 他アプリが無い所(CI=Linux など)では「自分1つだけ見た」になる（4つとも赤にしない）');
    say(alone.filter((a) => !a.dir).every((a) => String(a.notSeen || '').length > 0),
      '🚨 見ていないアプリには「なぜ見ていないか」が必ず付く（黙って消さない）');

    // 🚨 負の対照②: 走らせた場所が4アプリのどれでもない → 自分が決まらない(main が赤にする)
    say(detectSelfKey(P(HOME, 'zzz-nanika'), APP_DEFS, () => null) === null,
      '🚨 4アプリのどれでもない所で走らせたら「自分」が決まらない（main はこれを赤にする）');
    say(detectSelfKey(GOLD, APP_DEFS, () => null) === 'final',
      'package.json が読めなくても、フォルダ名から「自分」を決められる');

    // 環境変数で他アプリの置き場所を渡せる／渡した先が違えば「見ていない」
    const byEnv = resolveApps({ selfRoot: PROD, exists, readText: pkgOf('product-inspection-app'), home: HOME,
      env: { [envKeyOf('final')]: GOLD } });
    say(byEnv.find((a) => a.key === 'final').how === `環境変数 ${envKeyOf('final')}`,
      `他アプリの置き場所は ${envKeyOf('final')} でも渡せる`);
    const byBadEnv = resolveApps({ selfRoot: PROD, exists, readText: pkgOf('product-inspection-app'), home: HOME,
      env: { [envKeyOf('final')]: P(HOME, 'karappo') } });
    say(!byBadEnv.find((a) => a.key === 'final').dir,
      '🚨 環境変数の指す先に目印(src/App.firebase.jsx)が無ければ、見に行かない');

    // 🚨 Windows と Linux の両方で動く形か（道を文字で組み立てていないか）
    say(!/[A-Za-z]:[\\/]/.test(SELF_ROOT.replace(/^[A-Za-z]:/, '')) && path.isAbsolute(SELF_ROOT),
      '走らせた場所は path で組み立てている（区切り文字を手で書いていない）');
    say(APP_DEFS.every((d) => !/^[A-Za-z]:/.test(d.where[0]) && !d.where.some((w) => w.includes('\\'))),
      '🚨 アプリの覚え書きに **絶対の道(C:/… )** を1つも書いていない（CI=Linux でも同じに動く）');

    // 控え(manifest)も決め打ちにしない: いちばん新しい物を選ぶ／無ければ null
    const mBase = P(HOME, 'inspection-audit-local', 'backups');
    const mWorld = new Set([P(mBase, '2026-08-11_0530', 'manifest.json'), P(mBase, '2026-08-30_1211', 'manifest.json')]);
    const found = findManifest({ selfRoot: PROD, env: {}, home: HOME,
      exists: (p) => mWorld.has(path.normalize(p)),
      listDirs: (p) => (path.normalize(p) === path.normalize(mBase) ? ['2026-08-11_0530', '2026-08-30_1211', 'zzz'] : []) });
    say(found === P(mBase, '2026-08-30_1211', 'manifest.json'),
      '🚨 件数の控えは **いちばん新しい物** を毎回さがす（日付を焼き込まない）');
    say(findManifest({ selfRoot: PROD, env: {}, home: HOME, exists: () => false, listDirs: () => [] }) === null,
      '控えがどこにも無ければ null（作り話の道を返さない）');
  }

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

  // --- (A1) 🚨受け取り手に名前を付けただけの読み口を数える(2026-09-01) --------
  //   わざと壊す試験の途中で見つかった穴。`const u = watchCollection(...)` を数えていなかった。
  const NAMED = `
const u1 = watchCollection(APP_DATA_ID, 'logs', (rows) => setLogs(rows));
let u2 = P.watchQuery(APP_DATA_ID, 'lots', { limit: 500 }, cb);
const provider = { watchCollection: call('watchCollection'), getAll: call('getAll') };
`;
  const nm = scanFile(NAMED, '(memory)');
  say(nm.some((x) => x.col === 'logs' && x.kind === 'watchCollection' && !x.hasWhere && !x.hasLimit),
    "🚨 `const u = watchCollection(ns,'logs',cb)` を読み口として数える(2026-09-01 まで見ていなかった)");
  say(nm.some((x) => x.col === 'lots' && x.hasLimit), '`let u = watchQuery(…, {limit})` も数える');
  say(nm.length === 2, '窓口の一覧(`watchCollection: call(…)`)は今まで通り数えない');
  // ⚠ 棚の件数を口ごとに分けてある: lots は 900件(limit 500 が本当に絞る側)、logs は 179件。
  //   ここを一律 179件にすると、limit 500 が「棚より大きい＝絞れていない」に当たってしまい、
  //   この試験が見たい物(**絞り込みの無い口が ❌ になるか**)がぼやける。
  const nmj = judge({ sites: nm.map((s) => ({ ...s, appKey: 'final', docs: s.col === 'lots' ? 900 : 179, docsUnknown: false })),
    allows: {}, today: '2026-08-18' });
  say(nmj.violations.length === 1,
    '🚨 名前を付けただけの「絞り込みの無い読み口」は、ちゃんと ❌ になる');

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

  // --- (A3) 🚨🚨 「絞りが **効いているか**」(2026-09-01 追加) -------------------
  //   この日の わざと壊す試験で、下の2つが **どちらも緑** で素通りした(実測):
  //     M1  watchQuery(ns,'lots',{ where: [['id','!=','']] })  … 形は where。必ず全件返る
  //     M2  getPage(ns,'lots',{ limit: 100000 })               … 棚ぜんぶより大きい limit
  //   ＝ 見張りは `where:` `limit:` という **字面** しか見ていなかった。
  {
    const one = (code, over = {}) => scanFile(code, '(memory)')
      .map((s) => ({ ...s, appKey: 'final', docs: 633, docsUnknown: false, ...over }));
    const vio = (code, over) => judge({ sites: one(code, over), allows: {}, today: '2026-08-18' });

    // M1 … 必ず全件返る where
    const M1 = `Q.watchQuery(APP_DATA_ID, 'lots', { where: [['id','!=','']] }, cb);`;
    say(one(M1)[0].hasWhere && one(M1)[0].whereClauses.length === 1,
      "where: [['id','!=','']] の中身をほどける");
    say(vio(M1).violations.length === 1 && /常に真/.test(vio(M1).violations[0].why),
      "🚨 M1: where: [['id','!=','']]（必ず全件返る）は ❌ になる");
    const M1b = `Q.watchQuery(APP_DATA_ID, 'lots', { where: [['createdAt','>=',0]] }, cb);`;
    say(vio(M1b).violations.length === 1, "🚨 常に真の where その2: createdAt >= 0 は ❌ になる");
    const M1c = `Q.watchQuery(APP_DATA_ID, 'lots', { where: [['createdAt','<=',Infinity]] }, cb);`;
    say(vio(M1c).violations.length === 1, "🚨 常に真の where その3: createdAt <= Infinity は ❌ になる");
    const M1d = `Q.watchQuery(APP_DATA_ID, 'lots', { where: [] }, cb);`;
    say(vio(M1d).violations.length === 1, '🚨 where が空配列（条件0個）も ❌ になる');

    // M2 … 棚ぜんぶより大きい limit
    const M2 = `const p = await DATA(db).getPage(APP_DATA_ID, 'lots', { limit: 100000 });`;
    say(one(M2)[0].limitNum === 100000, 'limit の数(100000)を字面から読み取る');
    say(vio(M2).violations.length === 1 && /1件も絞っていない/.test(vio(M2).violations[0].why),
      '🚨 M2: 棚 633件に limit 100000（棚ぜんぶより大きい）は ❌ になる');
    say(vio(M2, { docs: 0 }).violations.length === 1,
      `🚨 棚が実測0件でも、limit 100000 は ❌（線 ${LIMIT_CEILING}件 を超えている）`);

    // 🚨 棚の件数が分からない時は「分かりません」＝赤。黙っては通さない。
    say(vio(`Q.watchQuery(APP_DATA_ID, 'lots', { limit: 20 }, cb);`, { docsUnknown: true }).violations.length === 1,
      '🚨 棚の件数が分からない口の limit は「確かめられません」として ❌（黙って通さない）');

    // --- ⚠ 正しい絞り込みは **緑のまま** である事（ここが赤くなると狼少年になる） ---
    const green = (code, over) => vio(code, over).violations.length === 0;
    say(green(`Q.watchQuery(APP_DATA_ID, 'lots', { limit: 20 }, cb);`),
      '⚠ 棚 633件に limit 20 は 緑のまま');
    say(green(`const r = await DATA(db).getAll(APP_DATA_ID, 'lots', { where: [['lotId','in',ids]] });`),
      "⚠ lotId in [...] は 緑のまま");
    say(green(`Q.watchQuery(APP_DATA_ID, 'lots', { where: [['status','!=','completed']] }, cb);`),
      "⚠ status != 'completed'（本当に絞る != ）は 緑のまま"),
    say(green(`Q.watchQuery(APP_DATA_ID, 'lots', { where: [['createdAt','>=',since]] }, cb);`),
      '⚠ 期間(createdAt >= since。値が変数)は 緑のまま');
    say(green(`Q.watchQuery(APP_DATA_ID, 'lots', { where: [['createdAt','>=',0],['status','==','open']] }, cb);`),
      '⚠ 常に真の条件が混ざっていても、本当に絞る条件が1つ在れば 緑');
    say(green(`Q.watchQuery(APP_DATA_ID, 'skill_marks', { orderBy: [['at','desc']], limit: 500 }, cb);`, { docs: 0 }),
      `⚠ 棚が実測0件 + limit 500（線 ${LIMIT_CEILING}件 以下）は 緑（増えた時の上限として効く）`);

    // --- limit が名前付きの定数（実コードはほとんどこれ） ---
    const CONSTS = `
export const LOTS_LIVE_LIMIT = 120;
const unsub = P.watchCollection(APP_DATA_ID, 'lots', cb, { orderBy: [['createdAt','desc']], limit: LOTS_LIVE_LIMIT });
`;
    const cs = scanFile(CONSTS, '(memory)').map((s) => ({ ...s, appKey: 'final', docs: 633, docsUnknown: false }));
    say(cs[0].limitNum === 120, '🚨 limit: LOTS_LIVE_LIMIT のような **名前付きの定数** の数も解く');
    say(judge({ sites: cs, allows: {}, today: '2026-08-18' }).violations.length === 0,
      '⚠ 定数で書いた limit 120（棚 633件より小さい）は 緑のまま');

    // --- 数が読めない limit は ❌ にも ✅ にもしない（嘘の❌を出さない） ---
    const VARLIM = `const page = await OPS(db).getPage(APP_DATA_ID, 'lots', { orderBy: [['createdAt','desc']], limit: pageSize });`;
    const vl = judge({ sites: one(VARLIM), allows: {}, today: '2026-08-18' });
    say(vl.violations.length === 0 && vl.unverifiable.length === 1,
      '🚨 limit: pageSize（数が静的に読めない）は「確かめられません」に置く（嘘の❌にしない）');
    const VARWHERE = `P.watchQuery(APP_DATA_ID, 'lots', { where: ACTIVE_LOTS_SPEC.where }, cb);`;
    const vw = judge({ sites: one(VARWHERE), allows: {}, today: '2026-08-18' });
    say(vw.violations.length === 0 && vw.unverifiable.length === 1,
      '🚨 where の中身が変数の口も「確かめられません」に置く（緑と言い切らない）');

    // --- 部品の試験（純粋な関数を直に叩く） ---
    say(alwaysTrueWhy({ op: '!=', value: '', valueLiteral: true, field: 'id', valueRaw: "''" }) !== null,
      "部品: != '' は「常に真」と判る");
    say(alwaysTrueWhy({ op: '!=', value: 'completed', valueLiteral: true, field: 'status', valueRaw: "'completed'" }) === null,
      "部品: != 'completed' は「常に真」ではない");
    say(alwaysTrueWhy({ op: '>=', value: undefined, valueLiteral: false, field: 'createdAt', valueRaw: 'since' }) === null,
      '部品: 値が変数なら「常に真」と決めつけない');
    say(parseWhereClauses('SOME_SPEC.where') === null, '部品: ほどけない where は null（＝分からない）');
    say(valueOfKey("{ where: [['a','==',1]], limit: 20 }", 'limit') === '20',
      '部品: limit の字面を括弧の対応を見て取り出す');
  }

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

  // 🚨 2026-09-01: 「③がこの端末に無い」と「③が在るのに読めない」を混ぜない。
  //   無い＝見ていない(赤にしない)／在るのに読めない＝赤。混ぜると CI が中身と関わりなく赤になる。
  const oNotHere = estimateOverview(fakeCounts, null, [{ key: 'overview', dir: null, notSeen: 'この端末に無い' }]);
  say(oNotHere.notSeen === true && oNotHere.unreadable === false,
    '🚨 ③の置き場所がこの端末に無い時は「見ていない」（赤にしない・数字も作らない）');
  const dNotHere = estimateDay(fakeCounts, [{ key: 'overview', dir: null, notSeen: 'この端末に無い' },
    { key: 'final', label: '最終', ns: 'final-inspection-v1' }, { key: 'product', label: '製品', ns: 'product-inspection-v1' },
    { key: 'parts', label: '部品', ns: 'parts-inspection-v1' }]);
  say(dNotHere.lowerBound === true && dNotHere.uncounted.some((u) => /司令塔③/.test(u)),
    '🚨 ③を見ていない日の合計は「合計」ではなく **下限** として出す（何を数えていないかも名指し）');

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
  for (const app of apps) { if (!app.missing) allows[app.key] = loadAllow(app); }

  const est = estimateDay(counts, apps);
  const fresh = checkStartupFresh(apps, counts);
  const embedBad = checkEmbedFresh(apps);
  const verdict = judge({ sites, allows, today });

  // --- 🚨 どこを見たか（見ていない物を黙って合格にしない） -------------------
  const selfApp = apps.find((a) => a.self);
  const seenApps = apps.filter((a) => !a.missing);
  const unseenApps = apps.filter((a) => a.missing);
  const coverage = `${apps.length}アプリ中 ${seenApps.length}アプリ`;
  const coverageLine = unseenApps.length
    ? `**${coverage}しか見ていません**（見ていないアプリの読み口は1つも数えていません）`
    : `**${coverage}** を見ました（4つとも読みました）`;

  if (wantJson) {
    console.log(JSON.stringify({
      today, manifest: counts?.path || null, manifestStamp: counts?.stamp || null,
      perOpen: Object.fromEntries(Object.entries(est.perOpen || {}).map(([k, v]) => [k, v.total])),
      overviewPerTabDay: est.ov?.perTabDay ?? null,
      day: est.day ?? null, dayIsLowerBound: !!est.lowerBound, uncounted: est.uncounted || [],
      overviewLightName: est.ov?.lightName ?? null,
      freeQuota: FREE_READS_PER_DAY, pct: est.pct ?? null,
      unfiltered: verdict.risky.length, violations: verdict.violations.length,
      // 🚨 where/limit は書いてあるのに 1件も絞れていない口(2026-09-01 追加)
      deadFilters: verdict.risky.filter((s) => s.hasWhere || s.hasLimit).length,
      limitCeiling: LIMIT_CEILING,
      unverifiable: verdict.unverifiable.length,
      excused: verdict.excused.length, allowProblems: verdict.problems.length,
      startupStale: fresh.gone.length, startupMissingFromEstimate: fresh.extra.length,
      // 🚨「どこを見たか」も数字で出す。見ていない物を黙って合格にしない為。
      selfKey: selfApp ? selfApp.key : null, selfRoot: SELF_ROOT,
      appsTotal: apps.length, appsSeen: seenApps.length,
      appsNotSeen: unseenApps.map((a) => a.key),
      filesRead: seenApps.reduce((s, a) => s + (a.files || 0), 0),
    }, null, 2));
  }

  console.log('==========================================================================');
  console.log('🚦 読み取り量の見張り（出荷ゲート）');
  console.log(`   無料枠 ${num(FREE_READS_PER_DAY)}回/日 ・ 🚨**製品/最終/部品/司令塔③ の4アプリで1枠を共有**`);
  console.log(`   (projectId=inspection-time-c4fd3 が1個。どれか1つが使い切れば4つ全部が止まる)`);
  console.log(counts
    ? `   件数の出どころ: ${counts.path}\n                   = 実測 ${counts.stamp}（合計 ${num(counts.totals?.docs || 0)}件）`
    : `   ⚠件数の実測(控え)が見つからない。件数は全部0として扱う（推測で埋めない）。`
      + `\n     置き場所を渡すなら ${MANIFEST_ENV}=<manifest.json> か --manifest <manifest.json>`);
  console.log('==========================================================================\n');

  // --- 🚨 このゲートが「どこを見たか」。合格でも不合格でも必ず先に出す --------
  console.log('■ 🚨 このゲートが見た範囲');
  console.log(`   走らせた場所: ${SELF_ROOT}`);
  console.log(`   → ${selfApp ? `${selfApp.label} として読みました` : '🚨 4アプリのどれか分かりません'}`);
  console.log(`   ${coverageLine}`);
  for (const a of apps) {
    const mark = a.missing ? '🚫 見ていない' : '👀 見た';
    const what = a.missing ? (a.notSeen || '道が見つからない')
      : `${a.dir}（${a.how}${a.self ? '・自分' : ''} / ${num(a.files || 0)}ファイル / 読み口 ${num(a.sites.length)}箇所）`;
    console.log(`   ${pad(mark, 14)} ${pad(a.label, 20)} ${what}`);
  }
  if (unseenApps.length) {
    console.log('   ⚠ 見ていないアプリは、そのアプリのリポジトリの中で同じ物を走らせてください');
    console.log(`     (この端末に置いてあるなら ${envKeyOf('product')} などに置き場所を渡せば、ここでも一緒に見ます)`);
  }
  console.log('');

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
  console.log(`   ${pad('limit の線', 20)} 棚が実測0件の口だけ、limit ${num(LIMIT_CEILING)}件を上限とみなす`);
  console.log('     ↳ 🚨これは実測ではなく **置いた線**。棚に中身が在る口は、線ではなく実測の件数と比べます');
  console.log('       (実測でいちばん大きい棚は lot_images 2,355件・次が lots 633件。1画面が一度に使うのは多くても数百)');
  console.log('     新しい端末・別ブラウザ・シークレット窓・控えを消した後・別の住所は毎回この数。\n');

  // --- ① 1回開くと何件読むか ----------------------------------------------
  console.log('--------------------------------------------------------------------------');
  console.log('① 1人が1回開くと何件読むか（冷たい状態=端末の控えが無い時の上限）');
  console.log('--------------------------------------------------------------------------');
  for (const [key, v] of Object.entries(est.perOpen || {})) {
    const app = apps.find((a) => a.key === key);
    console.log(`\n  ${app.label}: 起動時 ${num(v.startup)}件 + 遅れて張る ${num(v.lazy)}件 = **${num(v.total)}件/回**`);
    if (app.missing) console.log('    🚫 このアプリのコードはこの端末で見ていません。下の数字は STARTUP の覚え書き＋控えの件数だけで出した物です。');
    console.log(`    (${v.why})`);
    v.rows.slice().sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([c, n]) => console.log(`      ${String(num(n)).padStart(6)}  ${c}`));
    const rest = v.rows.slice().sort((a, b) => b[1] - a[1]).slice(5);
    if (rest.length) console.log(`      ${String(num(rest.reduce((s, r) => s + r[1], 0))).padStart(6)}  その他 ${rest.length}コレクション`);
    v.lazyRows.forEach(([c, n, why]) => console.log(`      ${String(num(n)).padStart(6)}  ${c} … ${why}`));
  }
  if (est.ov && est.ov.notSeen) {
    console.log('\n  🚫 司令塔③: この端末で見ていないので、③自身の読みは **数えていません**（0として置いてある）。');
    console.log(`     ${est.ov.why}`);
  } else if (!est.unreadable) {
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
  console.log(`   （コードを見たのは ${coverage}。件数は控えから。見ていないアプリぶんは STARTUP の覚え書きで数えています）`);
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
  if (fresh.gone.length || fresh.extra.length || fresh.notChecked.length) {
    console.log('\n--------------------------------------------------------------------------');
    console.log('③ 見積りの土台(STARTUP)と実コードのずれ  🚨ここがずれると数字が黙って嘘になる');
    console.log('--------------------------------------------------------------------------');
    for (const k of fresh.notChecked) {
      const a = apps.find((x) => x.key === k);
      console.log(`   🚫 ${a ? a.label : k}: コードを見ていないので、STARTUP の突き合わせを **していません**`);
    }
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
  const dead = verdict.risky.filter((s) => s.hasWhere || s.hasLimit);
  console.log(`④ 🚨 絞りが効いていない読み口 ${verdict.risky.length}箇所（件数が青天井＝増えるほど毎日悪くなる）`);
  console.log(`      うち ${dead.length}箇所は **where / limit は書いてあるのに 1件も絞れていない**`);
  console.log(`      （2026-09-01 まで、この ${dead.length}箇所は「絞り込み有り」として素通りしていました）`);
  console.log(`   🚫 これは **見た ${coverage}** の中の数です。見ていないアプリの読み口は1つも入っていません。`);
  console.log('--------------------------------------------------------------------------');
  console.log(`   ${pad('件数(実測)', 12)} ${pad('アプリ', 20)} ${pad('コレクション', 24)} ${pad('種類', 16)} 場所`);
  const byWeight = verdict.risky.slice().sort((a, b) => (b.docs - a.docs) || a.col.localeCompare(b.col));
  const shown = byWeight.filter((s) => s.docs > 0 || s.docsUnknown);
  for (const s of shown) {
    const n = s.docsUnknown ? '?' : num(s.docs);
    console.log(`   ${pad(n, 12)} ${pad(s.appLabel, 20)} ${pad(s.col, 24)} ${pad(s.kind, 16)} ${s.file}:${s.line}`);
    if (s.hasWhere || s.hasLimit) console.log(`   ${' '.repeat(12)} ↳ ${s.eff.why}`);
  }
  const zero = byWeight.filter((s) => !s.docsUnknown && s.docs === 0);
  console.log(`   ── いま実測0件だが、増えたらそのまま全件読む物 ${zero.length}箇所 ──`);
  for (const s of zero) {
    console.log(`   ${pad('0', 12)} ${pad(s.appLabel, 20)} ${pad(s.col, 24)} ${pad(s.kind, 16)} ${s.file}:${s.line}`);
    if (s.hasWhere || s.hasLimit) console.log(`   ${' '.repeat(12)} ↳ ${s.eff.why}`);
  }

  // 🚨 静的には確かめられない口（絞り込みが変数の中に居る）
  if (verdict.unverifiable.length) {
    console.log('');
    console.log(`   ⚠ 絞り込みの中身が **静的には読めない** 読み口 ${verdict.unverifiable.length}箇所`);
    console.log('     ここは中身が静的に読めないので ❌ にも ✅ にもしません。**現物を人が見て確かめる事。**');
    console.log('     （「無い」と言い切ると嘘の❌になり、見張りが信用されなくなります）');
    for (const s of verdict.unverifiable.sort((a, b) => b.docs - a.docs)) {
      const why = s.optsVar ? `絞り込み=${s.optsVar}` : (s.eff ? s.eff.why : '');
      console.log(`     ${pad(s.docsUnknown ? '?' : num(s.docs), 8)} ${pad(s.appLabel, 20)} ${pad(s.col, 22)} ${pad(s.kind, 14)} ${why}  ${s.file}:${s.line}`);
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
  // 🚨🚨 走らせた場所を **必ず** 食う。ここが赤くならないと「見張りが何も読んでいないのに緑」に戻る。
  if (!selfApp) {
    reasons.push(`走らせた場所(${SELF_ROOT})が4アプリのどれか分からない`
      + '（package.json の name も フォルダ名も一致しない）。この見張りは4アプリの中で走らせる物です');
  } else if (selfApp.missing) {
    reasons.push(`🚨 自分(${selfApp.label})のコードを1バイトも読めていない: ${selfApp.notSeen || selfApp.dir}`);
  } else if (!selfApp.sites.length) {
    reasons.push(`🚨 自分(${selfApp.label})の src から読み口を1件も見つけられなかった`
      + `（${num(selfApp.files || 0)}ファイル読んだのに0箇所＝数え方が壊れている疑い）`);
  }
  if (verdict.violations.length) {
    const dw = verdict.violations.filter((v) => v.site.hasWhere || v.site.hasLimit).length;
    reasons.push(`絞りが効いていない読み口が ${verdict.violations.length}箇所 残っている`
      + (dw ? `（うち ${dw}箇所は where / limit を書いてあるのに 1件も絞れていない）` : ''));
  }
  if (verdict.problems.length) reasons.push(`成り立っていない例外が ${verdict.problems.length}件 ある`);
  if (fresh.gone.length) reasons.push(`見積りの土台が実コードとずれている(${fresh.gone.length}件)`);
  // 🚨「?embed=map で読まない」は **見積りを小さくする** 側の申告。裏が取れない申告は通さない。
  for (const b of embedBad) reasons.push(`?embed=map で読まない、と書いてあるのに実コードに証拠が無い: ${b.key} / ${b.col} … ${b.why}`);
  // ⚠③が **この端末に無い** のは赤にしない(見ていない)。**在るのに読めない** のは赤。
  if (est.unreadable) reasons.push('司令塔③の実コードを読めず、見積りが出せない');
  if (!est.unreadable && est.over) reasons.push(`1日の見積り ${num(est.day)}件 が無料枠 ${num(FREE_READS_PER_DAY)} を超えている(${est.pct}%)`);

  if (listOnly) {
    console.log('（--list なので判定は出しません。上の一覧と見積りだけです）');
    console.log('==========================================================================');
    return 0;
  }
  if (!reasons.length) {
    console.log(`🚦 ✅ 合格（見た範囲で）。${coverageLine}`);
    console.log(`   見た: ${seenApps.map((a) => a.label).join(' / ') || '(なし)'}`);
    if (unseenApps.length) {
      console.log(`   🚫 見ていない: ${unseenApps.map((a) => a.label).join(' / ')}`);
      console.log('      → そのアプリのリポジトリの中で同じ物を走らせるまで、そこは何も確かめていません。');
    }
    console.log('   見た範囲では、絞り込みの無い読み口は無く、見積りも無料枠の中です。');
    console.log('==========================================================================');
    return 0;
  }
  console.log(`🚦 ❌ 不合格。出荷しないでください。（見たのは ${coverage}）`);
  reasons.forEach((r, i) => console.log(`   ${i + 1}. ${r}`));
  console.log('');
  console.log('   直し方は2つだけです。');
  console.log('   (A) 読みに絞り込みを付ける（where / limit）。');
  console.log('       🚨ただし **過去のロットを使う画面（分析・達成率・日次実績・成績表・完了履歴）が');
  console.log('          空になったり数字が減ったりしてはいけません。**');
  console.log('          「普段は最近の分だけ購読し、過去が要る画面を開いた時だけ読む」形にする事。');
  console.log('          直す前と直した後で **画面の数字を突き合わせて、1つも変わらない事を示す** 事。');
  console.log('   (B) どうしても絞れないなら、理由を書いて例外にする。');
  for (const app of apps) {
    const a = allows[app.key];
    console.log(`       ${pad(app.label, 20)} ${a && a.path ? a.path : '(この端末に置き場所が無いので開けません)'}`);
  }
  console.log('       1件につき { app, file, col, who, why(20文字以上), maxDocs, until(任意) }。');
  console.log('       🚨maxDocs は「この件数までなら許す」という約束。実測が追い越したら例外は自動で切れます。');
  console.log('==========================================================================');
  return 1;
};

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(main());
