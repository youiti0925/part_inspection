// 🧺 取り込んだ束が「機械グループの負荷」の計算に足りているか(足りないと分かる時だけ言う)
// 目的: 到着予想用の束(変換スクリプトの --mode orders = 検査が未完了の指図だけ)を機械グループに入れると、
//   検査より前に止まっていない指図(検査がまだ先でも未完了の物だけでなく、検査が済・検査の無い指図)の機械工程が束に無く、負荷が過小に出る。黙って小さい数字を出さない。
// 分かる条件(推測しない・数えられる事実だけ):
//   ① 未完了の機械工程が 1 つも無い(= 検査の行だけの束)
//   ② 未完了の指図が 10 件以上あり、その全部が「未完了の検査工程を持つ指図」(= orders の束の形。open の束には 検査が済・検査の無い指図が混ざる)
// 分からない物(束の外にある指図を数える方法は無い)は 言わない。
// 入力: orders(buildOrders / scheduleOrders の結果)  出力: { short:false } か { short:true, why:'no-machine'|'inspect-only-orders', openOrders, text }
// 触る外の物: なし
const MIN_ORDERS = 10;

export function machineBundleCheck(orders) {
    const open = (orders || []).filter((o) => (o.stages || []).some((s) => s.status !== 'done'));
    if (!open.length) return { short: false };
    let machineOpen = 0;
    for (const o of open) for (const s of o.stages) if (s.kind === 'machine' && s.status !== 'done') machineOpen++;
    if (machineOpen === 0) {
        return { short: true, why: 'no-machine', openOrders: open.length, text: 'この束は 機械グループの負荷が足りません: 終わっていない機械の工程が 1 つも入っていません(検査の行だけの束です)。機械グループには、終わっていない指図を全部入れた束(変換スクリプトの --mode open)を選んでください。' };
    }
    const allHaveOpenInspect = open.every((o) => o.stages.some((s) => s.kind === 'inspect' && s.status !== 'done'));
    if (open.length >= MIN_ORDERS && allHaveOpenInspect) {
        return { short: true, why: 'inspect-only-orders', openOrders: open.length, text: `この束は 機械グループの負荷が足りません: 入っている指図 ${open.length} 件が 全部「検査がまだ済んでいない指図」です(いつ来るか 用の束)。検査が済んだ指図・検査の無い指図の機械工程が入っていないので、負荷は 実際より小さく出ます。機械グループには、終わっていない指図を全部入れた束(変換スクリプトの --mode open)を選んでください。` };
    }
    return { short: false };
}
