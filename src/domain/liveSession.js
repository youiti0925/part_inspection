// ============================================================================
// 📱 別の端末のカメラを、この画面で見る — つなぐための「合図」の決まりごと
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13):
//   「別の端末(スマホ)で動画をとってる映像をこのアプリでリアルタイムで見ることは可能？」
//   「その方式でアプリでカメラ映像見れるようにして、見れるっていうか録画だね」
//
// ⚠⚠ 録画は **スマホ側で録る**。ここで送る映像は **画角を合わせるためだけ** の物。
//   理由: WebRTC は回線が細ると **勝手に画質を落とす**(それが役目)。工場のWi-Fiで
//   手本動画をPC側で録ると、画質が電波任せになる。スマホ側で録れば録画は高画質のまま。
//
// ⚠⚠ 回線の前提(2026-08-13 清水さんの指摘で判明):
//   **PCは工場のWi-Fi、スマホは携帯回線**。この2つは互いに「外から見えない」網の中に
//   いるので、住所を教え合っても **端末どうしの直通はまず繋がらない**(中継=TURNが要る)。
//   → 本命は **コマ送り(1秒に1枚の写真)**。中継が要らず、どの回線でも動く。
//     画角合わせ(手が入っているか・切れていないか)にはこれで足りる。
//   → 滑らかな映像(WebRTC)は **同じWi-Fiに繋げた時だけ** 自動で上乗せする。
//     繋がらなければコマ送りのまま。**どちらで繋がっているかは画面に出す**。
//
// つなぐ流れ(合図は Firestore の1つの書類でやりとりする。新しいサーバは要らない):
//   ① PC が部屋(session)を作り、6桁の合言葉を出す → QRにする
//   ② スマホがQRを読んで同じ部屋に入り、カメラを開く
//   ③ お互いの「つなぎ方(SDP)」と「経路(ICE)」を書類に書き合う
//   ④ つながったら、あとは端末どうしの直通(サーバを通らない)
//
// ⚠工場のWi-Fiが端末どうしの直通を切っていると繋がらない(ゲストWi-Fiによくある)。
//   その時は中継(TURN)が要る。**繋がらないことを画面に出す**(黙って真っ黒にしない)。
//
// ⚠ここには React も ブラウザAPI も import しない (node --test で回すため)。
// ============================================================================

/** 合言葉の長さ。⚠短すぎると偶然かぶる。長いと現場で打てない。 */
export const CODE_LEN = 6;
/** 部屋の有効時間(分)。⚠古い部屋にうっかり繋がないため。 */
export const ROOM_TTL_MIN = 30;
/** つながらない時に見切りをつける秒数。⚠永遠に「接続中…」を出さない。 */
export const CONNECT_TIMEOUT_SEC = 25;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 合言葉を作る。
 * ⚠紛らわしい字を外す(0とO、1とIとl)。現場で読み上げる/打ち込むことがあるため。
 * @param rnd 0以上1未満を返す関数(試験では固定の値を渡す)
 */
/** 合言葉に使う字。⚠normCode を通しても変わらない字だけ(試験で機械的に見張る)。 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const makeCode = (rnd = Math.random) => {
  // ⚠⚠ **normCode が書き換える字を1つも入れない。**
  //   2026-08-13 ハーネスで発覚: ここに L が入っていたのに normCode は L→I に直すので、
  //   画面には「5ELAMH」と出ているのに、実際に作られた部屋は「5EIAMH」になっていた。
  //   打ち込めば同じ所へ行くが、**読み上げた字と本当の部屋の名前が違う**。
  //   下の CODE_ALPHABET は normCode を通しても1字も変わらない字だけ(0 1 I L O を全部外す)。
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rnd() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
};

/** 打ち込まれた合言葉を整える(小文字・空白・紛らわしい字を吸収)。 */
export const normCode = (v) => String(v == null ? '' : v)
  .toUpperCase().replace(/\s+/g, '')
  .replace(/O/g, '0').replace(/[IL]/g, '1')     // 一旦そろえてから
  .replace(/0/g, 'O').replace(/1/g, 'I')        // 使っている字へ戻す
  .replace(/[^0-9A-Z]/g, '')
  .slice(0, CODE_LEN);

