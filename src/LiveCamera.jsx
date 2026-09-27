// ============================================================================
// 📱 スマホのカメラを、この画面で見ながら撮る
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13)
//   「別の端末(スマホ)で撮ってる映像をこのアプリでリアルタイムで見れる？」
//   「その方式でアプリでカメラ映像見れるようにして、見れるっていうか録画だね」
//   「リアルタイム編集が可能だけど、どんな風にするかって感じだね」
//
// ⚠⚠ 役割を分けている(ここを混ぜると画質が電波任せになる):
//   ・**録画は撮る側(スマホ)で録る** … 電波が悪くても録画は高画質のまま
//   ・**この画面に映るのは画角合わせ用** … WebRTC は回線が細ると勝手に画質を落とす
//
// ⚠⚠ リアルタイム編集で本当に効くのは「印を置く」ではなく **🚩いま要点**:
//   撮りながら押しておくと、撮り終わった瞬間に **章と要点の候補が入っている**。
//   撮り終わってから6分の動画を見返して要点を探す作業が丸ごと消える。
//   印はあとから「⏸止め絵」にすればズレない(だから撮影中に置く必要が無い)。
//
// ⚠映像は端末どうしの直通。**動画はクラウドに一切上がらない**(合図の文字だけ)。
// ============================================================================

import React, { useState, useRef, useEffect, useMemo, useCallback, useContext, createContext } from 'react';
import QRCode from 'qrcode';
import { startViewer, startCamera, hasLive, zoomRangeOf, setZoom, liveStatsOf, liveStatsText } from './liveLink.js';
import {
  makeCode, normCode, liveUrl, newRoom, roomAlive, flagsToChapters, CONNECT_TIMEOUT_SEC,
  asList, flagKey, frameFresh, FRAME_MAX_W, FRAME_QUALITY,
  FRAME_SPEEDS, frameSpeedOf, frameSlot, newestFrame,
  // 🚨 中継が1日の書き込み枠を焼き切るのを止める門(2026-08-17)。判断は全部 domain 側。
  frameSendPlan, frameWhyText, viewPingPatch, wantPreviewPatch, frameWhyPatch,
  VIEW_PING_MS, VIEW_STALE_MS, PREVIEW_FRAMES, FRAME_STUCK_MS, DEFAULT_FRAME_SPEED,
  pingWritesPerHour, writesPerHour,
  // 📷 画が動いていない時は、同じ絵を送り直さない(2026-08-23)。判断は全部 domain 側。
  framesDiffer, applyStillSkip, STILL_GRID_W, STILL_GRID_H, STILL_TELL_AFTER,
} from './domain/liveSession.js';
import {
  recPhase, videoSec, clockSkew,
  wantStart, wantStop, wantPause, wantResume, newTakePatch,
  reportStart, reportPause, reportResume, reportStop,
  liveFlags, flagAddPatch, flagRenamePatch, flagDeletePatch,
  WHOLE, isWhole, targetLabel, takeOf,
  REC_QUALITIES, recQualityList, recQualityLabel, recMbPerMin, pickRecQuality, recVideoConstraints, wantQualityPatch, recCapsPatch,
  nextViewScale, nextViewRotate, viewStageBox, viewRotatePatch,
  folderLabel, folderPathPatch, upPhase, upDoingPatch, upOkPatch, upNgPatch,
} from './domain/liveRecording.js';
// ============================================================================
// 📊 「10分とったら / 20分とったら どれくらいか」の表を、**選ぶその場で**開けるようにする
//
// 清水さん(2026-08-16)
//   「10分とったら20分とったらってなったら **どれぐらいの表になるのかも表で見れたらいい**」
//   「今の表って通信容量？保存したときのファイルの容量？**両方いるよ**」
//
// ⚠⚠ 表は既に `DataUsageTable.jsx` に在る(📁資料の頭・⚙設定の2か所から開ける)。
//   だが **一番要るのは、きれいさ(＝容量)を選ぶこの画面**。選ぶ本人が選ぶその場で
//   「10分で何MB」を見られないと、表が在っても判断に使われない。
//   → **同じ物(DataUsageOpenButton)をここでも使う**。同じ事をする物を新しく作らない。
// ⚠数字は `domain/liveDataUsage.js` の recordUsage() から取る。**この画面で計算しない**。
// ============================================================================
import { DataUsageOpenButton } from './DataUsageTable.jsx';
import {
  recordUsage, mbText,
  // 🚨【使った分を人に見せる】端末の中だけで数える(この見える化で書き込みは1回も増えない)
  relayBudgetView, addDayCount, readDayCount, relayDayKey, RELAY_COUNT_KEY, VIEWPING_COUNT_KEY,
  // 🚨 1日の硬い上限(持ち主は liveSession.js。ここは素通し)。達したら本当に止まる線。
  RELAY_HARD_CAP_DAY,
} from './domain/liveDataUsage.js';

/** 表を開くボタンの言葉。⚠2か所(画質・コマ送り)で **同じ言葉**にする(別物だと思われない為)。 */
const USAGE_BTN_LABEL = '📊 10分・20分…だとどれくらい？（表）';
const USAGE_BTN_TITLE = '10分・20分…と撮ったら、📶送る通信・💾残る容量・👀見る通信がどれだけ要るかの表を開きます';

