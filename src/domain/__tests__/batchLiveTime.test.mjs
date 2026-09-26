// バッチ(まとめて開始)タスクのライブ経過時間 liveSecOf のテスト。
// 前提となる設計: バッチ台は duration に積まず、batchStartedAt(休憩分シフト済み)が壁時計の起点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveSecOf, rebuildBatchStartTimes, mergeRestoredBatchStartTimes } from '../batchLiveTime.js';

const T0 = 1_770_000_000_000; // 適当な基準時刻(ms)
const sec = (n) => n * 1000;

test('B01 バッチ進行中: batchStartedAt 起点で累積表示 (startTime が再開で変わっても影響しない)', () => {
    const t = { status: 'processing', duration: 0, startTime: T0 + sec(500), batchOwner: 2, batchStartedAt: T0 };
    // 再開直後(startTime=T0+500s)でも、表示は起点からの600秒
    assert.equal(liveSecOf(t, T0 + sec(600)), 600);
});

test('B02 バッチ中断中: pausedAt - batchStartedAt で凍結表示 (0 に戻らない)', () => {
    const t = { status: 'paused', duration: 0, startTime: null, batchOwner: 2, batchStartedAt: T0, pausedAt: T0 + sec(300) };
    // 中断から時間が経っても表示は300秒のまま
    assert.equal(liveSecOf(t, T0 + sec(9999)), 300);
    // 旧表示式なら duration=0 → 「⏸ 00:00」だった
    assert.notEqual(liveSecOf(t, T0 + sec(9999)), 0);
});

test('B03 再開後: batchStartedAt が休憩分シフト済みなら中断前から連続した値になる', () => {
    // 300秒作業 → 100秒休憩 → 再開(batchStartedAt を +100秒シフト、toggleBreak/個別再開の補正)
    const resumed = { status: 'processing', duration: 0, startTime: T0 + sec(400), batchOwner: 2, batchStartedAt: T0 + sec(100) };
    // 再開直後 = 中断時の300秒とつながる
    assert.equal(liveSecOf(resumed, T0 + sec(400)), 300);
    // さらに50秒後 = 350秒
    assert.equal(liveSecOf(resumed, T0 + sec(450)), 350);
});

test('B04 通常タスク: 進行中は duration + 今セッション、停止中は duration 据置 (従来式)', () => {
    const running = { status: 'processing', duration: 120, startTime: T0 };
    assert.equal(liveSecOf(running, T0 + sec(30)), 150);
    // 一時停止中(通常タスクは停止時に duration へ確定済み)
    const paused = { status: 'paused', duration: 150, startTime: null, pausedAt: T0 + sec(30) };
    assert.equal(liveSecOf(paused, T0 + sec(999)), 150);
    // waiting は 0
    assert.equal(liveSecOf({ status: 'waiting', duration: 0, startTime: null }, T0), 0);
});

test('B05 completed: duration 据置 (バッチ完了で batchStartedAt は null に戻る=従来表示と同一)', () => {
    const done = { status: 'completed', duration: 480, startTime: null, endTime: T0, batchOwner: null, batchStartedAt: null };
    assert.equal(liveSecOf(done, T0 + sec(999)), 480);
    // duration 未定義の古いデータでも NaN を出さない
    assert.equal(liveSecOf({ status: 'completed' }, T0), 0);
});

test('B06 null/undefined タスクは 0', () => {
    assert.equal(liveSecOf(null), 0);
    assert.equal(liveSecOf(undefined), 0);
});

test('B07 時計の逆行やゼロ割相当でもマイナスにならない (バッチ側は max(0,…) ガード)', () => {
    const t = { status: 'processing', duration: 10, startTime: T0, batchOwner: 0, batchStartedAt: T0 + sec(100) };
    // now が起点より前 (端末間の時計ズレ) → base のみ
    assert.equal(liveSecOf(t, T0 + sec(50)), 10);
    const p = { status: 'paused', duration: 10, batchOwner: 0, batchStartedAt: T0 + sec(100), pausedAt: T0 + sec(50) };
    assert.equal(liveSecOf(p, T0 + sec(999)), 10);
});

