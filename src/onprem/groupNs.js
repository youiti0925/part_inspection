// ============================================================================
// 🏯 最上位の司令塔 段2(社内サーバー版だけ): このアプリが「どのグループの口で開かれたか」を決める — 名前空間は onprem-config.json の `group` から
// ----------------------------------------------------------------------------
// 設計: golden-meteoroid/docs/設計_最上位司令塔_複数グループ_2026-11-01.md §2.5
//   ・入口(tools/onprem/https-front/server.mjs)は、新しいグループの口の onprem-config.json にだけ
//     `group: { key, type, ns, commander, state }` を1つ足す(ファイルには書けない・口ごとに入口が決める)。
//   ・`group` が **無い** 時だけ、今の決まった名前(例 final-inspection-v1)で動く = 今の4つの口は何も変わらない。
//   ・`group` が **有るのに形が悪い** 時(種類がこのアプリと違う・ns が <種類>-g-<key>-v1 でない・invalid の印)は、
//     **画面を止めて理由を出す**。今の名前へは落とさない(別のグループの棚に書いてしまうのが一番危ない・R18 の守りは緩めない)。
//   ・読めない(ネットワークの失敗・壊れた JSON)時も止める。「設定ファイルが無い(404)」だけは group 無し(開発用の起動)。
//
// 🚨 なぜ同期で読むか: 名前空間(APP_DATA_ID)は App のファイルの上の階層の定数で、App が import された時に決まる。
//   起動の設定は非同期(boot)で読むが、それより前に決まってしまう。だから最初の1回だけ **同期の XHR** で小さい設定を読む
//   (同じ口の onprem-config.json・数百バイト・入口のメモリから返る)。boot が後で読んだ設定とも突き合わせる(assertGroupMatches)。
// ⚠今の本番ビルド(__ONPREM__ = false)では呼ぶ所が畳まれ、ビルドに入らない。上の階層で何も実行しない(関数を置くだけ)。
// ⚠React も Firebase も使わない(node の試験から読める)。
// ============================================================================

export const GROUP_TYPES = ['final', 'product', 'parts'];
const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
/** 形の悪い group のとき名前空間に入れる値。PB のルールの許可に無いので、読み書きは1件も通らない(止める画面が先に出る)。 */
export const INVALID_NS = '__group_invalid__';

/**
 * onprem-config.json の中身(raw)から group を決める(純関数)。
 * @param raw     JSON を読んだ物(null = 設定が無い)
 * @param appType このアプリの種類 'final' | 'product' | 'parts'
 * @returns { state: 'none' } | { state: 'ok', group } | { state: 'bad', reason }
 */
export const parseGroup = (raw, appType) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'none' };
  if (!('group' in raw) || raw.group === undefined) return { state: 'none' };
  const g = raw.group;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return { state: 'bad', reason: 'group の形がオブジェクトではありません' };
  if (g.invalid === true) return { state: 'bad', reason: '入口がこの口のグループの設定を確かめられませんでした(group が無効の印)' };
  const { key, type, ns, commander, state } = g;
  if (typeof key !== 'string' || !KEY_RE.test(key)) return { state: 'bad', reason: 'group.key の形が違います(英数字と _ の40字まで)' };
  if (!GROUP_TYPES.includes(type)) return { state: 'bad', reason: 'group.type が final / product / parts のどれでもありません' };
  if (type !== appType) return { state: 'bad', reason: `このアプリは ${appType} 用ですが、この口のグループの種類は ${type} です(別の種類のアプリで開いています)` };
  if (ns !== `${type}-g-${key}-v1`) return { state: 'bad', reason: `group.ns が ${type}-g-${key}-v1 ではありません` };
  if (commander != null && (typeof commander !== 'string' || (commander !== '' && !KEY_RE.test(commander)))) return { state: 'bad', reason: 'group.commander の形が違います' };
  const st = state == null ? 'active' : state;
  if (st !== 'active' && st !== 'archived') return { state: 'bad', reason: 'group.state が active / archived のどちらでもありません' };
  return { state: 'ok', group: { key, type, ns, commander: commander || '', state: st } };
};

