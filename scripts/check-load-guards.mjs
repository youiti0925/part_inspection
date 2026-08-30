// ============================================================================
// 🚦 「読み込みが終わる前に自動で保存する」を機械で見つける。
// ----------------------------------------------------------------------------
//   A0: ロットの読み込み完了の旗(lotsLoaded)が **そもそも無い**
//   A1: 「配列が空でない」を「読み込みが終わった」と思い込む
//   A2: 自動で走る処理(useEffect の中で saveData を呼ぶもの)が、読み込み完了を待っていない
//   A3: 🚨 **ロットへ書く**自動処理が lotsLoaded を見ていない(2026-08-17 の事故そのもの)
//   A4: 🚨 lots の購読に onError が無い(読めていないのに誰も気づかない)
//
// ⚠2026-08-13 の事故: マスタの入れ物はお手本で初期化されているので
//   `masterItems.length` は最初から0でない。長さで読み込み完了を判断すると、
//   本物が届く前に走って現物のデータを壊す。
//
// 🚨🚨 2026-08-17 の事故で、この見張りが **役に立たなかった** 理由(実測):
//   ① 白名簿(REVIEWED)に `autoOffloadBusy.current` が入っていた。
//      その effect の中身が `if (lot.tasks) update.tasks = lot.tasks;`(空マップを素通し)。
//      = **データを消した経路を、わざと検査対象から外していた。**
//   ② 判定が「LOAD_FLAGS のどれか1語が effect の中に在るか」だけだった。
//      お手本の項目を取り除く処理(src/App.firebase.jsx:32746)は `settingsLoaded` を
//      見ているので **素通りした**。ところが消えるのは **ロット**で、
//      ロットが届いたかは settingsLoaded では分からない。
//      → **ロットへ書く物は `lotsLoaded` を見ているかまで見る。**
//   ③ `lotsLoaded` は **どこにも無かった**(grep 0件)。門が無いので誰も通れない。
//
// ⚠⚠ **❌ が出るのが正しい。** 合格に見せる為に緩めない。
//   ロットへ書く自動処理は **白名簿では免除しない**。免除の条件は
//   「lotsLoaded を見ている」ただ1つ。理由書きで通せる抜け道を作らない。
//
// 使い方:
//   node scripts/check-load-guards.mjs                  … src/App.firebase.jsx を見る
//   node scripts/check-load-guards.mjs <ファイル>        … 指定した物を見る
//   node scripts/check-load-guards.mjs --selftest       … 見張り自身の試験
//
// ⚠⚠ **作り物の試験だけで信じない。実コードの「直す前」でも試す。**
//   作り物(--selftest)は自分で書いた物なので、都合よく通してしまう。
//   事故を起こした現物で落ちる事を、コミットの中身から出して確かめる:
//     git show <事故のコミット>:src/App.firebase.jsx > %TEMP%\before.jsx
//     node scripts/check-load-guards.mjs %TEMP%\before.jsx      → ❌ が出るのが正しい
//     node scripts/check-load-guards.mjs                        → 直した後は ✅
//   ⚠ 実測 2026-08-17: 26c6053(事故を起こした版) に対して A0/A3×5/A4 の **8件** が出た。
//     作業中の版(lotsLoaded を入れた後)は 0件。**通るのは直したからで、緩めたからではない。**
//   ⚠ git は読むだけ(show)。checkout / stash は絶対にしない。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 下ごしらえ
// ---------------------------------------------------------------------------
// ⚠コメントを消してから見る。コメントの中の例示コードを実コードとして数えると
//   指摘の文言が嘘になる(2026-08-16 に実コードを食う誤検出を出した)。
//   ⚠ URL の `//` を消さないよう、直前が `:` の時は行コメントとみなさない。
export const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

/** `(` から対応する `)` までを返す(文字列/テンプレートは飛ばす簡易版)。 */
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

/**
 * 🚨🚨 2026-08-19: 購読が `...道具(名札, 中身)` の形で **失敗の受け口ごと** 渡される事がある
 *   (golden の subPair。成功で札を消す・失敗で札を出す を1組で作る道具)。
 *   その場に `onError` の文字は無いが、受け口は付いている。
 * ⚠⚠ **名前を見ただけで通さない。** 通すのは
 *   「同じファイルに `const 道具 = …` が在って、**その中身に onError が在る**」時だけ。
 *   でないと onError を持たない偽物の道具を1つ置くだけで、全部の購読が素通りする。
 * ⚠ 渡される src は既にコメントを消した後(コメントに onError と書いても通らない)。
 * 🚨🚨 2026-08-20 に**穴を2つ塞いだ**(実測で素通りする事を確かめてから塞いだ):
 *   ①`onError` を **ただの文字として** 探していた。`{ onErrorX: 1 }` や
 *     `{ ...r, onErrorNote: 1 }` のような **別物の名前**でも通っていた(実測: 落ちるはずの
 *     購読が0件になった)。受け口は `onError:` という **鍵の形** でしか効かないので、
 *     鍵の形で探す。
 *   ②`...道具(` を **引数のどこからでも** 拾っていた。中身(コールバック)の奥にある
 *     `{ ...shape(r) }` まで拾うので、`const shape = …` が たまたま onError を含むだけで
 *     **onError を1つも持たない購読が丸ごと免除された**(実測)。拾うのは
 *     **引数の一番外側に置かれた spread だけ**にする(それが `...subPair(…)` の書き方)。
 * @param {string} source コメントを消した後のファイル全体
 * @param {string} name   `...name(` の name
 */
/** 受け口の**鍵の形**。`onErrorX:` や `onErrorNote:` は別物なので通さない。 */
const ON_ERROR_KEY = /(^|[^\w$])onError\s*:/;
export const helperHasOnError = (source, name) => {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(name || ''))) return false;
  const at = source.indexOf(`const ${name} = `);
  if (at < 0) return false;
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth === 0) return ON_ERROR_KEY.test(source.slice(at, i));
  }
  return ON_ERROR_KEY.test(source.slice(at));
};