test('B08 バッチ台に事前作業の duration があれば起点分に上乗せ (開始前の個別作業を失わない)', () => {
    // 個別で100秒作業→一時停止→バッチに巻き込んで開始(duration=100 維持)
    const t = { status: 'processing', duration: 100, startTime: T0, batchOwner: 1, batchStartedAt: T0 };
    assert.equal(liveSecOf(t, T0 + sec(60)), 160);
});

// =============================================================================
// 作業画面を閉じて開き直したときの「まとめて開始」起点の復元 (rebuildBatchStartTimes)
// 実機再現の事故: 起点(batchStartTimes)は state にしか無く、開き直すと空 →
//   ボタンが「まとめて開始」に逆戻り → 続きから開始で batchStartedAt を now で上書き →
//   12分55秒が 00:02 になって全損。復元できれば「まとめて完了」がそのまま出る。
// =============================================================================

test('R01 開き直し: batchOwner を持つ作業中の台から起点(stepIdx→batchStartedAt)を復元する', () => {
    const tasks = {
        's3-0': { status: 'processing', duration: 0, startTime: T0, batchOwner: 3, batchStartedAt: T0 },
        's3-1': { status: 'processing', duration: 0, startTime: T0, batchOwner: 3, batchStartedAt: T0 },
        's3-2': { status: 'processing', duration: 0, startTime: T0, batchOwner: 3, batchStartedAt: T0 },
        's3-3': { status: 'processing', duration: 0, startTime: T0, batchOwner: 3, batchStartedAt: T0 },
    };
    assert.deepEqual(rebuildBatchStartTimes(tasks), { 3: T0 });
    // 起点が戻る = 12分55秒が表示され続ける (0 に戻らない)
    assert.equal(liveSecOf(tasks['s3-0'], T0 + sec(775)), 775);
});

test('R02 台ごとに batchStartedAt がズレていたら最小値を採る (個別再開でズレる)', () => {
    const tasks = {
        's1-0': { status: 'processing', batchOwner: 1, batchStartedAt: T0 + sec(120) }, // 個別再開でシフト済み
        's1-1': { status: 'paused', batchOwner: 1, batchStartedAt: T0, pausedAt: T0 + sec(300) },
        's1-2': { status: 'processing', batchOwner: 1, batchStartedAt: T0 + sec(40) },
    };
    assert.deepEqual(rebuildBatchStartTimes(tasks), { 1: T0 });
});

test('R03 中断中(paused)の台だけでも復元する (閉じる前に一時停止した場合)', () => {
    const tasks = {
        's2-0': { status: 'paused', batchOwner: 2, batchStartedAt: T0, pausedAt: T0 + sec(775) },
        's2-1': { status: 'paused', batchOwner: 2, batchStartedAt: T0, pausedAt: T0 + sec(775) },
    };
    assert.deepEqual(rebuildBatchStartTimes(tasks), { 2: T0 });
    // 中断中の表示は凍結 = 12分55秒のまま
    assert.equal(liveSecOf(tasks['s2-0'], T0 + sec(99999)), 775);
});

test('R04 完了/NG/スキップ・マーカー無しは拾わない (完了時に batchOwner を null に戻す規約)', () => {
    const tasks = {
        'done-0': { status: 'completed', duration: 193, batchOwner: null, batchStartedAt: null },
        // 万一マーカーが残っていても完了済みは起点にしない
        'stale-0': { status: 'completed', duration: 193, batchOwner: 4, batchStartedAt: T0 },
        'ng-0': { status: 'ng', batchOwner: 4, batchStartedAt: T0 },
        'skip-0': { status: 'skipped', batchOwner: 4, batchStartedAt: T0 },
        // 単独計測 (batchOwner なし) は起点を作らない
        'solo-0': { status: 'processing', startTime: T0, batchOwner: null, batchStartedAt: null },
        // 壊れた値は無視 (NaN を state に入れない)
        'bad-0': { status: 'processing', batchOwner: 5, batchStartedAt: NaN },
    };
    assert.deepEqual(rebuildBatchStartTimes(tasks), {});
});

