// =============================================================================
//  operationsSimulation/simInputDoc.js — 相手の工場の「計算の入力」を共有棚に置く形(2026-09-15)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-15):「両方働ける人のやつで変更したら同時に両方の納期一覧見えるように
//    するって話なんで無視するの？」
//  相手の納期一覧を **こちらで引き直す** には、相手の計算の材料(normalizeInput の戻り)が要る。
//  日ごとの合計(daily_load)だけでは、置き分けた後の相手の行は作れない。
//
//  🚨 この file は **切って繋ぐだけ**。時計を読まない・数を作らない・中身を書き替えない。
//  🚨 欠けた時は null を返す(半分だけ読んで「相手の納期一覧です」と出さない)。
//
//  実測(2026-09-15 写し・製品検査 ロット138件/仕事1771件):
//    Worker へ渡している生の入力 1017KB / normalizeInput の戻り(normalized) 957.7KB
//      内訳 jobs 651KB(1771件)・lots 315KB(104件)・残り 13KB
//    → 1件1MB の決まりに対して **2枚**に切れば入る。ロットが増えると枚数も増える。
//
//  🚨 切るのは **UTF-8 のバイト** で。文字の数で切ると 日本語は1文字3バイトなので
//     70万文字 = 約2MB になり、1MB の決まりを黙って超える(設計書の型紙の穴)。
//     文字の途中でも 上位/下位の代用対(サロゲート)の途中でも切らない。
// =============================================================================

/** 1枚の本文の上限(バイト)。1MB の決まりに対して、鍵の名前や索引の分の余白を取る。 */
export const SIM_INPUT_CHUNK_BYTES = 700 * 1024;
/** 枚数の上限。これを超える入力は **置かない**(黙って途中まで置かない)。 */
export const SIM_INPUT_MAX_CHUNKS = 12;
/** 置き場の collection 名(共有棚 capacity-shared-v1 の中)。 */
export const SIM_INPUT_COL = 'sim_input';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));

/** 1文字の UTF-8 のバイト数(代用対は呼ぶ側が2文字まとめて渡す)。 */
const utf8LenOfCode = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/**
 * UTF-8 のバイト数で切る。**文字の途中でも代用対の途中でも切らない**。
 * @param {string} s
 * @param {number} maxBytes 1枚の上限(バイト)
 * @returns {string[]} 切った本文(順番どおり)。空文字は1枚の空を返す
 */
export function splitByUtf8Bytes(s, maxBytes = SIM_INPUT_CHUNK_BYTES) {
  const text = str(s);
  const cap = Math.max(4, Math.trunc(Number(maxBytes)) || SIM_INPUT_CHUNK_BYTES);
  if (text === '') return [''];
  const out = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i);
    const wide = cp > 0xffff;          // 代用対(2文字で1つ)
    const n = utf8LenOfCode(cp);
    if (bytes + n > cap && i > start) { out.push(text.slice(start, i)); start = i; bytes = 0; }
    bytes += n;
    i += wide ? 2 : 1;
  }
  out.push(text.slice(start));
  return out;
}

