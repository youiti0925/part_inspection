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
  const backend = createPocketbaseBackend(client, {
    owner: cfg.owner || '',
    onPendingChange: cfg.onPendingChange,
    onConflict: cfg.onConflict,
  });

  // ログイン。⚠失敗しても黙って続けない(読み書きが全部落ちる理由が分からなくなる)。
  if (cfg.email && cfg.password) {
    client.authUser(cfg.email, cfg.password, cfg.authCollection || 'device_users')
      .catch((e) => {
        console.error('[pb] ログインできませんでした。読み書きはできません。', e?.message || e);
        if (cfg.onAuthError) cfg.onAuthError(e);
      });
  } else {
    console.warn('[pb] 端末用アカウントが設定されていません(設定の pocketbase を確認してください)');
  }

  _byUrl.set(url, backend);
  return backend;
});

export const closeAllPocketbase = () => {
  for (const b of _byUrl.values()) { try { b.close(); } catch { /* 閉じられなくても進む */ } }
  _byUrl.clear();
};
