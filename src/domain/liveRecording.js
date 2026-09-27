// ============================================================================
// 🎥 録画の「いま何秒か」と、止めたり続けたりの合図を決める所
// ----------------------------------------------------------------------------
// 清水さん(2026-08-14)
//   「一時停止や続き録画や新規録画とかほしいかな、一時停止中には要点編集とか
//     できたら面白いね」
//   「各録画時には全体用なのか、各工程の名前で保存するのかも指定できたらいいね」
//
// ⚠⚠ **ここが今回いちばん壊れやすい所。**
//   一時停止している間、**動画の時間は進まない**(MediaRecorder.pause は録らない)。
//   なのに壁の時計は進む。だから「押した時刻の差」で旗を立てると、
//   **止めていた分だけ全部の旗が後ろにズレる**。
//   3分止めて再開したら、その後の旗は全部3分ズレた所を指す = 使い物にならない。
//   → 旗も画面の秒数も、**必ずこの1か所で出した「動画の中での秒」**を使う。
//
// ⚠⚠ 時計はPCとスマホで違う。
//   録画開始の時刻(recStartedAt)を書くのは**スマホ**、経過秒を出すのは**PC**。
//   両者の時計が何分もズレていると、開いた瞬間から嘘の秒数が出る
//   (この開発PCの時計が実時間より進んでいた実例がある)。
//   → PCが「録画が始まった」と**見た瞬間**の差を1回だけ測って引く(skewMs)。
//     書き込みは1バイトも増えない。ズレは通信の往復ぶん(0.5秒程度)まで縮む。
// ============================================================================

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** いまの状態。⚠画面の出し分けはこの3つだけで決める(条件を散らかさない)。 */
export const recPhase = (room) => {
  if (!room || !room.recording) return room && room.recStartedAt && room.recEndedAt ? 'done' : 'idle';
  return room.paused ? 'paused' : 'recording';
};

/**
 * 🎞 **動画の中での秒**。止まっていた分は入らない。
 * @param room   部屋(recStartedAt / pausedTotalMs / pausedAt / paused / recording)
 * @param nowMs  いまの時刻(PC側)
 * @param skewMs PCとスマホの時計の差(PCが進んでいれば正)
 */
export const videoSec = (room, nowMs, skewMs = 0) => {
  if (!room) return 0;
  const st = num(room.recStartedAt, 0);
  if (st <= 0) return 0;
  const now = num(nowMs, 0) - num(skewMs, 0);
  // 止め終わった録画は、止めた時刻で固定する(見るたびに伸びていかない)
  const end = num(room.recEndedAt, 0);
  const at = !room.recording && end > 0 ? end : now;
  // いま止まっている最中の分も引く
  const nowPause = room.paused && num(room.pausedAt, 0) > 0 ? Math.max(0, at - num(room.pausedAt, 0)) : 0;
  const ms = at - st - num(room.pausedTotalMs, 0) - nowPause;
  return Math.max(0, ms / 1000);
};

/**
 * PCとスマホの時計の差。**録画が始まったのを見た瞬間に1回だけ**測る。
 * ⚠差が大きすぎる時だけ効かせる。通信の遅れ(1秒未満)まで補正すると、
 *   かえって毎回ちらつく。
 */
export const clockSkew = (recStartedAt, seenAtMs, minMs = 3000) => {
  const st = num(recStartedAt, 0), seen = num(seenAtMs, 0);
  if (st <= 0 || seen <= 0) return 0;
  const d = seen - st;
  return Math.abs(d) >= minMs ? d : 0;
};

// ---------------------------------------------------------------------------
// PC → スマホ の「こうしてほしい」
// ⚠⚠ 部屋に書くのは **お願い(want*)** だけ。実際にどうなったかは
//   スマホが recording / paused に **報告** を返す。ここを混ぜると、
//   電波が切れた時に「PCでは録画中、スマホは止まっている」が起きる。
// ⚠wantAt を必ず一緒に書く。同じ値を書き直しただけだと相手が気づかない。
// ---------------------------------------------------------------------------
export const wantStart = (nowMs) => ({ wantRecording: true, wantPaused: false, wantAt: num(nowMs, 0) });
export const wantStop = (nowMs) => ({ wantRecording: false, wantPaused: false, wantAt: num(nowMs, 0) });
export const wantPause = (nowMs) => ({ wantRecording: true, wantPaused: true, wantAt: num(nowMs, 0) });
export const wantResume = (nowMs) => ({ wantRecording: true, wantPaused: false, wantAt: num(nowMs, 0) });

