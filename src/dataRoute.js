// ============================================================================
// どの保管庫へ書くか(切替の入口)— App.jsx から切り出し 2026-10-29
// ----------------------------------------------------------------------------
// ⚠ 中身は App.jsx:462-492(fff526a)にあった物と同じ。切り出した理由は1つ:
//   回転計測(RotaryMeasurements.jsx)が providerFor(d, FS_API) と2つの引数で呼んでいて、
//   切替が効かずいつも Firebase へ向いていた(点検 G5)。同じ行き先を両方から引けるようにする。
// ⚠ 既定は必ず Firebase。保存された行き先に enabled === true と接続先がはっきり入っている時、
//   または社内サーバ版のビルド(applyOnpremRoute)の時だけ切り替わる。
// ============================================================================
import { providerFor } from './data/provider.js';
import { DEFAULT_PROVIDERS, providersFromSettings } from './data/routes.js';
import { ONPREM_PROVIDERS, pbConfigOfOnprem } from './onprem.js';

let _routeProviders = DEFAULT_PROVIDERS;
let _routePbConfig = null;
let _onprem = false;

export const applyDataRoute = (pbSettings, extra = {}) => {
  if (_onprem) return { providers: _routeProviders, pbConfig: _routePbConfig };   // 社内版は設定の pocketbase で上書きしない
  const next = providersFromSettings(pbSettings);
  if (JSON.stringify(next) !== JSON.stringify(_routeProviders)) _routeProviders = next;
  const usesPb = Object.values(next).includes('pocketbase');
  const nextPb = usesPb ? {
    url: String(pbSettings.url || '').replace(/\/+$/, ''),
    email: pbSettings.email || '', password: pbSettings.password || '',
    authCollection: pbSettings.authCollection || 'device_users',
    owner: extra.owner || '', onPendingChange: extra.onPendingChange, onConflict: extra.onConflict,
  } : null;
  if ((nextPb?.url || '') !== (_routePbConfig?.url || '')) _routePbConfig = nextPb;
  else if (nextPb) _routePbConfig = { ..._routePbConfig, ...nextPb };
  return { providers: _routeProviders, pbConfig: _routePbConfig };
};

/** 社内サーバ版: 全部の領域を PocketBase へ。以後 applyDataRoute / 端末に覚えた行き先では変わらない。 */
export const applyOnpremRoute = (cfg, extra = {}) => {
  _onprem = true;
  _routeInit = true;
  _routeProviders = ONPREM_PROVIDERS;
  _routePbConfig = pbConfigOfOnprem(cfg, extra);
  return { providers: _routeProviders, pbConfig: _routePbConfig };
};

export const DATA_ROUTE_KEY = 'data.route.v1';
// ⚠ 読み込みは最初に使う時に行う(モジュールを読んだ瞬間に副作用を走らせない)。
let _routeInit = false;
export const ensureDataRoute = () => {
  if (_routeInit) return;
  _routeInit = true;
  try {
    const saved = JSON.parse(localStorage.getItem(DATA_ROUTE_KEY) || 'null');
    if (saved && saved.enabled === true && saved.url) applyDataRoute(saved);
  } catch { /* 読めなければ Firebase のまま(安全側) */ }
};

/** 今の行き先(画面の表示・写真の上げ先の判断に使う)。 */
export const currentProviders = () => { ensureDataRoute(); return _routeProviders; };
export const isOnpremRoute = () => _onprem;

/**
 * 窓口を返す。fs は Firestore の関数の束(App は数えるだけの覆い FS_EST、回転計測は FS_API)。
 * ⚠ providers が変わらない限り同じ窓口が返る(providerFor が db ごとに覚えている)。
 */
export const dataFor = (db, fs) => { ensureDataRoute(); return providerFor(db, fs, _routeProviders, _routePbConfig); };

/**
 * 設定の pocketbase(settings.pocketbase)から「端末に覚える行き先」を作る(純関数・点検 G1)。
 * ⚠製品 App.jsx:47705-47719 と同じ形。enabled===true と url が無ければ { enabled:false }。
 */
export const savedRouteFromSettings = (pb) => {
  const next = providersFromSettings(pb);
  const usesPb = Object.values(next).includes('pocketbase');
  return usesPb
    ? { enabled: true, url: String(pb.url || '').replace(/\/+$/, ''), email: pb.email || '', password: pb.password || '', authCollection: pb.authCollection || 'device_users', areas: pb.areas || null }
    : { enabled: false };
};

/** 試験用: 状態を最初に戻す。 */
export const __resetDataRouteForTest = () => { _routeProviders = DEFAULT_PROVIDERS; _routePbConfig = null; _onprem = false; _routeInit = false; };
