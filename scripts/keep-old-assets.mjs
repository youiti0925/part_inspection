/**
 * keep-old-assets.mjs — 前のビルドの assets を本番から消さないための仕掛け
 * ===========================================================================
 *
 * 【何が起きたか(2026-08-17 実測)】
 *   本番 https://inspection-time-c4fd3.web.app/assets/ を叩いたら
 *     index-D4LMK6Kl.js  → text/html   (消えている)
 *     index-Dp0LoHux.js  → text/html   (消えている)
 *     index-MOelDncI.js  → text/html   (消えている)
 *     index-xjtw4ujW.js  → text/javascript (今の物だけ本物)
 *
 *   原因は2つが重なった事:
 *     (1) `firebase deploy` は dist の中身で本番を丸ごと置き換える。
 *         Vite はビルドのたびにファイル名のハッシュを変えるので、
 *         前のビルドの .js/.css は本番から「消える」。
 *     (2) firebase.json の rewrites が "source": "**" だったので、
 *         消えたファイルにも index.html(HTML) を返していた。
 *
 *   結果、8/12 から開きっぱなしだった端末が 8/17 に遅延ロードのチャンクを取りに行き、
 *   HTML を <script> として読んで構文エラー → アプリが起動しない →
 *   その端末に貯まっていた 8/12 の作業の書き込みが送られないまま になった。
 *   5日で19回デプロイした事が引き金。
 *
 *   (2) は firebase.json の rewrites を `!/@(assets|notice-assets)/**` にして
 *   「無い物は素直に 404」に直した。このスクリプトは (1) の側の手当て。
 *
 * 【やる事】
 *   デプロイのたびに dist/assets の中身を .hosting-attic/assets/ に貯め、
 *   デプロイ直前に「まだ捨てていない過去のファイル」を dist/assets に戻す。
 *   これで前のビルドの成果物も一緒に本番へ上がり、開きっぱなしの端末が
 *   自分の掴んでいるファイル名を取りに来ても 404 にならない。
 *
 * 【なぜこの方式にしたか】
 *   ▼ 採らなかった案1: vite.config.js に `build.emptyOutDir: false`
 *       - dist が一切掃除されなくなり、際限なく太る(止める仕掛けが無い)。
 *       - ハッシュの付かない物(manifest.json 等)を public/ から消しても
 *         dist に居座り、本番に出続ける。「消したのに消えない」が起きる。
 *       - `npm run build` の出力が毎回違う物になり、検査やテストが当てにならない。
 *       → dist は「今のビルドそのもの」で綺麗なままにしたいので不採用。
 *
 *   ▼ 採らなかった案2: デプロイ前に本番の assets を落としてきて混ぜる
 *       - 本番にどのファイルが在るかを一覧するには Hosting REST API と
 *         OAuth トークンが要る。デプロイの道に「通信」と「資格情報」が増える。
 *       - 失敗した時、止めれば出荷できない/黙って飛ばせば事故が戻る、の二択になる。
 *       - そもそも同じ物が手元にある(このPCからデプロイしている)。
 *       → 依存を増やす割に得が無いので不採用。
 *
 *   ▼ 採った案: 手元に「置き場(.hosting-attic)」を作り、ファイル名で1個ずつ貯める
 *       - 通信なし・資格情報なし・失敗しても原因が見える。
 *       - Vite は中身が変わったファイルだけ名前が変わるので、変わっていない
 *         チャンク(exceljs 等)は同じ名前=1個しか貯まらない。実際の増分は小さい。
 *
 * 【どれだけ残すか — 「直近N世代」ではなく「直近N日」にした理由】
 *   今回の事故は「5日間 開きっぱなしの端末」が壊れた事故。
 *   その5日で19回デプロイしている(1日約4回)。
 *   もし「直近5世代」で残していたら 5 ÷ 4 ≒ 1.3日分しか残らず、
 *   **今回の事故は防げなかった**。守るべきなのはビルドの回数ではなく「日数」。
 *   → 既定は 90日。デプロイ回数が増えても守る期間は変わらない。
 *
 * 【30日 → 90日 へ延ばした(2026-08-30)。lastSeen は わざと据え置く】
 *   lastSeen は「最後にビルドに入っていた日」。持ち越しただけでは更新しない。
 *   ⚠これは間違いではなく、わざとそうしてある。
 *     持ち越すたびに更新すると、一度でも出した部品の期限が永久に先送りされ、
 *     置き場が「今まで出した物 全部」になって、捨てる仕掛けが意味を失う。
 *   つまり 8/17 の部品の時計は、その後 何回デプロイしても 8/17 から動かない。
 *   ⇒ 時計を止める側ではなく **時計を長くする側** で手当てする。
 *     開きっぱなしの端末が起動しなくなる方が比べものにならず重いので、長い側に倒す。
 *   4アプリ(製品/最終/部品/司令塔③)とも同じ既定にしてある。
 *
 * 【上限を 300MB → 1000MB にした(2026-08-30)。実測で決め直した】
 *   ⚠「置き場は 8個 6.1MB」は **部品検査だけ**の数字だった。4アプリの実測は:
 *       製品検査 150.8MB(135個) / 最終検査 193.9MB(165個) /
 *       部品検査 6.1MB(8個)     / 司令塔③ 1.7MB(4個)      … 合わせて 約352MB
 *     増え方は4アプリ合わせて 1日 約20.5MB。
 *   300MB のままだと 製品は約12日後(9/11頃)、最終は約13日後(9/12頃)に上限へ触り、
 *   **日数(90日)より先に「容量」で 8/17 の部品から捨てられる**所だった。
 *   4アプリは Firebase のプロジェクトを1つ共有していて、置き場の枠は合わせて10GB。
 *     90日ぶん貯めても 352 + 20.5×90 ≒ 2.2GB。4アプリ×1000MB でも最悪 4GB。枠の中。
 *   🚨 上限は「決まり」ではなく **安全弁**。
 *     上限で捨てる形になったら、それは「デプロイが多すぎる」か「束が大きすぎる」の合図で、
 *     静かに捨てて良い場面ではない。だから捨てる時は名指しで出し、台帳にも残す。
 *
 * 【上限の 70% を超えたら、触る前に言う】
 *   日数の警告(14日前)は「日で捨てる」ぶんしか見ない。
 *   容量で捨てる方は、上限に触ったその時に初めて分かるのでは遅い。
 *   合計が上限の 70% を超えたら「このまま増えると 日数より先に 容量で捨てる」と出し、
 *   **次に捨てられる(一番古い)部品を名指しする**。⚠これも赤にはしない。
 *
 * 【もうすぐ捨てる物は、捨てる前に名指しで出す】
 *   30日では足りなかった事に今まで気付けなかったのは、**見えていなかった**から。
 *   期限まで 14日以内 の部品が有ったら、デプロイのたびに
 *     「あと◯日で捨てます: <名前> (最後にビルドに入っていたのは YYYY-MM-DD)」
 *   と名指しで出す。⚠**赤にはしない**。出荷を止める話ではなく、見せる為の物。
 *
 * 【捨てた物は必ず台帳に残す】
 *   捨てた部品は scripts/deploy-ledger.json の "lost" に {name, at, why} で足す。
 *   ⚠ 既に在る形に合わせる(新しい形は作らない)。何を・いつ・何日経ったから捨てたか。
 *   lost に載った名前は verify-deploy-safety の「生きている部品」から外れるので、
 *   捨てた事で見張り(D3)が嘘の赤を出す事も無い。
 *
 * 【際限なく太らないように】
 *   ・90日より古く、かつ今のビルドに入っていないファイルは捨てる。
 *   ・それでも合計が上限(既定 1000MB)を超えたら、古い順に捨てる。
 *   ・今のビルドに入っているファイルは絶対に捨てない。
 *   環境変数で変えられる: HOSTING_ATTIC_DAYS / HOSTING_ATTIC_MAX_MB
 *
 * 【忘れたら出せない形にしてある】
 *   firebase.json の hosting.predeploy に
 *       "npm run build", "node scripts/keep-old-assets.mjs"
 *   を入れてある。firebase-tools は predeploy が 0 以外で終わるとデプロイを中止する
 *   (node_modules/firebase-tools/lib/deploy/lifecycleHooks.js: code !== 0 → reject)。
 *   なので `npm run deploy` でも、素の `firebase deploy` でも必ずここを通る。
 *   人が思い出す必要は無い。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');
const ATTIC = path.join(ROOT, '.hosting-attic');
const ATTIC_ASSETS = path.join(ATTIC, 'assets');
const INDEX_FILE = path.join(ATTIC, 'index.json');
// 📒 捨てた部品を控える先。deploy.mjs / verify-deploy-safety.mjs と同じファイル・同じ形。
const DEPLOY_LEDGER = path.join(ROOT, 'scripts', 'deploy-ledger.json');

const RETAIN_DAYS = numFromEnv('HOSTING_ATTIC_DAYS', 90);
const MAX_MB = numFromEnv('HOSTING_ATTIC_MAX_MB', 1000);
const MAX_BYTES = MAX_MB * 1024 * 1024;
/** 期限まで これ以下 の日数になったら、捨てる前に名指しで出す。⚠赤にはしない。 */
const WARN_DAYS = 14;
/** 置き場の合計が 上限の これ以上 になったら、触る前に言う。⚠これも赤にはしない。 */
const WARN_FULL_RATIO = 0.7;

function numFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`環境変数 ${name} の値が数として読めない: ${JSON.stringify(raw)}`);
  }
  return n;
}

function fail(message) {
  console.error('');
  console.error('  keep-old-assets: 中止しました。');
  console.error(`  ${message}`);
  console.error('');
  process.exit(1);
}

/** dir 以下のファイルを、dir からの相対パス(スラッシュ区切り)の一覧で返す。 */
function walk(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function mtimeIsoOf(file) {
  try {
    return new Date(fs.statSync(file).mtime).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function copyInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function humanMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** ISO の日時を YYYY-MM-DD に。読めない物は「不明」と言う(それらしい日付を作らない)。 */
function dayOf(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '不明';
}

/** lastSeen から数えて、あと何日で捨てるか。読めない物は 0(=次に捨てる)。 */
function daysLeftOf(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.ceil((t + RETAIN_DAYS * 864e5 - Date.now()) / 864e5));
}

/**
 * 📒 捨てた部品を台帳(scripts/deploy-ledger.json)の "lost" に足す。
 *   ⚠ 形は既に在る物に合わせる: { name: 'assets/…', at: 'YYYY-MM-DD', why: '…' }
 *   ⚠ ここで例外を投げてデプロイを止めない。控えられなかった事は必ず言う。
 */
function recordLost(entries) {
  if (entries.length === 0) return;
  const say = (msg) => {
    console.warn(`  ⚠ keep-old-assets: 捨てた ${entries.length}個を台帳に控えられませんでした(${msg})。`);
    console.warn(`     控える先: ${DEPLOY_LEDGER}`);
    for (const e of entries) console.warn(`     ⚰ ${e.name} … ${e.why}`);
  };
  if (!fs.existsSync(DEPLOY_LEDGER)) {
    say('台帳のファイルが無い');
    return;
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(DEPLOY_LEDGER, 'utf8'));
  } catch {
    say('台帳が読めない');
    return;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    say('台帳の中身が思っていた形ではない');
    return;
  }
  if (!Array.isArray(doc.lost)) doc.lost = [];
  const already = new Set(doc.lost.map((x) => x && x.name).filter(Boolean));
  let wrote = 0;
  for (const e of entries) {
    if (already.has(e.name)) continue;
    doc.lost.push(e);
    already.add(e.name);
    wrote += 1;
  }
  try {
    fs.writeFileSync(DEPLOY_LEDGER, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  } catch (err) {
    say(`台帳に書けない: ${err && err.message ? err.message : err}`);
    return;
  }
  console.log(`    📒 台帳に控えた      : ${wrote}個 (scripts/deploy-ledger.json の "lost")`);
}

// ---------------------------------------------------------------------------
// 0. 前提の確認。dist が無い/空のまま本番へ出すと全部消えるので、必ず止める。
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  fail(
    'dist/index.html が見つかりません。ビルドされていない dist をデプロイしかけています。\n' +
      '  `npm run deploy` を使ってください(build → このスクリプト → deploy の順に必ず走ります)。'
  );
}

const current = walk(DIST_ASSETS);
if (current.length === 0) {
  fail(
    `dist/assets に1つもファイルがありません (${DIST_ASSETS})。\n` +
      '  ビルドが途中で失敗している可能性があります。このまま出すと本番の assets が全部消えます。'
  );
}

// ---------------------------------------------------------------------------
// 1. 置き場の台帳を読む。壊れていても止まらず作り直す(デプロイを妨げない)。
// ---------------------------------------------------------------------------
fs.mkdirSync(ATTIC_ASSETS, { recursive: true });

/** @type {Record<string, { lastSeen: string, size: number }>} */
let ledger = {};
if (fs.existsSync(INDEX_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
      ledger = parsed.files;
    }
  } catch {
    console.warn('  keep-old-assets: 台帳(index.json)が読めなかったので作り直します。');
    ledger = {};
  }
}

