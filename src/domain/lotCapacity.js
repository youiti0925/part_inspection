// 📦 ロット1件の容量(Firestore 1ドキュメント=1MB上限)を扱う純関数。
//
// 背景(2026-07-26 実測 本番 final-inspection-v1/lots 138件 16.46MB):
//   ・65ロットが写真をロット本体に直接抱えている(356枚 12.98MB)。
//   ・最大の 59a5fa04b8ec は **1024KB = 上限の約99.6%**。この1件は今この瞬間、
//     写真どころか検査記録の保存すら失敗する「凍結状態」だった。
//
// 枠の空け方は2つある。効き方も副作用も違うので、必ずこの順で使う。
//   ①別置き(offload)  … 写真を lot_images へ逃がして参照だけ残す。**画質は落ちない**。
//                        ロット本体からはほぼ全量が消えるので、いちばん効く。
//   ②再圧縮(recompress) … 画質を下げて容量そのものを削る。**元には戻せない**。
//                        ①で足りない時と、保管総量を減らしたい時だけ。
//
// ここは「どれをどうするか」を決めるだけ。実際の画像変換とFirestore書き込みは呼び元。
// ⚠この判断を画面のあちこちに散らすと必ずズレるので、しきい値も含めて全部ここに集める。

// Firestore の1ドキュメント上限。実際にはフィールド名やインデックスの分も乗るので、
// 上限そのものではなく「安全に収まる線」で判断する。
export const DOC_LIMIT = 1_048_576;
export const SAFE_BYTES = 700_000;   // これを超えたら自動で別置きする(手を出す線)
export const DANGER_BYTES = 900_000; // これを超えたら次の保存が落ちうる(警告する線)

// data:image の base64 は1文字≒1バイト。JSON化した長さでそのまま測れる。
// ⚠Firestore の公式の数え方(文字列=UTF8バイト+1 / 数値=8 / マップ=キー名+1+値 …)とは少し違う。
//   JSON は引用符やカンマの分だけ**多め**に出る。実測 2026-07-26 の最重量ロットで
//   JSON 1,048,135 バイト に対し Firestore 実サイズ 1,044,176 バイト(+0.4%)。
//   多めに出る = 警告が少し早く鳴る側なので、安全側として JSON のまま使う(毎回の保存で走るので速さも要る)。
// ⚠⚠⚠ **文字数ではなく「本当のバイト数」で数える。**
//   2026-08-15 実測: 日本語の作業標準1行は 88文字 = **200バイト(2.27倍)**。
//   文字数で数えていたので、危険線の 900,000 は実際には **1,266KB** を意味していた。
//   Firestore の上限は 1,024KB なので、**警告が鳴る前に保存が落ちる**状態だった
//   (＝この見張りは日本語では一度も間に合わない)。
//   定数の名前が最初から SAFE_BYTES / DOC_LIMIT = 1MB なので、バイトで数えるのが正。
// ⚠ TextEncoder はブラウザにも node にもある(node 11以降は global)。
//   Buffer は node にしか無いので使わない(この箱はブラウザでも動く)。
const _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
export const utf8Bytes = (s) => {
    const str = String(s == null ? '' : s);
    if (_enc) return _enc.encode(str).length;
    // ⚠最後の手段。数え落とすより多めに見る(足りないと言われる方が安全)。
    return str.length * 3;
};
export const approxBytes = (obj) => {
    try { return utf8Bytes(JSON.stringify(obj ?? null)); } catch { return 0; }
};

export const isDataImage = (v) => typeof v === 'string' && v.startsWith('data:image');

// ロット本体に直接入っている写真を、場所つきで列挙する。
// path は ['packagingPhotos', トピック, 添字] / ['tasks', キー, 'aiAnalysis', 'imageUrl'] の形。
// ⚠ここで拾える場所 = 別置きが面倒を見られる場所。新しい写真の置き場を増やしたらここも足すこと。
export const inlineImagesOf = (lot) => {
    const out = [];
    if (!lot || typeof lot !== 'object') return out;
    const pkg = lot.packagingPhotos;
    if (pkg && typeof pkg === 'object') {
        for (const [topic, photos] of Object.entries(pkg)) {
            if (Array.isArray(photos)) {
                photos.forEach((p, i) => { if (isDataImage(p)) out.push({ path: ['packagingPhotos', topic, i], kind: 'pkg', label: `${topic} (${i + 1})`, bytes: p.length }); });
            } else if (isDataImage(photos)) {
                out.push({ path: ['packagingPhotos', topic], kind: 'pkg', label: topic, bytes: photos.length });
            }
        }
    }
    const tasks = lot.tasks;
    if (tasks && typeof tasks === 'object') {
        for (const [k, t] of Object.entries(tasks)) {
            const url = t?.aiAnalysis?.imageUrl;
            if (isDataImage(url)) out.push({ path: ['tasks', k, 'aiAnalysis', 'imageUrl'], kind: 'ai', label: k, bytes: url.length });
        }
    }
    return out;
};

