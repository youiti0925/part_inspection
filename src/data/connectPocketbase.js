// ============================================================================
// PocketBase の保管庫を窓口に差し込む(1行 import するだけ)
// ----------------------------------------------------------------------------
// 使い方(アプリの入口で1回):
//   import './data/connectPocketbase.js';
//
// ⚠これを読み込んでも **保管庫は切り替わりません**。
//   切り替わるのは routes.js の providers が 'pocketbase' を指した時だけ。
//   つまり「差し替えられる状態にしておく」だけで、今の動きは1バイトも変わらない。
//
// ⚠管理者(superuser)の資格情報をブラウザへ渡さないこと。端末用の普通のアカウントを使う。
// ============================================================================

import { registerPocketbaseFactory } from './provider.js';
import { createPbClient } from './pbClient.js';
import { createPocketbaseBackend } from './pocketbaseBackend.js';

/** url ごとに1つだけ作って使い回す(毎回作ると購読が張り直される)。 */
const _byUrl = new Map();

registerPocketbaseFactory((cfg) => {
  const url = String(cfg?.url || '').replace(/\/+$/, '');
  if (!url) throw new Error('PocketBase の接続先(url)がありません');
  const hit = _byUrl.get(url);
  if (hit) return hit;

  const client = createPbClient({ url });

  // ⚠⚠ **ログインを先に登録してから保管庫を作る。**
  //   ログインを投げっぱなしにすると、起動直後の読み出しが未ログインのまま走る。
  //   PocketBase の listRule は絞り込みとして効くので、そのときの返事は
  //   403 ではなく **200 + 0件**。つまり「まだ入れていない」と「データが無い」が
  //   区別できず、**画面が黙って空になる**(実測 2026-07-27: 139件あるのに0件)。
  //   setReady に渡すと、以後のリクエストは全部この後ろに並ぶ。
  if (cfg.email && cfg.password) {
    client.setReady(
      client.authUser(cfg.email, cfg.password, cfg.authCollection || 'device_users')
        .catch((e) => {
          // ⚠握り潰さない。ただしここで投げっぱなしにすると未処理の拒否になるので、
          //   知らせてから収める。**入れていない事実は isAuthed() が false で残る**ので、
          //   読み出し側は「0件」ではなく理由付きのエラーになる。
          console.error('[pb] ログインできませんでした。読み書きはできません。', e?.message || e);
          if (cfg.onAuthError) cfg.onAuthError(e);
        })
    );
  } else {
    console.warn('[pb] 端末用アカウントが設定されていません(設定の pocketbase を確認してください)');
  }

  const backend = createPocketbaseBackend(client, {
    owner: cfg.owner || '',
    onPendingChange: cfg.onPendingChange,
    onConflict: cfg.onConflict,
  });

  _byUrl.set(url, backend);
  return backend;
});

export const closeAllPocketbase = () => {
  for (const b of _byUrl.values()) { try { b.close(); } catch { /* 閉じられなくても進む */ } }
  _byUrl.clear();
};
