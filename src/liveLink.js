// ============================================================================
// 📱 別の端末のカメラを、この画面で見る — つなぐ所(WebRTC)
// ----------------------------------------------------------------------------
// 清水さん(2026-08-13)「別の端末(スマホ)で撮ってる映像をこのアプリでリアルタイムで見たい」
//
// ⚠⚠ 映像は **端末どうしの直通** で流れる。サーバ(Firestore)を通るのは
//   「つなぎ方の合図」だけ(数KBの文字)。**動画はクラウドに一切上がらない**。
//
// ⚠⚠ 録画は **撮る側(スマホ)で録る**。ここで送る映像は画角合わせ用。
//   WebRTC は回線が細ると勝手に画質を落とす(それが役目)。手本動画をこちら側で
//   録ると画質が電波任せになる。
//
// ⚠合図のやりとりは、呼び出し側から渡す「窓口(room)」越しに行う。
//   こうしておくと Firestore に縛られず、試験でもニセの窓口で確かめられる。
//   room = {
//     get(): Promise<部屋>          いまの中身
//     patch(obj): Promise<void>     書き足す
//     addIce(side, cand): Promise   経路の候補を足す ('offer' | 'answer')
//     watch(cb): () => void         変わったら cb(部屋)。戻り値で購読をやめる
//   }
//
// ⚠繋がらない時に「接続中…」のまま放置しない。必ず言い切って理由の見当を出す。
// ============================================================================

import { CONNECT_TIMEOUT_SEC, linkStateText, asList } from './domain/liveSession.js';

/**
 * 経路探し(STUN)。⚠映像はここを通らない。住所を知るためだけ。
 * 同じWi-Fiの中なら、これが使えなくても繋がることが多い(端末の直の住所で足りるため)。
 */
export const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

const mkPc = () => new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });

/**
 * 🚚 **中継で送る絵の長辺の上限**。⚠録画はこの上限を受けない(1920x1080のまま録る)。
 *
 * ⚠⚠ 清水さん(2026-08-16)「今まではWiFiは遅くて4Gとかは良かったのに、今は両方かくかくする」。
 *   2026-08-14 `eb31825` で撮る時の希望を 1280x720 → 1920x1080 に上げた(横向き対応のついで)。
 *   画素数が **2.25倍**。スマホ1台が同時に4つ(WebRTCの符号化・録画の符号化・
 *   0.5秒ごとのJPEG・自分のプレビュー)を回すので、符号化が追いつかなくなる。
 *   → **中継だけ**を 1280 までに縮める。録画は元の 1920x1080 のまま。
 *   ⚠録画と中継は **同じ1本のカメラ映像**を使っている。カメラ側を下げると録画も下がる。
 *     だから下げるのは「送り手(sender)」の側だけ。
 */
export const RELAY_MAX_W = 1280;

/** 何分の1に縮めて送るか。⚠1未満にしない(引き伸ばして送っても綺麗にはならない)。 */
export const relayScaleOf = (w, maxW = RELAY_MAX_W) => {
  const width = Number(w) || 0;
  const max = Number(maxW) || RELAY_MAX_W;
  if (!(width > 0) || !(max > 0) || width <= max) return 1;
  return Math.round((width / max) * 100) / 100;
};

/**
 * 🚚 中継だけを軽くする。⚠**録画には一切さわらない**。
 *   ① 送る絵を長辺 1280 までに縮める（符号化の重さが 2.25倍 → 1倍）
 *   ② 苦しい時は **コマ数ではなく絵の細かさ** から落とす
 *      ⚠⚠ 既定は "balanced" で、**コマ数から落ちる** = これが「カクカク」の見え方。
 *        画角合わせに要るのは「動きが分かる事」なので、粗くなる方がまだ良い。
 * ⚠対応していないブラウザでは黙って何も起きない(押しても動かない物を作らない)。
 * @returns 実際に入った設定(測るため)
 */