/**
 * ＋ 新しく録画する。⚠**前の録画の旗を必ず消す**。
 *   消さないと、前の動画の要点が次の動画に付いたまま編集へ渡り、
 *   まったく違う場面に「ここが要点です」と出る。
 * ⚠旗は鍵つきの入れ物なので、鍵を消すのではなく **消した印** を置く
 *   (merge:true では鍵を消せない。消したつもりで古い値が生き返る)。
 */
export const newTakePatch = (room, nowMs) => {
  const dead = {};
  for (const k of Object.keys((room && room.flags) || {})) dead[k] = { deleted: true };
  return {
    flags: dead,
    recording: false, paused: false,
    recStartedAt: 0, recEndedAt: 0, pausedTotalMs: 0, pausedAt: 0,
    up: null, recError: '',
    wantRecording: false, wantPaused: false, wantAt: num(nowMs, 0),
  };
};

// ---------------------------------------------------------------------------
// スマホ → PC の報告
// ---------------------------------------------------------------------------
export const reportStart = (nowMs) => ({
  recording: true, paused: false,
  recStartedAt: num(nowMs, 0), recEndedAt: 0, pausedTotalMs: 0, pausedAt: 0,
  recError: '', up: null,
});
export const reportPause = (nowMs) => ({ paused: true, pausedAt: num(nowMs, 0) });
/** 続ける。⚠止まっていた分を **足し込んでから** pausedAt を消す(足し忘れると秒がズレる)。 */
export const reportResume = (room, nowMs) => {
  const from = num(room && room.pausedAt, 0);
  const add = from > 0 ? Math.max(0, num(nowMs, 0) - from) : 0;
  return { paused: false, pausedAt: 0, pausedTotalMs: num(room && room.pausedTotalMs, 0) + add };
};
/** とめる。⚠止まっている最中に止めた時も、その分を足し込む。 */
export const reportStop = (room, nowMs) => {
  const base = (room && room.paused) ? reportResume(room, nowMs) : {};
  return { ...base, recording: false, paused: false, recEndedAt: num(nowMs, 0) };
};

// ---------------------------------------------------------------------------
// 🎬 録画のきれいさ（＝容量）
// ⚠⚠ **撮る前に決める**。撮り始めてから変えられると、1本の中で画質が変わる。
// ⚠⚠ 現場に見せるのは「1分あたり何MB」。ビットレートの数字は誰も判断できない。
// ⚠⚠ **音の細かさ(audioBitsPerSecond)は指定しない。** 低く指定すると、端末に
//   よっては音が丸ごと消える(2026-08-13 動画編集で実際に起きた)。絞るのは映像だけ。
//   目安の計算では、音のぶんを一律で足しておく。
// ---------------------------------------------------------------------------
/**
 * 録画のきれいさ。
 *
 * ⚠⚠ 2026-08-16: **画素の数(w×h)も一緒に決めるようにした。**清水さん了承済み。
 *   前は4段とも 1920x1080 のままビットレートだけ削っていたので、下2段は
 *   **1080pに必要な量の3〜7割しか与えていない**状態だった(動く所がブロックだらけになる)。
 *   YouTubeの推奨(30コマ/秒): 1080p=8Mbps / 720p=5 / 480p=2.5 / 360p=1。
 *   研修動画の実務値: 1080p=3,000〜5,000kbps / 720p=1,500〜2,500 / 480p=500〜1,000。
 *   → 下2段の解像度を落とし、**同じ容量のまま推奨帯の中に入れる**。
 *
 * ⚠⚠ **コマ数は4段とも30のまま**。解像度とコマ数は別のつまみで、
 *   解像度を下げても **カクカクにはならない**(清水さんのご確認事項)。
 *   むしろスマホの処理が軽くなるので、**カクつきにくくなる**
 *   (2026-08-14 に 720p→1080p へ上げた事が、中継のカクカクの原因だった)。
 *
 * ⚠**きれい・ふつうは1080pのまま**残す。刻印や型式を切り出す用途で画素を減らさない為。
 * ⚠国際規格 ITU-T G.1070 も「同じ通信量なら、解像度が高いほど最適なコマ数は下がる」
 *   と数式で示している。容量を削る時に落とすべきは **解像度** であって コマ数ではない。
 */
