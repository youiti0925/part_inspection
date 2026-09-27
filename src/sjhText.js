// 「状況→対処→判断」の型(製品 App.jsx の SJH_TEMPLATE・sjhInsert と同じ中身)。
export const SJH_TEMPLATE = '状況: \n対処: \n判断: ';
export const sjhInsert = (v) => (v && v.includes('状況:')) ? v : (SJH_TEMPLATE.slice(0, 4) + (v || '') + SJH_TEMPLATE.slice(4));
