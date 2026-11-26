#!/usr/bin/env node
// ============================================================================
// ⓪ 本番に出ている物を「消さない」見張り — 出す口(deploy.mjs)の一番手前
//
// ⚠⚠ なぜ作ったか（2026-11-03 の事故）:
//   最終検査を master から出したら、10-25/26 に別の枝(claude/fuzoku-deploy-20261026)から
//   本番へ出していた直し(背面カメラ・付属品の札・読み取り削減 ほか)が、
//   master に戻っていなかったので **黙って本番から消えた**。現場に怒られた。
//   10-14 には「コミットしていない作業ツリーのまま出した」直しも在った(後で dc2967d)。
//   → 同じ穴。**「いま本番に出ている版の変更は、出す物の中に全部入っている」を
//      出す前に機械で確かめる。** 人が思い出す必要が無い形にする。
//
// 決まり(全部、出す前に確かめる):
//   1. 作業ツリーに変更が残っている(追跡中のファイルが modified/staged)なら出さない。
//      「出す物はコミットである」。(.claude/ は道具の設定なので数えない)
//   2. git fetch --all(繋がらなければ警告して手元の枝だけで続ける)
//   3. 本番の印を読む: <site>/version.json → 無ければ <site>/ の <meta name="app-build">
//      commit(40桁)があればそれ、無ければ build の末尾の短いハッシュ。
//   4. 印が無い(印を入れて最初の1回)→ scripts/deploy-ledger.json の最後の commit。
//      それも無ければ **止まる**。初回の抜け道は --bootstrap-regress-check と --allow-regress "理由".
//   5. 本番の commit がこの PC に無い → **止まる**(本番はこの PC に無い版から出ている)。
//   6. 本番の commit が HEAD の祖先でない → **止まる**。消える変更と、それを持つ枝を出す。
//   7. 本番の印が dirty:true(コミットしていない変更ごと出した版)→ 残っているか証明できないので止まる。
//   8. 前回 master 以外の枝から出していて、その commit がまだ HEAD に入っていない(台帳 pendingMerge)→ 止まる。
//
// 通す為の唯一の道:  --allow-regress "<理由 20文字以上>"
//   ⚠⚠ これは **清水さんが了承した後にだけ** 使う事。理由は台帳に残り、画面に大きく出る。
//   ⚠ --skip-check では飛ばせない(①だけを飛ばす旗。⓪は別)。
//   ⚠ 作業ツリーの変更(1.)は --allow-regress でも通せない(コミットすれば済む為)。
//
// 使い方(単体):  node scripts/verify-no-regress.mjs [--allow-regress "理由…"] [--bootstrap-regress-check]
// 他のアプリにも **同じ中身** を置く(同じ物を4つ)。直す時は4つ同時に。
// ============================================================================
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_REASON = 20;
export const MAIN_BRANCHES = ['master', 'main'];
// 出す物に入らない道具の設定。ここが変わっていても「作業ツリーが汚れている」とは数えない。
export const IGNORED_DIRTY = [/^\.claude\//];

const HEX40 = /^[0-9a-f]{40}$/i;
const HEX_SHORT = /^[0-9a-f]{4,12}$/i;

// ---------------------------------------------------------------------------
// 純粋な部品(試験する物)
// ---------------------------------------------------------------------------

/** git status --porcelain の出力から「追跡中ファイルの変更」だけ取り出す(?? は数えない) */
export function parseDirtyTracked(porcelain) {
  const out = [];
  for (const raw of String(porcelain || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    if (code === '??' || code === '!!') continue;
    let file = raw.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop().trim();
    file = file.replace(/^"|"$/g, '');
    if (IGNORED_DIRTY.some((re) => re.test(file))) continue;
    out.push(file);
  }
  return out;
}

/** build 文字列 "YYYYMMDD-HHMMSS-<sha>" の末尾の短いハッシュ(無ければ '') */
export function shortShaFromBuild(build) {
  const m = /^\d{8}-\d{6}-([0-9a-f]{4,12})$/i.exec(String(build || '')); // 時刻だけの印(YYYYMMDD-HHMMSS)の6桁を hash と取り違えない
  return m ? m[1].toLowerCase() : '';
}

/** version.json の本文 → 印。読めなければ null(SPA が HTML を返した場合もここで null) */
export function parseStampJson(text) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.build !== 'string' || !j.build) return null;
  const commit = typeof j.commit === 'string' && HEX40.test(j.commit) ? j.commit.toLowerCase() : '';
  return {
    build: j.build,
    commit,
    short: commit ? commit.slice(0, 7) : shortShaFromBuild(j.build),
    dirty: j.dirty === true,
    builtAt: typeof j.builtAt === 'string' ? j.builtAt : '',
    source: 'version.json',
  };
}