/** UTF-8 のバイト数を数える(切る前に「入るか」を見る為)。 */
export function utf8Bytes(s) {
  const text = str(s);
  let n = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    n += utf8LenOfCode(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

/** 本文の書類の id。索引は `${app}`、本文は `${app}_c0` `${app}_c1` …。 */
export function simInputChunkId(app, i) { return `${str(app)}_c${Math.max(0, Math.trunc(Number(i)) || 0)}`; }

/**
 * normalizeInput の戻りを、共有棚に置ける形へ切る。
 * 🚨 中身は1バイトも書き替えない(JSON にして切るだけ)。
 * @param {object} p
 * @param {object} p.normalized normalizeInput の戻り
 * @param {'product'|'final'} p.app どの工場の物か
 * @param {number} p.nowMs 書いた時刻(**呼ぶ側が渡す**。ここで時計を読まない)
 * @param {number} [p.maxBytes]
 * @param {number} [p.maxChunks]
 * @returns {{ok:boolean, why:string, index:object|null, chunks:Array<{app:string,i:number,text:string}>}}
 */
export function buildSimInputDocs({ normalized = null, app = '', nowMs = null, maxBytes = SIM_INPUT_CHUNK_BYTES, maxChunks = SIM_INPUT_MAX_CHUNKS } = {}) {
  const fail = (why) => ({ ok: false, why, index: null, chunks: [] });
  if (!isObj(normalized)) return fail('計算の入力がありません');
  if (!str(app)) return fail('どの工場の物か分かりません');
  // 🚨 Number(null) は 0 で、0 は「有限の数」。null を弾かずに Number.isFinite だけ見ると
  //   時刻を渡し忘れた書類が 1970年1月1日 として置かれる(2026-09-15 自分で踏んだ)。
  if (nowMs == null || nowMs === '' || !Number.isFinite(Number(nowMs))) return fail('書いた時刻が渡されていません');
  let json = '';
  try { json = JSON.stringify(normalized); } catch { return fail('計算の入力を字にできません'); }
  if (typeof json !== 'string' || json === '') return fail('計算の入力を字にできません');
  const bytes = utf8Bytes(json);
  const cap = Math.max(4, Math.trunc(Number(maxBytes)) || SIM_INPUT_CHUNK_BYTES);
  const lim = Math.max(1, Math.trunc(Number(maxChunks)) || SIM_INPUT_MAX_CHUNKS);
  // 🚨 先に枚数を見て、超えるなら **置かない**。途中まで置くと、読む側が
  //    「欠けている」と分かっても 前の回の古い本文と混ざる。
  if (bytes > cap * lim) return fail(`計算の入力が大きすぎます（${Math.round(bytes / 1024)}KB・上限 ${Math.round((cap * lim) / 1024)}KB）`);
  const parts = splitByUtf8Bytes(json, cap);
  if (parts.length > lim) return fail(`計算の入力が大きすぎます（${parts.length}枚・上限 ${lim}枚）`);
  const index = {
    app: str(app),
    writtenAt: Number(nowMs),
    fingerprint: str(normalized.inputFingerprint),
    chunks: parts.length,
    bytes,
    horizonEnd: Number.isFinite(Number(normalized.horizonEnd)) ? Number(normalized.horizonEnd) : null,
    now: Number.isFinite(Number(normalized.now)) ? Number(normalized.now) : null,
    jobCount: Array.isArray(normalized.jobs) ? normalized.jobs.length : null,
    lotCount: Array.isArray(normalized.lots) ? normalized.lots.length : null,
  };
  return {
    ok: true,
    why: '',
    index,
    chunks: parts.map((text, i) => ({ app: str(app), i, text, fingerprint: index.fingerprint })),
  };
}

/**
 * 索引と本文から 計算の入力を戻す。**1枚でも欠けたら null**。
 * 🚨 指紋が違う本文が混ざっていたら null(前の回の本文と今回の本文を繋がない)。
 * @param {object|null} index
 * @param {Array<object>} chunkDocs
 * @returns {object|null}
 */
export function joinSimInputDocs(index, chunkDocs) {
  if (!isObj(index)) return null;
  const want = Math.trunc(Number(index.chunks));
  if (!Number.isFinite(want) || want < 1) return null;
  const list = Array.isArray(chunkDocs) ? chunkDocs.filter(isObj) : [];
  const byI = new Map();
  for (const c of list) {
    const i = Math.trunc(Number(c.i));
    if (!Number.isFinite(i) || i < 0 || i >= want) return null;      // 知らない番号が混ざっている
    if (str(c.fingerprint) && str(index.fingerprint) && str(c.fingerprint) !== str(index.fingerprint)) return null;
    if (byI.has(i)) return null;                                      // 同じ番号が2枚
    byI.set(i, str(c.text));
  }
  if (byI.size !== want) return null;                                 // 欠けている
  let json = '';
  for (let i = 0; i < want; i += 1) json += byI.get(i);
  if (Number.isFinite(Number(index.bytes)) && utf8Bytes(json) !== Number(index.bytes)) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/** 索引だけを見て「今こちらで引き直せるか」を言う。文は画面で作らない。 */
export function simInputText({ index = null, label = '向こうの工場' } = {}) {
  if (!isObj(index)) return `${label}の計算の材料は届いていません（${label}アプリを一度開くと届きます）`;
  const kb = Number.isFinite(Number(index.bytes)) ? `${Math.round(Number(index.bytes) / 1024)}KB` : '大きさ不明';
  const lots = Number.isFinite(Number(index.lotCount)) ? `${index.lotCount}件` : '—';
  return `${label}の計算の材料が届いています（ロット ${lots}・${kb}・${index.chunks}枚）`;
}

export default buildSimInputDocs;
