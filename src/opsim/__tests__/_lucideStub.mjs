// =============================================================================
//  _lucideStub.mjs — 絵文字の部品(lucide-react)の差し替え。
//  絵が出るかは この見張りの仕事ではない。読み込みを軽くする為だけの物。
//  🚨 画面のコードは 1バイトも差し替えない(差し替えるのは React と この絵の部品だけ)。
// =============================================================================
const icon = (name) => {
  const C = () => null;
  Object.defineProperty(C, 'name', { value: name });
  return C;
};

export const Loader2 = icon('Loader2');
export const Play = icon('Play');
export const Users = icon('Users');
export const CalendarRange = icon('CalendarRange');
export const ChevronDown = icon('ChevronDown');