/** index.html の <meta name="app-build" content="…"> → 印(commit/dirty は分からない) */
export function parseStampHtml(html) {
  const m = /<meta\s+[^>]*name=["']app-build["'][^>]*>/i.exec(String(html || ''));
  if (!m) return null;
  const c = /content=["']([^"']+)["']/i.exec(m[0]);
  if (!c) return null;
  return {
    build: c[1], commit: '', short: shortShaFromBuild(c[1]), dirty: false, builtAt: '', source: 'meta app-build',
  };
}

/** 台帳の最後の「commit を持つ」控え(40桁)。無ければ null */
export function lastLedgerCommit(ledger) {
  const bs = Array.isArray(ledger?.builds) ? ledger.builds : [];
  for (let i = bs.length - 1; i >= 0; i--) {
    const c = bs[i]?.commit;
    if (typeof c === 'string' && HEX40.test(c)) return { commit: c.toLowerCase(), branch: bs[i].branch || '', at: bs[i].at || '' };
  }
  return null;
}

/** 台帳の pendingMerge の控えのうち、HEAD に入っていない物(isAncestor: (sha)=>true|false|null。null=この PC に無い) */
export function pendingMergeUnresolved(ledger, isAncestor) {
  const out = [];
  for (const b of Array.isArray(ledger?.builds) ? ledger.builds : []) {
    if (b?.pendingMerge !== true || !HEX40.test(String(b.commit || ''))) continue;
    const r = isAncestor(b.commit);
    if (r !== true) out.push({ commit: b.commit, branch: b.branch || '', at: b.at || '', missingLocally: r === null });
  }
  return out;
}

export function validReason(reason) {
  return typeof reason === 'string' && [...reason.trim()].length >= MIN_REASON;
}

/** 旗の読み取り。--allow-regress "理由" / --allow-regress=理由 */
export function parseFlags(argv) {
  const a = Array.isArray(argv) ? argv : [];
  let allow = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--allow-regress') { allow = a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : ''; }
    else if (a[i].startsWith('--allow-regress=')) allow = a[i].slice('--allow-regress='.length);
  }
  return { allowRegress: allow, bootstrap: a.includes('--bootstrap-regress-check') };
}

/**
 * 判定(純粋)。入力が全部そろった後で「通す/止める」を決める。
 *  in: {
 *   dirtyFiles: string[],
 *   live: 印 | null,             // 本番の印(version.json か meta)
 *   ledgerLast: {commit}|null,   // 台帳の最後の commit
 *   liveKnown: boolean|null,     // 本番の commit がこの PC に在るか
 *   liveIsAncestor: boolean|null,
 *   pending: [{commit,branch,at,missingLocally}],
 *   flags: {allowRegress, bootstrap}
 *  }
 *  out: { ok, stops:[{code,msg}], warnings:[], bypass:null|{reason,codes,bootstrap}, basis }
 */
