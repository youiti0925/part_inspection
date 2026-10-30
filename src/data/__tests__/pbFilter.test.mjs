// ============================================================================
// 🔒R19 PocketBase の絞り込み(filter)へ値を入れる時の直し方の試験(4アプリ共通・同じ中身)
// ----------------------------------------------------------------------------
// 以前は値の「"」だけを \" にしていて「\」を直していなかった。
// 使い捨ての本物 PocketBase 0.40.6 で 16通りの値を試した結果(round4/fexpr_records.txt):
//   以前の形 = 7/16 だけ正しい(値の最後が「\」→ 400、「\\」→ 別の記録 1件、など)
//   「\」→「\\」・「"」→「\"」の順の形 = 16/16 正しい・仕掛けの入った値でも他の記録は 0件
// ここでは、その本物の読み方(「\」の次の1字をそのまま取る)を写した読み手で、
// 作った filter が「元の値そのもの」として読まれ、式が増えない事を確かめる。
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pbQuote, pbFilter } from '../pbFilter.js';
import { createDocStore } from '../pbDocStore.js';
import { createPocketbaseBackend } from '../pocketbaseBackend.js';
import { createMemoryStore } from '../outbox.js';

const BS = String.fromCharCode(92);
const NASTY = [
  'plain', `a${BS}b`, `a${BS}`, BS, BS + BS, 'a"b', `a${BS}"b`, "a'b", `a${BS}'b`,
  'a && b || c', 'a\nb', 'a\r\nb', `x${BS}" || id!="`, '" || id!="', `" || id!='' || ns="`,
  `end${BS}${BS}`, `日本語"${BS}`, `${BS}"${BS}'${BS}`, '{:col}', '',
];

/**
 * 本物の PocketBase と同じ読み方で filter を字句に分ける(文字列・それ以外)。
 * 文字列: 「"」か「'」で始まり、「\」の次の1字はそのまま値に入れ、同じ引用符で閉じる。
 * 閉じない文字列は投げる(本物は 400)。
 */
const tokenize = (src) => {
  const out = []; let i = 0; let raw = '';
  const flush = () => { if (raw.trim()) out.push({ t: 'code', v: raw.trim() }); raw = ''; };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      flush();
      let v = ''; i++; let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === BS && i + 1 < src.length) { v += src[i + 1]; i += 2; continue; }
        if (c === ch) { closed = true; i++; break; }
        v += c; i++;
      }
      if (!closed) throw new Error('閉じていない文字列(本物は 400)');
      out.push({ t: 'str', v });
    } else { raw += ch; i++; }
  }
  flush();
  return out;
};

/** 以前の形(「"」だけ直す)。比べるためだけに置く。 */
const oldEsc = (v) => `"${String(v).replace(/"/g, BS + '"')}"`;

test('R19-1 pbQuote: どの値も、本物の読み方で「元の値そのもの」1つとして読まれる', () => {
  for (const v of NASTY) {
    const toks = tokenize(pbQuote(v));
    assert.deepEqual(toks, [{ t: 'str', v }], `値 ${JSON.stringify(v)} が崩れた`);
  }
});

test('R19-2 pbFilter: 仕掛けの入った値でも式の形は「ns=… && col=… && docId=…」のまま(条件が増えない)', () => {
  for (const ns of ['final-inspection-v1', `x${BS}`]) {
    for (const col of NASTY) {
      for (const docId of NASTY) {
        const f = pbFilter('ns={:ns} && col={:col} && docId={:docId}', { ns, col, docId });
        const toks = tokenize(f);
        assert.deepEqual(toks.map((x) => x.t), ['code', 'str', 'code', 'str', 'code', 'str'], `形が崩れた: ${f}`);
        assert.deepEqual(toks.filter((x) => x.t === 'code').map((x) => x.v), ['ns=', '&& col=', '&& docId='], `式が増えた: ${f}`);
        assert.deepEqual(toks.filter((x) => x.t === 'str').map((x) => x.v), [ns, col, docId]);
      }
    }
  }
});

test('R19-3 以前の形は「\\」の入った値で崩れていた(直す前の穴が本当にあった事の記録)', () => {
  // 値の最後が「\」 → 閉じない(本物は 400 = その書類が読めない・保存できない)
  assert.throws(() => tokenize(oldEsc(`a${BS}`)));
  // 「\\」 → 「\」1つと読まれ、別の記録(docId が「\」の物)を探す
  assert.deepEqual(tokenize(oldEsc(BS + BS)), [{ t: 'str', v: BS }]);
  // 書類名に「\\」 → 名前が1字違う別の書類(「\」1つの物)を探す = 読み・上書き・消しの相手を取り違える
  const f = `ns=${oldEsc('final-inspection-v1')} && col=${oldEsc('lots')} && docId=${oldEsc(`a${BS}${BS}b`)}`;
  assert.deepEqual(tokenize(f).filter((x) => x.t === 'str').map((x) => x.v), ['final-inspection-v1', 'lots', `a${BS}b`]);
  // 前の値の最後が「\」 → 次の条件の中身までが1つの値になり、式の形が崩れる(本物は 400)
  assert.throws(() => tokenize(`scope=${oldEsc(`doc:x${BS}`)} && claimId=${oldEsc('rev:1')}`));
});

