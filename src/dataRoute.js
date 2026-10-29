// ============================================================================
// どの保管庫へ書くか(切替の入口)— App.jsx から切り出し 2026-10-29
// ----------------------------------------------------------------------------
// ⚠ 切り出した理由は1つ: 回転計測(RotaryMeasurements.jsx)が providerFor(d, FS_API) と2つの引数で呼んでいて、
//   切替が効かずいつも Firebase へ向いていた(点検 G5)。同じ行き先を両方から引けるようにする。
//
// 🚨 2026-10-30 PocketBase へ切り替わるのは **社内サーバ版のビルド(VITE_ONPREM=1)の中だけ**。
//   いつものビルド(本番の dist)では、行き先は **いつも全部 Firebase**。
//   ・Firestore の共有の設定(settings.pocketbase)を見て端末に覚える作り(data.route.v1)は消した。
//     前はそれがあったので、共有の設定を1つ書くだけで本番の全端末が「次に開いた時」に PocketBase へ切り替わり得た。
//   ・端末に覚えた行き先(localStorage の data.route.v1)も読まない。
//   ・社内版の行き先(applyOnpremRoute)も、ビルドが社内版でなければ何もしない(二重の止め)。
//   社内版の行き先は onprem-config.json だけで決まる(App の起動の所・IS_ONPREM_BUILD の枝)。
// ============================================================================
import { providerFor } from './data/provider.js';
import { DEFAULT_PROVIDERS } from './data/routes.js';
import { IS_ONPREM_BUILD, ONPREM_PROVIDERS, pbConfigOfOnprem } from './onprem.js';

// ⚠ ビルドが社内版か。値はビルドの時の定数(IS_ONPREM_BUILD)。試験だけが __setOnpremBuildForTest で変える。
let _buildIsOnprem = IS_ONPREM_BUILD;
let _routeProviders = DEFAULT_PROVIDERS;
let _routePbConfig = null;
let _onprem = false;

/** 社内サーバ版: 全部の領域を PocketBase へ。いつものビルドでは何もしない(Firebase のまま)。 */
export const applyOnpremRoute = (cfg, extra = {}) => {
  if (!_buildIsOnprem) return { providers: _routeProviders, pbConfig: _routePbConfig };
  _onprem = true;
  _routeProviders = ONPREM_PROVIDERS;
  _routePbConfig = pbConfigOfOnprem(cfg, extra);
  return { providers: _routeProviders, pbConfig: _routePbConfig };
};

/** 今の行き先(画面の表示・写真の上げ先の判断に使う)。いつものビルドでは必ず DEFAULT_PROVIDERS(全部 Firebase)。 */
export const currentProviders = () => _routeProviders;
export const isOnpremRoute = () => _onprem;

/**
 * 窓口を返す。fs は Firestore の関数の束(App は数えるだけの覆い FS_EST、回転計測は FS_API)。
 * ⚠ providers が変わらない限り同じ窓口が返る(providerFor が db ごとに覚えている)。
 */
export const dataFor = (db, fs) => providerFor(db, fs, _routeProviders, _routePbConfig);

/** 試験用: 状態を最初に戻す。 */
export const __resetDataRouteForTest = () => { _routeProviders = DEFAULT_PROVIDERS; _routePbConfig = null; _onprem = false; _buildIsOnprem = IS_ONPREM_BUILD; };
/** 試験用: 社内版のビルドのふりをする(node ではビルドの時の定数が無く、いつも false の為)。 */
export const __setOnpremBuildForTest = (v) => { _buildIsOnprem = v === true; };
