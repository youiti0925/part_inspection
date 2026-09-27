// 👤 人の色の丸 + 頭文字(部品検査・P084)。
//  製品 src/opsim/vizKit.jsx の Avatar と同じ形。vizKit は操業シミュの計算を連れて来るので写さず、丸だけをここに置く。
//  🚨 色は呼ぶ側が src/workerTone.js の workerToneOf(workers, name) で決めて渡す(名簿全体から1か所で配る = 同じ人が画面ごとに違う色にならない)。
//  🚨 7人目から色が重なるので、色だけで見分けさせない(showName 既定 true)。
import React from 'react';

export function WorkerAvatar({ name, tone = null, size = 'w-7 h-7', showName = true, className = '' }) {
  const nm = typeof name === 'string' ? name.trim() : '';
  const t = tone && typeof tone === 'object' ? tone : null;
  const dot = t && t.dot ? t.dot : 'bg-slate-400';
  const txt = t && t.text ? t.text : 'text-slate-600';
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full ${size} ${dot} font-bold text-white`}
        title={nm || '名前が読めていません'}
        aria-hidden="true"
      >
        <span className="fi-tap-text leading-none">{nm ? nm.slice(0, 1) : '?'}</span>
      </span>
      {showName ? <span className={`fi-tap-text truncate font-bold ${txt}`}>{nm || '(名前なし)'}</span> : null}
    </span>
  );
}

export default WorkerAvatar;