test('R19-4 pbFilter: 置き換えは1回だけ・書き間違いは投げる・値が無ければ投げる', () => {
  assert.equal(pbFilter('a={:a} && b={:b}', { a: '{:b}', b: 'x' }), 'a="{:b}" && b="x"');
  assert.equal(pbFilter('rev={:r}', { r: 3 }), 'rev="3"');
  assert.throws(() => pbFilter('a={:a} && b={:b}', { a: 'x' }), /\{:b\}/);
  assert.throws(() => pbFilter('a={:a}', { a: 'x', b: 'y' }), /b/);
  assert.throws(() => pbQuote(undefined));
  assert.throws(() => pbQuote(null));
  assert.throws(() => pbQuote({}));
});

// --- 実際に filter を作る所が pbFilter を通っている事(偽の client で filter を拾う) --------
const recorder = () => {
  const seen = [];
  const client = {
    listPage: async (col, opts = {}) => { seen.push({ col, filter: opts.filter }); return { items: [], totalItems: 0, totalPages: 1 }; },
    listAll: async (col, opts = {}) => { seen.push({ col, filter: opts.filter }); return []; },
    remove: async () => true,
    create: async () => ({ id: 'x' }),
    whenReady: async () => {},
    isAuthed: () => true,
  };
  return { client, seen };
};

test('R19-5 保管庫(pbDocStore)の読み・消し・掃除の filter は、値をそのまま1つの文字列として渡す', async () => {
  for (const v of NASTY) {
    const { client, seen } = recorder();
    const store = createDocStore(client, { now: () => Date.parse('2026-10-31T00:00:00Z') });
    await store.getOne('final-inspection-v1', 'lots', v);
    await store.getAll('final-inspection-v1', v);
    await store.remove('final-inspection-v1', 'lots', v).catch(() => {});
    await store.pruneGates();
    await store.pruneClaims();
    assert.ok(seen.length >= 5, `filter を拾えていない(${seen.length})`);
    for (const { filter } of seen) {
      const strs = tokenize(filter).filter((x) => x.t === 'str').map((x) => x.v);
      const codes = tokenize(filter).filter((x) => x.t === 'code').map((x) => x.v).join(' ');
      assert.ok(!/\|\||!=/.test(codes), `式が増えた: ${filter}`);
      if (/^ns=/.test(filter)) assert.ok(strs.includes(v), `値 ${JSON.stringify(v)} がそのまま渡っていない: ${filter}`);
      if (/^scope=/.test(filter)) assert.ok(strs[0].endsWith(v), `門の名前に値がそのまま入っていない: ${filter}`);
    }
  }
});

test('R19-6 窓口(pocketbaseBackend)の一覧の読み込み・読み直しの filter も同じ', async () => {
  for (const v of NASTY) {
    const { client, seen } = recorder();
    const be = createPocketbaseBackend(client, { outboxStore: createMemoryStore(), autoRealtime: false });
    await be.refresh('final-inspection-v1', v);
    const docsFilters = seen.filter((s) => /^ns=/.test(s.filter || ''));
    assert.ok(docsFilters.length >= 1, '読み直しの filter を拾えていない');
    for (const { filter } of docsFilters) {
      assert.deepEqual(tokenize(filter).filter((x) => x.t === 'str').map((x) => x.v), ['final-inspection-v1', v], filter);
    }
    be.close();
  }
});

// --- 手で filter を組み立てている所が src に無い事 ----------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'assets') walk(p, out); }
    else if (/\.(m?js|jsx)$/.test(e.name) && !/\.test\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
};
// 起動していない旧版の画面(main.jsx が import していない App*.jsx)はビルドに入らないので外す。
// ⚠名前で決め打ちせず、main.jsx の生きている import から毎回決める(4アプリで同じ試験にするため)。
const entryApp = () => {
  const main = path.join(SRC, 'main.jsx');
  if (!fs.existsSync(main)) return null;
  const live = fs.readFileSync(main, 'utf8').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const m = live.match(/import\s+App\s+from\s+['"]\.\/(App[^'"]*)['"]/);
  return m ? (m[1].endsWith('.jsx') ? m[1] : `${m[1]}.jsx`) : null;
};

test('R19-7 src の中に、filter を手で組み立てている所(値を ${} で直に埋める・「"」だけ直す)が無い', () => {
  const live = entryApp();
  const files = walk(SRC).filter((f) => {
    const b = path.basename(f);
    if (b === 'pbFilter.js') return false;
    if (/^App(\..+)?\.jsx$/.test(b) && path.dirname(f) === SRC && live && b !== live) return false;
    return true;
  });
  assert.ok(files.length > 10, `src を歩けていない(${files.length})`);
  const BAD = [
    /filter\s*:\s*`[^`]*\$\{/,                       // filter: `ns="${x}"`
    /getFirstListItem\(\s*`[^`]*\$\{/,               // SDK の直書き
    /getList\([^)]*filter\s*:\s*`[^`]*\$\{/,
    /\.replace\(\/"\/g,\s*'\\\\"'\)/,                // 「"」だけ直す形
  ];
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (BAD.some((re) => re.test(line))) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], '手で組み立てた filter が残っている(pbFilter を使う)');
});
