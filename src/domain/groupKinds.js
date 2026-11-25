// 🧱 種類の台帳: グループの種類ごとに「何ができるか」を1つの表(データ)で持つ
// 目的: 今 ③ の GROUP_TYPES に直書きの3種類(最終・製品・部品)と、新しい「工程の仕分け」を、同じ形の表にする。種類を足す時はここへ1行足すだけ。
// 入力: なし(データだけ)・groupKindOf(id)・kindsForCommander(司令塔の種類)
// 出力: { id, label, app, hasShelf, sapField, features, defaultLabels } の表
// 触る外の物: なし。足せる組み合わせ(司令塔の種類 → 下に置ける種類)もここで決まる
// 確かめ方: node --test src/domain/__tests__/groupKinds.test.mjs
/** 画面では「検査の現場」「工程のまとまり」と別の言葉で出す(「グループ」が2つの意味で混ざらない様に・辞書で変えられる) */
export const GROUP_KINDS = Object.freeze([
    { id: 'final', label: '最終検査系', screenWord: '検査の現場', app: 'final', hasShelf: true, sapField: 'wcList', features: ['plateAi', 'accessories'], defaultLabels: null },
    { id: 'product', label: '製品検査系', screenWord: '検査の現場', app: 'product', hasShelf: true, sapField: 'wcList', features: [], defaultLabels: null },
    { id: 'parts', label: '部品検査系', screenWord: '検査の現場', app: 'parts', hasShelf: true, sapField: 'wcListNamed', features: ['sapProgress', 'machineGroupLoad'], defaultLabels: null },
    { id: 'process', label: '工程の仕分け', screenWord: '工程のまとまり', app: null, hasShelf: false, sapField: 'wcRangeAndText', features: ['countInLoad'], defaultLabels: null },
]);

/** 司令塔の種類(下に置ける グループの種類) */
export const COMMANDER_KINDS = Object.freeze([
    { id: 'inspect', label: '検査の司令塔', groupKinds: ['final', 'product', 'parts'] },
    { id: 'process', label: '工程の司令塔', groupKinds: ['process'] },
]);

export const groupKindOf = (id) => GROUP_KINDS.find((k) => k.id === id) || null;
export const kindsForCommander = (commanderKind) => {
    const c = COMMANDER_KINDS.find((x) => x.id === commanderKind);
    return c ? c.groupKinds.map(groupKindOf).filter(Boolean) : [];
};
/** SAP 工程の登録の group.type('site'/'process')→ 種類の台帳の種類。site は app で引く */
export const kindOfRegGroup = (g) => (g && g.type === 'process' ? groupKindOf('process') : g && g.app ? groupKindOf(g.app) : null);