export function decide(input) {
  const { dirtyFiles = [], live = null, ledgerLast = null, liveKnown = null, liveIsAncestor = null, pending = [], flags = {} } = input;
  const stops = [];
  const warnings = [];
  const soft = []; // --allow-regress で通せる止め
  let basis = 'none';

  if (dirtyFiles.length) {
    stops.push({
      code: 'DIRTY_TREE',
      msg: `作業ツリーに変更が残っています(${dirtyFiles.length}件: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ' …' : ''})。先にコミットする事。出す物はコミットである事(--allow-regress でも通せません)。`,
    });
  }

  const haveLive = !!(live && (live.commit || live.short));
  if (haveLive) basis = live.source;
  else if (ledgerLast) basis = 'deploy-ledger.json';

  if (!haveLive && !ledgerLast) {
    if (flags.bootstrap) {
      warnings.push('本番の印も台帳の commit も無い。--bootstrap-regress-check により「commit 不明」として進みます(今回限り。出した版から印が入ります)。');
      basis = 'bootstrap';
      if (!validReason(flags.allowRegress)) {
        stops.push({ code: 'BOOTSTRAP_NEEDS_REASON', msg: `--bootstrap-regress-check には --allow-regress "理由(${MIN_REASON}文字以上)" が要ります。` });
      }
    } else {
      stops.push({
        code: 'NO_BASIS',
        msg: '本番に版の印(version.json の build/commit)が無く、台帳(scripts/deploy-ledger.json)にも commit の控えが有りません。\n'
          + '   これは「印を入れて最初の1回」です。いま本番に何が出ているか証明できないので止めます。\n'
          + '   最初の1回だけ: node scripts/deploy.mjs --bootstrap-regress-check --allow-regress "<理由 20文字以上: 本番の中身を目で確かめた等>"\n'
          + '   (二回目からは、出した版の印で自動で照合されます)',
      });
    }
  } else if (basis !== 'bootstrap') {
    const sha = haveLive ? (live.commit || live.short) : ledgerLast.commit;
    if (liveKnown === false) {
      soft.push({
        code: 'LIVE_UNKNOWN',
        msg: `本番の版(${sha})はこの PC に有りません(fetch しても無い)。本番は、この PC に無い枝/作業場所から出された版です。\n   出した作業場所(worktree)か枝を探して、そこを取り込んでから出す事。`,
      });
    } else if (liveIsAncestor === false) {
      soft.push({
        code: 'NOT_ANCESTOR',
        msg: `本番の版(${sha})は、これから出す HEAD の祖先ではありません。出すと、その版にだけ在る変更が本番から消えます。\n   (消える変更と、それを持つ枝は下に出します。先にそれを取り込む事)`,
      });
    }
    if (haveLive && live.dirty) {
      soft.push({
        code: 'LIVE_DIRTY',
        msg: `本番の版の印が dirty:true(コミットしていない変更ごと出された版: ${live.build})。\n   その変更が HEAD に入っているか証明できません。`,
      });
    }
  }

  for (const p of pending) {
    soft.push({
      code: 'PENDING_MERGE',
      msg: `前回 ${p.branch || '(枝不明)'} から出した版(${p.commit.slice(0, 7)}・${p.at})がまだ master に戻っていません${p.missingLocally ? '(その commit はこの PC に無い)' : ''}。先に master へ戻す事。`,
    });
  }

  let bypass = null;
  if (soft.length) {
    if (validReason(flags.allowRegress)) {
      bypass = { reason: flags.allowRegress.trim(), codes: soft.map((s) => s.code), bootstrap: false };
      for (const s of soft) warnings.push(`[--allow-regress で通す] ${s.msg}`);
    } else {
      stops.push(...soft);
      if (flags.allowRegress !== null && flags.allowRegress !== undefined) {
        stops.push({ code: 'REASON_TOO_SHORT', msg: `--allow-regress の理由が ${MIN_REASON}文字に足りません。` });
      }
    }
  }
  if (basis === 'bootstrap' && validReason(flags.allowRegress)) {
    bypass = { reason: flags.allowRegress.trim(), codes: ['BOOTSTRAP'], bootstrap: true };
  }
  return { ok: stops.length === 0, stops, warnings, bypass, basis };
}

// ---------------------------------------------------------------------------
// 本物の git / 通信を使う部分(deps で差し替え可能)
// ---------------------------------------------------------------------------
const gitOut = (root, args) => {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') };
  }
};

export function realDeps(root) {
  return {
    status: () => gitOut(root, ['status', '--porcelain', '--untracked-files=no']).out,
    fetchAll: () => gitOut(root, ['fetch', '--all', '--quiet']).ok,
    resolve: (rev) => {
      const r = gitOut(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
      return r.ok ? r.out.trim() : null;
    },
    isAncestor: (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }).status === 0,
    logRange: (range) => gitOut(root, ['log', '--oneline', range]).out.trim(),
    branchesContaining: (sha) => gitOut(root, ['branch', '-a', '--contains', sha, '--format=%(refname:short)']).out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    head: () => gitOut(root, ['rev-parse', 'HEAD']).out.trim(),
    branch: () => gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim(),
    httpGet: async (url) => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store', signal: ctl.signal });
        const body = await r.text();
        clearTimeout(t);
        return { status: r.status, body };
      } catch (e) {
        return { status: 0, body: '', error: String(e.message || e) };
      }
    },
    readLedger: () => {
      const p = join(root, 'scripts', 'deploy-ledger.json');
      if (!existsSync(p)) return null;
      try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
    },
  };
}