export const tuneRelay = async (pc, maxW = RELAY_MAX_W) => {
  const out = [];
  for (const sender of (pc && pc.getSenders ? pc.getSenders() : [])) {
    const track = sender.track;
    if (!track || track.kind !== 'video') continue;
    try {
      const w = (track.getSettings && track.getSettings().width) || 0;
      const scale = relayScaleOf(w, maxW);
      const prm = sender.getParameters();
      // ⚠⚠ **枠の数を変えない**。getParameters が返した物をそのまま直して返す決まりで、
      //   数を変えると InvalidModificationError で丸ごと効かなくなる。
      if (prm.encodings && prm.encodings[0]) prm.encodings[0].scaleResolutionDownBy = scale;
      prm.degradationPreference = 'maintain-framerate';
      await sender.setParameters(prm);
      out.push({ w, scale });
    } catch (e) { console.warn('[live] 中継の重さを調整できません:', e?.message || e); }
  }
  return out;
};

/**
 * 📊 いま本当に何コマ届いているか。⚠**推測でなく実測を画面に出す**ため。
 *   次に「カクカクする」と言われた時、fps と 絵の大きさ と 理由(電波かCPUか)が
 *   その場で分かる。分からないと、また丸1日かけて当てものをする事になる。
 * @param kind 'inbound'(見る側) | 'outbound'(撮る側)
 */
export const liveStatsOf = async (pc, kind = 'inbound') => {
  try {
    if (!pc || typeof pc.getStats !== 'function') return null;
    const st = await pc.getStats();
    let out = null;
    st.forEach((r) => {
      if (r.type !== `${kind}-rtp` || r.kind !== 'video') return;
      out = {
        fps: Math.round(Number(r.framesPerSecond) || 0),
        w: Number(r.frameWidth) || 0,
        h: Number(r.frameHeight) || 0,
        reason: String(r.qualityLimitationReason || ''),
      };
    });
    return out;
  } catch { return null; }
};

/** 実測の言い方。⚠数字だけ出しても現場は判断できないので、理由を日本語にする。 */
export const liveStatsText = (s) => {
  if (!s || !(s.fps >= 0) || !s.w) return '';
  const why = s.reason === 'cpu' ? '（スマホが重いので粗くしています）'
    : s.reason === 'bandwidth' ? '（電波が細いので粗くしています）'
      : s.reason === 'other' ? '（回線の都合で粗くしています）' : '';
  return `${s.fps}コマ/秒・${s.w}x${s.h}${why}`;
};

/** 相手の経路候補を足す。⚠まだ相手の言い分を受け取っていない間は貯めておく。 */
const iceQueue = (pc) => {
  const waiting = [];
  let ready = false;
  return {
    async add(cand) {
      if (!cand) return;
      if (!ready) { waiting.push(cand); return; }
      try { await pc.addIceCandidate(cand); } catch (e) { console.warn('[live] 経路を足せません:', e?.message || e); }
    },
    async flush() {
      ready = true;
      while (waiting.length) {
        const c = waiting.shift();
        try { await pc.addIceCandidate(c); } catch (e) { console.warn('[live] 経路を足せません:', e?.message || e); }
      }
    },
  };
};

const watchState = (pc, onState) => {
  const say = () => {
    const st = pc.connectionState === 'failed' || pc.iceConnectionState === 'failed'
      ? 'failed' : (pc.connectionState || pc.iceConnectionState);
    if (onState) onState(st, linkStateText(st));
  };
  pc.onconnectionstatechange = say;
  pc.oniceconnectionstatechange = say;
  say();
};

/**
 * 👀 見る側(PC)。部屋を開いて、相手の映像を待つ。
 *
 * ⚠⚠ `gen`(何回目の繋ぎ直しか) を必ず一緒に書く。
 *   「🔄つなぎ直す」を押すと **新しい繋ぎ先(pc)** を作るので、部屋に残っている
 *   **前の返事** をそのまま受け取ると、経路の合言葉が食い違って一生繋がらない。
 *   → 申し出に番号を付け、**同じ番号の返事だけ**受け取る。
 * @returns {{ stop, pc }}
 */