test('R05 複数工程が同時にバッチ計測中でも工程ごとに復元する / 空・不正入力は {}', () => {
    const tasks = {
        's0-0': { status: 'processing', batchOwner: 0, batchStartedAt: T0 },
        's7-0': { status: 'processing', batchOwner: 7, batchStartedAt: T0 + sec(600) },
    };
    assert.deepEqual(rebuildBatchStartTimes(tasks), { 0: T0, 7: T0 + sec(600) });
    assert.deepEqual(rebuildBatchStartTimes({}), {});
    assert.deepEqual(rebuildBatchStartTimes(null), {});
    assert.deepEqual(rebuildBatchStartTimes(undefined), {});
});

test('R06 合成: 既にある起点は上書きしない (画面側の休憩シフト済みの値が正)', () => {
    const prev = { 3: T0 + sec(100) }; // 休憩分シフト済み
    const restored = { 3: T0, 5: T0 + sec(50) };
    assert.deepEqual(mergeRestoredBatchStartTimes(prev, restored), { 3: T0 + sec(100), 5: T0 + sec(50) });
});

test('R07 合成: 足すものが無ければ同一参照を返す (再描画ループを起こさない)', () => {
    const prev = { 3: T0 };
    assert.equal(mergeRestoredBatchStartTimes(prev, { 3: T0 + sec(999) }), prev);
    assert.equal(mergeRestoredBatchStartTimes(prev, {}), prev);
    assert.equal(mergeRestoredBatchStartTimes(prev, null), prev);
    // prev が空でも復元があれば新しいオブジェクトを返す
    assert.deepEqual(mergeRestoredBatchStartTimes({}, { 1: T0 }), { 1: T0 });
    assert.deepEqual(mergeRestoredBatchStartTimes(null, { 1: T0 }), { 1: T0 });
});

test('R08 復元シナリオ通し: 中断中の台を batchStartedAt シフトで再開すると表示が連続する', () => {
    // 12分55秒(775秒)まとめて計測 → 一時停止して画面を閉じる
    const closedAt = T0 + sec(775);
    const paused = { status: 'paused', duration: 0, startTime: null, batchOwner: 3, batchStartedAt: T0, pausedAt: closedAt };
    const tasks = { 's3-0': paused, 's3-1': { ...paused }, 's3-2': { ...paused }, 's3-3': { ...paused } };

    // 開き直し: 起点が復元されるので「まとめて完了」ボタンが出る (batchStartTimes が空でなくなる)
    const restored = rebuildBatchStartTimes(tasks);
    assert.deepEqual(restored, { 3: T0 });
    // 開き直した直後の表示は 775 秒のまま (0 に戻らない)
    assert.equal(liveSecOf(tasks['s3-0'], closedAt + sec(3600)), 775);

    // 1時間放置してから「続きから開始」= 休憩ぶん(3600秒)だけ起点を後ろへシフト
    const resumeAt = closedAt + sec(3600);
    const shifted = resumeAt - paused.pausedAt;
    const resumed = { ...paused, status: 'processing', startTime: resumeAt, pausedAt: null, batchStartedAt: paused.batchStartedAt + shifted };
    // 再開直後 = 中断時の 775 秒とつながる (休憩1時間は入らない)
    assert.equal(liveSecOf(resumed, resumeAt), 775);
    // さらに 125 秒作業 = 900 秒
    assert.equal(liveSecOf(resumed, resumeAt + sec(125)), 900);
    // 4台まとめて完了したときの1台あたり = 900 / 4 = 225 秒 (壁時計÷台数)
    assert.equal(Math.floor(liveSecOf(resumed, resumeAt + sec(125)) / 4), 225);
});