export async function readLiveStamp(baseUrl, deps) {
  if (!baseUrl) return { stamp: null, note: '出し先の住所が分からない' };
  const v = await deps.httpGet(`${baseUrl}/version.json`);
  if (v.status === 200) {
    const s = parseStampJson(v.body);
    if (s) return { stamp: s, note: '' };
  }
  const h = await deps.httpGet(`${baseUrl}/`);
  if (h.status === 200) {
    const s = parseStampHtml(h.body);
    if (s) return { stamp: s, note: 'version.json が読めず meta から読んだ' };
  }
  const reached = v.status || h.status;
  return { stamp: null, note: reached ? `本番に印が無い(version.json ${v.status} / 表紙 ${h.status})` : `本番に繋がらない(${v.error || h.error || '不明'})` };
}

/**
 * ⓪ 本体。deps を差し替えて試験できる。
 * 戻り: { ok, result(decide の戻り), lines(画面に出す行), ledgerNote(台帳の控えに足す物) }
 */
export async function runStage0({ root, baseUrl, argv = [], deps = realDeps(root), log = console.log }) {
  const flags = parseFlags(argv);
  const say = (s = '') => log(s);

  say('⓪ 🧱 本番の変更を消さないか(出す物は、いま本番に出ている物を全部含むか)');

  const dirtyFiles = parseDirtyTracked(deps.status());

  let fetched = deps.fetchAll();
  if (!fetched) say('  ⚠ git fetch --all に失敗(オフライン?)。手元に在る枝だけで確かめます。');

  const { stamp, note } = await readLiveStamp(baseUrl, deps);
  if (note) say(`  ・本番の印: ${note}`);
  if (stamp) say(`  ・本番の印: ${stamp.build}${stamp.commit ? ` (commit ${stamp.commit.slice(0, 7)})` : ''}${stamp.dirty ? ' ⚠dirty' : ''}  [${stamp.source}]`);

  const ledger = deps.readLedger();
  const ledgerLast = lastLedgerCommit(ledger);
  if (!stamp?.short && ledgerLast) say(`  ・台帳の最後の commit: ${ledgerLast.commit.slice(0, 7)} (${ledgerLast.branch || '枝不明'} ${ledgerLast.at})`);

  const head = deps.head();
  const branch = deps.branch();
  say(`  ・出す物: ${head.slice(0, 7)} (${branch})`);

  const liveRef = stamp?.commit || stamp?.short || ledgerLast?.commit || '';
  let liveFull = null;
  let liveKnown = null;
  let liveIsAncestor = null;
  if (liveRef) {
    liveFull = deps.resolve(liveRef);
    liveKnown = !!liveFull;
    if (liveKnown) liveIsAncestor = deps.isAncestor(liveFull, head);
  }

  const pending = pendingMergeUnresolved(ledger, (sha) => (deps.resolve(sha) ? deps.isAncestor(sha, head) : null));

  const result = decide({ dirtyFiles, live: stamp, ledgerLast, liveKnown, liveIsAncestor, pending, flags });

  for (const w of result.warnings) say(`  ⚠ ${w}`);

  if (!result.ok) {
    say('');
    say('🛑🛑🛑 ⓪ で止まりました。本番に出ている変更が消える(または消えない証明が無い)ので出しません。');
    for (const s of result.stops) say(`  ❌ [${s.code}] ${s.msg}`);
    if (liveFull && liveIsAncestor === false) {
      const lost = deps.logRange(`${head}..${liveFull}`);
      say('');
      say(`  ▼ 消えてしまう変更(git log --oneline HEAD..${liveFull.slice(0, 7)}):`);
      say(lost ? lost.split('\n').map((l) => `     ${l}`).join('\n') : '     (なし: 枝の分かれ方だけが違う)');
      const br = deps.branchesContaining(liveFull);
      say(`  ▼ その版を含む枝: ${br.length ? br.join(', ') : '(無い: 枝の名前が付いていない版。reflog / worktree を探す)'}`);
      say(`  ▼ 直し方: 上の枝を先に ${MAIN_BRANCHES[0]} へ merge してから、出す物を作り直す。`);
    }
    if (pending.length) {
      say('  ▼ master に戻っていない出荷:');
      for (const p of pending) say(`     ${p.commit.slice(0, 7)}  ${p.branch}  ${p.at}`);
    }
    if (result.stops.some((x) => x.code !== 'DIRTY_TREE')) {
      say('');
      say('  どうしても通すなら: --allow-regress "<理由 20文字以上>"');
      say('  ⚠⚠ この旗は **清水さんが了承した後にだけ** 使う事。理由は台帳に残り、画面に出ます。');
    }
    return { ok: false, result, ledgerNote: null };
  }

  let ledgerNote = null;
  if (result.bypass) {
    say('');
    say('🔶🔶🔶 --allow-regress で ⓪ を通しています。');
    say(`   理由: ${result.bypass.reason}`);
    say(`   通した止め: ${result.bypass.codes.join(', ')}`);
    say('   ⚠⚠ この旗は **清水さんが了承した後にだけ** 使う事。理由は台帳に残します。');
    ledgerNote = { regressBypass: { reason: result.bypass.reason, codes: result.bypass.codes, bootstrap: result.bypass.bootstrap } };
    if (result.bypass.bootstrap) {
      // いま本番に出ている部品の控え(commit 不明として)
      const idx = await deps.httpGet(`${baseUrl}/`);
      const assets = [...new Set([...String(idx.body || '').matchAll(/(?:src|href)=["']\.?\/?(assets\/[^"']+)["']/g)].map((m) => m[1]))];
      ledgerNote.regressBypass.liveBefore = { commit: 'unknown', assets };
    }
  } else {
    say(`  ✅ ⓪ 通過: 本番の版(${(liveFull || '').slice(0, 7) || '印なし'})は出す物の祖先です。`);
  }
  return { ok: true, result, ledgerNote };
}