export const startViewer = async ({ room, onStream, onState, onRoom = null, gen = 0 }) => {
  const pc = mkPc();
  const q = iceQueue(pc);
  let stopped = false;
  const un = [];

  // ⚠受け取り専用で口を開けておく。開けてから offer を作らないと、映像の口が無い offer になる。
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (e) => { if (onStream && e.streams && e.streams[0]) onStream(e.streams[0]); };
  pc.onicecandidate = (e) => { if (e.candidate) room.addIce('offer', e.candidate.toJSON()).catch(() => {}); };
  watchState(pc, onState);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await room.patch({ offer: { type: offer.type, sdp: offer.sdp }, offerGen: gen });

  let answered = false;
  let sawRoom = false;
  const seen = new Set();
  un.push(room.watch(async (r) => {
    if (stopped) return;
    // ⚠⚠ **部屋が消えたことも知らせる。** 知らせずに捨てていたので、見る側(PC)は
    //   最後に見た姿のまま残り、録画中に部屋が消えると「● 録画中」の赤札が
    //   出っぱなしで秒だけ伸び続けていた(2026-08-15 実測)。
    //   作業者は録れていると思って作業を続け、あとでPCから止められないと分かる。
    //   ⚠一度も部屋を見ていない時の null は「まだ届いていない」だけなので流さない。
    if (!r) { if (sawRoom && onRoom) onRoom(null); return; }
    sawRoom = true;
    if (onRoom) onRoom(r);
    // ⚠⚠ **自分の申し出への返事だけ**受け取る。繋ぎ直した時、部屋には前の返事が
    //   残ったままなので、番号を見ないと古い返事を掴んで繋がらなくなる。
    if (!answered && r.answer && r.answer.sdp && Number(r.answerGen || 0) === Number(gen || 0)) {
      answered = true;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(r.answer));
        await q.flush();
      } catch (e) { console.warn('[live] 相手の言い分を受け取れません:', e?.message || e); }
    }
    for (const c of asList(r.answerIce)) {
      const k = JSON.stringify(c);
      if (seen.has(k)) continue;
      seen.add(k);
      q.add(c);
    }
  }));

  // ⚠つながらないまま放置しない
  const timer = setTimeout(() => {
    if (stopped) return;
    if (pc.connectionState !== 'connected' && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') {
      if (onState) onState('failed', linkStateText('failed'));
    }
  }, CONNECT_TIMEOUT_SEC * 1000);

  return {
    pc,
    stop() {
      stopped = true;
      clearTimeout(timer);
      un.forEach(f => { try { f(); } catch { /* noop */ } });
      try { pc.close(); } catch { /* noop */ }
    },
  };
};

/**
 * 🎥 撮る側(スマホ)。カメラを開いて、見る側へ流す。
 * ⚠録画そのものはこの端末で行う(この関数は「見せる」だけ)。
 *
 * ⚠⚠ PCから「🔄つなぎ直す」を押されたら、**繋ぎ先(pc)だけ作り直す**。
 *   カメラは開き直さない。開き直すと **録画中の映像がそこで切れる**(撮り直しになる)。
 * @returns {{ stop, pc, stream }}
 */