export const inlineBytesOf = (lot) => inlineImagesOf(lot).reduce((a, x) => a + x.bytes, 0);

// path で指した値を取り出す / 差し替えた新しいオブジェクトを返す(元は壊さない)。
export const getAt = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);
export const setAt = (obj, path, value) => {
    if (!path.length) return value;
    const [k, ...rest] = path;
    if (Array.isArray(obj)) { const a = [...obj]; a[k] = setAt(obj[k], rest, value); return a; }
    return { ...(obj || {}), [k]: setAt(obj?.[k], rest, value) };
};

// Firestore の setDoc(merge:true) と同じ合体をする。
// ⚠ここを浅い合体({...cur, ...patch})で済ませると、tasks を1件だけ更新する普通の保存で
//   「他の全タスク(=写真の本体)が無いことになる」ため、合体後サイズを大幅に小さく見積もる。
//   実際には残っているので保存は落ちる。つまり容量警告が肝心な場面で鳴らない。
//   マップは再帰的に合体・配列は置き換え(Firestoreの実挙動と同じ)。
export const mergeEstimate = (cur, patch) => {
    if (patch === undefined) return cur;
    const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object;
    if (!isMap(cur) || !isMap(patch)) return patch;
    const out = { ...cur };
    for (const [k, v] of Object.entries(patch)) out[k] = isMap(cur[k]) && isMap(v) ? mergeEstimate(cur[k], v) : v;
    return out;
};

// ---- ①別置きの計画 ----
// 「今のロット ⊕ これから保存する差分」が safeBytes を超えるなら、
// 本体に残っている写真を保存payloadに巻き込んで、別置き処理に通してもらう。
//
// なぜ差分だけ見てはいけないか: merge:true の結果は「今のdoc ⊕ 差分」。
// 差分が5KBでも合体後が1MBを超えれば保存は落ちる。だから合体後で測る。
//
// 返り値の pull は「payloadに追加すべきトップレベルのキー名」。
// packagingPhotos / tasks を丸ごと足せば、既存の dehydrate がそれを別置きしてくれる。
export const planAutoOffload = (currentLot, patch, opts = {}) => {
    const safe = opts.safeBytes ?? SAFE_BYTES;
    const merged = mergeEstimate(currentLot || {}, patch || {});
    const before = approxBytes(merged);
    if (before <= safe) return { needed: false, before, after: before, pull: [], images: 0, freed: 0 };
    // 差分にまだ入っていない、本体側の写真を探す
    const imgs = inlineImagesOf(merged);
    if (!imgs.length) return { needed: true, before, after: before, pull: [], images: 0, freed: 0 };
    const pull = [];
    if (imgs.some(i => i.path[0] === 'packagingPhotos') && patch?.packagingPhotos === undefined) pull.push('packagingPhotos');
    if (imgs.some(i => i.path[0] === 'tasks')) pull.push('tasks'); // tasksは差分に一部だけ入る事があるので常に合体版を渡す
    const freed = imgs.reduce((a, x) => a + x.bytes, 0);
    return { needed: true, before, after: Math.max(0, before - freed), pull, images: imgs.length, freed };
};

// 別置きだけでは safeBytes に収まらないロット(=写真以外が重い)を見つける。
// 該当したら②再圧縮でも直らないので、ロット分割など別の手を人に出す必要がある。
export const offloadInsufficient = (lot, opts = {}) => {
    const safe = opts.safeBytes ?? SAFE_BYTES;
    return approxBytes(lot) - inlineBytesOf(lot) > safe;
};

