import { useEffect, useMemo, useRef, useState } from 'react';
import { makeSharedPlanStore } from '../../domain/planControl/sharedPlanStore.js';
import { assignmentsFromPlan } from '../../domain/planControl/fieldOrders.js';

/* 👷 2026-09-22 採用中の版を棚から読み、head を購読するフック(帯 FieldPlanStrip と別ファイル: 部品だけのファイルにする決まり)。 */
/** 親が使う: 採用中の版の割付と、その版の番号。planShelf が無い画面では null(今の試算のまま)。 */
export function useAdoptedPlan({ planShelf, app }) {
  const store = useMemo(() => (planShelf ? makeSharedPlanStore({ ...planShelf, appId: app }) : null), [planShelf, app]);
  const [head, setHead] = useState(null);          // 棚の head(購読)
  const [plan, setPlan] = useState(null);          // 表示している版の本体
  const [prev, setPrev] = useState(null);          // 1つ前の版(変更の比較用)
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);             // 「読み直す」
  const wantRead = useRef(true);                   // 🚨 初回と「読み直す」を押した直後だけ真。読んだら偽に戻す(tick===0 では一度押すと二度と止まらない)
  useEffect(() => {
    if (!planShelf || typeof planShelf.watchHead !== 'function') return undefined;
    const off = planShelf.watchHead((doc) => setHead(doc || null), (e) => setError(e && e.message ? e.message : String(e)));
    return () => { if (typeof off === 'function') off(); };
  }, [planShelf]);
  const headRevision = head ? (Number(head.revision) || 0) : 0;
  useEffect(() => {
    if (!store) return undefined;
    let active = true;
    if (headRevision === 0) { setPlan(null); setPrev(null); setReview(null); return undefined; }
    // 🚨 表示中の版があるなら勝手に差し替えない(札で伝える)。初回と「読み直す」の時だけ読む
    if (plan && plan.revision && !wantRead.current) return undefined;
    wantRead.current = false;
    (async () => {
      try {
        const p = await store.read(app);
        if (!active) return;
        setPlan(p);
        setReview(p ? await store.readReview(app, p.revision) : null);
        setPrev(p && p.revision > 1 ? await store.readRevision(app, p.revision - 1) : null);
        setError('');
      } catch (e) { if (active) setError(e.message); }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, app, headRevision, tick]);
  const assignments = useMemo(() => (plan ? assignmentsFromPlan(plan) : null), [plan]);
  return { plan, prev, review, assignments, headRevision, error, reload: () => { wantRead.current = true; setTick((n) => n + 1); } };
}