// 台帳と実体のずれを直す(手で消された/手で置かれた場合の保険)。
const atticFilesNow = new Set(walk(ATTIC_ASSETS));
for (const rel of Object.keys(ledger)) {
  if (!atticFilesNow.has(rel)) delete ledger[rel];
}
for (const rel of atticFilesNow) {
  if (!ledger[rel]) {
    const abs = path.join(ATTIC_ASSETS, rel);
    ledger[rel] = { lastSeen: mtimeIsoOf(abs), size: sizeOf(abs) };
  }
}

// ---------------------------------------------------------------------------
// 2. 今のビルドを置き場に記録する。今のビルドが常に正。
// ---------------------------------------------------------------------------
const nowIso = new Date().toISOString();
const currentSet = new Set(current);
let added = 0;

for (const rel of current) {
  const src = path.join(DIST_ASSETS, rel);
  const dst = path.join(ATTIC_ASSETS, rel);
  const srcSize = sizeOf(src);
  // 同じ名前で中身の大きさが違う = ハッシュの付かないファイルが差し替わった。今の物で上書きする。
  if (!fs.existsSync(dst) || sizeOf(dst) !== srcSize) {
    copyInto(src, dst);
    added += 1;
  }
  ledger[rel] = { lastSeen: nowIso, size: srcSize };
}