// 起動時のサイレント移行の対象。危ない順に並べて返す(重いロットから先に助ける)。
//
// ⚠⚠ minImageBytes を必ず「実際に逃がす側のしきい値」と揃えること。
//   2026-07-28 の事故: ここは「data:image なら大きさ問わず写真1枚」と数えていたのに、
//   実際に逃がすのは 20,000文字以上の写真だけだった(App 側の isOffloadableImg)。
//   → 本体が重く、残っている写真が全部20,000文字未満のロットは、**書いても対象のまま**。
//     90秒ごとに全端末が同じロットを書き直し続け、その保存が全端末の onSnapshot を叩き、
//     画面全体が作り直されて **日次集計で選んだ人・日付が勝手に消える** という形で出た。
//   選ぶ側と動かす側で「写真」の定義がズレると、終わらない仕事になる。
export const lotsNeedingOffload = (lots, opts = {}) => {
    const min = opts.minBytes ?? 300_000; // これ未満は急がない(通信を無駄に使わない)
    const minImg = opts.minImageBytes ?? 0; // 0 = 大きさ問わず(容量メーターなど数える用途の既定)
    return (lots || [])
        .map(l => {
            const movable = inlineImagesOf(l).filter(x => x.bytes >= minImg);
            return { id: l.id, bytes: approxBytes(l), inline: inlineBytesOf(l), images: movable.length };
        })
        .filter(x => x.images > 0 && x.bytes >= min)
        .sort((a, b) => b.bytes - a.bytes);
};

// ---- ②再圧縮の計画(清水さん案「画質を全体的に下げて枠を作る」) ----
//
// 落とす順の考え方: **大きい写真から**。
//   同じ「1割落とす」でも、140KBの写真を落とす方が10KBの写真100枚をいじるより効く。
//   小さい写真まで一律に落とすと、見返した時に全部が汚くなるだけで容量は大して減らない。
// 予測式: JPEGは品質を下げると概ね容量が比例より緩やかに減る。ここでは実測に基づく
//   安全側(=減りを少なめに見積もる)の近似 bytes * (q/qNow)^1.35 を使う。
//   ⚠これは見積り。実際の削減は変換後に測り直して報告すること(見積りを実績として出さない)。
export const RECOMPRESS_PRESETS = [
    { key: 'light', label: 'すこし下げる', quality: 0.7, maxEdge: 1600, note: '見た目はほぼ変わらない' },
    { key: 'normal', label: '標準まで下げる', quality: 0.55, maxEdge: 1280, note: '拡大すると少し粗い' },
    { key: 'strong', label: 'かなり下げる', quality: 0.4, maxEdge: 1024, note: '文字は読めるが写真は粗い' },
];

export const predictRecompressed = (bytes, fromQuality, toQuality) => {
    const f = Math.max(0.05, Number(fromQuality) || 0.9);
    const t = Math.max(0.05, Number(toQuality) || 0.6);
    if (t >= f) return bytes;
    return Math.round(bytes * Math.pow(t / f, 1.35));
};

// need バイト空けるために、どの写真をどこまで落とせばよいかを決める。
// 大きい順に必要な分だけ選ぶので、小さい写真は触らずに済む。
export const planRecompress = (images, opts = {}) => {
    const quality = opts.quality ?? 0.55;
    const from = opts.assumeQuality ?? 0.9;
    const need = opts.needBytes ?? Infinity;   // Infinity = 全部落とす(保管総量を減らす用途)
    const minBytes = opts.minBytes ?? 30_000;  // これ未満の写真は触らない(効かないのに画質だけ落ちる)
    const sorted = [...(images || [])].filter(x => x.bytes >= minBytes).sort((a, b) => b.bytes - a.bytes);
    const picks = [];
    let freed = 0;
    for (const img of sorted) {
        if (freed >= need) break;
        const after = predictRecompressed(img.bytes, from, quality);
        if (after >= img.bytes) continue;
        picks.push({ ...img, quality, predictedBytes: after, predictedFreed: img.bytes - after });
        freed += img.bytes - after;
    }
    return { picks, predictedFreed: freed, enough: freed >= need || need === Infinity, skipped: (images || []).length - picks.length };
};