export const startCamera = async ({ room, onState, facing = 'environment', onRoom = null }) => {
  // ⚠背面カメラを既定に。手元を撮るのに内カメラが起動すると、その場で撮影が止まる。
  // ⚠⚠ 横向き(landscape)で撮れるようにする。
  //   清水さん(2026-08-14 実機)「スマホを横にして撮るときの機能がなかった」。
  //   スマホは既定で縦のまま来るので、**横長を希望**として渡す。対応していない端末では
  //   ideal なので黙って無視される(エラーにしない)。
  // ⚠⚠ ここを 720p に戻さない。**録画される絵はこの大きさ**で、手本動画の画質そのもの。
  //   中継が重いのは中継側だけ縮める(tuneRelay)。カメラを下げると録画まで下がる。
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1920 }, height: { ideal: 1080 },
      aspectRatio: { ideal: 16 / 9 },
    },
    audio: true,
  });
  let pc = null;
  let q = null;
  let stopped = false;
  let answered = false;
  const un = [];
  const seen = new Set();

  // ⚠繋ぎ先を作る/作り直す。**カメラ(stream)はそのまま使い回す**。
  const build = () => {
    try { pc?.close(); } catch { /* noop */ }
    seen.clear();
    pc = mkPc();
    q = iceQueue(pc);
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = (e) => { if (e.candidate) room.addIce('answer', e.candidate.toJSON()).catch(() => { /* noop */ }); };
    watchState(pc, onState);
    // 🚚 中継だけ軽くする(録画は 1920x1080 のまま)。⚠口が出来た直後にも一度入れておく。
    tuneRelay(pc).catch(() => { /* 対応していない端末では黙って何もしない */ });
  };
  build();

  let handledGen = null;
  un.push(room.watch(async (r) => {
    if (stopped || !r) return;
    if (onRoom) onRoom(r);
    const gen = Number(r.offerGen || 0);
    if (r.offer && r.offer.sdp && handledGen !== gen) {
      handledGen = gen;
      // ⚠⚠ 2回目以降(=PCが「🔄つなぎ直す」を押した)は **繋ぎ先を作り直す**。
      //   使い終わった繋ぎ先に新しい申し出を入れても、経路の合言葉が食い違って繋がらない。
      if (answered) build();
      answered = true;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(r.offer));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        // 🚚 **ここが本番**。口が決まった後でないと、縮める指示の入れ物(encodings)が無い。
        await tuneRelay(pc);
        await room.patch({ answer: { type: ans.type, sdp: ans.sdp }, answerGen: gen, camReady: true });
        await q.flush();
      } catch (e) {
        console.warn('[live] つなぎ返せません:', e?.message || e);
        if (onState) onState('failed', linkStateText('failed'));
      }
    }
    for (const c of asList(r.offerIce)) {
      const k = JSON.stringify(c);
      if (seen.has(k)) continue;
      seen.add(k);
      q.add(c);
    }
  }));

  return {
    // ⚠作り直すので、**その時いる方**を返す(掴んだままにすると閉じた物を測る事になる)
    get pc() { return pc; },
    stream,
    stop() {
      stopped = true;
      un.forEach(f => { try { f(); } catch { /* noop */ } });
      try { stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
      try { pc?.close(); } catch { /* noop */ }
    },
  };
};

/**
 * 🔍 カメラの拡大(ズーム)。⚠**端末が対応している時だけ**使う。
 *   清水さん(2026-08-14 実機)「拡大や縮小が操作できなかった」。
 *
 * ⚠⚠ ここで返すのは「デジタルではなくカメラ本体のズーム」。対応していない端末では
 *   `zoom` の欄そのものが無いので、**つまみを出してはいけない**
 *   (押しても何も起きないつまみを作らない)。
 * @returns {min,max,step,value} 対応していなければ null
 */
export const zoomRangeOf = (stream) => {
  try {
    const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== 'function') return null;
    const cap = track.getCapabilities();
    if (!cap || cap.zoom == null) return null;
    const st = (typeof track.getSettings === 'function' ? track.getSettings() : {}) || {};
    return {
      min: Number(cap.zoom.min ?? 1),
      max: Number(cap.zoom.max ?? 1),
      step: Number(cap.zoom.step ?? 0.1) || 0.1,
      value: Number(st.zoom ?? cap.zoom.min ?? 1),
    };
  } catch { return null; }
};

/** 🔍 拡大を変える。⚠失敗しても画面を止めない(その端末が対応していないだけ)。 */
export const setZoom = async (stream, v) => {
  try {
    const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== 'function') return false;
    await track.applyConstraints({ advanced: [{ zoom: Number(v) }] });
    return true;
  } catch (e) { console.warn('[live] 拡大を変えられません:', e?.message || e); return false; }
};

/** この端末で WebRTC が使えるか。⚠使えない端末に「つなぎます」と言わない。 */
export const hasLive = () => typeof window !== 'undefined'
  && typeof window.RTCPeerConnection === 'function'
  && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