// ---------------------------------------------------------------------------
// 3. 捨てる。まず「古い物」、それでも上限を超えるなら「古い順」。
//    今のビルドに入っている物は絶対に捨てない。
// ---------------------------------------------------------------------------
const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
const dropped = [];
/** 台帳(deploy-ledger.json)へ控える分。捨てた物は1個残らずここに積む。 */
const lostEntries = [];
const today = nowIso.slice(0, 10);

function drop(rel, why, ledgerWhy) {
  const lastSeen = ledger[rel] ? ledger[rel].lastSeen : undefined;
  try {
    fs.rmSync(path.join(ATTIC_ASSETS, rel), { force: true });
  } catch {
    /* 消せなくても台帳から外せば次回もう一度試す */
  }
  delete ledger[rel];
  dropped.push({ rel, why, lastSeen });
  // 📒 名前は台帳の書き方に合わせる(置き場の中は assets/ を外した相対パスで持っている)。
  lostEntries.push({
    name: rel.startsWith('assets/') ? rel : `assets/${rel}`,
    at: today,
    why: ledgerWhy(dayOf(lastSeen)),
  });
}

for (const rel of Object.keys(ledger)) {
  if (currentSet.has(rel)) continue;
  const seen = Date.parse(ledger[rel].lastSeen);
  if (!Number.isFinite(seen) || seen < cutoff) {
    const ageDays = Number.isFinite(seen) ? Math.floor((Date.now() - seen) / 864e5) : null;
    drop(
      rel,
      `${RETAIN_DAYS}日より古い`,
      (seenDay) =>
        `keep-old-assets が置き場から捨てた。最後にビルドに入っていたのは ${seenDay}` +
        `${ageDays === null ? '(日付が読めなかった)' : `(${ageDays}日前)`}で、保管の ${RETAIN_DAYS}日 を過ぎた。` +
        'この名前を掴んだままの端末は、これ以降 404 になる。' +
        '戻すなら当時のコミットの再ビルド(Vite は同じ出力を再現する)。'
    );
  }
}

