// 🏯 「最上位司令塔へ載せる」(機械グループの画面の上に置く1行)
// 目的: SAP の表を読んだ管理者が、押した時だけ 機械の集計(グループ名×週の%と件数)を 最上位司令塔の置き場 1件へ載せる(どの端末でも機械の札を見られる様にする)
// 入力: cap(この画面と同じ capacityGroups の答え)・handoffs・基準日・sortRows(未完了の行の数え)・basis(この画面の設定)・onPublish(digest)=書く窓口・canPublish(管理者か)
// 出力: 画面の1行(ボタン+何を載せるかの説明+結果)。計算はしない(machineDigest.js が画面の答えを写すだけ)
// 呼ぶ人: MachineGroupView.jsx(topPublish が渡された時だけ)
// 触る外の物: 押した時だけ onPublish 経由で overview-app-v1/top_status/machine の1件(自動では書かない・開いただけでは何もしない)
// 確かめ方: node scripts/verify-top-machine-emulator.mjs(本物の Firestore エミュレータ)・画面の写しは ③ の docs/最上位司令塔_朝の画面_1126
import { useState } from 'react';
import { buildMachineDigest } from './domain/machineDigest.js';
import { summarizeSort } from './domain/sapSortStore.js';
import { getActiveSapSort } from './domain/sapSort.js';

const hm = (ms) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

export default function TopPublishBar({ cap, handoffs, todayIso, sortRows, basis, onPublish, canPublish }) {
    const [busy, setBusy] = useState(false);
    const [res, setRes] = useState(null);   // { ok, text }
    const click = async () => {
        if (busy) return;
        setBusy(true); setRes(null);
        try {
            const reg = getActiveSapSort();
            const digest = buildMachineDigest({ cap, handoffs, todayIso, builtAtMs: Date.now(), reg, sortSummary: summarizeSort(sortRows || [], reg), basis });
            const r = await onPublish(digest);
            const over = digest.groups.filter((g) => g.status === 'over').length, tight = digest.groups.filter((g) => g.status === 'tight').length;
            setRes({ ok: true, text: `${hm(digest.builtAt)} に載せました(${Math.max(1, Math.round(r.bytes / 1024))}KB・グループ ${digest.groups.length}・あふれる ${over}・ぎりぎり ${tight}・今日終わる見込み ${digest.today.finishToday}・終わった ${digest.today.doneToday})` });
        } catch (e) { setRes({ ok: false, text: `載せられませんでした: ${e && e.message ? e.message : e}` }); }
        setBusy(false);
    };
    return (
        <div className="my-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm" data-testid="top-publish">
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={click} disabled={!canPublish || busy} className={`min-h-9 rounded-lg px-3 font-black ${canPublish && !busy ? 'bg-indigo-600 text-white' : 'bg-slate-300 text-slate-500'}`} data-testid="top-publish-btn">{busy ? '載せています…' : '最上位司令塔へ載せる'}</button>
                <span className="text-xs text-slate-700">{canPublish ? 'この画面の数字を、最上位司令塔の機械の札へ載せます(押した時の1回だけ書きます・自動では書きません)。' : '載せられるのは管理者の人だけです(ヘッダー左上で「管理者」を選んでください)。'}</span>
            </div>
            <p className="mt-1 text-xs text-slate-600">載せる物: グループの名前・週ごとの%・持ち越しの時間と件数・あふれる/ぎりぎりの判定・今日終わる見込み/終わったの件数・まだ仕分けていない作業区の番号と件数。<b>指図番号・品目・客先・金額・作業者名は載せません。</b></p>
            {res ? <p className={`mt-1 text-xs font-bold ${res.ok ? 'text-emerald-700' : 'text-rose-700'}`} role="status" data-testid="top-publish-res">{res.text}</p> : null}
        </div>
    );
}