export const REC_QUALITIES = {
  high: { key: 'high', vbps: 8_000_000, w: 1920, h: 1080, label: 'きれい' },
  normal: { key: 'normal', vbps: 5_000_000, w: 1920, h: 1080, label: 'ふつう' },
  light: { key: 'light', vbps: 2_500_000, w: 1280, h: 720, label: 'かるい' },
  tiny: { key: 'tiny', vbps: 1_200_000, w: 854, h: 480, label: 'とても軽い' },
};

/**
 * その画質で、カメラに希望する大きさ。
 * ⚠`ideal` で渡す(対応していない端末では黙って無視される。エラーにしない)。
 * ⚠⚠ カメラを下げると **中継の元も下がる**が、中継はどのみち1280まで縮めて送るので害はない。
 *   逆に、**録画だけを縮める道(canvas経由)は採らない** — スマホの処理をさらに増やして、
 *   いま直したばかりのカクカクを呼び戻す。
 */
export const recVideoConstraints = (key) => {
  const q = REC_QUALITIES[key] || REC_QUALITIES[REC_QUALITY_DEFAULT];
  return { width: { ideal: q.w }, height: { ideal: q.h } };
};
export const REC_QUALITY_DEFAULT = 'normal';
/** 目安に足す音のぶん。⚠実際には指定しない(上の理由)。数える時だけ使う。 */
export const REC_AUDIO_BPS = 128_000;

/** 1分あたり何MB か（目安）。⚠端末の画面と同じ数え方(1024)で出す。 */
export const recMbPerMin = (key) => {
  const q = REC_QUALITIES[key];
  if (!q) return 0;
  return Math.round(((q.vbps + REC_AUDIO_BPS) / 8) * 60 / (1024 * 1024));
};
/** 画面に出す一言。⚠必ず「約NMB/分」と大きさを付ける(数字だけでは選べない)。 */
export const recQualityLabel = (key) => {
  const q = REC_QUALITIES[key];
  if (!q) return 'この端末のまま';
  const px = q.h >= 1080 ? 'いちばん細かい' : q.h >= 720 ? '細かい' : 'ふつうの細かさ';
  return `${q.label}（約${recMbPerMin(key)}MB/分・${q.w}×${q.h} ${px}）`;
};
/**
 * その端末で **本当に録れる** 物だけ並べる。
 * ⚠空なら「まだ分からない / 選べない」。押しても何も起きないつまみを作らない。
 */
export const recQualityList = (caps) => {
  const src = Array.isArray(caps) ? caps : (caps && typeof caps === 'object' ? Object.keys(caps) : []);
  const seen = new Set();
  const out = [];
  for (const k of src) {
    const q = REC_QUALITIES[String(k)];
    if (!q || seen.has(q.key)) continue;
    seen.add(q.key);
    out.push(q);
  }
  return out;
};
/** 実際に使う物を決める。⚠選ばれた物がその端末で録れないなら、録れる物へ寄せる。 */
export const pickRecQuality = (key, caps) => {
  const list = recQualityList(caps);
  if (!list.length) return null;   // 端末任せ(画質を指定しない)
  return list.find((q) => q.key === key) || list.find((q) => q.key === REC_QUALITY_DEFAULT) || list[0];
};
/** PC → スマホ「このきれいさで撮ってほしい」 */
export const wantQualityPatch = (key) => ({ wantQuality: REC_QUALITIES[key] ? key : REC_QUALITY_DEFAULT });
/**
 * スマホ → PC「この端末で録れるのはこれだけ」
 * ⚠並びにしているが、**書き手はスマホ1台だけで毎回まるごと書き直す**ので後勝ちにならない
 *   (両側から足し込む経路の候補や旗とは事情が違う)。
 */
