// ============================================================================
// 🔎 動画の中を「言葉で探す」— いま在る文字だけで作る
// ----------------------------------------------------------------------------
// ⚠⚠ この機能は、前提が一度ひっくり返っている。ここを読まずに直さないこと。
//
//   最初の設計:「AIが聞き取った字幕から探す」
//   ところが **本番の実データを数えたら前提が崩れた**:
//     ・手本動画は 製品検査5本・最終検査0本
//     ・字幕も章も **1件も入っていない**(video_recipes を実測)
//   清水さん「動画でしゃべる前提なの？ 現場で本当にしゃべりながら仕事する事って
//            本当に可能で、やってるの？」
//   市場も「現場で喋りながら」は難しいと認めている。tebiki は
//   「製造現場の機械音のように撮影時の周辺環境が音声収録を難しくするケース」を
//   名指しして **後から声を吹き込む** 機能を持ち、さらに **字幕をAIが読み上げる**
//   機能まである(＝出演者が喋らない前提)。
//
//   → **喋る前提で作らない。** 探す材料の主役は「もう手で書いてある文字」。
//     AIの聞き取りは **在れば足す** おまけ。無くても機能が成り立つこと。
//
// 作業者から見て何が起きるか:
//   「ノギスの当て方どこだっけ」と打つ → 当てはまる要点が並ぶ → 押すとその秒から再生。
//   30分の動画を頭から見なくてよくなる。
//
// ⚠⚠ AIの聞き取りを出す時は、必ず「AIが聞き取った言葉」と分かる形で出す。
//   根拠は映像(押したらその秒へ飛ぶ)。AIの文そのものを事実として扱わない。
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
// ============================================================================

import { approxBytes } from './lotCapacity.js';
// 📍章の形は2つ在る(編集室 {name,atOut} / 手本レシピ {label,start})。読み替えは1本に寄せる。
import { normChapter } from './videoProject.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const txt = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const r2 = (v) => Math.round(num(v, 0) * 100) / 100;

/**
 * 探せる言葉の種類。
 * ⚠⚠ weight = 「当たった時、どれくらい上に出すか」。
 *   手で書いた 急所/作業手順 が いちばん当たる(人が「ここが要る」と思って書いた文だから)。
 *   AIの聞き取りは いちばん下(間違って聞き取っている事がある)。
 */
export const WORD_KINDS = [
  { key: 'step', label: '作業手順', weight: 5 },
  { key: 'point', label: '急所', weight: 5 },
  { key: 'why', label: '急所の理由', weight: 4 },
  { key: 'chapter', label: '章（工程）', weight: 4 },
  { key: 'caption', label: '字幕', weight: 3 },
  { key: 'text', label: 'テロップ', weight: 3 },
  { key: 'voice', label: 'あとから吹き込んだ言葉', weight: 3 },
  // ⚠⚠ 名前に必ず「AI」を残す。画面でこの名前をそのまま出すため。
  { key: 'ai', label: 'AIが聞き取った言葉', weight: 1 },
];
const KIND_MAP = Object.fromEntries(WORD_KINDS.map(k => [k.key, k]));

export const kindLabel = (k) => (KIND_MAP[k] ? KIND_MAP[k].label : 'その他');
export const kindWeight = (k) => (KIND_MAP[k] ? KIND_MAP[k].weight : 1);
/** 手で書いた物(＝いちばん当たる物)か。切り詰める時に最後まで残す。 */
export const isHandWritten = (k) => kindWeight(k) >= 4;

// ---------------------------------------------------------------------------
// 言葉のならし
// ---------------------------------------------------------------------------
/**
 * 探す時に「打ち方の違い」で外さないよう、両側を同じ形にならす。
 *   ・全角/半角、大文字/小文字   → NFKC + 小文字
 *   ・カタカナ/ひらがな          → ひらがなに寄せる（ノギス = のぎす）
 *   ・句読点・カッコ・空白        → 落とす
 * ⚠長音「ー」は落とさない。落とすと「コード」と「コド」が同じ物になる。
 * ⚠ここは辞書を持たない。「当て方」と「あて方」は別物のまま(誤魔化して当てない)。
 */