/**
 * 🚨🚨 2026-08-30(部品検査): 購読の **別名そのものが受け口を焼き込んでいる** 形がある。
 *     const watch = (colName, cb) =>
 *       P.watchCollection(APP_DATA_ID, colName, …, { onError: readFailed(colName) });
 *     watch('notes', (rows) => setNotes(rows)),      ← 呼ぶ側に onError の文字は無い
 *   `...subPair(…)`(受け口を **引数で** 渡す形)と同じ事を、別名の中で1回だけやっている。
 *   ⚠ここを見ないと、受け口が **全部の購読に確実に付いている** 一番強い書き方が
 *     赤になり続ける。赤が出っぱなしの見張りは、そのうち誰も見なくなる。
 *
 * ⚠⚠ **名前を見ただけで通さない。** 通すのは次を全部満たす時だけ:
 *   ① 同じファイルに `const 別名 = …` の定義が **1つ以上** ある
 *   ② その **全部** の中身に `onError:` という **鍵の形** が在る
 *      (`onErrorX:` は別物 / コメントは既に剥がしてあるので効かない)
 *   1つでも受け口の無い定義が在れば通さない。同名の別物が居る時に
 *   「たまたま片方が持っている」で全部を免除すると、偽物1つで素通りする。
 * @param {string} source コメントを消した後のファイル全体
 * @param {string} name   呼び出しに使われた別名
 * @returns {boolean}
 */
export const everyAliasDefHasOnError = (source, name) => {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(name || ''))) return false;
  const needle = `const ${name} = `;
  let found = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    found++;
    from = at + needle.length;
    // その定義1つぶん(次の「深さ0の ;」まで)を切り出して、鍵の形を探す。
    let depth = 0;
    let body = source.slice(at);
    for (let i = at; i < source.length; i++) {
      const c = source[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) { body = source.slice(at, i); break; }
    }
    if (!ON_ERROR_KEY.test(body)) return false; // 1つでも受け口の無い定義が在れば通さない
  }
  return found > 0;
};

/**
 * 🚨 引数の **一番外側** に置かれた `...道具(` の名前だけを返す(無ければ '')。
 *   ⚠中身(コールバック)の奥の `{ ...shape(r) }` を拾わない為。奥まで拾うと、
 *     onError を1つも持たない購読が「たまたま onError を含む別の道具」で免除される。
 * @param {string} args `(` から `)` まで(argsFrom の戻り)
 */
export const topLevelSpreadName = (args) => {
  const s = String(args || '');
  let depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; continue; }
    // depth 1 = 「この呼び出しの引数そのもの」の並び(0 は `(` の外側)。
    if (depth === 1 && c === '.' && s.slice(i, i + 3) === '...') {
      const m = s.slice(i).match(/^\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (m) return m[1];
    }
  }
  return '';
};