export const recCapsPatch = (keys) => ({ recCaps: recQualityList(keys).map((q) => q.key) });

// ---------------------------------------------------------------------------
// 🔍🔄 見え方（大きさ・向き）
// 清水さん(2026-08-14 実機)
//   「アプリ画面上で縮小と拡大」
//   「スマホを横にして撮る機能が無かった → 見る側で回せるように保険」
//
// ⚠⚠ **ここで変わるのは見え方だけ。録画される中身は1バイトも変わらない。**
//   動画に焼き込むと、PCで回した人と回さなかった人で **保存物が変わる**。
//   手本動画は常に「スマホが撮ったまま」。向きは部屋に控えるだけ(見る時の目安)。
// ---------------------------------------------------------------------------
export const VIEW_SCALES = [0.5, 0.75, 1, 1.5, 2, 3];
/** 1段大きく/小さく。⚠一覧に無い倍率から押しても、一番近い段から動く。 */
export const nextViewScale = (cur, dir) => {
  const c = num(cur, 1);
  let at = 0;
  for (let i = 1; i < VIEW_SCALES.length; i++) {
    if (Math.abs(VIEW_SCALES[i] - c) < Math.abs(VIEW_SCALES[at] - c)) at = i;
  }
  const to = at + (num(dir, 1) < 0 ? -1 : 1);
  return VIEW_SCALES[Math.min(VIEW_SCALES.length - 1, Math.max(0, to))];
};
/** 向きは90度きざみの4つだけ。⚠中途半端な角度を作らない(斜めの映像は見づらいだけ)。 */
export const normViewRotate = (deg) => (((Math.round(num(deg, 0) / 90) * 90) % 360) + 360) % 360;
export const nextViewRotate = (deg, dir = 1) => normViewRotate(normViewRotate(deg) + (num(dir, 1) < 0 ? -90 : 90));
/**
 * 回した時に画面へ収める入れ物の大きさ。
 * ⚠回すと縦横が入れ替わるので、入れ物も入れ替えないと **上下がはみ出て切れる**。
 */
export const viewStageBox = (box, deg) => {
  const w = num(box && box.w, 0);
  const h = num(box && box.h, 0);
  return normViewRotate(deg) % 180 === 90 ? { w: h, h: w } : { w, h };
};
/** 部屋に書く控え。⚠**動画には焼き込まない**。「見る時にこう回すと正しい向き」だけ。 */
export const viewRotatePatch = (deg) => ({ viewRotate: normViewRotate(deg) });

// ---------------------------------------------------------------------------
// 🚩 要点(旗)
// ---------------------------------------------------------------------------
/** 消した印を除いて並びにする。⚠これを通さずに Object.values すると消した旗が出る。 */
export const liveFlags = (flags) => {
  const src = flags && typeof flags === 'object' ? flags : {};
  const arr = Array.isArray(flags) ? flags : Object.entries(src).map(([key, f]) => ({ key, ...(f || {}) }));
  return arr
    .filter((f) => f && !f.deleted && Number.isFinite(Number(f.atSec)))
    .map((f) => ({ ...f, atSec: Number(f.atSec) }))
    .sort((a, b) => a.atSec - b.atSec);
};
export const flagAddPatch = (key, atSec, label) => ({ flags: { [key]: { atSec: Math.round(num(atSec, 0) * 10) / 10, label: String(label || '').trim() } } });
/** 名前だけ直す。⚠秒は触らない(直した拍子に場所が動いたら意味が無い)。 */
export const flagRenamePatch = (key, label) => ({ flags: { [key]: { label: String(label || '').trim() } } });
export const flagDeletePatch = (key) => ({ flags: { [key]: { deleted: true } } });