// 📴 2026-11-02 社内 LAN・サーバーに届かない時の起動(⚠清水さんの確認待ちの直し・本番へ出す前に決める)
// ----------------------------------------------------------------------------
// 同期の XHR は Service Worker の控えを通らない(Chrome で実測)ので、届かない時は今まで **全部の口で画面を止めていた**
// = 一度開いた端末でも、LAN が落ちると製品・最終・部品が開けなかった(2026-11-02 の出来事の原因の1つ)。
// 守り「前に覚えた名前空間へ落ちる道を作らない」は崩さない: **グループの名前空間は覚えない**。
// 覚えるのは「この口にはグループが無い(今の決まった名前で動く口)」の1ビットだけ(NO_GROUP_KEY)。
//   ・届いて group が無かった → 印を付ける / group が有った・形が悪かった → 印を消す
//   ・届かない(例外・status 0)時: 印が有れば group 無し(今の決まった名前)で開く。印が無ければ今まで通り止める
//     (= グループの口は、届かない時は今まで通り止まる。別のグループの棚に書く道は無い)
export const NO_GROUP_KEY = 'onprem.portHasNoGroup.v1';
const portStore = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
const notePortGroup = (parsed, storage) => {
  const st = storage || portStore();
  if (!st) return;
  try { if (parsed && parsed.state === 'none') st.setItem(NO_GROUP_KEY, '1'); else st.removeItem(NO_GROUP_KEY); } catch { /* 覚えられないだけ */ }
};
const portHadNoGroup = (storage) => { const st = storage || portStore(); try { return !!st && st.getItem(NO_GROUP_KEY) === '1'; } catch { return false; } };

/** 画面を止める時の文(日本語)。 */
export const stopMessage = (reason) => `この口のグループの設定が正しくないため、画面を止めました。データには何も書いていません。\n理由: ${reason}\n管理者に連絡してください(最上位の司令塔の台帳と、入口の設定を確かめます)。`;

/**
 * 最初の1回だけ、同じ口の onprem-config.json を同期で読む。
 * @param opts.xhrFactory 試験用(既定は XMLHttpRequest)
 * @param opts.baseUrl    既定は今の画面の場所(document.baseURI)
 * @returns { state, group?, reason? } + 読めなかった時 { state: 'bad', reason }
 */
export const readGroupSync = (appType, { xhrFactory = null, baseUrl = null, storage = null } = {}) => {
  let mk = xhrFactory;
  if (!mk && typeof XMLHttpRequest !== 'undefined') mk = () => new XMLHttpRequest();
  if (!mk) return { state: 'none' };   // node の試験・XHR が無い所
  let url = '';
  try {
    const base = baseUrl || (typeof document !== 'undefined' && document.baseURI) || '';
    if (!base) return { state: 'none' };
    url = new URL('./onprem-config.json', base).href;
  } catch { return { state: 'none' }; }
  try {
    const x = mk();
    x.open('GET', url, false);
    x.send(null);
    if (x.status === 0 && portHadNoGroup(storage)) return { state: 'none', offline: true };   // 📴 届かない・グループの無い口
    if (x.status === 404) return { state: 'none' };   // 設定ファイルが無い(開発用)。group は無い
    if (x.status !== 200) return { state: 'bad', reason: `onprem-config.json を読めません(${x.status})` };
    let raw;
    try { raw = JSON.parse(String(x.responseText || '').replace(/^\uFEFF/, '')); } catch { return { state: 'bad', reason: 'onprem-config.json が JSON として読めません' }; }
    const parsed = parseGroup(raw, appType);
    notePortGroup(parsed, storage);   // 📴 「グループの無い口」の印だけ
    return parsed;
  } catch (e) {
    if (portHadNoGroup(storage)) return { state: 'none', offline: true };   // 📴 届かない・グループの無い口(名前空間は今の決まった名前)
    return { state: 'bad', reason: `onprem-config.json を読めません(${(e && e.message) || e})` };
  }
};

let _early = null;
/** 最初の1回の結果(何回呼んでも同じ)。 */
export const earlyGroup = (appType, opts) => {
  if (!_early || _early.appType !== appType) _early = { appType, value: readGroupSync(appType, opts) };
  return _early.value;
};
/** 試験用: 覚えた結果を捨てる。 */
export const _resetEarlyGroup = () => { _early = null; };

/** 止める画面を出す(React を使わない)。 */
const paintStop = (reason) => {
  try {
    if (typeof document === 'undefined') return;
    const root = document.getElementById('root') || document.body;
    root.innerHTML = '';
    const d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.setAttribute('data-group-stop', '1');
    d.style.cssText = 'max-width:560px;margin:40px auto;padding:20px;border:2px solid #b91c1c;border-radius:12px;background:#fef2f2;color:#7f1d1d;font:15px/1.7 sans-serif;white-space:pre-wrap';
    d.textContent = stopMessage(reason);
    root.appendChild(d);
  } catch { /* 止める画面が出せなくても、下で投げて起動を止める */ }
};