const totalBytes = () => Object.values(ledger).reduce((sum, v) => sum + (v.size || 0), 0);
let cappedBySize = 0;
if (totalBytes() > MAX_BYTES) {
  const oldestFirst = Object.keys(ledger)
    .filter((rel) => !currentSet.has(rel))
    .sort((a, b) => Date.parse(ledger[a].lastSeen) - Date.parse(ledger[b].lastSeen));
  for (const rel of oldestFirst) {
    if (totalBytes() <= MAX_BYTES) break;
    drop(
      rel,
      `上限 ${MAX_MB}MB 超え`,
      (seenDay) =>
        `keep-old-assets が置き場から捨てた。最後にビルドに入っていたのは ${seenDay}。` +
        `保管の ${RETAIN_DAYS}日 にはまだ達していないが、置き場の上限 ${MAX_MB}MB を超えたので古い順に捨てた。` +
        'この名前を掴んだままの端末は、これ以降 404 になる。' +
        '戻すなら当時のコミットの再ビルド(Vite は同じ出力を再現する)。'
    );
    cappedBySize += 1;
  }
}

// ---------------------------------------------------------------------------
// 4. 置き場に残っている過去のファイルを dist/assets へ戻す。
//    今のビルドのファイルは絶対に上書きしない。
// ---------------------------------------------------------------------------
let restored = 0;
for (const rel of Object.keys(ledger)) {
  if (currentSet.has(rel)) continue;
  const dst = path.join(DIST_ASSETS, rel);
  if (fs.existsSync(dst)) continue;
  copyInto(path.join(ATTIC_ASSETS, rel), dst);
  restored += 1;
}

// ---------------------------------------------------------------------------
// 5. 台帳を書き戻して結果を出す。
// ---------------------------------------------------------------------------
fs.writeFileSync(
  INDEX_FILE,
  `${JSON.stringify({ updatedAt: nowIso, retainDays: RETAIN_DAYS, maxMB: MAX_MB, files: ledger }, null, 2)}\n`,
  'utf8'
);

const kept = Object.keys(ledger).length;

// 実際に何日ぶん守れているか。設定値ではなく「置き場に残っている一番古い物」から数える。
// ⚠設定を 30日 にしても、容量の上限が先に効けば実際の守備範囲はもっと短くなる。
//   それを黙って短くすると「設定してあるのに守れていない」事に気付けないので、必ず出す。
let oldestMs = Date.now();
for (const v of Object.values(ledger)) {
  const t = Date.parse(v.lastSeen);
  if (Number.isFinite(t) && t < oldestMs) oldestMs = t;
}
const actualDays = Math.floor((Date.now() - oldestMs) / 864e5);

console.log('  keep-old-assets:');
console.log(`    今回のビルド        : ${current.length}個 (新しく貯めた ${added}個)`);
console.log(`    過去分を戻した      : ${restored}個`);
console.log(`    捨てた              : ${dropped.length}個${dropped.length ? ` (${dropped[0].why} など)` : ''}`);
// 🚨 捨てた物は数だけにしない。何を捨てたのかが分からないと、後から追えない。
for (const d of dropped) {
  console.log(`      ⚰ ${d.rel} (最後にビルドに入っていたのは ${dayOf(d.lastSeen)} / ${d.why})`);
}
recordLost(lostEntries);
console.log(`    置き場の合計        : ${kept}個 / ${humanMB(totalBytes())} (上限 ${MAX_MB}MB, 設定 ${RETAIN_DAYS}日)`);
console.log(`    本番へ出る assets   : ${current.length + restored}個`);
console.log(`    実際に守れている幅  : 約 ${actualDays}日ぶん (一番古い持ち越しが ${actualDays}日前)`);