export const normJa = (s) => {
  let t = String(s == null ? '' : s);
  try { t = t.normalize('NFKC'); } catch { /* 古い端末。ならさずに進む */ }
  t = t.toLowerCase();
  // カタカナ(ァ〜ヶ) → ひらがな。⚠長音「ー」(U+30FC)はこの範囲の外なので残る。
  t = t.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // ⚠全角の空白(U+3000)は `\s` に含まれる。字として書くと見えないので書かない(lintも止める)。
  t = t.replace(/[\s、。，．・｡､「」『』（）()[\]{}【】〈〉《》!?！？"'`~〜:;：；\\/|+*=#$%&@…‥\-–—_]/g, '');
  return t;
};

/** 打った言葉を語に割る。⚠全角の空白でも割れること(日本語の入力では全角が出る = `\s` が拾う)。 */
export const queryTokens = (q) => String(q == null ? '' : q)
  .split(/\s+/)
  .map(normJa)
  .filter(Boolean);

// ---------------------------------------------------------------------------
// 材料を集める
// ---------------------------------------------------------------------------
/**
 * 探せる言葉を、いま在る物から全部集める。
 * @param input.project   編集の中身 { clips, overlays, notes }
 * @param input.timeline  timelineOf(project) の結果(出来上がりの秒を知るため)
 * @param input.chapters  [{name, atOut}]
 * @param input.transcript [{at, text}] … AIの聞き取り(**出来上がりの秒**に直した後の物)
 *
 * ⚠ id は決め打ちで作る(Math.random を使わない)。
 *   同じ編集なら毎回同じ id になる = 保存し直しても鍵が入れ替わらない。
 */
export const collectWords = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const p = src.project && typeof src.project === 'object' ? src.project : {};
  const clips = Array.isArray(p.clips) ? p.clips : [];
  const tl = Array.isArray(src.timeline) ? src.timeline : [];
  const out = [];
  const add = (kind, text, atOut, ref, extra = {}) => {
    const t = txt(text);
    if (!t) return;                                    // ⚠空欄は拾わない(空の行が並ぶと探す気が失せる)
    if (!Number.isFinite(Number(atOut))) return;       // ⚠押しても飛べない結果を作らない
    out.push({ id: `${kind}:${ref}`, kind, text: t, atOut: r2(Math.max(0, num(atOut, 0))), ref, ...extra });
  };

  // ⏸止め絵 / 🖼画像 に手で書いた 作業手順・急所・急所の理由・字幕
  clips.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    if (c.type !== 'freeze' && c.type !== 'image') return;
    const at = tl[i] ? num(tl[i].outStart, 0) : 0;
    const ref = c.id || `c${i + 1}`;
    add('step', c.step, at, ref);
    add('point', c.point, at, ref);
    add('why', c.why, at, ref);
    add('caption', c.caption, at, ref);
  });

  // 章の名前。⚠⚠ 章の形は2つ在る(編集室 {name,atOut} / 手本レシピ {label,start})。
  //   読み替えは domain/videoProject.js の normChapter 1本に寄せる。
  //   前はここが {name,atOut} しか読まなかったので、**手本レシピの章は索引に1件も入らなかった**。
  // ⚠鍵は「元の並びの番号」のまま(ch0/ch1…)。詰めると保存済みの索引と食い違う。
  (Array.isArray(src.chapters) ? src.chapters : []).forEach((c, i) => {
    const ch = normChapter(c);
    if (!ch) return;
    add('chapter', ch.name, ch.atOut, `ch${i}`);
  });

  // 焼き込むテロップ。⚠印・目隠し・スポットには文字が無い。拾わない。
  (Array.isArray(p.overlays) ? p.overlays : []).forEach((o, i) => {
    if (!o || typeof o !== 'object' || o.kind !== 'text') return;
    add('text', o.text, num(o.from, 0), o.id || `o${i + 1}`);
  });

  // あとから吹き込んだ言葉。⚠⚠ **鍵つきの入れ物(map)** から読む。
  //   多端末で同じ動画を触る。配列に足す作りだと、後から保存した端末が
  //   相手の分を丸ごと消す(後勝ち)。
  const notes = p.notes && typeof p.notes === 'object' && !Array.isArray(p.notes) ? p.notes : {};
  for (const [key, n] of Object.entries(notes)) {
    if (!n || typeof n !== 'object') continue;
    const kind = KIND_MAP[n.kind] ? n.kind : 'voice';
    add(kind, n.text, num(n.at, 0), key, n.by ? { by: String(n.by) } : {});
  }

  // AIの聞き取り。⚠必ず kind='ai'(画面で「AIが聞き取った言葉」と出すため)。
  (Array.isArray(src.transcript) ? src.transcript : []).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    add('ai', s.text, num(s.at, 0), `tr${i}`);
  });

  return out;
};