// ---------------------------------------------------------------------------
// 📁 この録画をどこへ入れるか(全体用 / 工程ごと)
// ---------------------------------------------------------------------------
export const WHOLE = { kind: 'whole', id: '', name: '' };
export const isWhole = (t) => !t || t.kind !== 'step' || !t.id;
/** 画面に出す一言。⚠「未選択」を作らない(選ばなければ全体用)。 */
export const targetLabel = (t) => (isWhole(t) ? '全体用' : `工程「${(t.name || t.id)}」`);

/** ファイル名に使えない字を落とす。⚠Driveでも Windows でも困る字を同じ規則で。 */
export const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * 保存する名前。⚠**あとでフォルダを見た人が中身を当てられる名前**にする。
 *   「手本_20260814_1530.mp4」が10本並ぶと、どれが何か分からなくなる。
 * @param opts { target, model, atMs, ext, kind }
 */
export const videoFileName = ({ target, model = '', atMs = 0, ext = 'webm', kind = '手本' } = {}) => {
  const d = new Date(num(atMs, 0) || 0);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const who = isWhole(target) ? '全体' : safeName(target.name || target.id);
  const m = safeName(model);
  return [kind, m || '共通', who, stamp].filter(Boolean).join('_') + '.' + String(ext || 'webm').replace(/^\./, '');
};

/**
 * どのフォルダへ入れるか。⚠作業者にフォルダを選ばせない(選ばせると必ず散らかる)。
 * @param base ['最終','型式','TK-1'] のような手前までの道
 */
export const videoFolderPath = (base, target) => {
  // ⚠⚠ 2026-08-16: **工程用のサブフォルダを作るのをやめた。**
  //   前は 工程を選ぶと `…/型式/RCV-1000R/工程別/外観検査/` へ入れていたが、
  //   **資料一覧はそのフォルダを一度も見に行っていなかった**。
  //   一覧を出す仕組みは1階層しか読まず、しかもフォルダ自体を結果から捨てるので、
  //   「Driveには在るのにアプリからは永久に見えない」になっていた(清水さん報告)。
  //   実際 `工程別` という文字は **書く側にしか無く、読む側には1箇所も無かった**。
  //   → 工程名は `videoFileName()` が **ファイル名に埋めている**
  //     (手本_RCV-1000R_外観検査_20260816_1030.webm)ので、
  //     「各工程の名前で保存する」は名前で満たせている。フォルダを分ける得は無い。
  //   ⚠フォルダ分けに戻すなら、**先に一覧側を潜れるように**してからにする事。
  void target;
  return Array.isArray(base) ? base.filter(Boolean) : [];
};

/**
 * 道順の掃除。⚠空の段を残さない(Driveに名前の無いフォルダが出来る)。
 */
const cleanPath = (v) => (Array.isArray(v) ? v.map((s) => String(s == null ? '' : s).trim()).filter(Boolean) : []);

/**
 * 📁📁 **どこへ入れるかを決める、ただ1つの場所。**
 *
 * 🚨🚨 2026-08-16 清水さん「結局スマホで撮った映像アプリ上だと見れなかった」の**根っこ**。
 *   Driveへ上げているのは `?live=` で開いた **スマホ側の画面**。その画面は
 *   `if (LIVE_CODE) return;` でロットもテンプレも読み込まない = **型式名もテンプレ名も
 *   いつも空**。だから道順を組み立てる材料がスマホ側には最初から無く、
 *   実際に入っていたのは 最終=`最終/マスタ`、製品=`製品/テンプレ/テンプレ` の固定だった。
 *   一方アプリが**読みに行く**のは 最終=`最終/型式/<型式>`、製品=`製品/テンプレ/<テンプレ名>`。
 *   **入れる場所と見に行く場所が別**。Worker は無いフォルダを黙って作るので、
 *   Driveを直接開けば在る=「Driveには在るのにアプリからは出てこない」になっていた。
 *   ⚠「保存先を全体用にした」でも直らないのはこの為(フォルダを決めているのは型式名の方)。
 *
 * → 道順は **PC側で組み立てて部屋(folderPath)へ書き、スマホはそれを運ぶだけ**にする。
 * ⚠base は「部屋に何も書かれていない古い部屋」用のよりどころ。**当てにしない**。
 *
 * @param folderPath PCが部屋へ書いた完成済みの道順 ['最終','型式','TK-1']
 * @param base       それが無い時のよりどころ(スマホ側で組んだ物・当てにならない)
 * @returns 文字列の並び。空の段は落とす。
 */
