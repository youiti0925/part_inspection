// 🔤 辞書の最初の登録: 機械・SAP の画面の言葉の目録と、よく使う単語(約30語)・種類ごとの既定
// 目的: 辞書(labels.js)に「どの目印が、今どんな文字か」を持たせる。画面の言葉は t('目印','今の文字') で通し、この目録の text と画面の文字が1字違えば試験が赤になる。
// 入力: なし(データだけ)。他の画面は 分割が進んだ順に ここへ足す(清水さん 11-25 Q8)
// 出力: LABEL_CATALOG(目印・今の文字・どのファイルか)・COMMON_WORDS(単語の目録)・KIND_LABEL_DEFAULTS(種類ごとの既定=今は空)
// 触る外の物: なし
// 確かめ方: node --test src/domain/__tests__/labels.test.mjs
/** 画面の言葉の目録。where のファイルに `t('key', 'text')` が1字も違わず書いてある事を試験で確かめる */
export const LABEL_CATALOG = Object.freeze([
    { key: 'machine.title', text: '機械グループ 負荷', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.col.group', text: '工程(機械グループ)', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.col.wcs', text: '作業区(今週〜2週後)', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.col.note', text: '見立て・注意', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.inner.heading', text: '中の作業区', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.inner.wc', text: '作業区', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.inner.units', text: '台数', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.inner.people', text: '人数', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.inner.multi', text: '掛け持ち', where: 'src/MachineGroupView.jsx' },
    { key: 'machine.todo.heading', text: '先に片付ける候補', where: 'src/MachineGroupView.jsx' },
    { key: 'sap.title', text: 'SAP 工程の進み', where: 'src/SapProgressPanel.jsx' },
    { key: 'sap.reach', text: '① 部品検査に近い順', where: 'src/SapProgressPanel.jsx' },
    { key: 'sap.groupsLoad', text: '② 機械グループごとの負荷', where: 'src/SapProgressPanel.jsx' },
    { key: 'sap.handoff', text: '次の工程(作業区)への連絡', where: 'src/SapProgressPanel.jsx' },
]);

/** よく使う単語(画面全体に効く置き換えの候補)。辞書の words に入れると、t() を通る文字の中のこの単語が置き換わる */
export const COMMON_WORDS = Object.freeze([
    '型式', 'ロット', '指図', '作業区', '工程', '機械', '旋盤', '持ち越し', '負荷', '台数', '人数', '掛け持ち', '付帯作業', '検査', '受入検査',
    '三次元検査', '未完了', '納期', '段取り', '作業者', '計画', '実績', '手直し', '不良', '出荷', '仕様変更', '面取り洗浄', '品名', '品目コード', '稼働',
]);

/** 種類ごとの既定の辞書(今は全部空=今の文字そのまま)。種類を足す時にここへ labels/1 の形で入れる */
export const KIND_LABEL_DEFAULTS = Object.freeze({ site: null, process: null });
