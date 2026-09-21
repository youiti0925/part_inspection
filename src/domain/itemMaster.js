// 品目名簿 (品目コード → 品名) の純関数。2026-09-21
//
// 部品検査の「型式」は 2本立て:
//   品目コード  = lot.model      … 部品単体のコード。集計の鍵。ドットが入る (例: MB-200.5)
//   品名        = lot.modelText  … 品目テキスト。人が読む名前。集計の鍵には絶対にしない
//
// 名簿 settings.itemMaster = { [品目コード]: 品名 }
//
// 🚨 直す前は、この名簿を **読む所が3箇所あるのに書く所が1つも無かった**。
//    つまり名簿は「在るのに永久に空」で、品名は毎回手で打つしかなく、
//    同じ品目コードでも人によって品名がばらついていた。
//
// ⚠ 品目コードにはドットが入るので、消す時は必ず配列パス(__deleteMapKeys)で。
//    'itemMaster.MB-200.5' のドット区切り文字列では **何も消えない**。

const str = (v) => String(v == null ? '' : v).trim();

export function normalizeItemCode(v) { return str(v); }
export function normalizeItemName(v) { return str(v); }

/** 名簿として使える形に整える (空の鍵・空の名前は捨てる) */
export function normalizeItemMaster(itemMaster) {
  const out = {};
  if (!itemMaster || typeof itemMaster !== 'object') return out;
  for (const [k, v] of Object.entries(itemMaster)) {
    const code = normalizeItemCode(k);
    const name = normalizeItemName(v);
    if (code && name) out[code] = name;
  }
  return out;
}

/**
 * ロットに出す品名。
 * ロット自身の品目テキストが最優先。空なら名簿で補う。どちらも無ければ空。
 * ⚠ 読む所3箇所が同じ順序で決めるように、ここ1本にまとめる。
 */
export function resolveItemName(model, modelText, itemMaster) {
  const own = normalizeItemName(modelText);
  if (own) return own;
  const code = normalizeItemCode(model);
  if (!code) return '';
  return normalizeItemName((itemMaster || {})[code]);
}

/** 品目コードごとに、ロットの数と、ロットが名乗っている品名を数える */
function countByCode(lots) {
  const map = new Map(); // code -> { lotCount, names: Map<name, n> }
  for (const lot of (Array.isArray(lots) ? lots : [])) {
    const code = normalizeItemCode(lot && lot.model);
    if (!code) continue;
    let e = map.get(code);
    if (!e) { e = { lotCount: 0, names: new Map() }; map.set(code, e); }
    e.lotCount += 1;
    const nm = normalizeItemName(lot && lot.modelText);
    if (nm) e.names.set(nm, (e.names.get(nm) || 0) + 1);
  }
  return map;
}

/** 一番多く名乗られている品名 (同数なら先に出た方) */
function topName(names) {
  let best = '';
  let bestN = 0;
  for (const [nm, n] of names) { if (n > bestN) { best = nm; bestN = n; } }
  return best;
}

/**
 * 名簿の一覧。使っているロットの数つき。品目コード順。
 * ⚠ ロットの数は countByCode 1本からだけ出す (同じ数字を2つの計算から出さない)。
 */
export function itemMasterRows(itemMaster, lots) {
  const master = normalizeItemMaster(itemMaster);
  const counts = countByCode(lots);
  return Object.keys(master).sort((a, b) => a.localeCompare(b)).map((code) => ({
    code,
    name: master[code],
    lotCount: (counts.get(code) || { lotCount: 0 }).lotCount,
  }));
}

/**
 * ロットには出てくるのに名簿に無い品目コード。
 * suggestedName = そのコードのロットが一番多く名乗っている品名 (無ければ空)。
 * ロットの多い順 → コード順。
 */
export function unregisteredItems(itemMaster, lots) {
  const master = normalizeItemMaster(itemMaster);
  const counts = countByCode(lots);
  const out = [];
  for (const [code, e] of counts) {
    if (master[code]) continue;
    out.push({
      code,
      lotCount: e.lotCount,
      suggestedName: topName(e.names),
      suggestions: Array.from(e.names.keys()),
    });
  }
  out.sort((a, b) => (b.lotCount - a.lotCount) || a.code.localeCompare(b.code));
  return out;
}

/**
 * 名簿の品名と、ロットが名乗っている品名が食い違っている物。
 * 「同じ品目コードなのに人によって品名が違う」を見つける窓。
 * 名簿に載っているコードだけを見る (載っていない物は unregisteredItems の担当)。
 */
export function itemNameConflicts(itemMaster, lots) {
  const master = normalizeItemMaster(itemMaster);
  const counts = countByCode(lots);
  const out = [];
  for (const [code, e] of counts) {
    const masterName = master[code];
    if (!masterName) continue;
    const others = Array.from(e.names.entries()).filter(([nm]) => nm !== masterName);
    if (!others.length) continue;
    out.push({
      code,
      masterName,
      lotNames: others.map(([nm, n]) => ({ name: nm, lotCount: n })),
      lotCount: others.reduce((s, [, n]) => s + n, 0),
    });
  }
  out.sort((a, b) => (b.lotCount - a.lotCount) || a.code.localeCompare(b.code));
  return out;
}

/**
 * 名簿に1件入れた後の名簿を返す (元は触らない)。
 * 空のコード・空の名前は受け付けない (null を返す)。
 */
export function withItem(itemMaster, code, name) {
  const c = normalizeItemCode(code);
  const n = normalizeItemName(name);
  if (!c || !n) return null;
  return { ...normalizeItemMaster(itemMaster), [c]: n };
}

/** 名簿から1件抜いた名簿を返す (元は触らない) */
export function withoutItem(itemMaster, code) {
  const c = normalizeItemCode(code);
  const next = normalizeItemMaster(itemMaster);
  delete next[c];
  return next;
}