const fmt = (s) => {
  const x = Math.max(0, Math.floor(Number(s) || 0));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// 🐢 道の切り替えは **ゆっくり**にする（清水さん 2026-08-16「両方かくかくする」）
// ⚠⚠ ここを 0 にすると画面が点滅する:
//   携帯回線では繋がり具合が一瞬 disconnected に落ちる事がある。そのたびに
//   「滑らかな映像 ⇄ コマ送りの紙芝居」が入れ替わると、**それ自体がカクカクに見える**。
//   → 繋がってから少し様子を見て止める / 切れたら少し待ってから落とす。
// ---------------------------------------------------------------------------
/** 繋がってから、コマ送りを止めるまで様子を見る時間。⚠すぐ止めると切れた瞬間に真っ黒。 */
const RTC_SETTLE_MS = 3000;
/** 切れてから「簡易表示です」に切り替えるまで持ちこたえる時間。⚠一瞬の途切れで点滅させない。 */
const LIVE_HOLD_MS = 3500;
/** 実測(コマ数・大きさ・理由)を測り直す間隔。⚠画面の描き直しを増やしすぎない。 */
const STATS_EVERY_MS = 2000;
/**
 * 📷 送っていない間、送ってよくなったかを見に行く間隔。
 * ⚠⚠ **これは書き込みではない**(端末の中で条件を見るだけ)。止まっている時に
 *   間隔を空けすぎると、録画を押してから絵が出るまで待たされる。
 */
const IDLE_TICK_MS = 2000;

/** 端末の中の控え。⚠使えない端末(私用モード等)でも落ちない。 */
const localStore = () => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/**
 * 📷 いまの絵を **STILL_GRID_W×STILL_GRID_H マスの明るさ** に縮めて取り出す（同じ絵かどうかを測る為だけの物）。
 *
 * ⚠⚠ ここで取る絵は **送らない**。送る絵は今まで通り 1280px / 画質0.7 のまま。
 * ⚠⚠ 1280×720 を1ドットずつ比べると、比べる事自体がメインスレッドを止める
 *   (中継のカクカクの原因を、減らす為の処理で作ることになる)。縮めるのは描画側の
 *   仕事なので、こちらは **192個の数を読むだけ**。
 * ⚠⚠ **JPEGのバイト列を比べてはいけない。** 同じ景色でもセンサのざらつきで毎回
 *   違うバイト列になるので「毎回動いている」と出て、書き込みは1回も減らない。
 * ⚠色ではなく **明るさ** で比べる(自動ホワイトバランスの揺れを動きと取り違えない)。
 * ⚠取れなければ null を返す。呼ぶ側は null を「動いた」扱いにする(＝今まで通り送る)。
 */
const framePeek = (video, cv) => {
  try {
    if (!video || !(video.videoWidth > 0) || !cv) return null;
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(video, 0, 0, cv.width, cv.height);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    const out = new Uint8ClampedArray(cv.width * cv.height);
    for (let i = 0, j = 0; j < out.length; i += 4, j += 1) {
      // ⚠⚠ 目の感じ方に合わせた明るさ(0.299R + 0.587G + 0.114B)を整数で。
      out[j] = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
    }
    return out;
  } catch { return null; }
};

/**
 * 🚨🚨 **約束が「返って来ない」ことを見張る。**
 *
 * Firestore の書き込みは、1日の枠を使い切ると **永久に解決しない**(SDKの現物で確認):
 *   ・RESOURCE_EXHAUSTED は「一時エラー」扱い → **拒否されない**
 *   ・最大60秒間隔で無限に送り直す → **await した保存が永久に返らない**
 *   ・画面にもコンソールにも **何も出ない**(読み取りの429は見えるが、書き込みは無言)
 * これが「通信が詰まる」の正体で、待ち続けると送り手の待ち行列にJPEGが積み上がる。
 *
 * @returns true=決着した / false=時間内に返って来なかった
 * ⚠元の約束は握りつぶさない(呼ぶ側があとで「戻った」を受け取れるようにする)。
 */
const settledWithin = (p, ms) => new Promise((res) => {
  let done = false;
  const t = setTimeout(() => { if (!done) { done = true; res(false); } }, Math.max(1, ms));
  Promise.resolve(p).then(() => {}, () => {}).then(() => {
    if (!done) { done = true; clearTimeout(t); res(true); }
  });
});

// ---------------------------------------------------------------------------
// 部屋の窓口の受け渡し
// ⚠⚠ 資料の画面は アプリの奥(3か所)から呼ばれている。そこまで手渡しで
//   持って行くと、渡し忘れた1か所だけボタンが出ない事故になる(過去に何度もやった)。
//   → 上で1回だけ配って、使う所で受け取る。
// ⚠受け取れない所では **ボタン自体を出さない**(押しても何も起きないボタンを作らない)。
// ---------------------------------------------------------------------------
export const LiveRoomContext = createContext(null);
/** 部屋の窓口。⚠受け取れない所ではボタンを出さない。 */
export const useRoomApi = () => {
  const v = useContext(LiveRoomContext);
  return v && typeof v === 'object' && 'api' in v ? v.api : v;
};
/**
 * 📱の画面を「開いてくれ」と頼む。
 * ⚠⚠ 画面そのものは **アプリの一番上** に1つだけ置く。
 *   資料モーダル(全面の黒幕)の中に置いていたので、**小さくしても黒幕が出るだけ**で
 *   検査画面に戻れなかった(清水さん 2026-08-14「画面最小化もいる」/ 検算で判明)。
 *   ここは「頼むだけ」。開けない所では null が返るので、ボタンを出さない判断に使える。
 */
export const useLiveOpen = () => {
  const v = useContext(LiveRoomContext);
  return v && typeof v === 'object' && typeof v.open === 'function' ? v.open : null;
};

/**
 * 📁 「Driveへ入れ終わった」の合図。数が増えたら資料一覧を読み直す。
 * ⚠⚠ 撮り終わるのは **アプリの一番上**、一覧を出しているのは **モーダルの中**。
 *   繋いでいなかったので、保存できても ↻更新 を押すまで画面に出なかった
 *   (「保存したのにアプリから見えない」の二次要因。2026-08-16)。
 */
export const useDriveSaved = () => {
  const v = useContext(LiveRoomContext);
  return v && typeof v === 'object' && Number.isFinite(Number(v.savedAt)) ? Number(v.savedAt) : 0;
};

// ---------------------------------------------------------------------------
// 👀 見る側(PC・タブレット)
// ---------------------------------------------------------------------------
/**
 * @param roomApi    { create(code, room), api(code) => {get,patch,addIce,watch} }
 * @param onDone     ({flags, chapters}) => void  撮り終わった時(旗を編集へ渡す)
 * @param folderPath 📁 **この録画をDriveのどこへ入れるか**(['最終','型式','TK-1'] のような並び)。
 *   🚨🚨 清水さん 2026-08-16「結局スマホで撮った映像アプリ上だと見れなかった」の直し。
 *   Driveへ上げているのは `?live=` で開いた **スマホ側の画面**で、その画面はロットも
 *   テンプレも読み込まない = 型式名もテンプレ名も**いつも空**。だからスマホ側で道順を
 *   組ませると、アプリが見に行かないフォルダ(最終/マスタ・製品/テンプレ/テンプレ)へ
 *   入り続ける。**道順を知っているのはこのPCの画面だけ**なので、ここで部屋へ書いて渡す。
 *   ⚠渡さない(null)と、スマホ側の当てにならない道順に落ちる。必ず渡すこと。
 */
export const LiveViewer = ({ roomApi, onClose, onDone = null, steps = [], folderPath = null }) => {
  const [code] = useState(() => makeCode());
  const [qr, setQr] = useState('');
  const [state, setState] = useState('new');
  const [note, setNote] = useState('スマホでQRを読み取ってください');
  const [room, setRoom] = useState(null);
  // ⚠部屋が消えた(30分の掃除・別のPCが開いた・誰かが閉じた)。黙って前の姿を出し続けない。
  const [roomGone, setRoomGone] = useState(false);
  const [frames, setFrames] = useState({});      // 📷 書類ごとの1枚 {0:{url,at}, 1:{...}}
  const [flags, setFlags] = useState([]);
  const [label, setLabel] = useState('');
  const vidRef = useRef(null);
  const linkRef = useRef(null);
  const frameUnRef = useRef(null);
  const url = liveUrl(typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '', code);

  useEffect(() => {
    QRCode.toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: 'M' })
      .then(setQr)
      .catch((e) => { console.warn('[live] QRを作れません:', e?.message || e); setQr(''); });
  }, [url]);

  const supported = hasLive();
  // 🔄 何回目の繋ぎ直しか。⚠**部屋は作り直さない**(合言葉が変わるとスマホが迷子になる)。
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!supported) return undefined;   // ⚠ここで setState しない(描画中の書き換えになる)
    let dead = false;
    (async () => {
      try {
        // ⚠⚠ 部屋を作るのは **最初の1回だけ**。繋ぎ直しで作り直すと、録画中の様子も
        //   🚩旗も保存先も全部消える(しかも消えた事は誰にも分からない)。
        if (gen === 0) await roomApi.create(code, newRoom(code, Date.now()));
        const api = roomApi.api(code);
        const link = await startViewer({
          room: api,
          gen,
          onStream: (s) => { if (!dead && vidRef.current) { vidRef.current.srcObject = s; vidRef.current.play().catch(() => {}); } },
          onState: (st, text) => { if (dead) return; setState(st); setNote(text); },
          // ⚠⚠ 部屋が消えた(=null)ことも受け取る。受け取らないと、最後に見た姿のまま
          //   「● 録画中」を出し続ける(秒だけ伸びる)。消えたら画面にそう出す。
          onRoom: (r) => { if (dead) return; setRoom(r); setRoomGone(!r); },
        });
        linkRef.current = link;
      } catch (e) {
        if (!dead) setNote('つなぐ用意ができませんでした: ' + (e?.message || e));
      }
      // 📷 コマ送りは **必ず** 受ける(滑らかな映像が繋がらなくても画角は見える)。
      // ⚠0.5秒は書類2つに交互に書かれてくる。**両方を見て、新しい方を映す**。
      try {
        const uns = [0, 1].map(i => roomApi.frame(code, i).watch((f) => {
          if (!dead && f?.url) setFrames(prev => ({ ...prev, [i]: f }));
        }));
        frameUnRef.current = () => uns.forEach(u => { try { u(); } catch { /* noop */ } });
      } catch { /* コマ送りが使えない時も、滑らかな方だけで続ける */ }
    })();
    return () => {
      dead = true;
      try { linkRef.current?.stop(); } catch { /* noop */ }
      try { frameUnRef.current?.(); } catch { /* noop */ }
    };
  }, [code, roomApi, supported, gen]);

  // 🔄 つなぎ直す。⚠**押した事が分かるように**すぐ言い方を変える(押しても無反応にしない)。
  const reconnect = useCallback(() => {
    setState('new');
    setNote('つなぎ直しています…');
    setGen((g) => g + 1);
  }, []);

  // ⚠⚠ 時計は **使うより前に** 置く。const は「巻き上げ」で名前だけ先にできるが
  //   値が入る前に読むと ReferenceError で **その場で白画面**になる(2026-08-13 実際にやった)。
  //   下の frameOk がこの nowTick を読むので、順番を入れ替えてはいけない。
  // ⚠描くたびに Date.now() を読まない(描画は同じ入力なら同じ結果にする)。
  //   時計は0.5秒ごとに進めて、その値から出す。**画面の秒数もこれで動く**。
  const [nowMs, setNowMs] = useState(0);
  // ⚠コマ送りが古くなっていないかを見るための時計(1秒ごと)
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ⚠⚠ 繋がり具合は **そのまま使わない**。携帯回線では一瞬 disconnected に落ちる事があり、
  //   そのたびに「滑らかな映像 ⇄ コマ送り」が入れ替わると、**入れ替わり自体がカクカクに見える**。
  //   → 一度つながったら LIVE_HOLD_MS の間は持ちこたえる(その間にコマ送りが戻ってくる)。
  const linked = state === 'connected' || state === 'completed';
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (linked) { setHold(true); return undefined; }
    const t = setTimeout(() => setHold(false), LIVE_HOLD_MS);
    return () => clearTimeout(t);
  }, [linked]);
  const live = linked || hold;
  // ⚠どちらで繋がっているかを **必ず画面に出す**(黙ってコマ送りに落ちない)
  const frame = newestFrame(Object.values(frames));
  const frameOk = frameFresh(frame?.at, nowTick, 8);
  // ⚠⚠ 2026-08-17: **止めたら「止め絵」を出す。QRに戻さない。**
  //   枠を節約する為に、画角合わせのぶんを送り終えたらスマホは送信を止める。
  //   その時に古い絵を捨ててQRを出すと、現場には「切れた・失敗した」としか見えず、
  //   QRを読み直す所からやり直しになる(直したはずの物が、別の形で現場を止める)。
  //   → **最後の1枚は出したまま**にして、「何秒前の絵か」を札で言う。
  const hasFrame = !!(frame && frame.url);
  const frameAgeSec = hasFrame ? Math.max(0, Math.round((Math.max(nowTick, Number(frame.at) || 0) - (Number(frame.at) || 0)) / 1000)) : 0;
  const mode = live ? 'rtc' : (frameOk ? 'frame' : (hasFrame ? 'still' : 'none'));

  // 📊 いま本当に何コマ届いているか。⚠**推測でなく実測**を出す。
  //   次に「カクカクする」と言われた時、この数字1つで「道」と「重さ」が分かる。
  //   ⚠中身が同じ時は入れ替えない(意味の無い描き直しを増やさない)。
  // ⚠開いた直後の一瞬で「簡易表示です」と騒がない(繋ぐのに数秒かかるのは普通)。
  //   ⚠⚠ 逆に、**落ちたまま黙っているのが一番悪い**。数秒で必ず出す。
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (mode === 'rtc') { setSlow(false); return undefined; }
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [mode]);

  const [stats, setStats] = useState(null);
  useEffect(() => {
    if (!supported) return undefined;
    let dead = false;
    const t = setInterval(async () => {
      const s = await liveStatsOf(linkRef.current?.pc, 'inbound');
      if (!dead) setStats((prev) => (liveStatsText(prev) === liveStatsText(s) ? prev : s));
    }, STATS_EVERY_MS);
    return () => { dead = true; clearInterval(t); };
  }, [supported, gen]);
  const statsText = liveStatsText(stats);
  // ⚠止まっている間も秒は動かないが、時計は回し続ける(止め時間の表示に使う)
  const phase = recPhase(room);
  useEffect(() => {
    if (phase === 'idle') return undefined;
    // ⚠effect の本体で直に setState しない(描き直しが連鎖する)。時計に任せる。
    const t = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [phase]);

  // ⚠⚠ PCとスマホの時計の差を **録画が始まったのを見た瞬間に1回だけ** 測る。
  //   スマホが書いた recStartedAt を PC の時計でそのまま引くと、時計が2分ズレて
  //   いる端末では **開いた瞬間から2分と出る**。書き込みは1バイトも増やさない。
  const skewRef = useRef(0);
  const skewFor = useRef(0);
  const st0 = room?.recStartedAt || 0;
  if (st0 && skewFor.current !== st0) { skewFor.current = st0; skewRef.current = clockSkew(st0, Date.now()); }
  if (!st0 && skewFor.current) { skewFor.current = 0; skewRef.current = 0; }

  // 🎞 **動画の中での秒**。止めていた分は入らない(ここが旗の正しさの根っこ)。
  const recSec = videoSec(room, nowMs || Date.now(), skewRef.current);
  const pausedSec = phase === 'paused' && room?.pausedAt ? Math.max(0, (nowMs - skewRef.current - room.pausedAt) / 1000) : 0;

  const send = useCallback((patch) => roomApi.api(code).patch(patch).catch(() => {}), [roomApi, code]);

  // ---------------------------------------------------------------------------
  // 👀🚨 **「まだ見ています」の印を、定期的に部屋へ書く**(2026-08-17)
  //
  // ⚠⚠ これが無かったので、**PCが「閉じる」を押さずにタブを消すと部屋が最大30分残り**、
  //   スマホはその間ずっと絵を送り続けていた(誰も見ていないのに 1,800回の書き込み)。
  //   印が古くなれば、スマホは 30秒 で自分から止まる。**部屋の30分を待たない。**
  //
  // ⚠⚠ **印を書くのも書き込み**なので、間隔をコマ送りより粗くする(12秒に1回 = 300回/時)。
  //   止まる方は 1,800〜3,600回/時 なので、**増える分は減る分の 1/6〜1/12**。
  //   (この釣り合いは domain の viewPingBalance() で数字にしてある)
  // 👀🚨 2026-08-31: **見えている時だけ打つ。**
  //   タブが裏・最小化 = 誰も見ていない。その間も打ち続けると、スマホは
  //   「見ている人がいる」と思って送り続ける(=この直しの狙いが印のせいで消える)。
  //   戻って来た瞬間(visibilitychange)に1回打つので、送信は数秒で自動再開する。
  // ⚠部屋が消えている時は書かない。書くと **createdAt の無い幽霊部屋**が出来て、
  //   スマホからは「見つかりません」になる(掃除まで残る)。
  // ---------------------------------------------------------------------------
  const [pingCount, setPingCount] = useState(() => readDayCount(localStore(), VIEWPING_COUNT_KEY, Date.now()));
  useEffect(() => {
    if (!supported || roomGone) return undefined;
    const ping = () => {
      const at = Date.now();
      send(viewPingPatch(at));
      setPingCount(addDayCount(localStore(), VIEWPING_COUNT_KEY, at, 1));
    };
    // ⚠document が無い環境(試験)では「見えている」扱い(止めない側に倒す)。
    const visible = () => (typeof document === 'undefined') || document.visibilityState !== 'hidden';
    const t = setInterval(() => { if (visible()) ping(); }, VIEW_PING_MS);
    // 👀 戻って来た瞬間に1回打つ → スマホ側は数秒で送信を再開する(次の12秒を待たせない)。
    const onVis = () => { if (visible()) ping(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [supported, roomGone, send]);

  // 📷 スマホが「いま送っている/止めている理由」。⚠黙って止めない為に必ず画面へ出す。
  const camWhy = String(room?.frameWhy || '');
  // ⚠⚠ **わざと止めている時に「回線が悪い」と言わない**。
  //   'still'(画が動いていない) と 'budget'(今日のぶんを使い切った) も、わざと止めている側。
  //   ここに足し忘れると「簡易表示です・つなぎ直してください」が出て、現場は電波のせいだと
  //   思ってつなぎ直しを繰り返す(そのたび書き込みが増える＝直した意味が消える)。
  const camStopped = camWhy === 'previewdone' || camWhy === 'stuck'
    || camWhy === 'still' || camWhy === 'budget';

  // 📁🚨 **この録画がDriveのどこへ入るか**を、部屋へ書いてスマホへ渡す。
  // ⚠⚠ 道順を知っているのは **この画面(PC)だけ**。スマホ側の画面はロットもテンプレも
  //   読み込まないので、向こうで組ませると型式名もテンプレ名も空のまま、
  //   **アプリが一度も見に行かないフォルダ**へ入り続ける
  //   (清水さん 2026-08-16「結局スマホで撮った映像アプリ上だと見れなかった」の正体)。
  // ⚠部屋が出来てから書く。出来る前に書くと、部屋を作る書き込みと前後して消えることがある。
  // ⚠同じ道順を何度も書かない(書くたびにスマホ側の描き直しが走る)。
  const folderKey = folderLabel(folderPath);
  const folderSentRef = useRef('');
  const roomLive = !!room;
  useEffect(() => {
    if (!roomLive || !folderKey || folderSentRef.current === folderKey) return;
    folderSentRef.current = folderKey;
    send(folderPathPatch(folderPath));
  }, [roomLive, folderKey, folderPath, send]);

  // 🚩 いま要点。⚠**動画の中での秒**で持つ(壁の時計で持つと、止めた分だけ全部ズレる)。
  const flag = useCallback(async () => {
    if (!room?.recording || !room?.recStartedAt) { setNote('スマホで録画を始めてから押してください'); return; }
    const at = videoSec(room, Date.now(), skewRef.current);
    const key = flagKey(at);
    const f = { key, atSec: Math.round(at * 10) / 10, label: label.trim() };
    setFlags(prev => [...prev, f]);
    setLabel('');
    // ⚠鍵つきの入れ物に **その鍵だけ** 書く(配列だと相手の分を消してしまう)
    try { await roomApi.api(code).patch(flagAddPatch(key, f.atSec, f.label)); } catch { /* 画面には残る */ }
  }, [room, label, code, roomApi]);

  // 📁 この録画をどこへ入れるか。⚠選ばなければ「全体用」。未選択という状態を作らない。
  const target = room?.target || WHOLE;
  const setTarget = useCallback((t) => send({ target: t || WHOLE }), [send]);

  // ⚠⚠ 手元の控えは **いまの録画のぶんだけ**。録画が変わったら必ず捨てる。
  //   捨てないと、「＋ 新しく録画する」で部屋の旗を消しても **画面には前の旗が残り**、
  //   そのまま「✓ 撮り終わった」を押すと **前の録画の秒** が新しい動画の要点として
  //   編集へ渡る(2026-08-15 実測: 新しい録画の一覧に前の「0:02 要点1」が残っていた)。
  //   下の shownFlags / finish は、部屋が空の時にこの控えを出す作りなので、
  //   ここで捨てておかないと消したはずの旗が生き返る。
  useEffect(() => { setFlags([]); }, [room?.recStartedAt]);

  // 🚩 一時停止中に要点を直す。⚠秒は触らない(直した拍子に場所が動いたら意味が無い)。
  const shownFlags = liveFlags(room?.flags).length ? liveFlags(room?.flags) : liveFlags(flags);
  const [editKey, setEditKey] = useState('');
  const [editLabel, setEditLabel] = useState('');

  // ⚠⚠ 部屋を消すのは **人が閉じた時だけ**。
  //   描き直しの後始末(useEffect の戻り値)で消してはいけない。React は開発中に
  //   わざと「出す→片付ける→もう一度出す」を1往復やるので、片付けの削除が
  //   2回目の作成より後に届くと、**出したばかりのQRが死ぬ**。
  //   閉じずにタブを消した分は、次に部屋を作る時の掃除(sweep)で片付く。
  const shut = useCallback(() => {
    try { roomApi.close?.(code); } catch { /* 残っても掃除で消える */ }
    onClose();
  }, [roomApi, code, onClose]);

  const finish = () => {
    // ⚠⚠ 旗は **動画の中での秒** で確定させてから渡す(止めた分はもう引いてある)。
    //   渡した先の編集画面は壁の時計を知らないので、ここでズレを吸収しておく。
    const take = takeOf(room || {}, { skewMs: skewRef.current });
    const all = take.flags.length ? take.flags : liveFlags(flags).map(f => ({ atSec: f.atSec, label: f.label || '' }));
    if (onDone) onDone({ flags: all, target: take.target, durationSec: take.durationSec, ...flagsToChapters(all, take.durationSec) });
    shut();
  };

  // ⚠⚠ **小さくできること**(清水さん 2026-08-14)
  //   「アプリ側で録画したら画面が全体に出るのが今の仕様だけど、その画面で検査作業の
  //     時間もとるわけだから、画面最小化もいる」
  //   録画は「見ているだけ」の時間ではない。**録りながら検査の時間を取る**。
  //   ⚠⚠ 小さくする時に **木から外してはいけない**。<video> を作り直すと srcObject が
  //     入るのは startViewer の onStream だけなので、**戻した時に永久に真っ黒**になる。
  //     → return を分けず、**同じ木のまま見た目(class)だけ変える**。
  const [mini, setMini] = useState(false);

  // ---------------------------------------------------------------------------
  // 🔍🔄 見え方（大きさ・向き） 清水さん(2026-08-14 実機)
  //   「アプリ画面上で縮小と拡大」「画面上でも回転できるように保険」
  //     ＝ スマホを横にして撮る手立てが無かったので、**見る側で回せる**ようにしておく。
  //
  // ⚠⚠ **見え方だけを変える。録画される中身は1バイトも変わらない。**
  //   ここを混ぜて動画に焼き込むと、PCで回した人と回さなかった人で保存物が変わる。
  //   手本動画は常に「スマホが撮ったまま」。向きは部屋に控えるだけ(見る時の目安)。
  // ---------------------------------------------------------------------------
  const [scale, setScale] = useState(1);
  const [deg, setDeg] = useState(0);
  const stageRef = useRef(null);
  const [boxWH, setBoxWH] = useState({ w: 0, h: 0 });
  // ⚠回すと縦横が入れ替わる。入れ物の大きさを測っておかないと、90度回した時に
  //   上下がはみ出て **映像の端が切れる**(幅で逃げると今度は小さくなりすぎる)。
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => setBoxWH({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => { try { ro.disconnect(); } catch { /* noop */ } };
  }, []);
  const stage = viewStageBox(boxWH, deg);
  const turnView = () => {
    const n = nextViewRotate(deg, 1);
    setDeg(n);
    // ⚠部屋に書くのは「見る時に何度回すか」の控えだけ。**動画には焼き込まない**。
    send(viewRotatePatch(n));
  };
  const resetView = () => { setScale(1); setDeg(0); send(viewRotatePatch(0)); };

  // 🎬 録画のきれいさ(＝容量)。⚠**スマホが「本当に録れる」と確かめた物だけ**を出す。
  const recQ = recQualityList(room?.recCaps);
  const curQ = pickRecQuality(room?.wantQuality, room?.recCaps);

  return (
    <div
      className={mini
        ? 'fixed bottom-3 right-3 z-[610] w-[330px] rounded-xl shadow-2xl border-2 border-slate-700 bg-slate-900 flex flex-col overflow-hidden'
        : 'fixed inset-0 z-[610] bg-slate-900 flex flex-col'}
      onClick={e => e.stopPropagation()}
    >
      <div className="shrink-0 px-3 py-2 flex items-center gap-2 bg-slate-800 text-white">
        <span className="font-bold text-sm">{mini ? '📱' : '📱 スマホのカメラを見ながら撮る'}</span>
        <span className={`ml-2 fi-tap-text rounded px-2 py-0.5 font-bold ${mini ? 'hidden' : ''} ${mode === 'rtc' ? 'bg-emerald-500' : mode === 'frame' ? 'bg-sky-600' : mode === 'still' ? 'bg-slate-500' : 'bg-white/20'}`}>
          {/* ⚠⚠ 実機で分かったこと(清水さん 2026-08-14):
                 **工場のWi-Fi同士だと失敗する・遅い。スマホを5G(携帯回線)にするとスムーズ。**
                 工場のWi-Fiが端末どうしの直通を止めているため。もともと「同じWi-Fiなら滑らか」と
                 書いていたが、**現場では逆**だった。案内を実測に合わせる。 */}
          {mode === 'rtc' ? '● 滑らかにつながっています'
            : mode === 'frame' ? '📷 コマ送りで見ています（スマホを5G/4Gにすると滑らかになります）'
              : mode === 'still' ? `⏸ 止め絵（${frameAgeSec}秒前）`
                : '… つないでいます'}
        </span>
        {/* 📊 実測。⚠⚠ 次に「カクカクする」と言われた時、**推測ではなく数字**で
               「いま何コマ・どの大きさ・理由は電波かCPUか」がその場で分かるようにする
               (これが無かったので、原因を突き止めるのに丸一日かかった)。 */}
        {!mini && mode === 'rtc' && statsText && (
          <span className="fi-tap-text text-white/70 tabular-nums whitespace-nowrap" data-live="stats">{statsText}</span>
        )}
        {/* ⚠小窓の時の「● 録画中 m:ss」は **下の操作の帯** に出す。
               ここ(帯の上)に詰めると「⤢ 大きく」「閉じる」が折り返して読めなくなる
               (画面写真を見て分かった。文字が入るかは実物を見るまで分からない)。 */}
        <button onClick={() => setMini(m => !m)}
          className="ml-auto px-3 py-1.5 min-h-[36px] rounded bg-white/15 font-bold text-xs whitespace-nowrap"
          title={mini ? '大きく表示する' : '小さくして検査画面に戻る（録画は続きます）'}>
          {mini ? '⤢ 大きく' : '▁ 小さく'}
        </button>
        <button onClick={shut} className="px-3 py-1.5 min-h-[36px] rounded bg-white/15 font-bold text-xs whitespace-nowrap">閉じる</button>
      </div>

      {/* ⚠⚠ 部屋が消えた時は **必ず言う**。黙っていると「● 録画中」が消えただけで、
             何が起きたのか分からない(押しても何も起きない画面になる)。
             ⚠録画そのものはスマホの中で続いている。**そこを間違えて案内しない**。 */}
      {roomGone && (
        <div className="shrink-0 px-3 py-2 bg-amber-500 text-white fi-tap-text font-black text-center leading-snug">
          ⚠ この撮影の部屋は閉じられました（PCからは操作できません）。<br />
          録画はスマホの中で続いています。<b>スマホの画面で「■ とめる」を押して保存してください。</b>
          もう一度PCから見るときは、この画面を閉じてQRを出し直してください。
        </div>
      )}

      {/* ⚠⚠ **簡易表示に落ちた事を黙っていない**(清水さん 2026-08-16「両方かくかくする」)。
             黙って落ちると、現場には「アプリが重い」としか見えず、直す先を探せない。
             ⚠開いた直後の数秒では出さない(繋ぐのに数秒かかるのは普通の事)。
             ⚠ここで一番大事なのは **録画は無事だと言い切る事**。
               「映りが悪い＝録画も失敗している」と思って撮り直す方が損が大きい。 */}
      {/* ⚠⚠ **わざと止めている時に「回線が悪い」と言わない**(2026-08-17)。
             枠の節約で送信を止めたのに「簡易表示です・つなぎ直してください」と出すと、
             現場は電波のせいだと思って つなぎ直しを繰り返す(そのたび書き込みが増える)。
             止めている時の案内は、下の「▶ 画角をもう一度見る」の方に出す。 */}
      {!mini && slow && room?.camReady && !roomGone && !camStopped && (
        <div className="shrink-0 px-3 py-2 bg-sky-700 text-white fi-tap-text font-bold leading-snug flex flex-wrap items-center gap-2" data-live="degraded">
          <span className="flex-1 min-w-[240px]">
            ⚠ いま<b>簡易表示</b>です（回線の状態でなめらかに映せません）。
            {mode === 'frame' ? '1秒に数枚の写真で画角だけ見えています。' : '映像がまだ届いていません。'}
            <b>録画はスマホの中で高画質のまま録れています。</b>
          </span>
          <button onClick={reconnect} data-live="reconnect"
            title="もう一度つなぎ直す（QRを出し直さなくてよい・録画は止まりません）"
            className="px-3 py-1.5 min-h-[40px] rounded bg-white text-sky-800 font-black text-xs whitespace-nowrap">
            🔄 つなぎ直す
          </button>
          <span className="w-full fi-tap-text font-normal text-white/80">
            ※ 工場のWi-Fiは端末どうしの直通を止めています。<b>スマホのWi-Fiを切って 5G/4G にしてから「🔄 つなぎ直す」</b>を押すと繋がります（2026-08-14 実機で確認）。
          </span>
        </div>
      )}

      {/* ⚠⚠ **小さくしたままでも、最低限は操作できる**(清水さん 2026-08-14)
             「最小化した状態でも、一時停止・再開など最低限の操作ができること」。
             小窓は検査をしながら横目で見る物なので、**詰め込まない**。
             一時停止／続き／とめる の3つだけ。旗も保存先もここには出さない。
           ⚠「とめる」は押し間違えると撮り直しになる。**離して置き、確認も挟む**。 */}
      {mini && (phase === 'recording' || phase === 'paused') && (
        <div className="shrink-0 px-2 py-2 bg-slate-800 space-y-1.5">
          {/* ⚠⚠ 札は **言葉で** 出す。色と記号だけだと、横目で見た人に録れているかが伝わらない。
                 ⚠止めている間に「● 録画中」を残さない(録れていると思って作業を続けてしまう)。 */}
          <div className={`text-center fi-tap-text font-black tabular-nums rounded py-0.5 ${phase === 'paused' ? 'bg-amber-500 text-white' : 'bg-rose-600 text-white animate-pulse'}`}>
            {phase === 'paused' ? `⏸ 止めています（${fmt(recSec)}）` : `● 録画中 ${fmt(recSec)}`}
          </div>
          <div className="flex items-center">
            <button onClick={() => send(phase === 'paused' ? wantResume(Date.now()) : wantPause(Date.now()))}
              className={`flex-1 py-2.5 min-h-[48px] rounded-xl font-black text-sm ${phase === 'paused' ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'}`}>
              {phase === 'paused' ? '▶ 続きを撮る' : '⏸ 一時停止'}
            </button>
            {/* ⚠すき間。隣り合わせだと「一時停止」のつもりで「とめる」を押す */}
            <span className="w-8 shrink-0" aria-hidden="true" />
            <button
              onClick={() => { if (confirm('録画をとめますか？（この録画はここで終わりです）')) send(wantStop(Date.now())); }}
              title="録画をとめる（確認します）"
              className="shrink-0 px-3 py-2.5 min-h-[48px] rounded-xl font-black text-sm bg-white text-rose-600 border-2 border-rose-500">
              ■ とめる
            </button>
          </div>
        </div>
      )}

      {/* ⚠小さい時は中身を隠すだけ(hidden)。**外さない** = <video> が生き続けるので戻せば映る */}
      <div className={`${mini ? 'hidden' : 'flex-1 min-h-0 flex'} flex-col md:flex-row gap-2 p-2`}>
        {/* 映像 */}
        <div className="flex-1 min-h-0 flex flex-col gap-1.5">
          {/* 🔍🔄 見え方のつまみ。⚠⚠ ここで変わるのは **見え方だけ**。
                 録画される中身は1バイトも変わらない(いつでも押してよい)。 */}
          <div className="shrink-0 flex flex-wrap items-center gap-1.5 bg-slate-800 rounded-lg px-2 py-1.5">
            <button onClick={() => setScale((s) => nextViewScale(s, -1))} title="表示を小さくする（見え方だけ）"
              className="px-3 py-1.5 min-h-[40px] rounded bg-white/15 text-white font-black text-lg leading-none">－</button>
            <span className="text-white text-xs font-bold tabular-nums w-14 text-center">{Math.round(scale * 100)}%</span>
            <button onClick={() => setScale((s) => nextViewScale(s, 1))} title="表示を大きくする（見え方だけ）"
              className="px-3 py-1.5 min-h-[40px] rounded bg-white/15 text-white font-black text-lg leading-none">＋</button>
            <button onClick={turnView} title="画面を回す（90度ずつ・見え方だけ）"
              className="px-3 py-1.5 min-h-[40px] rounded bg-white/15 text-white font-bold fi-tap-text">🔄 回す（{deg}°）</button>
            <button onClick={resetView} title="等倍・元の向きに戻す"
              className="px-3 py-1.5 min-h-[40px] rounded bg-white/15 text-white font-bold fi-tap-text">元に戻す</button>
            <span className="text-white/60 fi-tap-text ml-auto">※ 見え方だけです。録画される中身は変わりません</span>
          </div>

          <div ref={stageRef} className="flex-1 min-h-0 bg-black rounded-lg overflow-hidden relative">
            {/* ⚠⚠ この箱の中身(<video>)を **作り直さない**。srcObject が入るのは
                   startViewer の onStream の1回だけなので、作り直すと永久に真っ黒になる。
                   → 箱は必ず出しっぱなしにして、見た目(transform)だけ変える。
                 ⚠回すと縦横が入れ替わるので、箱の縦横も入れ替える(端が切れないように)。 */}
            <div data-live="stage"
              className="absolute left-1/2 top-1/2 flex items-center justify-center"
              style={{
                width: stage.w ? `${stage.w}px` : '100%',
                height: stage.h ? `${stage.h}px` : '100%',
                transform: `translate(-50%, -50%) rotate(${deg}deg) scale(${scale})`,
                transition: 'transform 120ms ease-out',
              }}>
              {/* 滑らかな映像。⚠繋がらない時はコマ送りの1枚を出す(真っ黒にしない)
                     ⚠⚠ **まず画面いっぱいに映す**(w/h いっぱい + はみ出さない)。
                       電波が細いと相手が勝手に小さい映像にするので、そのまま出すと
                       大きな黒地の真ん中に切手のような絵が出る = 何も見えない。
                       そのうえで ＋－ で好きな大きさにする。 */}
              <video ref={vidRef} playsInline muted autoPlay className={`w-full h-full object-contain ${live ? '' : 'hidden'}`} />
              {/* ⚠止め絵になっても外さない(外すとQRに戻り、現場は「切れた」と受け取る)。
                     古い絵は少し暗くして、上の札で「何秒前か」を言う。 */}
              {!live && hasFrame && (
                <img src={frame.url} alt="" className={`w-full h-full object-contain ${frameOk ? '' : 'opacity-60'}`} />
              )}
            </div>
            {/* ⚠合言葉・QR・赤札は **回さない**(読めなくなる)。映像の箱の外に置く。 */}
            {!live && !hasFrame && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white p-4 text-center">
                {qr ? <img src={qr} alt="QR" className="w-56 h-56 bg-white rounded-lg p-2" /> : null}
                <div className="text-lg font-black tracking-widest bg-white text-slate-900 rounded px-3 py-1">{code}</div>
                <div className="text-sm">{supported ? note : 'この端末では使えません（Chrome か Edge の新しい版でお試しください）'}</div>
                <div className="fi-tap-text text-white/60 break-all max-w-md">{url}</div>
                {state === 'failed' && (
                  <div className="fi-tap-text text-amber-200 bg-amber-900/40 rounded p-2 max-w-md space-y-2">
                    <div>
                      この場所のWi-Fiが端末どうしの直通を止めています。
                      <b>スマホのWi-Fiを切って 5G/4G にすると繋がります</b>（実機で確認済み）。
                      繋がらないままでも、コマ送りの絵は届くので画角は合わせられます。
                    </div>
                    {/* ⚠切り替えたあとに **押す所** が無いと、QRを出し直す所からやり直しになる。
                        ⚠⚠ 部屋が消えている時は出さない。押すと申し出だけの **幽霊部屋** が
                          出来てしまう(作った時刻が無いので、スマホからは「見つかりません」)。 */}
                    {!roomGone && (
                    <button onClick={reconnect} data-live="reconnect"
                      className="w-full py-2 min-h-[40px] rounded bg-white text-slate-900 font-black text-xs">
                      🔄 つなぎ直す（切り替えたら押してください）
                    </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* ⚠⚠ 止めている間に「● 録画中」を出したままにしない。
                   映像に赤札が出ていれば、作業者は録れていると思って作業を続ける。
                   止まっていたと分かるのは撮り終わってからで、**もう一度撮り直しになる**。
                   (実際に画面写真を見て見つけた。純関数の試験も e2e も通っていた) */}
            {phase === 'recording' && (
              <span className="absolute top-2 left-2 bg-rose-600 text-white text-xs font-bold rounded px-2 py-1 animate-pulse">
                ● 録画中 {fmt(recSec)}
              </span>
            )}
            {phase === 'paused' && (
              <span className="absolute top-2 left-2 bg-amber-500 text-white text-xs font-bold rounded px-2 py-1">
                ⏸ 止めています（{fmt(recSec)}）
              </span>
            )}
            {/* 📷🚨 **止めた事と、その理由と、戻し方を、絵の上に出す**(2026-08-17)。
                   枠を守る為に送信を止めるのは正しいが、**黙って止めるのは一番悪い**。
                   「切れた」と思われた瞬間に、つなぎ直しとQRの出し直しが始まる。 */}
            {!live && mode === 'still' && !roomGone && (
              <div className="absolute inset-x-2 bottom-2 rounded-lg bg-slate-900/85 text-white p-2 fi-tap-text font-bold flex flex-wrap items-center gap-2" data-live="stillnote">
                <span className="flex-1 min-w-[200px] leading-snug">
                  ⏸ この絵は <b>{frameAgeSec}秒前</b>です。
                  {camWhy === 'stuck'
                    ? <> ⚠ <b>スマホの送信が詰まっています</b>（Firebaseの1日の書き込み枠を使い切った可能性）。<b>録画はスマホの中で続いています。</b></>
                    : camWhy === 'previewdone'
                      ? <> 画角合わせの{PREVIEW_FRAMES}枚を送り終えたので、<b>枠を節約するため止めています</b>（録画を始めると自動で再開します）。</>
                      /* 📷🚨 2026-08-23: **画が1ドットも変わっていないので送り直していない**。
                             ⚠これを「届いていません（電波を確かめてください）」と言うと、
                               直っている物を現場に直させる事になる。**別の言い方を用意する。** */
                      : camWhy === 'still'
                        ? <> スマホの<b>画が止まっている</b>ので、<b>同じ絵を送り直していません</b>（枠の節約）。<b>動けばそのまま映ります。</b>{phase === 'recording' ? <> <b>録画はスマホの中で続いています。</b></> : null}</>
                        : camWhy === 'budget'
                          ? <> ⚠ <b>今日の中継の上限（{RELAY_HARD_CAP_DAY.toLocaleString()}回）に達した</b>ので送信を止めています（検査の記録が保存できなくなるのを防ぐため）。<b>録画はスマホの中で続いています。</b>枠が0に戻る(日本時間16時)と自動で再開します。</>
                          /* ⚠⚠ スマホ側は「送っている」と言っているのに絵が来ない＝**届いていない**。
                                 ここで「止めています」と言うと、直す先(電波)を取り違える。 */
                          : (camWhy === 'recording' || camWhy === 'preview')
                            ? <> スマホは<b>送っているつもり</b>ですが、ここに届いていません（電波を確かめてください）。<b>録画はスマホの中で続いています。</b></>
                            : <> {frameWhyText(camWhy)}</>}
                </span>
                {/* ⚠押しても何も起きないボタンを出さない。詰まっている時／今日のぶんを
                       使い切った時は、押してもスマホ側の門で止まる。 */}
                {camWhy !== 'stuck' && camWhy !== 'budget' && (
                  <button onClick={() => send(wantPreviewPatch(Date.now()))} data-live="wantpreview"
                    title={`スマホにもう${PREVIEW_FRAMES}枚だけ送ってもらいます（枠を${PREVIEW_FRAMES}回使います）`}
                    className="shrink-0 px-3 py-2 min-h-[40px] rounded bg-white text-slate-900 font-black text-xs whitespace-nowrap">
                    ▶ 画角をもう一度見る
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 操作 */}
        <div className="md:w-[320px] shrink-0 bg-white rounded-lg p-2 space-y-2 overflow-y-auto">
          <div className="fi-tap-text text-slate-600">
            <b>録画はスマホの中で行います。</b>ここに映るのは<b>画角を合わせるため</b>の映像です
            （電波が細いとここだけ粗くなりますが、<b>録画は高画質のまま</b>です）。
          </div>

          {/* 🔢🚨 **使った分を人に見せる**(2026-08-17)。
                 ⚠この見える化で書き込みは1回も増えない(端末の中だけで数えている)。
                 ⚠PC側が使うのは「見ています」の印だけ。コマ送りの回数はスマホ側に出す。 */}
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-2 fi-tap-text text-amber-900 leading-snug" data-live="pingcount">
            🔢 この画面が今日書いた「見ています」の印：<b>{pingCount.toLocaleString()}回</b>
            （{pingWritesPerHour().toLocaleString()}回/時）。
            この印があるので、<b>この画面を閉じると（タブを消しただけでも）スマホは約{Math.round(VIEW_STALE_MS / 1000)}秒で送信を止めます</b>。
            止めなければ、そのあと最大30分ぶん（{writesPerHour(FRAME_SPEEDS.saving.everyMs).toLocaleString()}回/時）書き続けていました。
          </div>

          {/* ⚠⚠ 録画の開始・停止は **PCから** 押せるようにする(清水さん 2026-08-14)。
                 作業者はスマホを構えるだけで、スマホを触らない。
                 ⚠部屋に「こうしてほしい」を書き、スマホがそれを見て録り始める。
                   スマホは録り始めたら `recording` に **報告** を返す(これが正)。
                   ⚠`recording` を書くのをやめてはいけない。経過秒の時計がこれで動いており、
                     消すと「● 録画中」も🚩の時刻も **全部 0:00 で固まる**(検算で判明)。 */}
          {/* 📁 どこへ入れるか。⚠**録画を始める前に**決める。始まってから変えられると、
                 撮り終わった時にどっちだったのか分からなくなる。 */}
          <div className="rounded-lg border border-slate-300 bg-slate-50 p-2 space-y-1">
            <div className="fi-tap-text font-bold text-slate-700">📁 この録画の保存先</div>
            <select
              value={isWhole(target) ? '' : target.id}
              disabled={phase !== 'idle'}
              onChange={(e) => {
                const s = (steps || []).find(x => String(x.id) === e.target.value);
                setTarget(s ? { kind: 'step', id: String(s.id), name: String(s.name || s.id) } : WHOLE);
              }}
              className="w-full border border-slate-300 rounded px-2 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500">
              <option value="">全体用（この製品ぜんぶ）</option>
              {(steps || []).map((s) => <option key={s.id} value={String(s.id)}>工程：{s.name || s.id}</option>)}
            </select>
            <div className="fi-tap-text text-slate-500">
              {phase === 'idle'
                ? <>この名前で Drive に入ります → <b>{targetLabel(target)}</b></>
                : <>録画中は変えられません（撮り終わってから次の録画で選べます）</>}
            </div>
            {/* 📁🚨 **入る場所を撮る前に見せる**(清水さん 2026-08-16「どこに入ったのか分からない」)。
                   ⚠道順が決まっていない時は黙らない。黙ると、アプリが見に行かない
                     フォルダへ入って「Driveには在るのに出てこない」が また起きる。 */}
            {folderKey
              ? <div className="fi-tap-text text-slate-600">入る場所 → <b>Driveの〈{folderKey}〉</b></div>
              : <div className="fi-tap-text text-amber-700 bg-amber-50 rounded px-1.5 py-1">
                ⚠ 入る場所がまだ決まっていません（このまま撮ると、アプリの一覧に出てこない所へ入ることがあります）。
              </div>}
            {!(steps || []).length && (
              <div className="fi-tap-text text-amber-700">※ 工程の一覧が無いので「全体用」だけです（ロットを開いてから撮ると工程を選べます）。</div>
            )}
          </div>

          {/* 🎬 録画のきれいさ(＝容量)。清水さん(2026-08-14)「録画の容量を決められるように」
                 ⚠⚠ **撮る前に決める**。撮り始めてから変えられると、1本の中で画質が変わる。
                 ⚠⚠ 出すのは **スマホが「本当に録れる」と確かめた物だけ**。
                    対応していない細かさを選ばせると、押しても何も起きない(または録画が始まらない)。
                 ⚠数字(ビットレート)ではなく **1分あたり何MB** で出す。現場が判断できるのはこちら。 */}
          <div className="rounded-lg border border-slate-300 bg-slate-50 p-2 space-y-1">
            <div className="fi-tap-text font-bold text-slate-700">🎬 録画のきれいさ（＝容量）</div>
            {recQ.length ? (
              <>
                <div className="flex gap-1">
                  {recQ.map((q) => (
                    <button key={q.key} data-q={q.key} disabled={phase !== 'idle'}
                      onClick={() => send(wantQualityPatch(q.key))}
                      title={`${q.label}で撮る（約${recMbPerMin(q.key)}MB/分）`}
                      className={`flex-1 py-2 min-h-[52px] rounded-lg fi-tap-text font-bold leading-tight disabled:opacity-50
                        ${curQ && curQ.key === q.key ? 'bg-slate-800 text-white' : 'bg-white text-slate-700 border border-slate-300'}`}>
                      <span className="block">{q.label}</span>
                      <span className="block fi-tap-text font-normal">約{recMbPerMin(q.key)}MB/分</span>
                    </button>
                  ))}
                </div>
                {/* ⚠⚠ 「6分で約NMB」では清水さんの問いに答えていない。
                       聞かれたのは **「10分とったら 20分とったら」**。その2つをそのまま出す。
                     ⚠数字は recordUsage() から取る(掛け算をこの画面で書かない)。 */}
                <div className="fi-tap-text text-slate-500">
                  {phase === 'idle'
                    ? <>いまは<b>{recQualityLabel(curQ?.key)}</b>。
                      <b>10分</b>で<b className="text-rose-700">約{mbText(recordUsage(curQ?.key, 10).keepMb)}</b>、
                      <b>20分</b>で<b className="text-rose-700">約{mbText(recordUsage(curQ?.key, 20).keepMb)}</b>が
                      Driveに残ります（見る人がいれば、そのたび同じだけ通信します）。</>
                    : <>録画中は変えられません（1本の途中で画質が変わらないようにするため）。</>}
                </div>
              </>
            ) : (
              <div className="fi-tap-text text-slate-500">
                {room?.camReady
                  ? 'この端末では選べません（そのまま撮ります）。'
                  : 'スマホがカメラを開くと、その端末で選べる分だけ出ます。'}
              </div>
            )}
            {/* 📊 表への入口。⚠⚠ **選べない端末でも出す**(選べなくても、何MB残るかは知りたい)。
                   ⚠既に在る DataUsageOpenButton をそのまま置く(開け閉ての状態はこの中が持つ)。 */}
            <DataUsageOpenButton
              label={USAGE_BTN_LABEL}
              title={USAGE_BTN_TITLE}
              className="w-full min-h-[44px] px-2 rounded-lg bg-indigo-50 hover:bg-indigo-100 border-2 border-indigo-300 text-indigo-800 fi-tap-text font-black"
            />
          </div>

          {/* ⚠⚠ 録画の開始・停止は **PCから** 押せるようにする(清水さん 2026-08-14)。
                 一時停止・続き・新規も同じ(清水さん 2026-08-14 追加)。
                 ⚠PCが書くのは「お願い(want*)」だけ。実際にどうなったかはスマホが報告する。
                   ここを混ぜると、電波が切れた時に「PCでは録画中・スマホは止まっている」になる。 */}
          {phase === 'idle' ? (
            <button onClick={() => send(wantStart(Date.now()))} disabled={!room?.camReady}
              className="w-full py-4 min-h-[64px] rounded-2xl font-black text-lg bg-rose-600 text-white disabled:bg-slate-200 disabled:text-slate-400">
              ● 録画をはじめる
            </button>
          ) : phase === 'done' ? (
            <div className="space-y-1.5">
              <div className="text-center text-sm font-bold text-slate-700">撮り終わりました（{fmt(recSec)}）</div>
              <button onClick={() => send(newTakePatch(room, Date.now()))}
                className="w-full py-3.5 min-h-[56px] rounded-2xl font-black text-base bg-rose-600 text-white">
                ＋ 新しく録画する
              </button>
              {/* ⚠新しく録画すると **前の録画の要点は消える**。押す前に必ず言う。 */}
              <div className="fi-tap-text text-slate-500">
                ※ 押すと、いま立っている要点 {shownFlags.length}件 は消えます（この録画のぶんです）。
                先に「✓ 撮り終わった」で編集へ渡してください。
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <button onClick={() => send(phase === 'paused' ? wantResume(Date.now()) : wantPause(Date.now()))}
                  className={`flex-1 py-4 min-h-[64px] rounded-2xl font-black text-base ${phase === 'paused' ? 'bg-emerald-600 text-white' : 'bg-white text-amber-700 border-2 border-amber-500'}`}>
                  {phase === 'paused' ? '▶ 続きを撮る' : '⏸ 一時停止'}
                </button>
                <button onClick={() => send(wantStop(Date.now()))}
                  className="flex-1 py-4 min-h-[64px] rounded-2xl font-black text-base bg-white text-rose-600 border-2 border-rose-500">
                  ■ とめる
                </button>
              </div>
              <div className="text-center text-sm font-bold tabular-nums">
                {phase === 'paused'
                  ? <span className="text-amber-700">⏸ 止めています（動画は {fmt(recSec)} のまま・{fmt(pausedSec)} 止めています）</span>
                  : <span className="text-rose-600">● 録画中 {fmt(recSec)}</span>}
              </div>
              {phase === 'paused' && (
                <div className="fi-tap-text text-slate-500">
                  止めている間は動画が伸びません。続きを撮ると、止めた所からそのまま繋がります。
                </div>
              )}
            </div>
          )}
          {!room?.camReady && (
            <div className="fi-tap-text text-slate-500">スマホがQRを読んでカメラを開くと押せます。</div>
          )}
          {/* ⬆🚨 Driveへ入れる途中の報告。
                 **2026-08-16 まで、送り始めた瞬間に「✓ Driveに保存しました」が出ていた。**
                 スマホは送る **前** に up:{state:'doing'} を書くのに、ここは up.error の
                 有無しか見ていなかったので、送信中も成功と同じ緑の札になっていた。
                 しかも書き込みは深い混ぜ(merge)なので、**一度失敗すると error が残り続け**、
                 次に成功しても「⚠入れられませんでした」が出たままだった。
                 → 出し分けは state ただ1つ(doing / ok / ng)で決める。 */}
          {upPhase(room?.up) !== 'idle' && (
            <div className={`fi-tap-text rounded p-2 ${upPhase(room.up) === 'ng' ? 'bg-rose-50 text-rose-700'
              : upPhase(room.up) === 'doing' ? 'bg-sky-50 text-sky-800' : 'bg-emerald-50 text-emerald-700'}`}>
              {upPhase(room.up) === 'doing'
                ? <>⏳ Driveへ送っています…（終わるまでスマホの画面を閉じないでください）</>
                : upPhase(room.up) === 'ng'
                  ? <>⚠ Driveへ入れられませんでした: {room.up.error || '理由は分かりません'}<br /><b>動画はスマホの中に残っています。</b>スマホの画面から保存し直せます。</>
                  /* ⚠場所が分からない時に、それらしい場所を作って出さない(嘘になる)。 */
                  : (room.up.folder || folderKey)
                    ? <>✓ Driveの〈<b>{room.up.folder || folderKey}</b>〉に入れました（{room.up.name || '手本動画'}）</>
                    : <>✓ Driveに入れました（{room.up.name || '手本動画'}・<b>入った場所は分かりません</b>）</>}
            </div>
          )}

          <div className="rounded-lg border-2 border-indigo-300 bg-indigo-50/60 p-2 space-y-1.5">
            <div className="text-xs font-bold text-indigo-800">🚩 撮りながら要点に旗を立てる</div>
            <div className="fi-tap-text text-slate-600">
              押した所が、あとで<b>章と要点の候補</b>になります。撮り終わってから探し直す手間が消えます。
            </div>
            <input value={label} onChange={(e) => setLabel(e.target.value.slice(0, 20))}
              placeholder="この要点の名前(任意)" className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm" />
            <button onClick={flag} disabled={phase !== 'recording'}
              className="w-full py-3 min-h-[52px] rounded-lg bg-indigo-600 disabled:bg-slate-200 text-white font-black text-base">
              🚩 いま要点（{fmt(recSec)}）
            </button>
            {/* ⚠一時停止中は旗を立てられない。止まっている間の「いま」は動画に無いので、
                   立てると全部同じ秒に積み上がる。代わりに **名前を直す** 時間にする。 */}
            {phase === 'paused' && (
              <div className="fi-tap-text text-amber-700 bg-amber-50 rounded p-1.5">
                ⏸ 止めている間は旗を立てられません（その瞬間は動画に無いため）。
                <b>いまのうちに下の要点に名前を付けられます。</b>
              </div>
            )}
            {shownFlags.length > 0 && (
              <div className="space-y-0.5 max-h-48 overflow-y-auto">
                {shownFlags.map((f, i) => (
                  <div key={f.key || i} className="flex gap-1.5 items-center fi-tap-text bg-white rounded px-1.5 py-1">
                    <span className="font-bold text-indigo-700 tabular-nums shrink-0">{fmt(f.atSec)}</span>
                    {editKey && editKey === f.key ? (
                      <>
                        <input autoFocus value={editLabel} onChange={(e) => setEditLabel(e.target.value.slice(0, 20))}
                          onKeyDown={(e) => { if (e.key === 'Enter') { send(flagRenamePatch(f.key, editLabel)); setEditKey(''); } if (e.key === 'Escape') setEditKey(''); }}
                          className="flex-1 min-w-0 border border-indigo-300 rounded px-1.5 py-1 fi-tap-text" />
                        <button onClick={() => { send(flagRenamePatch(f.key, editLabel)); setEditKey(''); }}
                          className="shrink-0 px-2 py-1 rounded bg-indigo-600 text-white font-bold">✓</button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate">{f.label || `要点${i + 1}`}</span>
                        {/* ⚠直せるのは名前だけ。秒は触らない(直した拍子に場所が動いたら意味が無い)。 */}
                        <button onClick={() => { setEditKey(f.key); setEditLabel(f.label || ''); }} disabled={!f.key}
                          title="名前を直す（場所は動きません）"
                          className="shrink-0 px-1.5 py-1 rounded bg-slate-100 disabled:opacity-40 font-bold">✎</button>
                        <button onClick={() => { if (confirm(`この要点（${fmt(f.atSec)}）を消しますか？`)) send(flagDeletePatch(f.key)); }} disabled={!f.key}
                          title="この要点を消す"
                          className="shrink-0 px-1.5 py-1 rounded bg-slate-100 disabled:opacity-40 font-bold text-rose-600">✕</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={finish} className="w-full py-2.5 rounded-lg bg-emerald-600 text-white font-bold text-sm">
            ✓ 撮り終わった（旗を編集へ渡す）
          </button>
          <div className="fi-tap-text text-slate-400">
            ※ 動画そのものはこの画面を通りません（端末どうしの直通）。撮った動画はスマホからアップロードしてください。
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 🎥 撮る側(スマホ)
// ---------------------------------------------------------------------------
/** 録画の入れ物。⚠この端末が扱える形を上から順に選ぶ。 */
const REC_MIMES = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const pickRecMime = () => (typeof window !== 'undefined' && window.MediaRecorder
  ? (REC_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '')
  : '');

/**
 * 🎬 この端末で **本当に録れる** きれいさだけを選び出す。
 *
 * ⚠⚠ isTypeSupported が「使える」と言っても、その細かさを渡すと
 *   new MediaRecorder が投げる端末がある。**実際に作って確かめる**(作るだけ・録らない)。
 *   ここで落とした分は PC 側につまみを出さない
 *   = 押しても何も起きないつまみを作らない(清水さん 2026-08-14 実機の指摘と同じ理由)。
 *
 * ⚠⚠ **音の細かさ(audioBitsPerSecond)は指定しない。** 低く指定すると、端末に
 *   よっては音が丸ごと消える(2026-08-13 動画編集で実際に起きた)。絞るのは映像だけ。
 */
const probeRecQualities = (stream) => {
  if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function' || !stream) return [];
  const mime = pickRecMime();
  const ok = [];
  for (const q of Object.values(REC_QUALITIES)) {
    try {
      const t = new MediaRecorder(stream, mime
        ? { mimeType: mime, videoBitsPerSecond: q.vbps }
        : { videoBitsPerSecond: q.vbps });
      if (t) ok.push(q.key);
    } catch { /* この端末では選ばせない */ }
  }
  return ok;
};

/**
 * URLに ?live=CODE が付いていたら、この画面を出す。
 * @param roomApi { api(code) => {...}, get(code) }
 */
export const LiveCameraPage = ({ roomApi, code: codeIn, onUpload = null, onClose }) => {
  const code = normCode(codeIn);
  const [state, setState] = useState('new');
  const [note, setNote] = useState('カメラを開いています…');
  const [rec, setRec] = useState(false);
  const [sec, setSec] = useState(0);
  const [blob, setBlob] = useState(null);
  // 📷 コマ送りの速さ。⚠⚠ **既定は「枠から逆算した物」**(DEFAULT_FRAME_SPEED)。
  //   ここに 'fast' や 'normal' と書くと、逆算した結果を黙って上書きしてしまう
  //   (実際 'fast' は もう無い設定名で、静かに1秒ごとへ落ちていた)。
  const [speed, setSpeed] = useState(DEFAULT_FRAME_SPEED);
  const [err, setErr] = useState('');
  const [gone, setGone] = useState(false);      // PC側が閉じた
  // 📷🚨 いま送っているか/止めているか と その理由。⚠**黙って止めない**為に画面へ出す。
  const [frameWhy, setFrameWhy] = useState('');
  const [previewLeft, setPreviewLeft] = useState(PREVIEW_FRAMES);
  // 🚨 書き込みが「返って来ない」(枠を使い切った時に起きる)。⚠止めて、そう言う。
  const [stuck, setStuck] = useState(false);
  // 🔢 今日この端末が中継で書いた回数。⚠端末の中だけで数える(書き込みを増やさない)。
  const [relayCount, setRelayCount] = useState(() => readDayCount(localStore(), RELAY_COUNT_KEY, Date.now()));
  // 🔢🚨 端末の控えに **本当に書けているか**(2026-08-31 夜)。
  //   私用モード・容量満杯の端末は setItem が例外を投げる = 控えが残らない。
  //   その端末では数はこの画面を開いている間しか続かないので、**そう書いて出す**(黙って甘くしない)。
  const [countKept, setCountKept] = useState(() => !!localStore());
  // 📷🚨 **最後に1枚送れた時刻**と、いまの時刻。
  //   ⚠⚠ 送らない事にした時、これが無いと画面から「動いている証拠」が消える。
  //     現場は「固まった」と受け取って、つなぎ直しを始める(そのたび書き込みが増える)。
  const [lastSentAt, setLastSentAt] = useState(0);
  const [camNow, setCamNow] = useState(() => Date.now());
  // 🔍 拡大(ズーム)。⚠**端末が対応している時だけ**つまみを出す
  //   (押しても何も起きないつまみを作らない)。清水さん 2026-08-14 実機の指摘。
  const [zoomCap, setZoomCap] = useState(null);
  const [zoomVal, setZoomVal] = useState(1);
  // 🎬 録画のきれいさ(＝容量)。**選ぶのはPC**。この端末は「録れる物」を報告して、その通りに録る。
  //   ⚠caps は録画を始める瞬間に要るので、描き直しを待たない入れ物(ref)にも置く。
  const [caps, setCaps] = useState([]);
  const [wantQ, setWantQ] = useState('');
  const capsRef = useRef([]);
  const vidRef = useRef(null);
  const linkRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  // ⚠PCの指示を受ける所から呼ぶ。関数そのものは下で定義されるので、**入れ物だけ先に置く**
  //   (値が入る前の名前を読むと ReferenceError で白画面になる。2026-08-13 に実際にやった)。
  const startRef = useRef(null);
  const stopRef = useRef(null);
  const pauseRef = useRef(null);
  const resumeRef = useRef(null);
  const [paused, setPaused] = useState(false);
  // ⬆ Driveへ送る状態。'' / 'doing' / 'ok' / 'ng'
  const [upState, setUpState] = useState('');
  const [upErr, setUpErr] = useState('');
  // 📁 入った先(「最終/型式/TK-1」)。⚠「保存しました」だけでは **どこに入ったのか分からない**
  //   (清水さん 2026-08-16)。上げ終わったら必ず場所も出す。
  const [upFolder, setUpFolder] = useState('');

  const supported2 = hasLive();
  useEffect(() => {
    if (!supported2) return undefined;   // ⚠同上
    let dead = false;
    (async () => {
      // ⚠⚠ **どこで失敗したかで、言うことを変える。**
      //   ひとまとめに「カメラを開けませんでした」と出していたが、実際に多いのは
      //   電波が届かず **部屋を読めなかった** 方(2026-08-13 実機の画面で判明)。
      //   カメラのせいにすると、直す先を間違える(端末の設定をいじり始める)。
      // ⚠⚠ **一度の失敗で諦めない。** 開いた直後は、まだ「このアプリの利用者です」の
      //   手続き(匿名ログイン)が終わっていないことがあり、その一瞬だけ読めない。
      //   1回で諦めると、**あとで手続きが終わっても永久にエラーのまま**になる
      //   (2026-08-13 本番で実際にこうなった: 「権限がありません」で行き止まり)。
      let r = null;
      let lastMsg = '';
      for (let i = 0; i < 6 && !dead; i++) {
        try { r = await roomApi.get(code); lastMsg = ''; break; }
        catch (e) {
          lastMsg = String(e?.message || e);
          if (!dead) setNote(`つなぐ用意をしています…（${i + 1}回目）`);
          await new Promise((ok) => setTimeout(ok, 1200));
        }
      }
      if (dead) return;
      if (lastMsg) {
        setErr(/offline|network|unavailable/i.test(lastMsg)
          ? '電波が届いていません（Wi-Fi か 4G/5G を確認して、開き直してください）'
          : /permission|insufficient/i.test(lastMsg)
            ? 'この端末がまだアプリの利用者として認められていません（開き直してください）'
            : '合言葉を確かめられませんでした: ' + lastMsg);
        return;
      }
      if (!r || !roomAlive(r, Date.now())) { setErr('この合言葉の部屋が見つかりません（PC側でもう一度出してください）'); return; }
      try {
        const link = await startCamera({
          room: roomApi.api(code),
          onState: (st, text) => { if (!dead) { setState(st); setNote(text); } },
        });
        linkRef.current = link;
        if (!dead && vidRef.current) { vidRef.current.srcObject = link.stream; vidRef.current.play().catch(() => {}); }
        // ⚠カメラが開いた後でないと、拡大できるかどうかが分からない
        if (!dead) {
          const z = zoomRangeOf(link.stream);
          if (z && z.max > z.min) { setZoomCap(z); setZoomVal(z.value); }
          // 🎬 この端末で本当に録れるきれいさを確かめて、PCへ報告する。
          //   ⚠PCはこの報告に載っている物しか出さない(押せないつまみを出さないため)。
          const list = probeRecQualities(link.stream);
          capsRef.current = list;
          setCaps(list);
          try { await roomApi.api(code).patch(recCapsPatch(list)); } catch { /* 次の合図で届く */ }
        }
      } catch (e) {
        const msg = String(e?.message || e);
        if (!dead) {
          // ⚠「許可していない」と「壊れている」は直し方が違う
          setErr(/NotAllowed|Permission/i.test(msg)
            ? 'カメラの使用が許可されていません（ブラウザの🔒からカメラを「許可」にしてください）'
            : /NotFound|NotReadable|Overconstrained/i.test(msg)
              ? 'カメラを使えませんでした（他のアプリがカメラを使っていないか確かめてください）'
              : 'カメラを開けませんでした: ' + msg);
        }
      }
    })();
    return () => { dead = true; try { linkRef.current?.stop(); } catch { /* noop */ } };
  }, [code, roomApi, supported2]);

  // ⚠止めている間は数えない。動画が伸びていないのに秒だけ進むと、
  //   PCの表示と食い違って「どっちが本当か」が分からなくなる。
  useEffect(() => {
    if (!rec || paused) return undefined;
    const t = setInterval(() => setSec(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [rec, paused]);

  // ⚠⚠ PCの「● 録画をはじめる / ■ とめる」を受ける(清水さん 2026-08-14)。
  //   作業者はスマホを構えるだけ。スマホ側のボタンも残す(電波が切れた時の逃げ道)。
  //
  // ⚠⚠ PC側が閉じたら **絵を送るのをやめる**(2026-08-13 ハーネスで発覚)。
  //   気づかないと、誰も見ていない絵を送り続ける = **相手のギガと1日の枠を黙って使う**。
  //   しかも部屋の無い絵は掃除に引っかからず残り続ける。
  // ⚠録画は止めない。撮っているのはこの端末の中で、その人の物。
  //
  // ⚠⚠ 2026-08-17: **同じ書類を2か所で見張っていたのを1本にまとめた。**
  //   Firestore は「見張り1つにつき1回」読み取りを数えるので、同じ部屋を2本で
  //   見張ると **書き込み1回につき読み取り2回**かかっていた。しかも「見ています」の印を
  //   足した事で部屋への書き込みが増える(30秒に1回)ので、2本のままだと二重に効く。
  const wantRef = useRef(null);
  const wantPRef = useRef(null);
  const roomRef = useRef(null);
  // 👀🚨🚨 「まだ見ています」の印を **受け取った時刻(この端末の時計)**(2026-08-31)。
  //   ⚠⚠ room.viewAt は **PC(見る側)の時計** で書かれた数字。こちらの時計と引き算すると、
  //     端末どうしの時計のズレ(数十秒は普通に有る)がそのまま「経過時間」に化ける。
  //     見切りを30秒にした日から、**18秒ずれているだけで、見ている最中に送信が止まる**
  //     ようになっていた(現場からは「映らない」としか見えない)。
  //   ⚠ 控えるのは **値が変わった時だけ**。同じ印をもう一度受け取っても新しくしない。
  const viewSeenValRef = useRef(0);   // 最後に見た viewAt の値(PCの時計)
  const viewSeenAtRef = useRef(0);    // それを受け取った時刻(こちらの時計)
  // ▶ 画角合わせのぶん。⚠**この入れ物は描き直しで消えない**(消えると何度でも配り直す)。
  const previewGrantRef = useRef(0);
  const previewSentRef = useRef(0);
  // 🚨 詰まりの見張り。⚠止めるのと、戻ったら再開するのに使う。
  const stuckRef = useRef(false);
  // 📷 いま画面に出している理由(変わった時だけPCへ知らせる = 書き込みを増やさない)
  const whyRef = useRef('');
  // 🔢 今日の回数。⚠端末の控えが使えない端末でも数を進める為に、こちらにも持つ。
  const relayCountRef = useRef(0);
  // 🔢🚨 いま数えている日(枠が0に戻る日本時間16時の区切り)。⚠これが変わった時だけ 0 に戻す。
  const relayDayRef = useRef('');
  // 📷 **前に送った絵**(縮めた明るさ)と、続けて送らなかった枚数。
  //   ⚠描き直しで消えない入れ物に置く。消えると「前と同じ」が分からず、毎回送ってしまう。
  const lastSigRef = useRef(null);
  const stillSkipRef = useRef(0);
  // ⚠この画面がまだ生きているか。**effect の dead とは別物**。
  //   詰まりが解けた合図は、effect が作り直された後に届くので dead で見ると届かない。
  const aliveRef = useRef(true);
  useEffect(() => () => {
    aliveRef.current = false;
    // 🚨撮影画面ごと閉じたら「録画中」の印も外す(残すと、録画していないのに更新が一生押せなくなる)。
    try { if (typeof window !== 'undefined') window.__appBusyNote = ''; } catch { /* noop */ }
  }, []);
  useEffect(() => {
    if (!supported2 || err) return undefined;
    let dead = false;
    let seen = false;
    const un = roomApi.api(code).watch((r) => {
      if (dead) return;
      if (!r) {
        // ⚠一度も見えていないうちの「無い」は、まだ読めていないだけ。閉じたと決めつけない。
        if (seen) setGone(true);
        return;
      }
      seen = true;
      setGone(false);
      roomRef.current = r;
      // 👀 印が新しくなった瞬間を **こちらの時計** で控える(上の viewSeenAtRef の説明)。
      const va = Number(r.viewAt) || 0;
      if (va && va !== viewSeenValRef.current) { viewSeenValRef.current = va; viewSeenAtRef.current = Date.now(); }
      // ▶🚨 PCが「画角をもう一度見せて」と言った。⚠**押された時だけ**もう一度ぶん配る。
      //   ⚠名前は wpv。この下に wp(一時停止の申し出)があるので、同じ名前を使わない
      //     (同じ入れ物の中で同じ名前を2度作ると、その場で白画面になる)。
      const wpv = Number(r.wantPreviewAt) || 0;
      if (wpv && wpv !== previewGrantRef.current) {
        previewGrantRef.current = wpv;
        previewSentRef.current = 0;
        setPreviewLeft(PREVIEW_FRAMES);
        // 📷🚨 **押したら必ず1枚届く。** 絵が止まっていても送り直す。
        //   ⚠ここを忘れると「▶ 画角をもう一度見る」が **押しても何も起きないボタン**になる
        //     (止まっている絵は「前と同じ」なので、下の門で全部弾かれる)。
        lastSigRef.current = null;
        stillSkipRef.current = 0;
      }
      // ⚠⚠ **とめる/はじめる を先に見る。** 止める指示と一時停止の指示が同じ書き込みで
      //   来た時、一時停止を先に処理すると「止まっているのに録画中」が残る。
      const want = r.wantRecording;
      if (want !== undefined && want !== wantRef.current) {
        wantRef.current = want;
        // ⚠すでにその状態なら何もしない(押し直しで二重に始めない)
        if (want && !recRef.current) { wantPRef.current = false; startRef.current?.(); }
        if (!want && recRef.current) { wantPRef.current = null; stopRef.current?.(); }
      }
      // 🎬 PCが選んだきれいさ。⚠**撮る前に決まっている物**を使う(録画中は触らない)。
      if (typeof r.wantQuality === 'string') setWantQ(r.wantQuality);
      // ⏸ 一時停止 / ▶ 続き。⚠録画していない時は何もしない。
      const wp = r.wantPaused;
      if (wp !== undefined && wp !== wantPRef.current) {
        wantPRef.current = wp;
        if (recRef.current) { if (wp) pauseRef.current?.(); else resumeRef.current?.(); }
      }
    });
    return () => { dead = true; try { un(); } catch { /* noop */ } };
  }, [code, roomApi, supported2, err]);

  // ⚠⚠ 滑らかな映像(WebRTC)で繋がっているか。**コマ送りを止める判断に使う**ので、
  //   使う所より前に置く(値が入る前に読むと ReferenceError で白画面)。
  const live = state === 'connected' || state === 'completed';
  // ⚠⚠ **繋がったその瞬間には止めない**(RTC_SETTLE_MS だけ様子を見る)。
  //   切れたら **すぐ** 送り直す(false は待たずに入れる)。
  //   ここをヒステリシスにしないと、一瞬切れるたびに絵が消えてPCの画面が点滅する。
  const [rtcSteady, setRtcSteady] = useState(false);
  useEffect(() => {
    if (!live) { setRtcSteady(false); return undefined; }
    const t = setTimeout(() => setRtcSteady(true), RTC_SETTLE_MS);
    return () => clearTimeout(t);
  }, [live]);

  // 📷 コマ送りを送り続ける。⚠中継サーバが要らないので、**どの回線でも動く**。
  //   PCは工場Wi-Fi・スマホは携帯回線 = 互いに外から見えないため、滑らかな直通は
  //   まず繋がらない。画角合わせはこちらが本命。
  //
  // ⚠⚠ **滑らかな映像が届いている間は送らない**(清水さん 2026-08-16「両方かくかくする」)。
  //   2026-08-13 の初版から、繋がり具合を1文字も見ずに送り続けていた。実測では
  //   PCに「● 滑らかにつながっています」と出ている間も **2.00回/秒**(約84kbps)書き続け、
  //   1枚作るのに **メインスレッドを 5ms 止めて** いた(toDataURL は同期処理)。
  //   スマホは同時に「1080pの符号化・録画・プレビュー」もやっているので、
  //   この二重の仕事がそのままコマ落ちになる。**繋がっている間は丸ごと要らない。**
  //
  // ⚠⚠🚨 2026-08-17: **送ってよいかの判断を、この画面から追い出した。**
  //   条件が「PCが閉じた/滑らかに繋がった/録画中か/誰か見ているか/詰まっていないか」と
  //   増えていくのに、判断が useEffect の頭に散らばっていた。散らばると、条件を1つ足した時に
  //   どこかの枝だけ直し忘れて **本番で一度も点かない門** になる(前科あり)。
  //   → 判断は domain の frameSendPlan() ただ1つ。ここは **その通りに動くだけ**。
  //
  // ⚠⚠ 時計は止めない(止めると、録画を押しても絵が出るまで待たされる)。
  //   送らない時は IDLE_TICK_MS ごとに **条件だけ** 見に行く。**これは書き込みではない。**
  //
  // 🚨 録画していない時に送るのは PREVIEW_FRAMES 枚まで(画角合わせ)。
  //   足りなければ、PCの「▶ 画角をもう一度見る」でもう1回ぶん配られる。
  useEffect(() => {
    if (!supported2 || err) return undefined;
    const sp = frameSpeedOf(speed);
    const store = localStore();
    let dead = false;
    let timer = 0;
    let n = 0;
    const cv = document.createElement('canvas');
    // 📷 「前の絵と同じか」を測る為だけの、うんと小さい絵。⚠送る絵とは別物。
    const peek = document.createElement('canvas');
    peek.width = STILL_GRID_W;
    peek.height = STILL_GRID_H;

    // 📷 いま送っている/止めている理由をPCへ知らせる。⚠**変わった時だけ**(書き込みを増やさない)。
    //   ⚠PCが居ない時は書かない(消えた部屋に書くと、createdAt の無い幽霊部屋が出来る)。
    const tellWhy = (why) => {
      if (whyRef.current === why) return;
      whyRef.current = why;
      setFrameWhy(why);
      if (why === 'gone' || why === 'noviewer' || why === 'unsupported' || why === 'error') return;
      roomApi.api(code).patch(frameWhyPatch(why)).catch(() => { /* 次の合図で届く */ });
    };

    const tick = async () => {
      if (dead) return;
      const now = Date.now();
      // 🔢🚨 今日の回数。⚠⚠ 枠が0に戻る区切り(日本時間16:00)をまたいだら 0 に戻す。
      //   戻さないと古い大きな数を持ち続けて **硬い上限の門が翌日になっても開かない**。
      // 🚨🚨 2026-08-31(夜) **控えに書けない端末で上限が一生閉まらなかった**のを直す。
      //   直す前は毎回 控えの数で **入れ替えて** いた。私用モード・容量満杯の端末は setItem が
      //   例外を投げるので控えは 0 のまま = 読み直すたびに数が 0 に戻り、4,000回の門に一生届かない
      //   (＝検査の記録を守る為の安全弁が、一番効いてほしい端末で効いていなかった)。
      //   → ①日鍵が変わった時だけ 0 に戻す ②控えとは **大きい方を採る**(記憶の床)。
      //   ⚠読むだけ(書き込みではない)。
      const dayKey = relayDayKey(now);
      if (relayDayRef.current !== dayKey) { relayDayRef.current = dayKey; relayCountRef.current = 0; }
      if (store) {
        const kept = readDayCount(store, RELAY_COUNT_KEY, now);
        // 控えが自分の数より小さい = 書けていない。⚠その時こそ記憶の床で止める(甘い方へ倒さない)。
        if (kept < relayCountRef.current) setCountKept(false);
        relayCountRef.current = Math.max(relayCountRef.current, kept);
      }
      const base = frameSendPlan({
        room: roomRef.current,
        nowMs: now,
        rtcSteady,
        gone,
        // ⚠止めている間は「録画中」に数えない。止めたまま送り続けると枠だけ減る。
        //   代わりに画角合わせのぶんが配り直されるので、置き直しの絵は見える。
        recording: !!rec && !paused,
        previewSent: previewSentRef.current,
        stuck: stuckRef.current,
        error: !!err,
        supported: supported2,
        // 🚨 **1日の中継ぶんを使い切ったら止める**(2026-08-23)。数えるだけで止めていなかった。
        todayWrites: relayCountRef.current,
        // 👀🚨 「まだ見ています」の印を **受け取った時刻**(この端末の時計)。
        //   ⚠これを渡さないと、PCの時計で書かれた viewAt とこちらの時計を引き算する事になり、
        //     時計が数十秒ずれている端末では **見ている最中に 'noviewer' で止まる**。
        viewSeenAt: viewSeenAtRef.current,
      });
      // 📷🚨 **場面が正しくても、絵が1ドットも変わっていないなら送らない**(2026-08-23)。
      //   ⚠⚠ ここで比べるのは **縮めた絵(STILL_GRID_W×STILL_GRID_H マスの明るさ)**。重い toDataURL は
      //     「送る」と決まってから初めて呼ぶので、止まっている間は
      //     **書き込みも、メインスレッドを5ms止める処理も、両方まるごと消える**。
      //   ⚠絵が読めない(peek が null)時は「動いた」扱い＝今まで通り送る(安全側)。
      let plan = base;
      let sig = null;
      if (base.send) {
        sig = framePeek(vidRef.current, peek);
        const same = !framesDiffer(lastSigRef.current, sig);
        stillSkipRef.current = same ? stillSkipRef.current + 1 : 0;
        plan = applyStillSkip(base, same, stillSkipRef.current);
      }
      tellWhy(plan.why);
      if (plan.send) {
        const v = vidRef.current;
        if (v && v.videoWidth > 0) {
          const w = Math.min(FRAME_MAX_W, v.videoWidth);
          const h = Math.max(1, Math.round(v.videoHeight * (w / v.videoWidth)));
          if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
          let p = null;
          try {
            cv.getContext('2d').drawImage(v, 0, 0, w, h);
            const url = cv.toDataURL('image/jpeg', FRAME_QUALITY);
            // ⚠**1つの書類に毎秒1回**を守るため、速い設定の時は複数に振り分ける
            p = roomApi.frame(code, frameSlot(n, sp.slots)).patch({ url, at: now });
            n += 1;
            // 📷 送れた絵を「前の絵」として覚える。⚠**送れた時だけ**覚える
            //   (作れなかった絵を覚えると、次に同じ絵が来た時に送らなくなる)。
            lastSigRef.current = sig;
            setLastSentAt(now);
            if (plan.why === 'preview') {
              previewSentRef.current += 1;
              setPreviewLeft(Math.max(0, PREVIEW_FRAMES - previewSentRef.current));
            }
            // 🔢🚨 **数えるのは「渡した時」**。返りを待って数えない。
            //   枠が尽きた書き込みは永久に返らないので、返ってから数えると
            //   **一番数えたい場面で数字が止まる**(そして誰も気づけない)。
            //   🚨2026-08-31(夜): **控えに書けない端末でも必ず1つ進む**(記憶の床)。
            //     控えが返す数と「今の数+1」の大きい方を採る。日をまたいだ時の 0 戻しは
            //     上の日鍵の見比べが受け持つので、ここで下げる必要は無い。
            relayCountRef.current = Math.max(relayCountRef.current + 1, store ? addDayCount(store, RELAY_COUNT_KEY, now, 1) : 0);
            setRelayCount(relayCountRef.current);
          } catch { /* 1枚落ちても次で送る */ }
          if (p) {
            // 🚨 返って来るかを見張る。返らない＝枠を使い切った可能性。**積まずに止める**。
            const ok = await settledWithin(p, FRAME_STUCK_MS);
            if (!ok) {
              stuckRef.current = true;
              setStuck(true);
              // ⚠戻ったら自分で再開する(人に押させない)。⚠**effect の dead では見ない**
              //   (止めた時点で作り直されるので、dead で見ると永久に止まったままになる)。
              const back = () => { if (aliveRef.current) { stuckRef.current = false; setStuck(false); } };
              Promise.resolve(p).then(back, back);
            }
          }
        }
      }
      // ⚠⚠ **「絵が止まっているから送らなかった」時は、見に行く間隔を広げない**(base.send で決める)。
      //   広げると、動き出してから絵が出るまでの遅れがそのまま増える
      //   (現場から見た速さは今まで通りにする、が この直しの前提)。
      //   ⚠絵を見比べるのは端末の中だけ。**これは書き込みではない。**
      if (!dead) timer = setTimeout(tick, base.send ? sp.everyMs : IDLE_TICK_MS);
    };
    // ⚠開いた直後の1枚は少し待つ(カメラの絵がまだ真っ黒なことがある)
    timer = setTimeout(tick, 600);
    return () => { dead = true; clearTimeout(timer); };
  }, [code, roomApi, supported2, err, speed, gone, rtcSteady, rec, paused, stuck]);

  // 📷 場面が変わったら「前の絵」を忘れる ＝ **次の1枚は必ず送る**。
  // ⚠⚠ 忘れないと、なめらかな中継が切れた時・PCが戻って来た時に「前と同じ絵だから
  //   送らない」が効いてしまい、**画面が黙ったまま**になる。
  // ⚠ここは画角合わせの枚数(previewSent)には触らない。触ると中継が一瞬切れるたびに
  //   PREVIEW_FRAMES 枚が配り直されて、逆に書き込みが増える。
  useEffect(() => {
    lastSigRef.current = null;
    stillSkipRef.current = 0;
  }, [rec, paused, rtcSteady, gone, speed]);

  // ▶ 録画の状態が変わったら、画角合わせのぶんを配り直す。
  // ⚠⚠ 撮り終わった後・一時停止した後は **置き直す**(次の画を決める)。そこで絵が出ないと、
  //   現場は「壊れた」と思ってPCでつなぎ直しを始める(結局そちらの方が書き込みが増える)。
  useEffect(() => {
    previewSentRef.current = 0;
    setPreviewLeft(PREVIEW_FRAMES);
  }, [rec, paused]);

  const start = async () => {
    const st = linkRef.current?.stream;
    if (!st) { setErr('カメラがまだ開いていません'); return; }
    chunksRef.current = [];
    // ⚠録画は **この端末** で。ここが高画質の本体。送っている映像は画角合わせ用。
    const mime = pickRecMime();
    // 🎬 きれいさ(＝容量)は **撮る前に決まった物** を使う。
    //   ⚠録画の途中では変えない(1本の中で画質が変わる)。
    //   ⚠選ばれた物がこの端末で録れないなら、録れる物へ寄せる(黙って失敗させない)。
    //   ⚠音の細かさは触らない(低く指定すると音が丸ごと消える端末がある)。
    const q = pickRecQuality(roomRef.current?.wantQuality || wantQ, capsRef.current);
    // 🎥 きれいさに合わせて **カメラの大きさ** も合わせる(2026-08-16 清水さん了承)。
    // ⚠⚠ 前は4段とも 1920x1080 のまま ビットレートだけ削っていたので、
    //   下2段は 1080p に必要な量の3〜7割しか無く、**動く所がブロックだらけ**になっていた。
    //   → 「かるい」は1280x720、「とても軽い」は854x480 へ。**同じ容量のまま綺麗になる。**
    // ⚠**コマ数(30)は変えない。** 解像度とコマ数は別のつまみで、下げてもカクカクにはならない。
    //   むしろ符号化が軽くなるので **カクつきにくくなる**(中継のカクカクの原因が1080p化だった)。
    // ⚠効かない端末では黙って無視される(ideal)。失敗しても録画は続ける。
    if (q) {
      try {
        const vt = st.getVideoTracks()[0];
        if (vt && typeof vt.applyConstraints === 'function') await vt.applyConstraints(recVideoConstraints(q.key));
      } catch (e) { console.info('[live] カメラの大きさを変えられません(このまま録ります):', e?.message || e); }
    }
    const opt = {};
    if (mime) opt.mimeType = mime;
    if (q) opt.videoBitsPerSecond = q.vbps;
    // ⚠⚠ 対応していない端末では new MediaRecorder が投げる。囲わないと
    //   **画面に何も出ないまま無反応**になる(PC側の撮影モーダルは囲ってあるのに、ここだけ裸だった)。
    let r;
    try {
      r = new MediaRecorder(st, Object.keys(opt).length ? opt : undefined);
    } catch (e) {
      setErr('この端末では録画できません（' + ((e && e.message) || e) + '）。PC側の🎥撮影をお使いください。');
      try { await roomApi.api(code).patch({ recording: false, recError: 'この端末では録画できません' }); } catch { /* noop */ }
      return;
    }
    r.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    r.onstop = () => setBlob(new Blob(chunksRef.current, { type: r.mimeType || 'video/webm' }));
    // ⚠⚠ OSにカメラを切られた時、onstop だけ来て「録画中」の表示が **両方の画面に残り続ける**。
    //   止まったことを必ず部屋へ書く(黙って壊れない)。
    r.onerror = (ev) => {
      setRec(false);
      setErr('録画が止まりました（' + ((ev && ev.error && ev.error.name) || '端末の都合') + '）。撮れた分は残っています。');
      roomApi.api(code).patch({ recording: false, recError: '録画が止まりました' }).catch(() => {});
    };
    r.start(1000);
    recRef.current = r;
    // 🚨🚨 録画中は「新しい版に更新する」を押させない(2026-08-20 最終→2026-08-31 製品にも配線)。
    //   録っている映像は、まだどこにも保存されていない。読み直すと **丸ごと消える**。
    //   ⚠版の関所(canReload)が見ているのは Firestore の送信待ちだけで、録画は一度もそこに現れない。
    //   ⚠印はここ1つ。止める時に必ず外す(下の stop で外している所と対にする)。
    try { if (typeof window !== 'undefined') window.__appBusyNote = '録画中です。読み直すと映像が消えます'; } catch { /* 印が置けなくても録画は続ける */ }
    // ⚠新しく撮り始めたら、前の回の「入りました」を消す(前の場所が出たままになる)。
    setRec(true); setPaused(false); setSec(0); setBlob(null); setUpState(''); setUpErr(''); setUpFolder('');
    // ⚠見る側が旗の時刻を出すのに使う。**録画開始の時刻**をここで書く。
    // ⚠⚠ `recording` は **報告**。PCの経過秒・🚩の時刻・赤札は全部これで動くので、
    //   書くのをやめてはいけない(やめると全部 0:00 で固まる)。
    // ⚠どのきれいさで録っているかも報告する(PCが選んだ物と違う時に、黙らない)。
    try { await roomApi.api(code).patch({ ...reportStart(Date.now()), recQuality: q ? q.key : '' }); } catch { /* noop */ }
  };
  // ⏸ 一時停止。⚠⚠ MediaRecorder.pause は **その間を録らない**。だから動画は繋がるが、
  //   壁の時計は進む。止めていた分は必ず部屋に足し込む(でないと旗が全部ズレる)。
  const pause = async () => {
    const r = recRef.current;
    if (!r || r.state !== 'recording') return;
    try { r.pause(); } catch { /* 対応していない端末では何も起きない */ }
    if (r.state !== 'paused') {
      // ⚠押しても止まらない端末がある。**黙って「止めました」と言わない。**
      setErr('この端末は一時停止に対応していません（そのまま録画は続いています）。');
      try { await roomApi.api(code).patch({ paused: false, recError: 'この端末は一時停止に対応していません' }); } catch { /* noop */ }
      return;
    }
    setPaused(true);
    try { await roomApi.api(code).patch(reportPause(Date.now())); } catch { /* noop */ }
  };
  const resume = async () => {
    const r = recRef.current;
    if (!r || r.state !== 'paused') return;
    try { r.resume(); } catch { /* noop */ }
    setPaused(false);
    // ⚠止めていた分を足し込んでから pausedAt を消す。順番を逆にすると足し忘れる。
    try { await roomApi.api(code).patch(reportResume(roomRef.current || {}, Date.now())); } catch { /* noop */ }
  };
  const stop = async () => {
    try { recRef.current?.stop(); } catch { /* noop */ }
    recRef.current = null;
    // 🚨録画が終わったら印を外す(外し忘れると、以後ずっと更新を押せなくなる)。
    try { if (typeof window !== 'undefined') window.__appBusyNote = ''; } catch { /* noop */ }
    setRec(false); setPaused(false);
    try { await roomApi.api(code).patch(reportStop(roomRef.current || {}, Date.now())); } catch { /* noop */ }
  };

  /**
   * ⬆ 撮れた動画をDriveへ送る。
   * ⚠⚠ **失敗しても blob を消さない。** 消すと撮り直しになる(手本動画は撮り直しが重い)。
   * ⚠結果は部屋にも書く。PC側の画面に「送っています / 入れました / 入れられませんでした」を
   *   出すため(作業者はスマホを見ていない。PCを見ている)。
   * ⚠⚠ 送っている **最中** を「入れました」と言わない。2026-08-16 まで、送り始めた瞬間に
   *   ✓の緑札がPCに出ていた(PC側が up.error の有無だけで判断していた)。
   */
  const doUpload = useCallback(async (b) => {
    if (!onUpload || !b) return;
    setUpState('doing'); setUpErr(''); setUpFolder('');
    // ⚠⚠ ここは **まだ送り始めてもいない**。前の回の結果(理由・名前・入った先)を
    //   必ず消してから書く。消さないと、送っている最中にPC側で前の失敗が出続ける。
    try { await roomApi.api(code).patch(upDoingPatch(Date.now())); } catch { /* noop */ }
    try {
      // 📁 どこへ入れるか(道順・全体用/工程名)は **PCが部屋に書いた物**をそのまま運ぶ。
      //   ⚠⚠ **スマホ側で道順を組み立てない。** この画面はロットもテンプレも読み込まないので、
      //     組ませると型式名もテンプレ名も空のまま、アプリが見に行かないフォルダへ入る
      //     (清水さん 2026-08-16「スマホで撮った映像アプリ上だとみれなかった」の正体)。
      //   ⚠部屋が読めなくても上げるのは止めない(受け取った側のよりどころに落ちるだけ。
      //     動画そのものを失う方がずっと重い)。
      const take = takeOf(roomRef.current || {});
      const res = await onUpload(b, take);
      const name = (res && (res.name || res.fileName)) || '';
      // 📁 入った先。⚠**実際に入れた側が返した道順**を優先する(部屋の道順が空で、
      //   受け取った側のよりどころへ落ちた時に、嘘の場所を出さない為)。
      const folder = (res && res.folder) || folderLabel(take.folderPath);
      setUpState('ok'); setUpFolder(folder);
      try { await roomApi.api(code).patch(upOkPatch({ name, folder, fileId: (res && res.id) || '', atMs: Date.now() })); } catch { /* noop */ }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      setUpState('ng'); setUpErr(msg);
      try { await roomApi.api(code).patch(upNgPatch({ error: msg, atMs: Date.now() })); } catch { /* noop */ }
    }
  }, [onUpload, roomApi, code]);

  // ⚠撮り終わったら **自動で** Driveへ送る(作業者に押させない)。
  //   ⚠失敗したら上の「⬆ もう一度Driveへ」で押し直せる。動画は端末に残ったまま。
  useEffect(() => {
    if (!blob || !onUpload || upState) return;
    doUpload(blob);
  }, [blob, onUpload, upState, doUpload]);
  // ⚠PCの指示を受ける所へ渡す(定義の後で入れる。前で読むと白画面になる)
  startRef.current = start;
  stopRef.current = stop;
  pauseRef.current = pause;
  resumeRef.current = resume;

  // 📊 いま何コマ送れているか・なぜ粗いのか。⚠**推測でなく実測**を、撮っている人にも出す。
  const [sendStats, setSendStats] = useState(null);
  useEffect(() => {
    if (!supported2 || err) return undefined;
    let dead = false;
    const t = setInterval(async () => {
      // 📷 「最後に送ってから何秒」を進める為の時計。⚠**書き込みではない**(画面の数字だけ)。
      if (!dead) setCamNow(Date.now());
      const s = await liveStatsOf(linkRef.current?.pc, 'outbound');
      if (!dead) setSendStats((prev) => (liveStatsText(prev) === liveStatsText(s) ? prev : s));
    }, STATS_EVERY_MS);
    return () => { dead = true; clearInterval(t); };
  }, [supported2, err]);

  // ⚠⚠ 保存用のあて先は **1本だけ作って、要らなくなったら返す**。
  //   JSXの中で URL.createObjectURL を呼んでいたので、描き直すたびに新しいあて先が
  //   でき、1つも返していなかった(revokeObjectURL が1回も呼ばれない)。
  const dlUrl = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(() => () => { if (dlUrl) { try { URL.revokeObjectURL(dlUrl); } catch { /* noop */ } } }, [dlUrl]);

  // 🔢 今日の使い具合。⚠数字は domain 側で作る(この画面で割り算をしない)。
  const budget = relayBudgetView(relayCount, speed);
  // 📷 いま送っているか(札の色と言い方を、送信の門と食い違わせない)
  const sending = frameWhy === 'recording' || frameWhy === 'preview';

  return (
    <div className="fixed inset-0 z-[620] bg-black flex flex-col">
      <div className="shrink-0 px-3 py-2 flex items-center gap-2 text-white bg-slate-900">
        <span className="font-bold text-sm">🎥 撮影</span>
        {/* ⚠⚠ どちらの道で送っているかを、撮っている人にも出す。
               「PCでカクカクしている」と言われた時、スマホ側で見るのはこの札1つ。 */}
        <span className={`fi-tap-text rounded px-2 py-0.5 font-bold ${stuck ? 'bg-rose-700' : gone ? 'bg-amber-600' : live ? 'bg-emerald-500' : sending ? 'bg-sky-600' : 'bg-slate-600'}`}>
          {stuck ? '⚠ 送れていません（枠を使い切った可能性）'
            : gone ? '⚠ PC側が閉じました（送信は止めました）'
              : live ? '● PCに映っています'
                : sending ? `📷 コマ送りで送っています（${note}）`
                  : `⏸ ${frameWhyText(frameWhy)}`}
        </span>
        <button onClick={onClose} className="ml-auto px-3 py-1.5 min-h-[36px] rounded bg-white/15 font-bold text-xs">閉じる</button>
      </div>
      <div className="flex-1 min-h-0 relative flex items-center justify-center">
        <video ref={vidRef} playsInline muted autoPlay className="max-w-full max-h-full" />
        {rec && (paused
          ? <span className="absolute top-3 left-3 bg-amber-500 text-white font-bold rounded px-3 py-1.5">⏸ 止めています（{fmt(sec)}）</span>
          : <span className="absolute top-3 left-3 bg-rose-600 text-white font-bold rounded px-3 py-1.5 animate-pulse">● 録画中 {fmt(sec)}</span>)}
      </div>
      <div className="shrink-0 p-3 space-y-2 bg-slate-900">
        {(err || !supported2) && <div className="text-xs text-rose-200 bg-rose-900/50 rounded p-2">{err || 'この端末では使えません（カメラを開けません）'}</div>}
        {gone && !err && (
          <div className="text-xs text-amber-100 bg-amber-800/60 rounded p-2">
            PC側の画面が閉じられました。<b>映像を送るのはやめました</b>（通信量を使い続けないため）。
            {rec ? <> <b>録画はこのまま続いています</b>——止めればこの端末に残ります。</> : ' もう一度見せるときは、PCでQRを出し直してください。'}
          </div>
        )}
        {/* 🚨🚨 **書き込みが返って来ない**＝1日の枠を使い切った可能性。
               ⚠⚠ Firestore はこの時 **失敗を返さない**(永久に返らないだけ)。黙っていると
                 現場には「なんとなく重い」としか見えない。**必ず言葉にして出す。** */}
        {stuck && !err && (
          <div className="text-xs text-rose-100 bg-rose-800/70 rounded p-2 leading-snug" data-live="stuck">
            ⚠ <b>映像を送れていません。</b>{Math.round(FRAME_STUCK_MS / 1000)}秒待っても保管庫から返事がありません
            （<b>Firebaseの1日の書き込み枠を使い切った可能性</b>があります）。
            <b>コマ送りは止めました</b>（止めないと、送れない絵が端末の中に積み上がります）。
            <br /><b>録画はこのまま続いています。</b>とめればこの端末に残ります。返事が戻れば自動で再開します。
          </div>
        )}
        {/* 📊 いま何コマ送れているか。⚠⚠ **推測でなく実測**。
               「カクカクする」と言われた時、ここに理由(電波が細い / スマホが重い)が出る。
               ⚠コマ送りを止めている事も必ず言う(黙って止めると「送っていない」と誤解される)。
               🔢 使った分も出す(2026-08-17)。⚠この表示で書き込みは1回も増えない。 */}
        {!err && supported2 && (
          <div className="fi-tap-text text-white/70 leading-snug space-y-1" data-live="sendstats">
            {live && (
              <div>📡 なめらかな中継：{liveStatsText(sendStats) || '測っています…'}</div>
            )}
            <div data-live="framewhy">
              {frameWhy === 'recording' || frameWhy === 'preview'
                ? <>📷 <b className="text-sky-300">送っています</b>（{frameWhyText(frameWhy)}
                  {frameWhy === 'preview' ? `・あと${previewLeft}枚` : ''}／{frameSpeedOf(speed).label}）</>
                : <>⏸ <b className={stuck ? 'text-rose-300' : 'text-emerald-300'}>送っていません</b>（{frameWhyText(frameWhy)}）
                  {frameWhy === 'previewdone' ? <span className="text-white/60">／PCの「▶ 画角をもう一度見る」でまた送ります</span> : null}</>}
            </div>
            {/* 📷🚨 **止めている間も「動いている」事が分かる印**(2026-08-23)。
                   ⚠⚠ 黙って送らないのが一番悪い。最後に送れた時刻を必ず残す
                     (これが無いと、現場は「固まった」と受け取ってつなぎ直しを始める)。
                   ⚠この表示で書き込みは1回も増えない(端末の中の時計だけ)。 */}
            <div data-live="lastsent" className="text-white/60">
              🕒 最後に1枚送れたのは
              {lastSentAt
                ? <> <b className="text-white/85">{Math.max(0, Math.round((Math.max(camNow, lastSentAt) - lastSentAt) / 1000))}秒前</b></>
                : ' まだ1枚も送っていません'}
              {frameWhy === 'still'
                ? <span className="text-emerald-300">／画が動いた瞬間に、そのまま送ります（{STILL_TELL_AFTER}枚ぶん同じだったので止めています）</span>
                : null}
            </div>
            <div data-live="relaycount" className={budget.over ? 'text-rose-300 font-bold' : ''}>
              🔢 今日この端末が中継で書いた回数：<b>{budget.writes.toLocaleString()}回</b> / 上限{budget.budget.toLocaleString()}回
              （<b>{budget.pct}%</b>）
              {budget.over
                ? <>・⚠ <b>上限に達したので送信を止めています</b>（検査の記録を守るため。枠が0に戻る日本時間16時に自動で再開します）</>
                : <>・このまま録画を続けると <b>あと約{budget.leftHours}時間</b></>}
            </div>
            {/* 🔢🚨 控えが残せない端末(私用モード・容量満杯)。黙って甘くしない = 画面に出す。
                   ⚠上限そのものは効きます(この画面を開いている間の数で 4,000回に達したら止めます)。 */}
            {!countKept && (
              <div className="text-amber-200 bg-amber-900/50 rounded p-1.5" data-live="countnotkept">
                ⚠ この端末では回数の<b>控えが残せません</b>（私用モード・空き容量なし）。
                数えるのは<b>この画面を開いている間だけ</b>になります。
                上限（{RELAY_HARD_CAP_DAY.toLocaleString()}回）に達したら、その時点で<b>送信は止めます</b>。
                閉じて開き直すと数え直しになるので、<b>長く撮る日はこの画面を開いたままにしてください</b>。
              </div>
            )}
            <div className="text-white/45">
              ⚠ 数えているのは<b>この端末の中だけ</b>です（この表示で書き込みは増えません）。
              日付はこの端末の時計で数えているので、Firebaseの枠が切り替わる時刻とは少しズレます。
            </div>
          </div>
        )}
        {/* 🔍 拡大。⚠対応していない端末では出さない(押しても動かない物を出さない) */}
        {zoomCap && (
          <div className="flex items-center gap-2">
            <button onClick={() => { const v = Math.max(zoomCap.min, zoomVal - zoomCap.step * 3); setZoomVal(v); setZoom(linkRef.current?.stream, v); }}
              className="px-4 py-2 min-h-[44px] rounded-lg bg-white/15 text-white font-black text-lg">－</button>
            <input type="range" min={zoomCap.min} max={zoomCap.max} step={zoomCap.step} value={zoomVal}
              onChange={(e) => { const v = Number(e.target.value); setZoomVal(v); setZoom(linkRef.current?.stream, v); }}
              className="flex-1 fi-big-thumb" aria-label="拡大" />
            <button onClick={() => { const v = Math.min(zoomCap.max, zoomVal + zoomCap.step * 3); setZoomVal(v); setZoom(linkRef.current?.stream, v); }}
              className="px-4 py-2 min-h-[44px] rounded-lg bg-white/15 text-white font-black text-lg">＋</button>
            <span className="text-white text-xs font-bold w-12 text-right tabular-nums">{zoomVal.toFixed(1)}倍</span>
          </div>
        )}
        {/* 🎬 いま何で録るか。⚠選ぶのはPC側(作業者はスマホを構えているだけ)。
               ここは「何で録るつもりか」が分かるように出すだけ。 */}
        {!rec && !blob && (
          <div className="fi-tap-text text-white/60">
            {caps.length
              ? <>🎬 録画のきれいさ：<b className="text-white/90">{recQualityLabel(pickRecQuality(wantQ, caps)?.key)}</b>（PC側で選べます）</>
              : <>🎬 この端末では録画のきれいさを選べません（そのまま撮ります）</>}
          </div>
        )}
        {/* 📷 コマ送りの速さ。⚠通信量が変わるので、その場で選べるようにする
               ⚠⚠ ここも **選ぶ場所** なので、画質と同じ表への入口を出す(2か所とも同じ部品)。
                 「ふつう」と「ギガ節約」で通信量がどれだけ違うのかは、表を見ないと分からない。 */}
        {!rec && !blob && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              {Object.values(FRAME_SPEEDS).map(sp => (
                <button key={sp.key} onClick={() => setSpeed(sp.key)}
                  className={`flex-1 py-2 min-h-[40px] rounded-lg fi-tap-text font-bold ${speed === sp.key ? 'bg-white text-slate-900' : 'bg-white/15 text-white'}`}>
                  {sp.label}
                </button>
              ))}
            </div>
            <DataUsageOpenButton
              label={USAGE_BTN_LABEL}
              title={USAGE_BTN_TITLE}
              className="w-full min-h-[44px] px-2 rounded-lg bg-white/15 hover:bg-white/25 border-2 border-white/25 text-white fi-tap-text font-black"
            />
          </div>
        )}
        {!blob ? (
          // ⚠⚠ ここは三項の枝。要素を2つ並べるなら **必ず <> で1つに束ねる**。
          //   束ねずに並べると `Unexpected token, expected ","` で **画面ごと出なくなる**。
          //   ⚠この行の直後に {/* */} のコメントは置けない(同じ理由で構文が壊れる)。
          <>
            {/* ⏸ スマホ側にも一時停止を出す。PCから押すのが本筋だが、電波が切れた時の逃げ道。
                   ⚠録画していない時は出さない(押せないボタンを並べない)。 */}
            {rec && (
              <button onClick={paused ? resume : pause}
                className={`w-full py-3 min-h-[52px] rounded-2xl font-black text-base mb-2 ${paused ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'}`}>
                {paused ? '▶ 続きを撮る' : '⏸ 一時停止'}
              </button>
            )}
            <button onClick={rec ? stop : start} disabled={!!err || !supported2}
              className={`w-full py-4 min-h-[64px] rounded-2xl font-black text-lg ${rec ? 'bg-white text-rose-600' : 'bg-rose-600 text-white'} disabled:bg-slate-600`}>
              {rec ? '■ 録画をとめる' : '● 録画をはじめる'}
            </button>
          </>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-white">撮れました（{(blob.size / 1024 / 1024).toFixed(1)} MB）{upState === 'doing' ? ' — Driveへ送っています…' : ''}</div>
            {/* ⚠⚠ **撮れた動画を絶対に失わない。**
                   Driveへ送れなくても、この「⬇ この端末に保存」は **必ず出したまま** にする。
                   手本動画は撮り直しに現場の時間がかかる。上げ損ねて消えるなら改善ではなく事故。 */}
            <div className="flex gap-2">
              <a href={dlUrl} download={`手本_${new Date().toISOString().slice(0, 10)}.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`}
                className="flex-1 text-center py-3 min-h-[52px] rounded-xl bg-white text-slate-800 font-bold">⬇ この端末に保存</a>
              {onUpload && (
                <button onClick={() => doUpload(blob)} disabled={upState === 'doing'}
                  className="flex-[2] py-3 min-h-[52px] rounded-xl bg-sky-600 disabled:bg-slate-500 text-white font-bold">
                  {upState === 'doing' ? '送っています…' : upState === 'ng' ? '⬆ もう一度Driveへ' : '⬆ Driveへ保存'}
                </button>
              )}
            </div>
            {/* ⚠⚠ 「消して構いません」は **上げ終わってから** しか出さない(送信中は出さない)。
                   ⚠入った先も一緒に出す。場所を言わずに「保存しました」だけ出すと、
                     Driveのどこを探せばいいのか分からない(清水さん 2026-08-16)。 */}
            {upState === 'ok' && (
              <div className="fi-tap-text text-emerald-300">
                {/* ⚠場所が分からない時に、それらしい場所を作って出さない(嘘になる)。 */}
                {upFolder
                  ? <>✓ Driveの〈<b>{upFolder}</b>〉に入れました。この端末の分は消して構いません。</>
                  : <>✓ Driveに入れました（<b>入った場所は分かりません</b>）。この端末の分は消して構いません。</>}
              </div>
            )}
            {upState === 'ng' && (
              <div className="fi-tap-text text-rose-200 bg-rose-900/50 rounded p-2">
                Driveへ入れられませんでした：{upErr}<br />
                <b>動画はこの端末に残っています。</b>電波の良い所でもう一度押すか、⬇で保存してください。
              </div>
            )}
            <button onClick={() => { setBlob(null); setUpState(''); setUpErr(''); setUpFolder(''); }}
              disabled={upState === 'doing'}
              className="w-full py-2 rounded-lg bg-white/10 disabled:opacity-40 text-white font-bold text-xs">もう一度撮る</button>
          </div>
        )}
        <div className="fi-tap-text text-white/50">
          ※ 録画はこの端末で行います。PCに映っているのは画角合わせ用なので、
          電波が細くてもこの録画の画質は落ちません。（{CONNECT_TIMEOUT_SEC}秒つながらない時はPC側に理由が出ます）
        </div>
      </div>
    </div>
  );
};

export default LiveViewer;