/** ⑤ 用: この出荷の控え(commit/枝/pendingMerge)。branch が master 系以外なら pendingMerge */
export function ledgerFields({ head, branch, dirty = false }) {
  const pendingMerge = !!branch && branch !== 'HEAD' ? !MAIN_BRANCHES.includes(branch) : true;
  return { commit: head, branch, dirty, ...(pendingMerge ? { pendingMerge: true } : {}) };
}

export function mergeReminderLines(branch) {
  return [
    '🔔🔔🔔 今日中に、この枝を master に戻す事!',
    `   いま本番に出ている版は「${branch}」から出ました(master ではない)。`,
    '   master に戻さないまま次を master から出すと、今日の直しが本番から消えます(2026-11-03 の事故)。',
    '   台帳に pendingMerge として控えました。戻すまで、次の出荷は ⓪ が止めます。',
  ];
}

/** ビルドの印(vite.config から使う)。dirty = 追跡中のファイルが変わっている(.claude/ は数えない) */
export function collectBuildStamp({ now = new Date(), cwd = process.cwd(), exec = null } = {}) {
  const run = exec || ((args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }));
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let commit = '';
  let dirty = false;
  try { commit = String(run(['rev-parse', 'HEAD'])).trim(); } catch { commit = ''; }
  if (!HEX40.test(commit)) commit = '';
  try { dirty = parseDirtyTracked(run(['status', '--porcelain', '--untracked-files=no'])).length > 0; } catch { dirty = false; }
  const short = commit.slice(0, 7);
  const build = HEX_SHORT.test(short) ? `${stamp}-${short}` : stamp;
  return { build, commit, dirty, builtAt: now.toISOString() };
}

// ---------------------------------------------------------------------------
// 単体で動かす時
// ---------------------------------------------------------------------------
const isMain = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = process.env.DEPLOY_SAFETY_ROOT || join(HERE, '..');
  const { appConfig } = await import('./verify-deploy-safety.mjs');
  const c = appConfig()[0];
  const r = await runStage0({ root: ROOT, baseUrl: c?.baseUrl || '', argv: process.argv.slice(2) });
  process.exit(r.ok ? 0 : 1);
}
