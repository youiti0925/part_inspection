// ============================================================================
// 📱 スマホのカメラをつなぐ「部屋」を、いまの保管庫(Firestore)の上に作る
// ----------------------------------------------------------------------------
// LiveCamera.jsx / liveLink.js は **保管庫を知らない**。ここが唯一のつなぎ役。
// (こうしておくと、試験ではニセの窓口を渡して机の上で確かめられる)
//
// 使う棚は2つだけ:
//   live_rooms   … つなぎ方の合図(数KBの文字)。書類ID = 合言葉
//   live_frames  … 📷コマ送りの1枚(JPEGの文字)。書類ID = 合言葉_番号
//
// ⚠⚠ **なぜ書類を分けるのか**
//   Firestore は「1つの書類に毎秒1回」が目安。0.5秒ごとに絵を送ると倍になり、
//   詰まってかえって遅れる。→ 絵は **2つの書類に交互に** 書く(1つあたり毎秒1回)。
//   合図(live_rooms)と絵(live_frames)を混ぜないのも同じ理由。
//   絵を混ぜると、合図を1文字書くたびに25KBの絵まで全端末へ流れる。
//
// ⚠⚠ **足すときは、その鍵だけ書く**(経路の候補・🚩旗)。
//   配列にして「読んで足して書く」をやると、その間に相手が足した分が消える(後勝ち)。
//   保存は merge なので、鍵つきの入れ物なら重ならない。
//
// ⚠ 使い終わったら消す。絵は1枚25KBで、消さないと部屋の数だけ残り続ける。
// ============================================================================

import { normCode, iceKey, ROOM_TTL_MIN, FRAME_SPEEDS } from './domain/liveSession.js';

export const ROOM_COL = 'live_rooms';
export const FRAME_COL = 'live_frames';

/** 絵の書類ID。⚠合言葉と番号を「_」でつなぐだけ(/ を入れると別の場所へ書く)。 */
export const frameId = (code, slot) => `${normCode(code)}_${Math.max(0, Math.round(Number(slot) || 0))}`;

/**
 * @param P   保管庫の窓口 (DATA(db))
 * @param ns  名前空間 (APP_DATA_ID)
 */
export const makeRoomApi = (P, ns) => {
  const roomId = (code) => normCode(code);
  const warn = (what) => (e) => console.warn(`[live] ${what}:`, e?.message || e);

  const api = (code) => {
    const id = roomId(code);
    return {
      get: () => P.getOne(ns, ROOM_COL, id),
      // ⚠merge で書き足す(既定が merge:true)。丸ごと上書きすると相手の分が消える。
      patch: (obj) => P.save(ns, ROOM_COL, id, obj),
      // ⚠経路の候補は **その鍵だけ**。side は 'offer'(見る側) / 'answer'(撮る側)。
      addIce: (side, cand) => P.save(ns, ROOM_COL, id, { [`${side}Ice`]: { [iceKey(cand)]: cand } }),
      watch: (cb) => P.watchDoc(ns, ROOM_COL, id, (d) => cb(d), { onError: warn('部屋を見られません') }),
    };
  };

  const frame = (code, slot) => {
    const id = frameId(code, slot);
    return {
      // ⚠絵は毎回まるごと差し替え(古い絵が残ると「新しい方」を選び間違える)
      patch: (obj) => P.save(ns, FRAME_COL, id, obj, { merge: false }),
      watch: (cb) => P.watchDoc(ns, FRAME_COL, id, (d) => cb(d), { onError: warn('コマ送りを受け取れません') }),
    };
  };

  // 速さの設定を変えると番号が増えるので、少し多めに消しておく
  // ⚠⚠ **ここを決め打ちの [0,1,2,3] にしない。** 速さの一覧に「0.2秒ごと(5枚に振り分け)」が
  //   足された時、**5枚目(_4)だけ消し忘れて残る**(1枚25KB。掃除が来るまで居座る)。
  //   → 一覧の中で **一番多い枚数** から数える。速さを足す人が、ここを直さなくてよくする。
  const SLOTS_MAX = Math.max(2, ...Object.values(FRAME_SPEEDS).map((s) => Number(s?.slots) || 1)) + 2;
  const dropFrames = (id) => Promise.all(
    Array.from({ length: SLOTS_MAX }, (_, i) => i)
      .map((i) => P.remove(ns, FRAME_COL, frameId(id, i)).catch(() => { /* 無ければそれでよい */ }))
  );

  /** 使い終わった部屋と絵を消す。⚠絵は1枚25KB。消さないと溜まり続ける。 */
  const close = async (code) => {
    const id = roomId(code);
    if (!id) return;
    // ⚠**部屋を先に消す**。撮る側はこれを見て送るのをやめる。
    await P.remove(ns, ROOM_COL, id).catch(warn('部屋を消せません'));
    await dropFrames(id);
    // ⚠消した直後に、行き違いで1枚届くことがある(送る側が気づくまでの一瞬)。
    //   親の無い絵は次の掃除まで残るので、少し待ってもう一度だけ消す。
    setTimeout(() => { dropFrames(id).catch(() => { /* 掃除で消える */ }); }, 3000);
  };

  /**
   * 古い部屋を片付ける。
   * ⚠「閉じるを押さずにタブを閉じた」時のための保険。押した人任せにしない。
   */
  const sweep = async (nowMs = Date.now()) => {
    const rows = await P.getAll(ns, ROOM_COL).catch(() => []);
    const alive = new Set();
    const dead = (rows || []).filter((r) => {
      const at = Number(r?.createdAt || 0);
      // ⚠作った時刻が無い書類も古い扱い(いつの物か分からない物を残さない)
      const old = !(at > 0) || nowMs - at > ROOM_TTL_MIN * 60 * 1000;
      if (!old && r?.id) alive.add(String(r.id));
      return old;
    });
    for (const r of dead) {
      if (!r?.id) continue;
      await close(r.id);
    }
    // ⚠⚠ **親の無い絵**も消す(2026-08-13 ハーネスで発覚)。
    //   PC側が閉じたあともスマホが送り続けると、部屋の無い絵だけが残る。
    //   部屋を見るだけの掃除では **一生消えない**(1枚25KBが積み上がる)。
    const frames = await P.getAll(ns, FRAME_COL).catch(() => []);
    let orphans = 0;
    for (const f of (frames || [])) {
      const id = String(f?.id || '');
      const owner = id.replace(/_\d+$/, '');
      if (!owner || alive.has(owner)) continue;
      orphans++;
      await P.remove(ns, FRAME_COL, id).catch(() => { /* 次の掃除で消える */ });
    }
    return dead.length + orphans;
  };

  // ⚠ `this` を使わない。画面側が { create } のように取り出して渡すと `this` が外れて落ちる。
  return {
    api,
    frame,
    close,
    sweep,
    get: (code) => P.getOne(ns, ROOM_COL, roomId(code)),

    /** 部屋を作る。⚠作り直しなので merge しない(前の合図が残っていると繋がらない)。 */
    async create(code, room) {
      await P.save(ns, ROOM_COL, roomId(code), room, { merge: false });
      // 古い部屋の後片付けは、繋ぐのを待たせないよう裏でやる
      sweep().catch(() => { /* 片付けに失敗しても、つなぐのには関係ない */ });
    },
  };
};