/** スマホに読ませるURL。⚠アプリのURLに合言葉を付けるだけ(新しい画面を増やさない)。 */
export const liveUrl = (origin, code) => {
  const base = String(origin || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${base}/?live=${encodeURIComponent(normCode(code))}`;
};

/** URLから合言葉を読む。無ければ空文字。 */
export const codeFromUrl = (href) => {
  const m = String(href || '').match(/[?&]live=([^&#]+)/);
  return m ? normCode(decodeURIComponent(m[1])) : '';
};

/**
 * 部屋の書類の形。⚠**中身は合図だけ**。映像そのものは通さない(端末どうしの直通で流れる)。
 */
export const newRoom = (code, nowMs) => ({
  code: normCode(code),
  createdAt: num(nowMs, 0),
  // 👀🚨 **見る側(PC)が「まだ見ています」と書き足す印**(下の VIEW_PING_MS を参照)。
  //   ⚠ここに最初から入れておくのが肝。入れないと、部屋が出来てから最初の印が
  //     届くまでの間、撮る側が「誰も見ていない」と判断して1コマも送らない。
  //   ⚠**この1個で書き込みは増えない**(部屋を作る書き込みに相乗りしている)。
  viewAt: num(nowMs, 0),
  // 見る側(PC)が書く / 撮る側(スマホ)が書く
  offer: null, answer: null,
  // ⚠⚠ 経路の候補は **配列にしない**。両側から何度も足すので、配列だと
  //   読んで書き足す間に相手の分が消える(後勝ち)。**鍵つきの入れ物**にして、
  //   足す時はその鍵だけ書く(setDoc merge が壊さない)。
  offerIce: {}, answerIce: {},
  // 撮る側の様子(画面に出す)
  camReady: false, recording: false, note: '',
  // 撮りながら立てた旗(要点)。⚠こちらも同じ理由で鍵つきの入れ物
  flags: {},
});

/** 部屋がまだ使えるか。⚠古い部屋につながないための見張り。 */
export const roomAlive = (room, nowMs) => {
  if (!room || !room.createdAt) return false;
  return num(nowMs, 0) - num(room.createdAt, 0) < ROOM_TTL_MIN * 60 * 1000;
};

/** 経路の候補・旗の鍵。⚠同じ物を2回足さないための名前。 */
export const iceKey = (cand) => 'k' + String(JSON.stringify(cand || '')).split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 7).toString(36);
export const flagKey = (atSec) => 'f' + Math.round(num(atSec, 0) * 10);

/** 鍵つきの入れ物でも配列でも、同じように並びとして読む。 */
export const asList = (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []));

/**
 * 📷 コマ送りの1枚が「新しいか」。⚠古い絵を映したまま「つながっています」と言わない。
 */
export const frameFresh = (frameAt, nowMs, maxSec = 6) =>
  num(frameAt, 0) > 0 && num(nowMs, 0) - num(frameAt, 0) < num(maxSec, 6) * 1000;

/**
 * 📷 コマ送りの速さ。清水さん(2026-08-13)「0.5秒毎は無理なの？」→ できる。
 *
 * ⚠⚠ Firestore は **1つの書類に毎秒1回** が目安。0.5秒だと倍になって詰まり、
 *   かえって遅れる。→ **書類を2つ用意して交互に書く**。1つあたりは毎秒1回のまま。
 *   受け取る側は **新しい方を映す** だけ。
 */
/**
 * コマ送りの速さ。
 *
 * ⚠⚠ **これは「動画」ではなく「写真の連続」**。1秒あたりのコマ数は
 *   `1000 / everyMs` で頭打ちになる。なめらかに見えるには 15〜30コマ/秒 要るので、
 *   ここをいくら詰めても **カクカクは根本的には消えない**(清水さん 2026-08-16)。
 *   0.5秒=2コマ/秒 / 0.2秒=5コマ/秒。5コマでも「パラパラ漫画」の域。
 *   → 本筋は **なめらかな中継(WebRTC/srcObject)で繋ぐ**事。ここはその逃げ道。
 *
 * ⚠⚠ **回線が速くてもコマ数は増えない**(清水さんが「変わらないって表現が謎」と言われた所)。
 *   送るのは **時計仕掛け**で everyMs ごと。速い回線は「その1枚が遅れずに着く」だけで、
 *   枚数そのものは増やせない。逆に遅い回線では **間に合わず飛ぶ**ので 2コマ/秒 を下回る。
 *   = 速い回線 … 上限どおり(それ以上にはならない) / 遅い回線 … 上限を下回る。
 *
 * ⚠ slots = 何枚の書類に振り分けるか。**1つの書類に毎秒1回まで**を守る為
 *   (Firestore の同じ書類を毎秒何度も書き換えると弾かれる)。everyMs を詰めるなら
 *   slots も一緒に増やす事。0.2秒 → 5コマ/秒 なので 5枚に振り分ける。
 * ⚠ 通信量は everyMs に反比例する。0.2秒は 0.5秒の **2.5倍**。
 *   4G/LTE の使い放題でない回線では、ここを既定にしない事。
 */
/**
 * ⚠⚠ 2026-08-17: **既定を「1秒ごと」から「2秒ごと」へ移した。**
 *   数を変えたのではなく、**どちらを既定にするか** を枠から逆算して決め直した
 *   (下の DEFAULT_FRAME_SPEED / speedKeyForBudget)。
 *   ・中継に使ってよい枠 10,000回/日 ÷ 目標4時間 = **1コマ1.44秒より速くできない**
 *   ・1秒ごと … 3,600回/時。中継の枠は 2.8時間ぶんしか無い
 *   ・2秒ごと … 1,800回/時。**5.6時間ぶん**あり、目標の4時間に収まる
 *   ⚠名前も直した。既定が「ギガ節約」だと、現場は「絞られている」と思って
 *     必ず速い方へ変える(そして枠が尽きる)。**既定を「ふつう」と呼ぶ。**
 */
export const FRAME_SPEEDS = {
  normal: { key: 'normal', everyMs: 1000, slots: 1, label: 'こまめ（1秒ごと・枠を2倍使います）' },
  saving: { key: 'saving', everyMs: 2000, slots: 1, label: 'ふつう（2秒ごと・既定）' },
};
export const frameSpeedOf = (k) => FRAME_SPEEDS[k] || FRAME_SPEEDS.normal;

/** 1秒あたり何コマになるか。⚠画面に出して「これ以上は増えない」と分かるようにする。 */
export const framesPerSec = (k) => {
  const s = frameSpeedOf(k);
  return Math.round((1000 / Math.max(1, s.everyMs)) * 10) / 10;
};

/**
 * 何番目の書類に書くか。⚠**1つの書類に毎秒1回**を守るための振り分け。
 * @param n 送った回数
 */
export const frameSlot = (n, slots) => {
  const k = Math.max(1, Math.round(Number(slots) || 1));
  return Math.abs(Math.round(Number(n) || 0)) % k;
};

/** 受け取った複数の書類から、**一番新しい1枚**を選ぶ。 */
export const newestFrame = (frames) => {
  let best = null;
  for (const f of (frames || [])) {
    if (!f || !f.url) continue;
    if (!best || Number(f.at || 0) > Number(best.at || 0)) best = f;
  }
  return best;
};

/** いままでの呼び方(1枚だけ送る時の間隔)。 */
export const FRAME_EVERY_MS = 1000;
/** コマ送りの絵の大きさ(長辺)。⚠画角が分かればよい。大きくすると通信量だけ増える。 */
/**
 * コマ送りで送る絵の 長辺 と 画質。
 *
 * ⚠⚠ 2026-08-16 に 640px/画質0.5 から **1280px/画質0.7** へ上げた。
 *   同時に間隔を 0.5秒 → 1秒 にしたので、**通信量はほぼ同じ**(実測 約53KB/秒)。
 *   なぜ「枚数を減らして1枚を大きく」なのか:
 *     手が写っている映像では、**コマ数より1枚の鮮明さの方が読み取りに効く**
 *     (手話の研究で実証。同じ通信量ならコマを増やすほど1枚が甘くなり、かえって読めない)。
 *     Microsoft の産業用遠隔支援も、回線が細いと映像をやめて**高解像度の静止画**に切り替える。
 *   → 絵の画素は **4倍**、Firebaseへの書き込みは **半分**(枠が2.8時間→5.6時間もつ)。
 */
export const FRAME_MAX_W = 1280;
export const FRAME_QUALITY = 0.7;

// ===========================================================================
// 🚨🚨 中継が「1日の書き込み枠」を焼き切るのを止める門（2026-08-17）
// ---------------------------------------------------------------------------
// 実測で分かっていた事:
//   ・1コマ = 1書き込み(JPEGを丸ごと差し替え)。1秒ごとなら **3,600回/時**。
//     枠は 20,000回/日 なので **5.6時間で尽きる**(2台同時なら2.8時間)。
//   ・🚨 **録画していなくても、カメラ画面を開いているだけで送り続けていた。**
//   ・🚨 **PCが「閉じる」を押さずにタブを消すと部屋が最大30分残る**(ROOM_TTL_MIN)。
//     その30分 = 1,800回。**誰も見ていないのに書き続けていた。**
//   ・枠は4アプリで1つ。使い切ると **検査の作業記録が保存できなくなる**。
//
// 🚨🚨 そして一番たちが悪い所（Firestore SDK の現物で確認済み）:
//   枠が尽きると setDoc の約束は **永久に解決しない。失敗にもならない。**
//   RESOURCE_EXHAUSTED が「一時エラー」扱いなので拒否されず、最大60秒間隔で無限に送り直す。
//   = **await した保存が永久に返らない。画面にもコンソールにも一切出ない。**
//   → だから「詰まったら送るのをやめる」見張り(FRAME_STUCK_MS)がここに要る。
//     詰まったまま送り続けると、JPEGを抱えた待ち行列が端末の中で膨らみ続ける。
//
// ⚠⚠ **画質ではなく回数を落とす。** 課金も枠も **件数** で数える。バイト数ではない。
// ===========================================================================

/**
 * 👀 見る側(PC)が「まだ見ています」と部屋に書き足す間隔(ms)。
 * ⚠⚠ **この印を書くのも書き込み**なので、コマ送りより粗くする。12秒なら 300回/時。
 *   止まる方は 1,800〜3,600回/時 なので、**増える分は減る分の 1/6〜1/12**。
 * 🚨 2026-08-31: 30秒→12秒へ。「誰も見ていない」に **30秒で気づく**(下の VIEW_STALE_MS)為には、
 *   印はその 2.5分の1 で打つ(1回取りこぼしても、30秒の中に次の印が入る)。
 * ⚠⚠ 見ていない間(タブが裏・最小化)は **印を打たない**(LiveViewer 側の配線)。
 *   打ち続けると「誰も見ていないのに送り続ける」が、印のせいで一生直らない。
 */
export const VIEW_PING_MS = 12000;
/**
 * 👀 その印が これより古くなったら「もう誰も見ていない」と決める(ms)。
 * ⚠印1回ぶんの取りこぼし(電波の一瞬の途切れ)で止めない為、間隔の 2.5倍 にする。
 * ⚠⚠ これが「PCがタブを消しただけの部屋」を止める仕掛け。部屋の30分は待たない。
 * 🚨 2026-08-31 の直し方針: 75秒→**30秒**へ(「心拍が30秒途切れたら送信を止める」)。
 *   見る人が戻れば viewAt がその場で書かれ(visibilitychange で即1回)、数秒で自動再開する。
 * 🚨🚨 2026-08-31 夜の是正: この30秒は **「印を受け取った時刻」から数える**。
 *   viewAt は見る側(PC)の時計で書かれた数字なので、撮る側(スマホ)の時計と
 *   直に引き算してはいけない。**端末どうしの時計は簡単に数十秒ずれる**ので、
 *   30秒で切ると「見ているのに止まる」→ 現場は「映らない」と言う(前は45秒の余裕があった)。
 */
export const VIEW_STALE_MS = 30000;
/**
 * 🚨 **受け取った時刻が分からない時だけ**足す、時計ズレの余裕(ms)。
 * ⚠⚠ どうしても viewAt(相手の時計)と いまの時刻(こちらの時計)を引き算するしかない時、
 *   **端末どうしの時計の差がそのまま誤差**になる。ここを0にすると、見ている最中でも
 *   時計が18秒ずれているだけで送信が止まる。
 * ⚠この45秒は作った数ではない。2026-08-31 の朝までこの見切りは **75秒 = 30 + 45** だった。
 *   受け取った時刻が渡っている所(撮影画面の frameSendPlan)では **1ミリ秒も足さない**
 *   = 狙いどおり きっちり30秒で止まる。
 */
export const VIEW_SKEW_SLACK_MS = 45000;
/**
 * 📷 **録画していない時に、画角合わせで送ってよい枚数。**
 * ⚠清水さんの用途は「手が入っているか・切れていないか」を先に合わせる事なので、
 *   開いた直後の何コマかは必ず要る。**そこだけ通して、あとは止める。**
 * ⚠⚠ **30枚 = 既定(2秒ごと)で ちょうど60秒ぶん。** ここを短くしすぎない。
 *   PC側は この間に「保存先」「きれいさ」を選んでから ● を押す。40秒では足りず、
 *   毎回「▶ 画角をもう一度見る」を押させる事になる(押させる設計はだいたい失敗する)。
 * ⚠足りなければPCの「▶ 画角をもう一度見る」でもう1回ぶん配られる
 *   (**押した人が要ると言った時だけ**増える。勝手には増えない)。
 * ⚠30回の書き込みは、1秒ごとに送り続けた時の **30秒ぶん**でしかない。
 */
export const PREVIEW_FRAMES = 30;
/**
 * ⏱ 1コマの保存が これだけ返って来なければ「詰まった」と見なす(ms)。
 * ⚠⚠ 枠が尽きた時、保存の約束は **永久に返らない**(上の説明)。待ち続けると
 *   送り手の待ち行列にJPEGが積み上がるだけなので、**見切って止めて、画面に出す**。
 */
export const FRAME_STUCK_MS = 8000;

/** 👀 「まだ見ています」の印。⚠1つの鍵だけ書く(他の合図を消さない)。 */
export const viewPingPatch = (nowMs) => ({ viewAt: num(nowMs, 0) });
/** ▶ 「画角をもう一度見せて」の申し出。⚠押した時だけ書く。 */
export const wantPreviewPatch = (nowMs) => ({ wantPreviewAt: num(nowMs, 0) });
/** 📷 撮る側が「いま送っている/止めている理由」を報告する。⚠**変わった時だけ**書く。 */
export const frameWhyPatch = (why) => ({ frameWhy: String(why || '') });

/**
 * 👀 見る側が本当にまだ居るか。
 * ⚠⚠ 印が **1度も書かれていない部屋** は「古い版のPCが作った部屋」なので、
 *   居ない事にしない(画角合わせを黙って殺さない)。その場合も下の PREVIEW_FRAMES で
 *   出血は20コマまでに止まる。
 *
 * 🚨🚨 **時計を混ぜない**(2026-08-31 夜)。
 *   room.viewAt は 見る側(PC)の時計。nowMs は 撮る側(スマホ)の時計。
 *   この2つの引き算は「経過時間」ではなく「経過時間 ＋ 端末どうしの時計のズレ」になる。
 *   → 印を **受け取った時刻**(こちらの時計で控えた物)を渡してもらえば、
 *     式から相手の時計が丸ごと消える。残る誤差は配達の遅れ1回分だけ。
 *
 * @param room     いまの部屋
 * @param nowMs    いまの時刻(こちらの時計)
 * @param seenAtMs その印を **受け取った**時刻(こちらの時計)。0 = 分からない
 */
export const viewerFresh = (room, nowMs, seenAtMs = 0) => {
  if (!room) return false;
  const at = Number(room.viewAt);
  if (!Number.isFinite(at) || at <= 0) return true;   // ⚠印の無い部屋＝古い版。止めない
  const seen = num(seenAtMs, 0);
  // ① 受け取った時刻が分かる = **こちらの時計だけ**で測れる(時計ズレは式から消える)
  if (seen > 0) return num(nowMs, 0) - seen < VIEW_STALE_MS;
  // ② 分からない時だけ、相手の時計の数字と引き算する。**その分の余裕を必ず足す**
  return num(nowMs, 0) - at < VIEW_STALE_MS + VIEW_SKEW_SLACK_MS;
};

/** 送る/送らないの理由を、そのまま画面に出す言葉に。⚠黙って止めない為に必ず対で持つ。 */
export const FRAME_WHY_TEXT = {
  recording: '録画中なので送っています',
  preview: '画角合わせのぶんを送っています',
  previewdone: '画角合わせのぶんを送り終えたので止めています（枠の節約）',
  rtc: 'なめらかな中継で映っているので止めています',
  // 🚨 2026-08-31: 「カメラは動いている(録画は無事)」まで言い切る。止まった理由を電波と取り違えさせない。
  noviewer: '見ている人がいないので送信を止めています（カメラは動いています。見る人が戻れば自動で再開します）',
  gone: 'PC側が閉じたので止めています',
  stuck: '⚠ 送信が詰まっています（1日の枠を使い切った可能性）',
  error: 'カメラが使えないので送っていません',
  unsupported: 'この端末では送れません',
  // 📷 2026-08-23 追加(製品)→2026-08-31 最終へ移植。**同じ絵を送り直さない**(下の framesDiffer / applyStillSkip)
  still: '画が止まっているので、同じ絵を送り直していません（動いたらすぐ送ります）',
  // 🚨 2026-08-23 追加(製品)→2026-08-31 最終へ移植。**1日の硬い上限に達した**(下の frameSendPlan の門)
  budget: '今日の中継の上限に達したので送信を止めています（検査の記録を守るため。枠が戻れば自動で再開します）',
};
/** ⚠まだ決まっていない(空)時に「止めています」と言わない(開いた直後に不安にさせる)。 */
export const frameWhyText = (why) => FRAME_WHY_TEXT[why] || (why ? '止めています' : '用意しています…');

// ===========================================================================
// 📷🚨 **画が動いていない時は、同じ絵を送り直さない**（2026-08-23 製品→2026-08-31 最終へ移植）
// ---------------------------------------------------------------------------
// なぜ要るのか:
//   ここまでの門(frameSendPlan)は「送ってよい場面か」しか見ていない。**場面が正しければ、
//   絵が1ドットも変わっていなくても everyMs ごとに1回書いていた。**
//   現場の使い方は「スマホを置いて／固定して撮る」なので、**止まっている時間が長い**。
//   ・置いたまま段取りをしている / 人が写野の外にいる → 何分でも同じ絵
//   ・録画を始める前の画角合わせ → 構えが決まった後は同じ絵
//   1コマ = 1書き込み なので、**止まっている間の書き込みは1回残らず無駄**。
//
// ⚠⚠ **間隔は1ミリ秒も広げない。** 動いた瞬間に、次の tick でそのまま送る。
//   現場から見た速さ(動いている時のコマ数)は今までと同じ。
//
// ⚠⚠ **黙って止めない。** 3枚ぶん止めたら理由を 'still' として部屋へ書き、
//   PC側は「画が止まっているので送り直していません」と出す。
//   (ここを黙ると、PCには「絵が来ない＝壊れた」としか見えず、つなぎ直しが始まる)
//
// ⚠⚠ 見比べるのは **縮めた絵** (16×12 の明るさ)。1280×720 を1ドットずつ比べると
//   それ自体が重い。縮めた絵なら 192個の引き算で済む。
//   ⚠⚠ **JPEGのバイト列を比べてはいけない**。同じ景色でもセンサのざらつきで毎回
//     違うバイト列になるので「毎回動いている」と出て、1回も減らない。
// ===========================================================================

/**
 * 見比べる時の絵の細かさ(マスの数)。
 * ⚠⚠ 粗いほど **小さい動きを見落とす**。32×24 なら 1マス = 1280×720 のうち 40×30px、
 *   下の STILL_MOVE_CELLS(2マス) は **画面の約0.26%** にあたる。
 *   16×12 だと同じ2マスが約1%になり、腕時計くらいの物の動きを取りこぼす。
 * ⚠比べるのは 768個の引き算だけ。1280×720 を1ドットずつ(92万回)見るのとは桁が違う。
 */
export const STILL_GRID_W = 32;
export const STILL_GRID_H = 24;
/**
 * 1マスの明るさが これだけ違ったら「そのマスは動いた」(0〜255)。
 * ⚠⚠ 0 にしてはいけない。カメラは静止していても毎コマ ±1〜3 ゆれる(センサのざらつき)。
 *   0 にすると「毎回動いている」と出て、**1回も減らない**。
 */
export const STILL_TOL = 6;
/**
 * 何マス動いたら「絵が動いた」とみなすか。
 * ⚠1マスだけの揺れ(反射・表示ランプの点滅)で送り直さない。
 * ⚠⚠ 大きくしすぎると **小さい手の動きを見落として送らなくなる**。768マス中2マス
 *   = 画面の約0.26%。
 */
export const STILL_MOVE_CELLS = 2;
/**
 * 🚨 絵ぜんぶの明るさが これだけ動いたら、中身に関係なく「動いた」(0〜255)。
 * ⚠⚠ **自動露出/自動ホワイトバランス対策**。カメラは何も動いていなくても明るさを
 *   勝手に上げ下げする。そのズレをそのまま数えると **全マスが「動いた」になり、
 *   本番では1回も減らない門**になる(2026-08-10「本番で一致0/45」と同じ壊れ方)。
 *   → 下の framesDiffer は **全体のズレを先に引いてから** マスを比べる。
 * ⚠ただし引きっぱなしにはしない。部屋の明かりが消えた/点いたのに「止まっている」と
 *   言い続けるのは嘘なので、**全体が12(約5%)を超えて動いたら送り直す**。
 */
export const STILL_LIGHT_TOL = 12;
/**
 * 何枚ぶん止めたら、その事を部屋へ書くか。
 * ⚠⚠ **これが「止めた事を知らせる書き込み」で損をしない為の線**。
 *   知らせるのに 入る時1回・戻る時1回 = 2回書く。3枚止めてから知らせれば
 *   **止めた3回 > 知らせた2回** で必ず得になる。1枚で知らせると損をする事がある。
 * ⚠3枚 = 既定(2秒ごと)で6秒。PC側が「古い絵」と見なすのは8秒なので、
 *   **PCが不安になる前に理由が届く**(ここを8秒より後にしない)。
 */
export const STILL_TELL_AFTER = 3;

/**
 * 📷 縮めた絵を2枚 見比べて「動いたか」を返す。
 *
 * ⚠⚠ **分からない時は「動いた」を返す**(安全側)。片方が無い/長さが違うなら送る。
 *   ここを逆(送らない)にすると、**カメラが開いた直後に1枚も送らない**事故になる。
 *
 * @param a 前に送った絵の明るさ(0〜255の並び)
 * @param b いまの絵の明るさ(同じ長さ)
 * @returns true=動いた(送る) / false=止まっている(送らない)
 */
export const framesDiffer = (a, b, tol = STILL_TOL, minCells = STILL_MOVE_CELLS) => {
  if (!a || !b) return true;
  const la = a.length, lb = b.length;
  if (!la || la !== lb) return true;
  const t = Math.max(0, num(tol, STILL_TOL));
  const need = Math.max(1, Math.round(num(minCells, STILL_MOVE_CELLS)));
  // ① 絵ぜんぶの明るさのズレ(＝自動露出が勝手に動かした分)を出す
  let sa = 0, sb = 0;
  for (let i = 0; i < la; i++) { sa += num(a[i], 0); sb += num(b[i], 0); }
  const shift = (sb - sa) / la;
  // ② ズレが大きすぎる = 明かりそのものが変わった。**中身を見るまでもなく送り直す**
  if (Math.abs(shift) > STILL_LIGHT_TOL) return true;
  // ③ そのズレを引いてから、マスごとに見比べる(露出の揺れを「動いた」と取り違えない)
  let cells = 0;
  for (let i = 0; i < la; i++) {
    if (Math.abs((num(b[i], 0) - shift) - num(a[i], 0)) > t) {
      cells += 1;
      if (cells >= need) return true;
    }
  }
  return false;
};

/**
 * 📷🚨 送ると決まった1枚を、**絵が同じなら送らない**に上書きする。
 *
 * ⚠⚠ 判断を画面の中に散らさない(frameSendPlan と同じ理由)。ここ1か所に置いて、
 *   画面は「その通りに動くだけ」にする。
 * ⚠⚠ **止めた枚数が {@link STILL_TELL_AFTER} 枚に届くまでは理由を書き換えない。**
 *   理由が変わるたびに部屋へ1回書くので、1枚ごとに 'still' と書くと
 *   **減らした分を書き込みで食い潰す**。
 *
 * @param plan    frameSendPlan() の答え
 * @param same    前に送った絵と同じか(framesDiffer の逆)
 * @param skipped 続けて送らなかった枚数(この1枚を **含む**)
 * @returns plan と同じ形。send=false になった時だけ中身が変わる
 */
export const applyStillSkip = (plan, same, skipped = 0) => {
  if (!plan || !plan.send || !same) return plan;
  const n = Math.max(0, Math.round(num(skipped, 0)));
  const why = n >= STILL_TELL_AFTER ? 'still' : plan.why;
  return { ...plan, send: false, why, text: frameWhyText(why), left: plan.left };
};

/**
 * 📷🚨 **いま1コマ送ってよいか。中継の枠を守る、唯一の門。**
 *
 * ⚠⚠ 判断を画面(LiveCamera.jsx)の中に散らさない。散らすと、条件が1つ増えるたびに
 *   どこかの枝だけ直し忘れて **本番で一度も点かない門** になる
 *   (2026-08-10「設定はマスタのid・判定はロットのstep.id で一致0/45」と同じ壊れ方)。
 *
 * @param s.room        いまの部屋(null = 消えた)
 * @param s.nowMs       いまの時刻
 * @param s.rtcSteady   なめらかな中継が **落ち着いて** 繋がっているか
 * @param s.gone        PC側が閉じたと分かっているか
 * @param s.recording   いま録画しているか
 * @param s.previewSent 録画前に送った枚数(この回のぶん)
 * @param s.stuck       送信が詰まっているか
 * @param s.todayWrites この端末が今日この機能で書いた回数(端末の中の控え)
 * @param s.viewSeenAt  「まだ見ています」の印を **受け取った**時刻(こちらの時計)。
 *                      🚨渡さないと相手の時計と引き算する事になり、時計ズレの分だけ
 *                      早く「誰も見ていない」に倒れる(上の viewerFresh)。
 * @returns {{send:boolean, why:string, text:string, left:number}}
 */
export const frameSendPlan = (s = {}) => {
  const nowMs = num(s.nowMs, 0);
  const sent = Math.max(0, Math.round(num(s.previewSent, 0)));
  const left = Math.max(0, PREVIEW_FRAMES - sent);
  const out = (send, why) => ({ send, why, text: frameWhyText(why), left });
  // ⚠順番に意味がある。**止める理由から先に見る**(送る理由が1つでも先に立つと門が緩む)。
  if (s.supported === false) return out(false, 'unsupported');
  if (s.error) return out(false, 'error');
  if (s.stuck) return out(false, 'stuck');
  // 🚨🚨 **1日の硬い上限(安全弁)に達したら、そこで必ず止める**(2026-08-23→2026-08-31 強化)。
  //   ⚠⚠ 2026-08-17 から回数は数えて画面にも出していたが、**数えるだけで止めていなかった**。
  //     「使いすぎです」と赤く出しても、送るのは止まらない = 出血は止まらない。
  //   ⚠これが在るので、この機能が1日に書く回数は **どんな使われ方をしても
  //     RELAY_HARD_CAP_DAY 回を超えない**(=検査の記録のぶんは必ず残る)。
  //   ⚠黙って止まらない: 理由 'budget' は部屋にも書かれ、撮影側にも視聴側にも文言が出る。
  //   ⚠日付が変わる(日本時間16:00)と控えが0に戻り、自動でまた使えるようになる。
  if (num(s.todayWrites, 0) >= RELAY_HARD_CAP_DAY) return out(false, 'budget');
  if (s.gone || !s.room) return out(false, 'gone');
  if (s.rtcSteady) return out(false, 'rtc');
  if (!viewerFresh(s.room, nowMs, s.viewSeenAt)) return out(false, 'noviewer');
  if (s.recording) return out(true, 'recording');
  if (left > 0) return out(true, 'preview');
  return out(false, 'previewdone');
};

// ---------------------------------------------------------------------------
// 🔥 1日の書き込み枠 と、そこから逆算した既定の速さ
//
// ⚠⚠ **ここが数字の出どころ**。画面でも表でも掛け算をしない(2か所で違う数字が出る)。
// ⚠liveDataUsage.js は この2つを読み直して使う(定数を2か所に書かない)。
// ---------------------------------------------------------------------------
/** Firestore の無料枠(書き込み/日)。実測(2026-08-16 公式ページ)。⚠4アプリで1つ。 */
export const FS_WRITES_DAY = 20000;
/**
 * そのうち **中継に使ってよい分**。
 * ⚠⚠ 残りは検査の作業に要る。実測で **1,100〜4,700回/日**(4アプリ合計)。
 *   多い日(4,700)に加えて、テンプレ保存・連絡・司令塔の読み書きが乗る。
 *   → 中継は **半分まで**。ここを 20,000 にすると、中継が枠を独り占めして
 *     **検査の記録が保存できなくなる**(それが 2026-08-17 に起きた事)。
 */
export const RELAY_WRITE_BUDGET_DAY = 10000;
/**
 * 🚨🚨 **硬い上限(安全弁)。中継が1日に書いてよい絶対の回数**(2026-08-31)。
 * ⚠⚠ 上の RELAY_WRITE_BUDGET_DAY(10,000)は「設計の予算」(表や逆算に使う数字)。
 *   こちらは **必ず止まる線**。枠(20,000回/日)の2割 = 4,000回。
 *   frameSendPlan がこの線で send=false('budget') を返すので、
 *   **どんな使われ方をしても中継はこの回数で必ず止まる**(=検査の記録のぶんは必ず残る)。
 * ⚠⚠ 出荷の門(scripts/verify-write-budget.mjs)は、この線が実コードで本当に効く事を
 *   確かめてから初めて緑を出す。**この値を枠の半分以上へ緩めると、門はそのまま赤に戻る。**
 * ⚠止まる時は黙らない(撮影側・視聴側の両方に理由が出る)。日本時間16:00に控えが0へ戻り自動再開。
 */
export const RELAY_HARD_CAP_DAY = Math.round(FS_WRITES_DAY * 0.2);   // = 4,000回/日
/**
 * 1日に中継が **実際に送っている** 時間の目標(時間)。
 * ⚠⚠ 上の門を入れた後は「画面を開いている時間」ではなく **録画している時間** に効く。
 *   手本動画を1本6分として、1日40本撮っても4時間。**現場が1日中使っても足りる**。
 */
export const RELAY_TARGET_HOURS_DAY = 4;

/** その間隔で送り続けたら、1時間あたり何回書くか。 */
export const writesPerHour = (everyMs) => Math.round(3600000 / Math.max(1, num(everyMs, 1000)));
/** 👀「見ています」の印が、1時間あたり何回書くか。 */
export const pingWritesPerHour = () => writesPerHour(VIEW_PING_MS);
/** 目標の時間ぶん送っても枠に収まる、**1コマあたりの最短の間隔**(ms)。 */
export const minFrameEveryMs = (hours = RELAY_TARGET_HOURS_DAY, budget = RELAY_WRITE_BUDGET_DAY) =>
  Math.ceil((Math.max(0, num(hours, 0)) * 3600 * 1000) / Math.max(1, num(budget, 1)));
/**
 * 🚨 **既定の速さを、枠から逆算して決める。**
 * ⚠⚠ 「なんとなく1秒」で決めない。10,000回 ÷ 4時間 = **1コマ1.44秒より速くできない**。
 *   → 用意してある中で、それを満たす **一番速い物** を既定にする。
 */
export const speedKeyForBudget = (hours = RELAY_TARGET_HOURS_DAY, budget = RELAY_WRITE_BUDGET_DAY) => {
  const need = minFrameEveryMs(hours, budget);
  const list = Object.values(FRAME_SPEEDS).slice().sort((a, b) => a.everyMs - b.everyMs);
  const fit = list.find((s) => s.everyMs >= need);
  return (fit || list[list.length - 1] || FRAME_SPEEDS.normal).key;
};
/** 📷 既定の速さ。⚠画面で 'normal' と書き直さない。**必ずこれを使う**。 */
export const DEFAULT_FRAME_SPEED = speedKeyForBudget();
/** その速さなら、中継の枠(1日)で何時間ぶん送れるか。 */
export const relayHoursInBudget = (everyMs, budget = RELAY_WRITE_BUDGET_DAY) =>
  Math.round(((Math.max(1, num(everyMs, 1000)) * Math.max(0, num(budget, 0))) / 3600000) * 10) / 10;

/**
 * 🚩 撮りながら立てた旗を、編集室の「章」と「要点」の候補にする。
 *
 * ⚠⚠ ここが撮影と編集をつなぐ肝。
 *   撮り終わってから6分の動画を見返して要点を探す作業が丸ごと消える。
 * ⚠旗の時刻は **録画を始めてからの秒**。撮る側の時計と見る側の時計は合っていないので、
 *   **押した瞬間の時刻の差**ではなく「録画開始からの経過」で持つ(ここを間違えると全部ズレる)。
 *
 * ⚠⚠ **まとめた分は必ず数えて返す**(2026-08-13 ハーネスで発覚)。
 *   3秒でまとめていたので「2回押したのに章は1つ」が起き、しかも画面には旗が2本
 *   出たままだった。**押した人にとっては黙って1本消えたのと同じ**。
 *   → ①まとめる幅は「押し間違いの連打」だけに届く長さにする(1.2秒)
 *     ②まとめた本数を返して、画面に出す。
 *
 * @param flags [{atSec, label}]
 * @param durationSec 出来上がった動画の長さ(これを超える旗は捨てる)
 * @returns {chapters:[{name, atOut}], marks:[{atSec, label}], merged:number, dropped:number}
 */
export const FLAG_MIN_GAP_SEC = 1.2;
export const flagsToChapters = (flags, durationSec = 0, minGap = FLAG_MIN_GAP_SEC) => {
  const dur = num(durationSec, 0);
  const all = asList(flags)
    .map(f => ({ atSec: num(f?.atSec, NaN), label: typeof f?.label === 'string' ? f.label.trim() : '' }))
    .filter(f => Number.isFinite(f.atSec) && f.atSec >= 0);
  const list = all
    .filter(f => !(dur > 0) || f.atSec < dur - 0.2)
    .sort((a, b) => a.atSec - b.atSec);
  const out = [];
  let merged = 0;
  for (const f of list) {
    const prev = out[out.length - 1];
    // ⚠押し間違いの連打をまとめる。**まとめた分は数える**(黙って消さない)
    if (prev && f.atSec - prev.atSec < minGap) { merged++; continue; }
    out.push(f);
  }
  return {
    chapters: out.map((f, i) => ({ name: f.label || `要点${i + 1}`, atOut: Math.round(f.atSec * 100) / 100 })),
    marks: out.map(f => ({ atSec: Math.round(f.atSec * 100) / 100, label: f.label })),
    merged,
    // 動画より後ろに付いていて捨てた分(押したまま録画が終わった時)
    dropped: all.length - list.length,
  };
};

/** つながり具合の言い方。⚠「接続中…」のまま放置しない。 */
export const linkStateText = (state) => ({
  new: 'つなぎ先を探しています…',
  checking: 'つないでいます…',
  connected: 'つながりました',
  completed: 'つながりました',
  disconnected: '切れました（電波を確認してください）',
  failed: 'つながりませんでした（この場所のWi-Fiは端末どうしの直通を許していないかもしれません）',
  closed: '終了しました',
}[state] || 'つないでいます…');