/**
 * このアプリの名前空間。App のファイルの上の階層で `__ONPREM__ ? resolveAppNs('final-inspection-v1', 'final') : 'final-inspection-v1'` の形で呼ぶ。
 *   none → 今の名前 / ok → グループの ns / bad → 止める画面を出して **投げる**(起動を止める)
 */
export const resolveAppNs = (defaultNs, appType, opts) => {
  const g = earlyGroup(appType, opts);
  if (g.state === 'none') return defaultNs;
  if (g.state === 'ok') return g.group.ns;
  paintStop(g.reason);
  throw new Error(`グループの設定が正しくありません: ${g.reason}`);
};

/**
 * 共有の棚(capacity-shared-v1)の名前空間。今の口は今の共有の棚のまま。グループの口は **グループ自身の名前空間** の中に
 * 同じ形の棚(daily_load・plan_control・achieve_rate など)を置く = 元のアプリの docId('final' など)を上書きしない。
 *   @param nsMap routes.js の NS({ capacity: 'capacity-shared-v1', … })
 */
export const withGroupCapacity = (nsMap, appType, opts) => {
  const g = earlyGroup(appType, opts);
  if (g.state === 'ok') return { ...nsMap, capacity: g.group.ns };
  return nsMap;
};

/** 今の口が「しまってある(読むだけ)」グループか。 */
export const archivedGroupOf = (appType, opts) => {
  const g = earlyGroup(appType, opts);
  return g.state === 'ok' && g.group.state === 'archived' ? g.group : null;
};

/**
 * boot が非同期で読んだ設定(raw)と、最初の同期の読みが同じグループを指しているか確かめる。
 * 違えば { ok:false, reason }(boot が止める画面を出す)。
 */
export const assertGroupMatches = (raw, appType, opts) => {
  const early = earlyGroup(appType, opts);
  const now = parseGroup(raw, appType);
  if (now.state === 'bad') return { ok: false, reason: now.reason };
  if (early.state === 'bad') return { ok: false, reason: early.reason };
  const a = early.state === 'ok' ? early.group.ns : '';
  const b = now.state === 'ok' ? now.group.ns : '';
  if (a !== b) return { ok: false, reason: `起動の途中で、この口のグループの設定が変わりました(${a || '無し'} → ${b || '無し'})。開き直してください` };
  return { ok: true, reason: '' };
};

/** しまってあるグループの口に出す帯(React を使わない)。書き込みは PB のルールが断る。 */
export const showArchivedBand = (doc = (typeof document !== 'undefined' ? document : null), group) => {
  if (!doc || !group) return null;
  try {
    const el = doc.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('data-archived-band', '1');
    el.textContent = `「${group.key}」はしまってあります(読むだけ)。書き込みはサーバーが断ります。戻すのは最上位の司令塔の「しまったもの」から。`;
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147482500;background:#475569;color:#fff;padding:6px 12px;font:14px sans-serif;text-align:center';
    doc.body.appendChild(el);
    return el;
  } catch { return null; }
};

/** 止める画面を出す(boot が使う)。 */
export const stopWith = (reason) => paintStop(reason);

/**
 * 非同期版の突き合わせ: 同じ口の onprem-config.json をもう一度読み、起動の最初に決めた名前空間と同じか確かめる。
 * 読めない時は ok:false(404 は設定無し = group 無し)。@returns Promise<{ ok, reason }>
 */
export const verifyGroupAsync = (appType, { fetchImpl = null, baseUrl = null, opts = undefined } = {}) => {
  const f = fetchImpl || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  if (!f) return Promise.resolve({ ok: true, reason: '' });
  let url = '';
  try {
    const base = baseUrl || (typeof document !== 'undefined' && document.baseURI) || '';
    if (!base) return Promise.resolve({ ok: true, reason: '' });
    url = new URL('./onprem-config.json', base).href;
  } catch { return Promise.resolve({ ok: true, reason: '' }); }
  return Promise.resolve()
    .then(() => f(url, { cache: 'no-store' }))
    .then((res) => {
      if (res && res.status === 404) return assertGroupMatches(null, appType, opts);
      if (!res || !res.ok) return { ok: false, reason: `onprem-config.json を読めません(${res ? res.status : '応答なし'})` };
      return res.json().then((raw) => assertGroupMatches(raw, appType, opts), () => ({ ok: false, reason: 'onprem-config.json が JSON として読めません' }));
    })
    .catch((e) => ({ ok: false, reason: `onprem-config.json を読めません(${(e && e.message) || e})` }));
};