export const recordFolderPath = ({ folderPath, base } = {}) => {
  const want = cleanPath(folderPath);
  return want.length ? want : cleanPath(base);
};

/**
 * 画面に出す道順。⚠⚠「保存しました」だけでは**どこに入ったのか分からない**
 *   (清水さん 2026-08-16)。入った先を必ず一緒に出す為の文字。
 */
export const folderLabel = (path) => cleanPath(path).join('/');

/** PC → 部屋「この録画はここへ入れる」。⚠**書くのはPCだけ**(スマホは読むだけ)。 */
export const folderPathPatch = (path) => ({ folderPath: cleanPath(path) });

// ---------------------------------------------------------------------------
// ⬆ Driveへ入れる途中の報告（部屋の `up`）
// 🚨 清水さんの実害(2026-08-16): **送り始めた瞬間に「✓ Driveに保存しました」が出ていた。**
//   スマホが送る前に `up:{state:'doing'}` を書き、PC側は `up.error` の有無しか
//   見ていなかったので、doing も ok と同じ緑の合格札になっていた。
//   さらに書き込みは深い混ぜ(merge)なので、**一度失敗すると up.error が残り続け**、
//   次に成功しても「⚠入れられませんでした」が出たままだった。
//   → 状態は `state` ただ1つで決める。成功・送信中は **error を空で上書き**する。
// ---------------------------------------------------------------------------
/** いまの上げ具合。⚠画面の出し分けはこの4つだけで決める(error を見て決めない)。 */
export const upPhase = (up) => {
  const s = up && typeof up === 'object' ? String(up.state || '') : '';
  return s === 'doing' || s === 'ok' || s === 'ng' ? s : 'idle';
};
/** 送り始めた。⚠前の回の結果(error/name/folder)を**必ず消す**(残ると嘘になる)。 */
export const upDoingPatch = (atMs) => ({ up: { state: 'doing', at: num(atMs, 0), error: '', name: '', folder: '' } });
/** 入った。⚠**どこへ入ったか(folder)も書く**。名前だけでは場所が分からない。 */
export const upOkPatch = ({ name = '', folder = '', fileId = '', atMs = 0 } = {}) => ({
  up: {
    state: 'ok',
    name: String(name || ''),
    folder: String(folder || ''),
    fileId: String(fileId || ''),
    error: '',          // ⚠⚠ 明示的に消す。消さないと前の失敗が生き残る(merge の深い混ぜ)。
    at: num(atMs, 0),
  },
});
/** 入れられなかった。⚠理由をそのまま出す(「失敗しました」だけでは直せない)。 */
export const upNgPatch = ({ error = '', atMs = 0 } = {}) => ({
  up: { state: 'ng', error: String(error || '理由は分かりません').slice(0, 120), at: num(atMs, 0) },
});

/**
 * 撮り終わった1本ぶんの控え。⚠**旗は「動画の中での秒」で確定させてから渡す**。
 *   渡した先(編集画面)は壁の時計を知らないので、ここでズレを吸収しておく。
 */
export const takeOf = (room, { skewMs = 0 } = {}) => ({
  target: (room && room.target) || WHOLE,
  // 📁 PCが部屋へ書いた **完成済みの道順**。スマホは組み立てず、そのまま運ぶだけ。
  //   ⚠空なら「PCがまだ書いていない古い部屋」。受け取った側が base へ落とす。
  folderPath: cleanPath(room && room.folderPath),
  durationSec: Math.round(videoSec(room, num(room && room.recEndedAt, 0), skewMs) * 10) / 10,
  flags: liveFlags(room && room.flags).map((f) => ({ atSec: f.atSec, label: f.label || '' })),
  // ⚠⚠ 見ていた向きの **控え**。動画そのものは回っていない(焼き込んでいない)。
  //   使う側が「見る時に回す」ために持つ物で、これを元に動画を作り直してはいけない。
  viewRotateDeg: normViewRotate(room && room.viewRotate),
});