// ---------------------------------------------------------------------------
// 探す
// ---------------------------------------------------------------------------
/** 一度に出す上限。⚠これ以上並べても現場は読まない。 */
export const SEARCH_LIMIT = 50;

/**
 * 打った言葉で探す。
 * ⚠語をいくつ打ったら **全部入っている物だけ** 出す(AND)。
 *   片方だけ当たった物まで出すと、絞ったつもりが増えて使えない。
 * @param opts.kinds  出す種類をしぼる(例: AIの聞き取りを外す)
 */
export const searchWords = (words, query, opts = {}) => {
  const limit = Math.max(1, num(opts.limit, SEARCH_LIMIT));
  const allow = Array.isArray(opts.kinds) ? new Set(opts.kinds) : null;
  const toks = queryTokens(query);
  if (!toks.length) return [];                       // ⚠空の言葉で全件を出さない
  const hits = [];
  for (const w of (Array.isArray(words) ? words : [])) {
    if (!w || typeof w !== 'object') continue;
    if (allow && !allow.has(w.kind)) continue;
    const n = normJa(w.text);
    if (!n) continue;
    let ok = true;
    let score = kindWeight(w.kind) * 10;
    for (const t of toks) {
      const i = n.indexOf(t);
      if (i < 0) { ok = false; break; }
      score += i === 0 ? 6 : 3;                      // 頭から当たった方が「その物」らしい
      if (n === t) score += 20;                      // まるごと同じ
    }
    if (!ok) continue;
    hits.push({ ...w, score });
  }
  hits.sort((a, b) => b.score - a.score || num(a.atOut) - num(b.atOut));
  // ⚠同じ秒に同じ文字が2つ出ない(同じ物を2回押させない)。0.1秒でまとめる。
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${normJa(h.text)}@${Math.round(num(h.atOut, 0) * 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
};

// ---------------------------------------------------------------------------
// 保存の形
// ---------------------------------------------------------------------------
/**
 * ⚠⚠ **鍵つきの入れ物(map)** にする。配列にしない。
 *   多端末前提。配列を読んで書き足す作りは、後から保存した端末が相手の分を消す。
 *   map なら 1件ずつ別の欄として書ける(setDoc の merge が効く)。
 * ⚠中身は3つだけ(kind/text/at)。誰が言ったかは編集側(project.notes)に残る。
 *   ここは **探すための索引**。太らせると1MBに当たる。
 */
export const wordsMap = (words) => {
  const m = {};
  for (const w of (Array.isArray(words) ? words : [])) {
    if (!w || typeof w !== 'object') continue;
    const t = txt(w.text);
    const id = String(w.id || '');
    if (!t || !id || !Number.isFinite(Number(w.atOut))) continue;
    m[id] = { kind: KIND_MAP[w.kind] ? w.kind : 'ai', text: t, at: r2(w.atOut) };
  }
  return m;
};

/** 保存した物を読み戻す。⚠秒の順に並べて返す(画面がそのまま出せる)。 */
export const wordsFromMap = (map) => {
  const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const out = [];
  for (const [id, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const t = txt(v.text);
    const at = Number(v.at);
    if (!t || !Number.isFinite(at)) continue;
    out.push({ id, kind: KIND_MAP[v.kind] ? v.kind : 'ai', text: t, atOut: r2(Math.max(0, at)), ref: id });
  }
  return out.sort((a, b) => a.atOut - b.atOut);
};

/**
 * 章で切り出した「1本ぶん」の索引に作り直す。
 *
 * ⚠⚠ 索引の秒は **合体後の通し秒**。章ごとに別ファイルへ書き出すと、その1本の中では
 *   0秒から数え直しになる。区間の始まり(from)を引かないと、押した先が
 *   **全然違う場面**になる。しかも黙ってズレるので、押した人には気づけない。
 * ⚠区間の外にある言葉は入れない。入れると「その動画に写っていない場面」を指す索引になる。
 *
 * @param map  wordsMap(...) の結果（保存の形のまま）
 * @param from 区間の始まり(通し秒) / @param to 区間の終わり(通し秒)
 */
export const sliceWordsMap = (map, from, to) => {
  const a = num(from, 0);
  const b = Number.isFinite(Number(to)) ? Number(to) : Infinity;
  const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const out = {};
  for (const [id, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    const at = Number(v.at);
    const t = txt(v.text);
    if (!t || !Number.isFinite(at)) continue;
    if (at < a - 0.001 || at >= b) continue;      // ⚠区間の外は入れない
    out[id] = { kind: KIND_MAP[v.kind] ? v.kind : 'ai', text: t, at: r2(Math.max(0, at - a)) };
  }
  return out;
};

/**
 * 手本レシピが **もう持っている文字** から索引を作る。
 *
 * ⚠⚠ これが無いと、**編集室を通していない既存の手本動画は 🔎 が一生0件**になる。
 *   本番のレシピは ⏸要点(events[].label / .text) と 📍頭出し(chapters[].label) という
 *   文字をすでに持っている。狙いは「いま在る文字だけで成立させる」なので、
 *   書き出し直しを待たずにここから拾う。
 * ⚠⏭スキップ・⚡倍速には文字が無い。拾わない(空の行が並ぶと探す気が失せる)。
 * ⚠ id は保存済みの索引とぶつからない形にする(`rev`/`rch`)。
 */
export const wordsFromRecipe = (recipe) => {
  const r = recipe && typeof recipe === 'object' ? recipe : {};
  const out = [];
  const add = (kind, text, at, ref) => {
    const t = txt(text);
    if (!t) return;
    if (!Number.isFinite(Number(at))) return;
    out.push({ id: `${kind}:${ref}`, kind, text: t, atOut: r2(Math.max(0, num(at, 0))), ref });
  };
  (Array.isArray(r.events) ? r.events : []).forEach((e, i) => {
    if (!e || typeof e !== 'object' || e.type !== 'pause') return;
    const ref = `rev${e.id || i}`;
    add('point', e.label, e.start, ref);   // ⏸要点の名前 = 手で書いた急所
    add('why', e.text, e.start, ref);      // その説明 = 急所の理由
  });
  (Array.isArray(r.chapters) ? r.chapters : []).forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    add('chapter', c.label, c.start, `rch${c.id || i}`);
  });
  return out.sort((a, b) => a.atOut - b.atOut);
};

/** 保存した時の文字数。⚠数え方は lotCapacity.approxBytes(=JSONの文字数)と同じ。 */
export const wordsBytes = (words) => approxBytes(wordsMap(words));

/**
 * 索引に使ってよい文字数。
 * ⚠⚠ Firestore は **1ドキュメント 1MB**。この索引は動画1本の doc に相乗りするので、
 *   1MBの半分より十分小さくしておく(題名・章・イベントの分が要る)。
 */
export const WORDS_BUDGET = 300_000;

/** 1件ぶんの文字数(map に入れた時の増分)。 */
const entryBytes = (w) => {
  const one = wordsMap([w]);
  const k = Object.keys(one)[0];
  if (!k) return 0;
  return approxBytes(one) - 2;      // 外側の { } を除く
};

/**
 * 上限で切る。⚠⚠ **黙って切らない。** 何件切ったかを言葉で返す。
 * ⚠切る順番: 当たりにくい物(AIの聞き取り)から捨てる。
 *   手で書いた 急所/作業手順 を先に捨てると、この機能がいちばん役に立つ材料が消える。
 * @returns {{kept, dropped, bytes, limitBytes, note}}
 */
export const capWordsForDoc = (words, opts = {}) => {
  const limit = Math.max(0, num(opts.limitBytes, WORDS_BUDGET));
  const list = (Array.isArray(words) ? words : []).filter(w => w && typeof w === 'object');
  const order = [...list].sort((a, b) =>
    kindWeight(b.kind) - kindWeight(a.kind) || num(a.atOut) - num(b.atOut));
  const kept = [], dropped = [];
  let bytes = 2;   // '{}'
  for (const w of order) {
    const add = entryBytes(w) + (kept.length ? 1 : 0);   // 2件目からはカンマの分
    if (!add) { dropped.push(w); continue; }
    if (bytes + add > limit) { dropped.push(w); continue; }
    bytes += add;
    kept.push(w);
  }
  kept.sort((a, b) => num(a.atOut) - num(b.atOut));
  let note = '';
  if (dropped.length) {
    const by = {};
    for (const w of dropped) by[w.kind] = (by[w.kind] || 0) + 1;
    const breakdown = Object.entries(by)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${kindLabel(k)} ${n}件`)
      .join(' / ');
    note = `⚠ ${dropped.length}件が入りきらないので保存しません（${breakdown}）。この分は「言葉で探す」に出てきません。`;
  }
  return { kept, dropped, bytes: kept.length ? bytes : 2, limitBytes: limit, note };
};