// ---------------------------------------------------------------------------
// 旗
// ---------------------------------------------------------------------------
// ロット以外(設定・連絡など)へ書く物の免除条件。今までと同じ。
const LOAD_FLAGS = /settingsLoaded|arrivalsLoaded|lotsLoaded|loaded\b/;
// 🚨ロットへ書く物の免除条件。**これだけ**。`settingsLoaded` では代わりにならない。
//
// 🚦 「ロットの読み込みを待つ門」として認める **名前の一覧**(2026-08-31・4アプリ共通)。
//   ⚠⚠ **`〜Ref.current` なら何でも門、にしてはいけない。** それは門ではなく ただの変数で、
//     `if (!busyRef.current) return;` のような別物まで免除してしまう。
//     認めるのは「ロットの読み込みが終わったか」を表す名前 **だけ**。
//   ⚠ここへ足すのは、その名前が本当に読み込み完了を表す時だけ。理由を書かずに足さない。
//   経緯: 製品検査の測定図の巡回は `if (!lotsLoadedRef.current) return;` で ちゃんと門を
//   持っているのに、見張りの語彙が `lotsLoaded` だけだったので赤が出ていた。
//   90秒ごとに黙って走る処理は **再描画を待てない** ので ref で読むのが正しい。
//   動いているコードを道具に合わせて書き換えるのではなく、道具に語彙を教える。
//   ⚠4アプリで同じ一覧にする(部品検査が同じ書き方を採った時に嘘の赤が出ない様に)。
const LOTS_GATE_NAMES = [
  'lotsLoaded',             // 画面の状態(再描画で伝わる)
  'lotsLoadedRef.current',  // 同じ旗を ref で読む形(巡回など、再描画を待てない所)
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// ⚠前後を「名前の切れ目」で挟む。挟まないと `lotsLoaded` が `lotsLoadedRef` の頭に当たり、
//   一覧に無い別名まで門と数えてしまう。
const LOTS_FLAG = new RegExp(`(?<![\\w$.])(?:${LOTS_GATE_NAMES.map(escapeRe).join('|')})(?![\\w$])`);

// ロットへ書いている形。col が変数の物も拾う(`saveData(col, id, ...)`)。
const WRITES_LOTS = [
  /\bsaveData\s*\(\s*['"]lots['"]/,
  /\bsaveLot\s*\(/,
  /\.save\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]lots['"]/,
  /\bsetDoc\s*\(\s*[^)]*['"]lots['"]/,
];
// ロットの中の「時間取りデータ」に触っている形。ここが消えると復旧できない。
const WRITES_TASKS = [
  /(?<![.\w$])tasks\s*:/,
  /\bupdate\.tasks\s*=/,
  /\{\s*tasks\s*[,}]/,
  /\[\s*['"]tasks['"]\s*,/,   // __deleteMapKeys: [['tasks', k]]
];

// 見た上で「読み込みを待たなくてよい」と判断した物。
// ⚠⚠ **ロットへ書く物はここへ書いても免除されない**(A3 は白名簿を見ない)。
//   ここが効くのは A2(ロット以外への書き込み)だけ。
// ⚠理由を書かずに足さないこと。足す＝「この処理は設定にも初期値のある一覧にも触らない」の宣言。
export const REVIEWED = [
  { needle: "saveData('contact_requests', detailId, { seenApp", why: '人が開いた連絡1件に「見た」印を付けるだけ。設定も、初期値のある一覧も使っていない' },
  { needle: 'if (r && !r.seenPortal)', why: '人が開いた受信箱に「見た」印を付けるだけ。同上' },
  // --- 2026-08-17 に外した分 -------------------------------------------------
  //  ❌ `autoOffloadBusy.current`     … 写真の自動別置き。中身が `if (lot.tasks) update.tasks = lot.tasks;`
  //                                     = 空マップを素通しして **サーバの tasks を丸ごと消す** 経路。
  //                                     「ロット本体の写真を別置きするだけ」は嘘だった(tasks も送っていた)。
  //  ❌ `optimizedStepOrder !== undefined` … 「lots はお手本で初期化されないので長さで判断してよい」は
  //                                     **読み込み完了の判断としては誤り**。長さが1以上でも中身は
  //                                     古いキャッシュ/欠けた購読の結果でありうる(persistentLocalCache)。
  //  ❌ `l.status === 'completed' && l.mapZoneId` … ロットへ書くので A3 の対象。白名簿では免除しない。
  //  ⚠ この3つを戻さない。戻すなら「lotsLoaded を見る」を先に実装する事。
];

// ---------------------------------------------------------------------------
// 本体(純関数。--selftest はこれを文字列に対して回す)
// ---------------------------------------------------------------------------
export const analyze = (rawSrc, file = '(memory)') => {
  const src = stripComments(rawSrc);
  const lines = src.split(/\r?\n/);
  const problems = [];
  const noErrorSubs = [];   // onError の無い購読の一覧(lots 以外は数に入れない)
  const add = (kind, line, msg, snippet) =>
    problems.push({ kind, line, msg, snippet: String(snippet || '').trim().slice(0, 110) });

  // --- A0: ロットの読み込み完了の旗が そもそも在るか -------------------------
  const hasLotsFlag = LOTS_FLAG.test(src);
  if (!hasLotsFlag) {
    add('A0', 0,
      '🚨 ロットの読み込み完了の旗(lotsLoaded)がこのファイルに1つも無い。'
      + '「ロットが届いた」を判断する手段が無いので、下に並ぶ自動処理は全部'
      + '**空のロットで走りうる**(2026-08-17 の事故の土台)', '');
  }

  // --- useEffect のブロックを雑に切り出す(括弧の深さで追う) -----------------
  const effects = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/useEffect\(\s*\(\s*\)\s*=>\s*\{/.test(lines[i])) continue;
    let depth = 0, started = false, end = i;
    for (let j = i; j < lines.length && j < i + 400; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      if (started && depth <= 0) { end = j; break; }
    }
    effects.push({ start: i, end, body: lines.slice(i, end + 1).join('\n') });
  }

  /**
   * 🚨🚨 2026-08-30(部品検査で実測): **依存の並びは「門」ではない。**
   *   useEffect のブロックは最後の行が `}, [lots, lotsLoaded]);` なので、
   *   `body` にはその並びまで入っている。免除の判定をそのまま body でやると
   *     useEffect(() => { …lotsLoaded を1度も見ずにロットへ書く… }, [lots, lotsLoaded]);
   *   が **通ってしまう**(実測: 門の1行 `if (!lotsLoaded) return;` を消しても緑のままだった)。
   *   依存に名前を並べても、走るのは止まらない。止めるのは中の `if` だけ。
   *   → 免除を見る時は **閉じ括弧より後ろを捨ててから** 見る。
   *   ⚠捨て方は「最後の行の最初の `}` まで」。1行で書かれた effect では
   *     余分に捨てる事があるが、その向きは **見張りが厳しくなる側** なので安全。
   */
  const bodyWithoutDeps = (body) => {
    const nl = body.lastIndexOf('\n');
    const head = nl < 0 ? '' : body.slice(0, nl + 1);
    const last = nl < 0 ? body : body.slice(nl + 1);
    const brace = last.indexOf('}');
    return head + (brace < 0 ? last : last.slice(0, brace));
  };

  for (const e of effects) {
    const writesLots = WRITES_LOTS.some((re) => re.test(e.body));
    const writes = writesLots || /\bsaveData\(|\bsaveSettings\(|\bsetDoc\(|\bsaveContactShared\(/.test(e.body);
    if (!writes) continue;

    // --- A3: ロットへ書く自動処理 ------------------------------------------
    //   🚨白名簿を見ない。免除は lotsLoaded を見ている事だけ。
    if (writesLots) {
      // ⚠免除は **中身だけ** で見る。依存の並びに名前が在っても走るのは止まらない。
      if (LOTS_FLAG.test(bodyWithoutDeps(e.body))) continue;
      const touchesTasks = WRITES_TASKS.some((re) => re.test(e.body));
      add('A3', e.start + 1,
        touchesTasks
          ? '🚨🚨 自動で走る処理が **ロットの tasks(時間取りデータ)** を書いているのに、'
            + 'ロットの読み込み完了(lotsLoaded)を見ていない。手元が空/古いまま1回走れば'
            + '**サーバの時間取りが丸ごと消える**(復旧手段は無い)'
          : '🚨 自動で走る処理がロットへ書いているのに、ロットの読み込み完了(lotsLoaded)を見ていない。'
            + 'settingsLoaded では代わりにならない(消えるのはロット)',
        lines[e.start].trim());
      continue;
    }

    // --- A2: ロット以外への書き込み(今までどおり。白名簿が効く) ------------
    if (REVIEWED.some((r) => e.body.includes(r.needle))) continue;
    // ⚠A3 と同じ理由で、免除は **中身だけ** で見る(依存の並びは門ではない)。
    if (LOAD_FLAGS.test(bodyWithoutDeps(e.body))) continue;
    add('A2', e.start + 1,
      'useEffect の中でデータを保存しているのに、読み込み完了の旗(settingsLoaded など)を見ていません',
      lines[e.start].trim());
  }

  // --- A1: 「.length」だけで読み込み完了を判断していそうな所 ----------------
  //   ⚠旗を探す範囲は **その処理の中** に限る。前は「前後12行」で見ていたので、
  //     隣の別の effect に settingsLoaded が在るだけで黙って免除されていた
  //     (この見張り自身の試験で判明。2026-08-17)。
  const SEEDED = ['masterItems', 'templates', 'workers', 'mapZones'];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const name of SEEDED) {
      const re = new RegExp(`!\\s*${name}\\.length\\s*\\)\\s*return`);
      if (!re.test(l)) continue;
      const owner = effects.find((e) => i >= e.start && i <= e.end);
      const near = owner ? owner.body : lines.slice(Math.max(0, i - 12), i + 4).join('\n');
      if (LOAD_FLAGS.test(near)) continue;
      add('A1', i + 1,
        `${name}.length で読み込み完了を判断しています。この入れ物は初期値(お手本)が入っているので長さは0になりません`,
        l.trim());
    }
  }

  // --- A4/A5: 購読に onError が無い ------------------------------------------
  //   🚨読み取りが 429(無料枠切れ)や権限で死んでも、誰も気づかない。
  //     キャッシュ有りの端末は古い中身で動き、無しの端末は空で動く。
  //   ⚠第1引数が文字列でない `watch(el, cb)`(ResizeObserver の道具)は対象外。
  //
  // 🚨🚨 2026-08-18: ここに **見張り自身の穴** が有った。
  //   旧: `const quoted = args.match(/['"]…['"]/); if (!quoted) continue;`
  //   = コレクション名を **定数で渡した購読を黙って見逃す**
  //     (P.watchCollection(CONTACT_SHARED_NS, FEEDBACK_COL, …) など実測3本)。
  //   しかも「引数の中で最初に見つかった文字列」を名前にしていたので、
  //   名前空間の方を名前と取り違える事もあった。**見つけられない見張りは無いのと同じ。**
  //   さらに lots 以外は一覧に出すだけで数に入れず、13件残ったまま「✅ 問題なし」と出ていた。
  /** `(a, b, c)` を深さ0のカンマで分ける。⚠文字列の中のカンマ・括弧で切らない。 */
  const argList = (a) => {
    const inner = a.replace(/^\(/, '');
    const out = []; let depth = 0, q = null, cur = '';
    for (const c of inner) {
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const SUB_RE = /\b(?:watchCollection|watchQuery|watchDoc|watch)\s*\(/g;
  let s;
  while ((s = SUB_RE.exec(src))) {
    const open = src.indexOf('(', s.index);
    const args = argsFrom(src, open);
    const isAlias = /^\bwatch\s*\(/.test(src.slice(s.index, open + 1).trim());
    const parts = argList(args);
    // ⚠置き場所の引数は形で位置が違う。
    //   別名 : watch('lots', cb)               → 1つ目
    //   窓口 : watchCollection(NS, 'lots', cb) → **2つ目**(1つ目は名前空間)
    const colArg = (isAlias ? parts[0] : parts[1]) || '';
    const lit = colArg.match(/^['"]([A-Za-z0-9_]+)['"]$/);
    // 名前は「文字列」か「定数(大文字だけ)」のどちらか。
    //   それ以外(`colName` のような小文字の引数)は **別名を定義している行そのもの**なので数えない。
    //   `watch(headerElRef.current, cb)`(ResizeObserver)も同じ理由で外れる。
    const col = lit ? lit[1] : (/^[A-Z][A-Z0-9_]*$/.test(colArg) ? colArg : '');
    if (!col) continue;
    if (/onError/.test(args)) continue;
    // 🚨 失敗の受け口を **道具ごと** 渡している形(`...subPair(名札, 中身)`)。
    //   ⚠道具の中身に onError が在る事まで確かめてから通す(helperHasOnError)。
    //     名前だけで通すと、偽物の道具1つで全部の購読が素通りする。
    //   ⚠拾うのは **引数の一番外側** の spread だけ(topLevelSpreadName)。
    //     中身の奥の `{ ...shape(r) }` まで拾うと、onError を1つも持たない購読が免除される。
    const spread = topLevelSpreadName(args);
    if (spread && helperHasOnError(src, spread)) continue;
    // 🚨 別名そのものが受け口を **焼き込んで** いる形(部品検査の `const watch = …{ onError: … }`)。
    //   ⚠ここも「名前を見て通す」ではない。**同じファイルの定義を全部読んで、
    //     全部に `onError:` の鍵が在る時だけ** 通す(everyAliasDefHasOnError)。
    //   ⚠焼き込みが在っても、呼ぶ側で受け口を **上書き** できる書き方(第3引数 opts を
    //     そのまま渡す別名)は ここへ来ない: その形は定義に onError: が無いので落ちる。
    if (isAlias && everyAliasDefHasOnError(src, 'watch')) continue;
    const line = lineOf(src, s.index);
    noErrorSubs.push({ line, col, code: (lines[line - 1] || '').trim().slice(0, 100) });
    if (col === 'lots') {
      add('A4', line,
        '🚨 lots の購読に onError が無い。読み取りが 429(無料枠切れ)や権限で死んでも'
        + '**誰にも見えない**。キャッシュ有りの端末は古い中身で、無しの端末は空で動き続ける',
        (lines[line - 1] || '').trim());
    } else {
      // 🚨 lots 以外も **落とす**(2026-08-18)。「読めていない」と「本当に0件」は
      //   画面の上で同じ顔をする。数に入れないと、直す理由が誰にも伝わらない。
      add('A5', line,
        `🚨 ${col} の購読に onError が無い。読み取りが死んでも画面は「0件」の顔で動き続ける`
        + '(「読めていない」と「本当に0件」の混同)',
        (lines[line - 1] || '').trim());
    }
  }

  problems.sort((a, b) => a.line - b.line);
  return { file, problems, noErrorSubs, hasLotsFlag };
};

// ---------------------------------------------------------------------------
// 見張り自身の試験
// ⚠⚠ 「直す前のコードなら落ちる」「直した後のコードなら通る」を両方確かめる。
//   片方だけだと、何も検出しない空っぽの見張りでも合格してしまう。
// ---------------------------------------------------------------------------
const BEFORE_FIX = `
useEffect(() => {
    if (autoOffloadBusy.current) return;
    const update = {};
    if (lot.tasks) update.tasks = lot.tasks;
    await saveData('lots', lot.id, update);
}, [lots, user, db]);
useEffect(() => {
    if (!canAutoFill(settingsLoaded, masterItems, FINAL_INSPECTION_DATA)) return;
    const tasks = { ...(lot.tasks || {}) };
    await saveData('lots', r.lotId, { steps: r.keptSteps, tasks });
}, [lots, masterItems, settingsLoaded]);
useEffect(() => {
    if (!masterItems.length) return;
    saveSettings({ masterItems });
}, [masterItems]);
const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb);
watch('lots', (rows) => setLots(rows)),
watch('workers', (rows) => setWorkers(rows)),
`;

const AFTER_FIX = `
const [lotsLoaded, setLotsLoaded] = useState(false);
useEffect(() => {
    if (!lotsLoaded) return;
    if (autoOffloadBusy.current) return;
    const update = {};
    if (Object.keys(lot.tasks || {}).length) update.tasks = lot.tasks;
    await saveData('lots', lot.id, update);
}, [lotsLoaded, lots, user, db]);
useEffect(() => {
    if (!lotsLoaded) return;
    if (!canAutoFill(settingsLoaded, masterItems, FINAL_INSPECTION_DATA)) return;
    const tasks = { ...(lot.tasks || {}) };
    await saveData('lots', r.lotId, { steps: r.keptSteps, tasks });
}, [lotsLoaded, lots, masterItems, settingsLoaded]);
useEffect(() => {
    if (!settingsLoaded) return;
    if (!masterItems.length) return;
    saveSettings({ masterItems });
}, [settingsLoaded, masterItems]);
const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb);
P.watchCollection(APP_DATA_ID, 'lots', (rows) => { setLots(rows); setLotsLoaded(true); }, { onError: (e) => setReadError(e) }),
watch('workers', (rows) => setWorkers(rows), { onError: (e) => setReadError(e) }),
`;

export const selftest = () => {
  let bad = 0;
  const say = (ok, what) => { console.log(`${ok ? '  ✅' : '  ❌'} ${what}`); if (!ok) bad++; };
  console.log('🧪 見張り自身の試験');

  const before = analyze(BEFORE_FIX, '(直す前)');
  const kinds = before.problems.map((p) => p.kind);
  say(kinds.includes('A0'), '直す前: lotsLoaded がどこにも無い事を捕まえる');
  say(kinds.includes('A1'), '直す前: masterItems.length で読み込み完了を判断する形を捕まえる');
  say(kinds.filter((k) => k === 'A3').length >= 2,
    `直す前: ロットへ書く自動処理を2本とも捕まえる (A3=${kinds.filter((k) => k === 'A3').length}件)`);
  say(kinds.includes('A4'), '直す前: lots の購読に onError が無い事を捕まえる');

  // 🚨🚨 2026-08-18 に見つけた「見張り自身の穴」の再発防止。**ここを緩めて通さない**。
  //   旧コードは「引数の中で最初に見つかった文字列」を置き場所の名前にしていたので、
  //   ① 名前を定数で渡した購読を **黙って見逃し**(実測3本)
  //   ② 名前空間(第1引数)を置き場所と取り違える危険が有った。
  //   見つけられない見張りは無いのと同じ。
  const constCol = analyze(`
const lotsLoaded = true;
P.watchCollection(CONTACT_SHARED_NS, FEEDBACK_COL, (rows) => setAppFeedback(rows || [])),
P.watchCollection(CONTACT_SHARED_NS, NOTICE_COL, (rows) => setAppNotices(rows || [])),
watch(ACTUAL_COL, (rows) => setArrivalActuals(rows || [])),
`, '(定数名の購読)');
  say(constCol.problems.filter((p) => p.kind === 'A5').length === 3,
    `直す前: 定数でコレクション名を渡した購読も見逃さない (実際 ${constCol.problems.filter((p) => p.kind === 'A5').length}/3件)`);

  const aliasDef = analyze(`
const lotsLoaded = true;
const watch = (colName, cb, opts) => P.watchCollection(APP_DATA_ID, colName, cb, opts);
`, '(別名の定義)');
  say(aliasDef.problems.length === 0 && aliasDef.noErrorSubs.length === 0,
    `負の対照: 別名を定義している行そのものは購読と数えない (実際 ${aliasDef.problems.length + aliasDef.noErrorSubs.length}件)`);

  // 🚨🚨 2026-08-30 に足した所: 別名が受け口を **焼き込んで** いる形(部品検査の `watch`)。
  //   ⚠ここも「名前を見て通す」だけにすると、受け口の無い別名1つで全部素通りする。
  //     だから **本物は通し / 偽物は落ちる / 定義が無ければ落ちる / 同名の別物が混ざれば落ちる**
  //     の4つを毎回確かめる。
  const BAKED_REAL = `
const lotsLoaded = true;
const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, (rows, snap) => { meter(colName, snap); cb(rows, snap); }, { onError: readFailed(colName) });
watch('notes', (rows) => setNotes(rows)),
watch('announcements', (rows) => setAnnouncements(rows)),
`;
  const bakedReal = analyze(BAKED_REAL, '(別名に焼き込み・本物)');
  say(bakedReal.problems.length === 0 && bakedReal.noErrorSubs.length === 0,
    `負の対照: 受け口を焼き込んだ別名(const watch = …{ onError: … })を通した購読は通す (実際 ${bakedReal.problems.length + bakedReal.noErrorSubs.length}件)`);

  const bakedFake = analyze(BAKED_REAL.replace('{ onError: readFailed(colName) }', '{ onErrorX: 1 }'), '(別名に焼き込み・別の名前)');
  say(bakedFake.problems.filter((p) => p.kind === 'A5').length === 2,
    `🚨 別名の中身が onErrorX のような **別の名前** なら落とす (実際 ${bakedFake.problems.filter((p) => p.kind === 'A5').length}/2件)`);

  const bakedComment = analyze(BAKED_REAL.replace('{ onError: readFailed(colName) }', '{} /* onError: ここに書いても効かない */'), '(別名の中身がコメントだけ)');
  say(bakedComment.problems.filter((p) => p.kind === 'A5').length === 2,
    `🚨 別名の中身のコメントに onError と書いただけでは通さない (実際 ${bakedComment.problems.filter((p) => p.kind === 'A5').length}/2件)`);

  const bakedNoDef = analyze(`
const lotsLoaded = true;
import { watch } from './somewhere.js';
watch('notes', (rows) => setNotes(rows)),
`, '(別名の定義がこのファイルに無い)');
  say(bakedNoDef.problems.filter((p) => p.kind === 'A5').length === 1,
    `🚨 別名の定義が見つからなければ通さない (実際 ${bakedNoDef.problems.filter((p) => p.kind === 'A5').length}/1件)`);

  const bakedMixed = analyze(`
const lotsLoaded = true;
const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb, { onError: readFailed(colName) });
const watch = (colName, cb) => P.watchCollection(APP_DATA_ID, colName, cb);
watch('notes', (rows) => setNotes(rows)),
`, '(同名の別物が混ざる)');
  say(bakedMixed.problems.filter((p) => p.kind === 'A5').length === 1,
    `🚨 同じ名前の定義が2つ在って片方に受け口が無ければ通さない (実際 ${bakedMixed.problems.filter((p) => p.kind === 'A5').length}/1件)`);

  const bakedPassThrough = analyze(`
const lotsLoaded = true;
const watch = (colName, cb, opts) => P.watchCollection(APP_DATA_ID, colName, cb, opts);
watch('notes', (rows) => setNotes(rows)),
`, '(受け口を呼ぶ側に任せる別名)');
  say(bakedPassThrough.problems.filter((p) => p.kind === 'A5').length === 1,
    `🚨 受け口を呼ぶ側に任せる別名(opts を素通し)は、呼ぶ側が渡さなければ落とす (実際 ${bakedPassThrough.problems.filter((p) => p.kind === 'A5').length}/1件)`);

  // 🚨🚨 2026-08-30 に足した所: **依存の並びを「門」と取り違えない**。
  //   実測: 部品検査の掃除処理から `if (!lotsLoaded) return;` の1行を消しても、
  //   `}, [lots, lotsLoaded]);` が body に入っているせいで **緑のままだった**。
  //   依存に名前を並べても走るのは止まらない。ここを見逃すと 2026-08-17 の形が素通りする。
  const depsOnly = analyze(`
const lotsLoaded = useLotsLoaded();
useEffect(() => {
  for (const lot of dirty) { saveData('lots', lot.id, { optimizedStepOrder: null }); }
}, [lots, lotsLoaded]);
`, '(依存に並べただけ)');
  say(depsOnly.problems.filter((p) => p.kind === 'A3').length === 1,
    `🚨 依存の並び([lots, lotsLoaded])を「読み込みを待った」と数えない (実際 ${depsOnly.problems.filter((p) => p.kind === 'A3').length}/1件)`);

  const depsAndGuard = analyze(`
const lotsLoaded = useLotsLoaded();
useEffect(() => {
  if (!lotsLoaded) return;
  for (const lot of dirty) { saveData('lots', lot.id, { optimizedStepOrder: null }); }
}, [lots, lotsLoaded]);
`, '(門も依存も在る)');
  say(depsAndGuard.problems.filter((p) => p.kind === 'A3').length === 0,
    `負の対照: 中に門(if (!lotsLoaded) return;)が在れば通す (実際 ${depsAndGuard.problems.filter((p) => p.kind === 'A3').length}件)`);

  // 🚦 2026-08-31 に足した所: 門の書き方は1つではない。`lotsLoadedRef.current` も門。
  //   ⚠ただし **広げすぎない**。関係ない `〜Ref.current` を門と認めたら、見張りは何も守らない。
  const refGate = analyze(`
const lotsLoadedRef = useRef(false);
useEffect(() => {
  const tick = async () => {
    if (!lotsLoadedRef.current) return;
    for (const t of targets) { saveData('lots', t.id, { steps }); }
  };
}, [user, db]);
`, '(ref で門を持つ)');
  say(refGate.problems.filter((p) => p.kind === 'A3').length === 0,
    `負の対照: ref で読む門(if (!lotsLoadedRef.current) return;)を門と認める (実際 ${refGate.problems.filter((p) => p.kind === 'A3').length}件)`);

  const otherRef = analyze(`
useEffect(() => {
  const tick = async () => {
    if (!sweepBusyRef.current) return;
    for (const t of targets) { saveData('lots', t.id, { steps }); }
  };
}, [user, db]);
`, '(関係ない ref)');
  say(otherRef.problems.filter((p) => p.kind === 'A3').length === 1,
    `🚨 関係ない \`〜Ref.current\` は門と認めない (実際 ${otherRef.problems.filter((p) => p.kind === 'A3').length}/1件)`);

  const noGateAtAll = analyze(`
const lotsLoadedRef = useRef(false);
useEffect(() => {
  const tick = async () => {
    for (const t of targets) { saveData('lots', t.id, { steps }); }
  };
}, [user, db]);
`, '(門が無い)');
  say(noGateAtAll.problems.filter((p) => p.kind === 'A3').length === 1,
    `🚨 門が1つも無ければ赤 (実際 ${noGateAtAll.problems.filter((p) => p.kind === 'A3').length}/1件)`);

  const lookAlikeName = analyze(`
useEffect(() => {
  if (!lotsLoadedSoonRef.current) return;
  saveData('lots', id, { steps });
}, [lots]);
`, '(似た名前の別物)');
  say(lookAlikeName.problems.filter((p) => p.kind === 'A3').length === 1,
    `🚨 一覧に無い似た名前(lotsLoadedSoonRef)を門と数えない (実際 ${lookAlikeName.problems.filter((p) => p.kind === 'A3').length}/1件)`);

  const nsMix = analyze(`
const lotsLoaded = true;
P.watchCollection(APP_DATA_ID, 'workers', cb),
`, '(名前空間との取り違え)');
  say(nsMix.problems.length === 1 && nsMix.problems[0].msg.includes('workers'),
    '負の対照: 名前空間(APP_DATA_ID)を置き場所の名前と取り違えない');

  const withErr = analyze(`
const lotsLoaded = true;
P.watchCollection(CONTACT_SHARED_NS, FEEDBACK_COL, (rows) => setAppFeedback(rows||[]), { onError: (e) => note(e) }),
watch('notes', (rows) => setNotes(rows), { onError: (e) => note(e) }),
`, '(onError 付き)');
  say(withErr.problems.length === 0,
    `負の対照: onError が在れば定数名でも通す (実際 ${withErr.problems.length}件)`);

  // 🚨🚨 2026-08-19 に足した所: 失敗の受け口を **道具ごと** 渡す形(`...subPair(…)`)。
  //   ⚠ここを「名前を見て通す」だけにすると、onError を持たない偽物の道具で全部素通りする。
  //     だから **本物は通し / 偽物は落ちる / 定義の無い道具も落ちる** の3つを毎回確かめる。
  const PAIR_REAL = `
const lotsLoaded = true;
const subPair = (label, cb) => [ (...a) => { onSubOk(label); return cb(...a); }, { onError: onSubError(label) } ];
watch('notes', ...subPair('メモ', (rows) => setNotes(rows))),
P.watchCollection(CONTACT_SHARED_NS, FEEDBACK_COL, ...subPair('要望箱', (rows) => setAppFeedback(rows))),
`;
  const pairReal = analyze(PAIR_REAL, '(対で渡す道具・本物)');
  say(pairReal.problems.length === 0 && pairReal.noErrorSubs.length === 0,
    `負の対照: 失敗の受け口を持つ道具(...subPair)を通した購読は通す (実際 ${pairReal.problems.length + pairReal.noErrorSubs.length}件)`);

  const pairFake = analyze(PAIR_REAL.replace('{ onError: onSubError(label) }', '{}'), '(対で渡す道具・偽物)');
  say(pairFake.problems.filter((p) => p.kind === 'A5').length === 2,
    `🚨 道具の中身に onError が無ければ落とす (実際 ${pairFake.problems.filter((p) => p.kind === 'A5').length}/2件)`);

  const pairComment = analyze(PAIR_REAL.replace('{ onError: onSubError(label) }', '{} /* onError */'), '(コメントに onError と書いただけ)');
  say(pairComment.problems.filter((p) => p.kind === 'A5').length === 2,
    `🚨 コメントに onError と書いただけでは通さない (実際 ${pairComment.problems.filter((p) => p.kind === 'A5').length}/2件)`);

  const pairUndef = analyze(`
const lotsLoaded = true;
watch('notes', ...subPairX('メモ', (rows) => setNotes(rows))),
`, '(定義の無い道具)');
  say(pairUndef.problems.filter((p) => p.kind === 'A5').length === 1,
    `🚨 定義の見つからない道具では通さない (実際 ${pairUndef.problems.filter((p) => p.kind === 'A5').length}/1件)`);

  // 🚨🚨 2026-08-20 に実測で見つけた **2つの穴**。塞いだ事を毎回ここで確かめる。
  //   放っておくと「見張りが在るのに素通り」= 2026-08-17 と同じ形になる。
  //   ①受け口の名前が違う物(onErrorX)でも通っていた
  const pairLookAlike = analyze(PAIR_REAL.replace('{ onError: onSubError(label) }', '{ onErrorX: 1 }'), '(似た名前の受け口)');
  say(pairLookAlike.problems.filter((p) => p.kind === 'A5').length === 2,
    `🚨 onErrorX のような **別の名前** では通さない (実際 ${pairLookAlike.problems.filter((p) => p.kind === 'A5').length}/2件)`);
  //   ②中身の奥の `{ ...shape(r) }` を拾って、onError を1つも持たない購読が免除されていた
  const nestedSpread = analyze(`
const lotsLoaded = true;
const shape = (r) => ({ ...r, onErrorNote: 1 });
watch('notes', (rows) => setNotes(rows.map(r => ({ ...shape(r) })))),
`, '(中身の奥の spread)');
  say(nestedSpread.problems.filter((p) => p.kind === 'A5').length === 1,
    `🚨 中身の奥の spread では免除しない (実際 ${nestedSpread.problems.filter((p) => p.kind === 'A5').length}/1件)`);
  // 🚨 白名簿では免除されない事(これが 2026-08-17 に効かなかった所)。
  //   BEFORE_FIX の1本目が「写真の自動別置き(`autoOffloadBusy.current` を含む effect)」。
  //   その effect の開始行が A3 に載っている事を **行番号で** 確かめる。
  const offloadLine = BEFORE_FIX.split('\n').findIndex((l) => l.includes('useEffect')) + 1;
  say(before.problems.some((p) => p.kind === 'A3' && p.line === offloadLine),
    `直す前: 旧・白名簿に在った経路(写真の自動別置き @${offloadLine}行)も A3 として出る`);
  // 🚨 settingsLoaded だけでは通さない事
  const onlySettings = analyze(`
useEffect(() => {
    if (!canAutoFill(settingsLoaded, masterItems, X)) return;
    await saveData('lots', id, { tasks });
}, [lots, masterItems, settingsLoaded]);
const lotsLoaded = false;
`, '(settingsLoaded だけ)');
  say(onlySettings.problems.some((p) => p.kind === 'A3'),
    'settingsLoaded だけの effect を「ロットの読み込みを待った」と数えない');
  // 🚨 tasks に触る物は文言を強くする
  say(onlySettings.problems.some((p) => p.kind === 'A3' && p.msg.includes('丸ごと消える')),
    'tasks に触る物は「丸ごと消える」と名指しする');

  // ⚠負の対照 ①: 直した後は指摘ゼロ
  const after = analyze(AFTER_FIX, '(直した後)');
  say(after.problems.length === 0,
    `直した後: 指摘ゼロになる (実際 ${after.problems.length}件: ${after.problems.map((p) => `${p.kind}@${p.line}`).join(',')})`);

  // ⚠負の対照 ②: ロット以外への書き込みは白名簿で免除される(今までの働きを壊していない)
  const contact = analyze(`
const lotsLoaded = true;
useEffect(() => {
    if (r && !r.seenApp) saveData('contact_requests', detailId, { seenApp: { at: Date.now() } });
}, [detailId]);
`, '(連絡の既読)');
  say(contact.problems.length === 0,
    `負の対照: 連絡の既読印(ロット以外)は今まで通り免除される (実際 ${contact.problems.length}件)`);

  // ⚠負の対照 ③: ResizeObserver の watch(el, cb) を購読と数えない
  const resize = analyze(`
const lotsLoaded = true;
watch(headerElRef.current, setHeaderH);
watch(midTabsElRef.current, setMidTabsH);
`, '(ResizeObserver)');
  say(resize.problems.length === 0 && resize.noErrorSubs.length === 0,
    `負の対照: watch(el, cb) を Firestore の購読と数えない (実際 ${resize.problems.length + resize.noErrorSubs.length}件)`);

  // ⚠負の対照 ④: コメントの中の例示を実コードとして数えない
  const commented = analyze(`
const lotsLoaded = true;
// useEffect(() => { saveData('lots', id, { tasks: {} }); }, [lots]);
/* watch('lots', (rows) => setLots(rows)) */
`, '(コメントだけ)');
  say(commented.problems.length === 0,
    `負の対照: コメントの中の例示を実コードとして数えない (実際 ${commented.problems.length}件)`);

  // ⚠見張りが「何も見ていない」状態で合格しないこと
  say(before.problems.length > after.problems.length,
    '直す前より直した後の方が指摘が少ない(見張りが実際に効いている)');

  console.log(bad === 0 ? '🧪 見張り自身の試験: 合格' : `🧪 見張り自身の試験: ❌ ${bad}件 失敗`);
  return bad === 0;
};

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------
const main = (args) => {
  if (args.includes('--selftest')) return selftest() ? 0 : 1;

  // ⚠まず見張り自身の試験を通してから本番のコードを見る。
  //   壊れた物差しで測って「合格」と言わないため。
  if (!selftest()) {
    console.error('❌ 見張り自身が壊れているので、実コードの判定はしません。');
    return 1;
  }
  console.log('');

  // 🏠 現用の主ファイルは アプリごとに名前が違う(golden=src/App.firebase.jsx / 製品・部品=src/App.jsx)。
  //   ⚠ verify-promises.mjs の MAIN と **同じ決め方**にする(App.firebase.jsx が在ればそれ、無ければ App.jsx)。
  //   ⚠ 両方を並べて見ると、golden の休眠 src/App.jsx まで数えて赤が出っぱなしになる。
  //     見張りは「現用の1本」だけを見る。休眠を復活させる時は、ここも直す事。
  const MAIN_CANDIDATES = ['src/App.firebase.jsx', 'src/App.jsx'];
  const MAIN = MAIN_CANDIDATES.find((f) => fs.existsSync(f));
  const files = (args.filter((a) => !a.startsWith('--')).length
    ? args.filter((a) => !a.startsWith('--'))
    : (MAIN ? [MAIN] : [])).filter((f) => fs.existsSync(f));
  if (!files.length) { console.log('（対象のファイルが無いので省略）'); return 0; }

  let total = 0;
  for (const f of files) {
    const r = analyze(fs.readFileSync(f, 'utf8'), f);
    console.log(`📄 ${path.normalize(f)}   ロットの読み込みの門(lotsLoaded): ${r.hasLotsFlag ? '✅ ある' : '❌ 無い'}`);
    for (const p of r.problems) {
      console.log(`  ❌ [${p.kind}] ${f}:${p.line}`);
      console.log(`      ${p.msg}`);
      if (p.snippet) console.log(`      ${p.snippet}`);
      total++;
    }
    if (r.noErrorSubs.length) {
      console.log(`  ── onError の無い購読(lots 以外。数には入れないが、同じ事が起きる) ${r.noErrorSubs.length}件 ──`);
      r.noErrorSubs.forEach((x) => console.log(`      ・${f}:${x.line}  ${x.col}`));
    }
    console.log('');
  }

  if (!total) { console.log('✅ 読み込み待ちの見張り: 問題なし'); return 0; }
  console.log(`❌ ${total}件（A0=門が無い / A1=長さで判断 / A2=保存が待たない / A3=ロットへ書くのに lotsLoaded 無し / A4=lots の購読に onError 無し / A5=lots 以外の購読に onError 無し）`);
  console.log('⚠ この見張りを緩めて合格にしない。直すのは src 側(lotsLoaded を作って門にする)。');
  return 1;
};

// ⚠ここから下は「直接動かした時」だけ。import して analyze() だけ使う道を塞がない。
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) process.exit(main(process.argv.slice(2)));