// ---- 容量の内訳(人に見せる診断専用) ----
//
// ⚠⚠ **これを inlineImagesOf に足してはいけない。**
//   inlineImagesOf は「別置き(dehydrate)が実際に動かせる場所」という意味で、
//   planAutoOffload / lotsNeedingOffload / 再圧縮UI(getAt/setAt) が使っている。
//   ここに製品側の置き場(steps の測定図・不具合写真)を足すと、最終検査側で
//   「移せる」と数えたのに dehydrate は packagingPhotos と tasks しか積まないため
//   (App.firebase.jsx の巡回が payload に積むのはその2つだけ)、書いても減らない。
//   諦め判定があるので無限ループにはならないが、該当ロットを1回ずつ無駄に書き、
//   その保存が全端末の onSnapshot を叩いて画面を作り直し、そのロットには恒久的に
//   諦め印が付く。だから **判断系とは配線しない別の関数** として分ける。
//
// removable = **作業者がその場で減らせるか**。ここがこの関数の芯。
//   ⚠測定図は測定値を入れるための下敷きの絵で、作業者には消せない。
//     消せない物を指して「減らしてください」と出すと、作業者は探し回った末に
//     手が無いと分かる = その場で詰む。バイト数と一緒に「消せるかどうか」を必ず返す。
//
// ⚠parts は互いに重ならないトップレベルのキーだけで作る(steps / tasks / interruptions)。
//   合計と一致しない分は他のフィールドなので、呼び元は「うち」として出すこと。
//   diagramBytes は steps の**内訳**(steps に含まれる)。二重に足さない。
export const lotHeavyParts = (lot) => {
    if (!lot || typeof lot !== 'object') return { total: 0, parts: [], diagramBytes: 0, removableBytes: 0 };
    const total = approxBytes(lot);
    // 測定図: テンプレからロットへ複製されて入る(製品のみ。最終検査には measurementConfig が無い)。
    let diagramBytes = 0;
    for (const s of (Array.isArray(lot.steps) ? lot.steps : [])) {
        const img = s && s.measurementConfig && s.measurementConfig.diagramImage;
        if (isDataImage(img)) diagramBytes += img.length;
    }
    // 不具合写真: 作業者が自分で撮ってロットに直入れした物。両アプリ共通の置き場。
    let defectBytes = 0, defectCount = 0;
    for (const it of (Array.isArray(lot.interruptions) ? lot.interruptions : [])) {
        for (const p of (Array.isArray(it && it.photos) ? it.photos : [])) {
            if (isDataImage(p)) { defectBytes += p.length; defectCount++; }
        }
    }
    const parts = [];
    const stepsBytes = approxBytes(lot.steps);
    if (stepsBytes > 0) parts.push({ key: 'steps', label: diagramBytes > 0 ? '工程の設定(測定図の絵を含む)' : '工程の設定', bytes: stepsBytes, removable: false });
    if (defectBytes > 0) parts.push({ key: 'defectPhoto', label: `不具合の写真 ${defectCount}枚`, bytes: defectBytes, removable: true });
    const tasksBytes = approxBytes(lot.tasks);
    if (tasksBytes > 0) parts.push({ key: 'tasks', label: '検査の記録', bytes: tasksBytes, removable: false });
    parts.sort((a, b) => b.bytes - a.bytes);
    return { total, parts, diagramBytes, removableBytes: parts.reduce((a, p) => a + (p.removable ? p.bytes : 0), 0) };
};

// 容量で詰まった時に **作業者へ出す文** をここで決める。
//
// ⚠⚠ 文面を画面の中で組まないこと。組むと試験できず、あとで誰かが最終検査の文面を
//   コピーで戻しても誰も気づかない。最終検査の文は「荷姿写真かAI画像が在るか」で
//   分岐するが、製品にはどちらも1件も無いので **必ず else 側**に落ち、毎回
//   「写真を減らしても解決しません」+ 製品に存在しない「画像データ管理」画面への案内 が出る。
//   → 判断の軸は「置き場が在るか」ではなく **作業者がその場で減らせるか**(removable)。
//
// canFix=false の時は逃げ道を作業者に探させない。手が無いことを認めて事務所へ回す。
export const capacityAdviceFor = (lot) => {
    const heavy = lotHeavyParts(lot);
    const canFix = heavy.removableBytes > 0;
    const text = canFix
        ? `不具合の写真が ${Math.round(heavy.removableBytes / 1024)}KB あります。\n作業画面の不具合報告から要らない写真を消すと、その分の枠が空きます。`
        : `重いのは「${(heavy.parts[0] && heavy.parts[0].label) || '検査の記録'}」で、これは作業者の操作では減らせません。\n入力はこのまま残ります。事務所へ「このロットが容量で保存できない」と伝えてください。`;
    // 保存が実際に落ちた後に出す短い版(赤帯に載るので1行)。
    const afterFail = `このロットは1件あたりの上限(1MB)を超えたため保存できませんでした。入力は消えていません。`
        + (canFix
            ? ` 不具合の写真(${Math.round(heavy.removableBytes / 1024)}KB)を減らすと保存できるようになります。`
            : ` 作業者の操作では空けられないため、事務所へ連絡してください。`);
    return { canFix, text, afterFail, heavy };
};

// 画面に出す一行サマリ。数字はここで作って、文章側で組み立て直さない(表示ごとに数字がズレるのを防ぐ)。
export const capacityLabel = (bytes) => {
    const pct = Math.round((bytes / DOC_LIMIT) * 1000) / 10;
    const level = bytes >= DANGER_BYTES ? 'danger' : bytes >= SAFE_BYTES ? 'warn' : 'ok';
    return { bytes, kb: Math.round(bytes / 1024), pct, level, text: `${Math.round(bytes / 1024)}KB (上限の${pct}%)` };
};