test('R09 「最初から開始」だけは起点を取り直す (続きから開始は起点を守る)', () => {
    const paused = { status: 'paused', duration: 0, batchOwner: 3, batchStartedAt: T0, pausedAt: T0 + sec(775) };
    const now = T0 + sec(800);
    // toggleBatch 開始側と同じ規則
    const startedAtFor = (t, resetDuration) => {
        if (resetDuration || t.batchStartedAt == null) return now;
        if (t.status === 'paused' && t.pausedAt) return t.batchStartedAt + Math.max(0, now - t.pausedAt);
        return t.batchStartedAt;
    };
    // 続きから: 休憩(25秒)ぶんシフト → 表示は 775 秒から続く
    assert.equal(startedAtFor(paused, false), T0 + sec(25));
    assert.equal(liveSecOf({ ...paused, status: 'processing', pausedAt: null, batchStartedAt: startedAtFor(paused, false) }, now), 775);
    // 最初から: now で取り直し → 0 から
    assert.equal(startedAtFor(paused, true), now);
    assert.equal(liveSecOf({ ...paused, status: 'processing', pausedAt: null, duration: 0, batchStartedAt: startedAtFor(paused, true) }, now), 0);
    // 起点をまだ持たない未着手の台は now から
    assert.equal(startedAtFor({ status: 'waiting' }, false), now);
});

test('R10 まとめて再開の休憩シフトは台ごと (止まった時刻が違う台の中断時間を作業に混ぜない)', () => {
    // 画面ヘッダーの「再開」(toggleBreak)と同じ規則: その台が止まっていた幅だけ起点を後ろへずらす。
    const resumeAll = (tasks, now) => Object.fromEntries(Object.entries(tasks).map(([k, t]) => {
        if (!(t.status === 'paused' && t.pausedAt)) return [k, t];
        const myBreakMs = Math.max(0, now - t.pausedAt);
        return [k, { ...t, status: 'processing', startTime: now, pausedAt: null, ...(t.batchStartedAt != null ? { batchStartedAt: t.batchStartedAt + myBreakMs } : {}) }];
    }));
    // #1 は 100秒で止めてすぐ再開、#2 は 100秒で止めたまま 600秒放置 → 同時に再開
    const tasks = {
        u0: { status: 'paused', duration: 0, batchOwner: 4, batchStartedAt: T0, pausedAt: T0 + sec(100) },
        u1: { status: 'paused', duration: 0, batchOwner: 4, batchStartedAt: T0, pausedAt: T0 + sec(100) },
    };
    // まず #1 だけ個別に再開(50秒後)
    const t1 = T0 + sec(150);
    tasks.u0 = { ...tasks.u0, status: 'processing', startTime: t1, pausedAt: null, batchStartedAt: tasks.u0.batchStartedAt + (t1 - tasks.u0.pausedAt) };
    // 600秒後にまとめて中断→再開 (u1 はここまでずっと止まっていた)
    const t2 = T0 + sec(750);
    const paused2 = { ...tasks.u0, status: 'paused', startTime: null, pausedAt: t2 };
    const resumed = resumeAll({ u0: paused2, u1: tasks.u1 }, t2 + sec(1));
    // #1 = 止まる前の 100秒 + 150→750 の 600秒 = 700秒
    assert.equal(liveSecOf(resumed.u0, t2 + sec(1)), 700);
    // #2 = 止まる前の 100秒のまま (放置していた 651秒は1秒も入らない)
    assert.equal(liveSecOf(resumed.u1, t2 + sec(1)), 100);
    // ⚠全台を「最初の1台の休憩幅(=1秒)」でずらす旧実装だと #2 は 750秒になり、
    //   一度も作業していない 650秒が実測として記録されてしまう。
    const wrong = { ...tasks.u1, status: 'processing', pausedAt: null, batchStartedAt: tasks.u1.batchStartedAt + sec(1) };
    assert.equal(liveSecOf(wrong, t2 + sec(1)), 750);
});