// ---------------------------------------------------------------------------
// 6. もうすぐ捨てる物を、捨てる前に名指しで出す。
//    ⚠ 赤にしない(出荷を止める話ではない)。今まで見えていなかったから気付けなかった。
//    ⚠ lastSeen は持ち越しでは更新しないので、この日数は デプロイしても伸びない。
// ---------------------------------------------------------------------------
const soon = [];
for (const [rel, v] of Object.entries(ledger)) {
  if (currentSet.has(rel)) continue; // 今のビルドに入っている物は期限が今日から数え直し
  const left = daysLeftOf(v.lastSeen);
  if (left <= WARN_DAYS) soon.push({ rel, left, seenDay: dayOf(v.lastSeen) });
}
soon.sort((a, b) => a.left - b.left || a.rel.localeCompare(b.rel));

if (soon.length > 0) {
  console.log('');
  console.log(`  ⚠ もうすぐ捨てる部品が ${soon.length}個 あります(期限まで ${WARN_DAYS}日以内)。`);
  for (const s of soon) {
    console.log(`     あと${s.left}日で捨てます: ${s.rel} (最後にビルドに入っていたのは ${s.seenDay})`);
  }
  console.log('     ⚠これは出荷を止める話ではありません。捨てる前に見せているだけです。');
  console.log('     捨てた後は、この名前を掴んだままの端末が 404 になって起動しなくなります。');
  console.log('     打ち手は2つ。どちらかを選んでください:');
  console.log(`       (1) その端末の画面を再読み込みしてもらう … 新しい名前を掴み直すので、捨てても影響しません`);
  console.log(`       (2) 保管を延ばす … 例: HOSTING_ATTIC_DAYS=180 (今は ${RETAIN_DAYS}日)`);
}

// ---------------------------------------------------------------------------
// 7. 上限の 70% を超えたら、触る前に言う。
//    ⚠ 日数の警告(6)は「日で捨てる」ぶんしか見ない。容量で捨てる方は、
//      上限に触った時に初めて分かるのでは遅い。→ 手前で、次に捨てる物を名指しする。
//    ⚠ これも赤にしない。
// ---------------------------------------------------------------------------
const usedBytes = totalBytes();
if (usedBytes >= MAX_BYTES * WARN_FULL_RATIO) {
  // 次に捨てられるのは「今のビルドに入っていない物のうち 一番古い物」。捨てる順と同じ数え方。
  const evictable = Object.keys(ledger)
    .filter((rel) => !currentSet.has(rel))
    .sort((a, b) => Date.parse(ledger[a].lastSeen) - Date.parse(ledger[b].lastSeen));
  const first = evictable[0];
  const pct = Math.round((usedBytes / MAX_BYTES) * 100);
  console.log('');
  console.log(`  ⚠ 置き場が ${humanMB(usedBytes)} / 上限 ${MAX_MB}MB (${pct}%)。`);
  console.log('     このまま増えると、日数より先に**容量で**古い部品から捨てられます。');
  if (first) {
    console.log(`     いま一番古いのは ${first} (最後にビルドに入っていたのは ${dayOf(ledger[first].lastSeen)})`);
  } else {
    console.log('     いま持ち越している部品は有りません(置き場は今のビルドだけ)。');
  }
  console.log('     ⚠これは出荷を止める話ではありません。触る前に見せているだけです。');
  console.log('     ⚠上限は「決まり」ではなく安全弁です。ここに来たら、');
  console.log('       「デプロイが多すぎる」か「束が大きすぎる」かのどちらかを疑ってください。');
  console.log(`       上限を上げるなら: HOSTING_ATTIC_MAX_MB=2000 (今は ${MAX_MB}MB)`);
}

if (cappedBySize > 0) {
  console.log('');
  console.log(`  ⚠ 容量の上限(${MAX_MB}MB)が先に効いて、${cappedBySize}個を設定の ${RETAIN_DAYS}日より早く捨てました。`);
  console.log(`     いま実際に守れているのは 約 ${actualDays}日ぶんです(設定は ${RETAIN_DAYS}日)。`);
  console.log('     ⚠これより長く開きっぱなしの端末は、やはり起動しなくなります。');
  console.log('     打ち手は2つ。どちらかを選んでください:');
  console.log(`       (1) 上限を上げる … 例: HOSTING_ATTIC_MAX_MB=2000 (今の2倍)`);
  console.log('       (2) デプロイの回数を減らす … 1日4回出すと1世代あたりの寿命が短くなります');
}
