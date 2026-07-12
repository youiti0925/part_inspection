// PocketBase 移行インポータ
//   検査アプリ(製品/部品/最終)の「PocketBase移行用」エクスポートJSONを PocketBase に取り込む。
//   設計: setup_db_v3.mjs と同じ「1コレクション = appData(json) に丸ごと格納」方式 + fbId(元のFirestore doc id) で冪等 upsert。
//   → データを一切落とさず PocketBase に移せる“お守り”。あとから型付きスキーマへ発展可能。
//
// 前提: Node 18+ / `npm i pocketbase` / PocketBase を起動し管理者(_superusers)を作成済み。
//
// 使い方:
//   node pb_import.mjs --export "pocketbase移行_製品検査_2026-06-29.json" --email admin@example.com --password ****
//   （複数アプリ分を1つのPBへ: 既定で appDataId ごとに名前空間化されるので衝突しません）
//   オプション:
//     --url      PocketBase URL          (既定 http://127.0.0.1:8090 / 環境変数 PB_URL)
//     --email    管理者メール             (環境変数 PB_ADMIN_EMAIL)
//     --password 管理者パスワード         (環境変数 PB_ADMIN_PASSWORD)
//     --prefix   コレクション名の接頭辞    (既定=appDataIdから自動。 --prefix "" で接頭辞なし=単一アプリ用)
//     --dry      作成/書込をせず計画だけ表示(ドライラン)
//
// 取り込み後: PocketBase の各レコードは { fbId, appData } 形式。appData に元のドキュメント全体が入っています。

import PocketBase from 'pocketbase';
import { readFileSync } from 'node:fs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : def;
}

const PB_URL = arg('--url', process.env.PB_URL || 'http://127.0.0.1:8090');
const EXPORT_FILE = arg('--export', null);
const ADMIN_EMAIL = arg('--email', process.env.PB_ADMIN_EMAIL || null);
const ADMIN_PASSWORD = arg('--password', process.env.PB_ADMIN_PASSWORD || null);
const PREFIX_OPT = process.argv.includes('--prefix') ? arg('--prefix', '') : null; // null=自動
const DRY = process.argv.includes('--dry');

if (!EXPORT_FILE || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.log(`PocketBase 移行インポータ
使い方:
  node pb_import.mjs --export <pocketbase移行_*.json> --email <admin> --password <pass> [--url http://127.0.0.1:8090] [--prefix ""] [--dry]

  --export   検査アプリで出力した「PocketBase移行用」JSON (必須)
  --email    PocketBase 管理者メール (必須 / 環境変数 PB_ADMIN_EMAIL)
  --password PocketBase 管理者パスワード (必須 / 環境変数 PB_ADMIN_PASSWORD)
  --url      PocketBase URL (既定 http://127.0.0.1:8090)
  --prefix   コレクション名の接頭辞 (既定=appDataIdから自動で名前空間化)
  --dry      ドライラン(作成/書込なし)`);
  process.exit(1);
}

// PBのコレクション名は英数字と_のみ・先頭は英字。Firestoreの appDataId(例: product-inspection-v1)を安全化。
const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([^a-zA-Z])/, 'c$1');

const client = new PocketBase(PB_URL);
client.autoCancellation(false);

async function ensureCollection(name) {
  try {
    await client.collections.getOne(name);
    return; // 既存ならそのまま使う(壊さない)
  } catch (e) { /* 無ければ作る */ }
  if (DRY) { console.log(`   [dry] would create collection '${name}' (fbId text + appData json)`); return; }
  await client.collections.create({
    name,
    type: 'base',
    fields: [
      { name: 'fbId', type: 'text', required: false },
      { name: 'appData', type: 'json', required: false, options: { maxSize: 5000000 } },
    ],
    // 移行直後は読み書きを管理者のみに(空ルール=APIルール未設定=管理者のみ)。運用に合わせて後で緩める。
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
  });
  // fbId に一意インデックス(冪等 upsert を速く・安全に)
  try {
    const col = await client.collections.getOne(name);
    await client.collections.update(col.id, { indexes: [`CREATE UNIQUE INDEX idx_${name}_fbId ON ${name} (fbId)`] });
  } catch (e) { /* インデックスは必須ではない(無くても動く) */ }
  console.log(`   ✅ created '${name}'`);
}

async function upsert(name, fbId, appData) {
  if (DRY) return 'dry';
  let existing = null;
  try {
    existing = await client.collection(name).getFirstListItem(client.filter('fbId = {:id}', { id: fbId }));
  } catch (e) { existing = null; }
  if (existing) { await client.collection(name).update(existing.id, { fbId, appData }); return 'updated'; }
  await client.collection(name).create({ fbId, appData }); return 'created';
}

async function main() {
  const raw = JSON.parse(readFileSync(EXPORT_FILE, 'utf8'));
  if (!raw || !raw.collections) { console.error('❌ これは検査アプリの PocketBase移行用JSON ではありません(collections が見つからない)。'); process.exit(1); }

  const appDataId = raw.appDataId || raw.app || 'app';
  const prefix = PREFIX_OPT !== null ? PREFIX_OPT : (sanitize(appDataId) + '_');
  console.log(`\n=== PocketBase 移行インポート ===`);
  console.log(`  PB: ${PB_URL}`);
  console.log(`  元: ${raw.app || '?'} / appDataId=${appDataId} / exportedAt=${raw.exportedAt || '?'}`);
  console.log(`  コレクション接頭辞: '${prefix}'${PREFIX_OPT === '' ? ' (接頭辞なし指定)' : ''}`);
  if (DRY) console.log('  ※ ドライラン: 実際の作成/書込はしません');

  console.log('\n1. 管理者認証...');
  await client.collection('_superusers').authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('   OK');

  const summary = [];
  for (const [col, records] of Object.entries(raw.collections)) {
    const arr = Array.isArray(records) ? records : [];
    const pbName = sanitize(prefix + col);
    console.log(`\n--- ${col} → '${pbName}' (${arr.length}件) ---`);
    await ensureCollection(pbName);
    let created = 0, updated = 0, failed = 0;
    for (const rec of arr) {
      const fbId = (rec && (rec.id != null)) ? String(rec.id) : `auto_${created + updated + failed}`;
      try {
        const r = await upsert(pbName, fbId, rec);
        if (r === 'created') created++; else if (r === 'updated') updated++;
      } catch (e) {
        failed++;
        console.error(`   ! ${fbId}: ${e && (e.message || e)}`);
      }
    }
    console.log(`   作成${created} / 更新${updated} / 失敗${failed}`);
    summary.push({ col, pbName, total: arr.length, created, updated, failed });
  }

  console.log('\n=== 完了サマリ ===');
  for (const s of summary) console.log(`  ${s.pbName}: 合計${s.total} (作成${s.created}/更新${s.updated}/失敗${s.failed})`);
  const totalFailed = summary.reduce((a, s) => a + s.failed, 0);
  if (totalFailed > 0) { console.log(`\n⚠ 失敗 ${totalFailed} 件あり。上のエラーを確認してください。`); process.exit(2); }
  console.log('\n🎉 全コレクションの取り込みが完了しました。PocketBase の各レコードは { fbId, appData } 形式です。');
}

main().catch((e) => { console.error('❌ 取り込み失敗:', (e && (e.response || e.message)) || e); process.exit(1); });
