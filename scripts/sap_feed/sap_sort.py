#!/usr/bin/env python3
"""SAP 工程の仕分けの登録 sap-sort/1 を読んで、工程を「どのグループか」に分ける(アプリの src/domain/sapSort.js と同じ答えを返す)。標準ライブラリだけ。
目的: 今まで feed.py・machine_rules.json・app_wcs.json に別々にあった分類表を、登録 1 つ(src/domain/sap_sort.default.json)にまとめて、アプリと束を作る係が同じ物を読む。
入力: load_sap_sort(パス) / classify_op(作業テキスト, 作業区, 登録) / app_wcs_of(登録) / machine_kinds_of(登録)
出力: 登録 dict・{name, kind, group, commander}・アプリ別の作業区の表・束 machine に入れる kind。登録が無い・壊れている時は今と同じ分け方(code_default)で動き、理由を返す
呼ぶ人: scripts/sap_feed/feed.py・make_feed.py・selftest_sap_feed.py
確かめ方: npm run sap-feed:test(アプリの classifyOp と同じ答えか・切り替え前の表と束のハッシュが同じか)と node --test src/domain/__tests__/sapSort.test.mjs
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = 'sap-sort/1'
DEFAULT_PATH = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'src', 'domain', 'sap_sort.default.json')   # アプリが同梱している物と同じファイル


def js_number(code):
    """JS の Number(code) と同じ(空=0・数でない=NaN)。アプリの classifyOp の c と同じ値にする"""
    t = str(code if code is not None else '').strip()
    if t == '':
        return 0.0
    if re.fullmatch(r'[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', t):
        return float(t)
    return float('nan')


def code_default():
    """登録が無い・壊れている時の最後の砦(切り替え前の表そのまま・コード側の既定)。同梱の JSON と同じ答えになる事を試験で守る"""
    ranges = [('lathe', '旋盤', 2313, 2319), ('lathe_v', '立旋盤', 2341, 2349), ('milling', 'フライス', 2320, 2329), ('mc_h', '横M/C', 2351, 2359),
              ('mc_g', '門M/C', 2361, 2369), ('grind_flat', '平面研削', 2381, 2389), ('grind_round', '円筒研削', 2371, 2379), ('gear', '歯切り', 2390, 2396), ('change', '仕様変更', 2330, 2336)]
    g = [{'key': k, 'name': n, 'type': 'process', 'kind': 'machine', 'count': True, 'wcRanges': [[a, b]]} for k, n, a, b in ranges]
    g.append({'key': 'wash', 'name': '面取り洗浄', 'type': 'process', 'kind': 'wash', 'count': True, 'wcRanges': []})
    return {
        'schema': SCHEMA, 'rev': 1,
        'commanders': [
            {'key': 'inspect', 'name': '検査', 'order': 1, 'groups': [
                {'key': 'product', 'name': '製品', 'type': 'site', 'app': 'product', 'wc': ['2309']},
                {'key': 'final', 'name': '最終', 'type': 'site', 'app': 'final', 'wc': ['2526']},
                {'key': 'parts', 'name': '部品', 'type': 'site', 'app': 'parts', 'wc': ['2509', '2519'], 'wcNames': {'2509': '三次元検査', '2519': '受入検査'}}]},
            {'key': 'machine', 'name': '機械', 'order': 2, 'groups': g,
             'textRules': [['平面研削', 'grind_flat'], ['円筒研削', 'grind_round'], ['歯切り', 'gear'], ['ﾌﾗｲｽ', 'milling'], ['フライス', 'milling'],
                           ['門M/C', 'mc_g'], ['横M/C', 'mc_h'], ['立旋盤', 'lathe_v'], ['旋盤', 'lathe']],
             'special': {'wash': {'textHas': ['洗浄'], 'to': 'wash'},
                         'misc': {'name': '付帯作業', 'headStarts': ['付帯作業'], 'textHas': ['一時置き', '応援', '現合'], 'nameIfTextHas': ['一時置き', '付帯作業(一時置き)'], 'count': False},
                         'change': {'headStarts': ['仕様変更'], 'fallbackTo': 'change'}}}],
        'laneOrder': ['旋盤', '立旋盤', 'フライス', '横M/C', '門M/C', '平面研削', '円筒研削', '歯切り', '仕様変更', '面取り洗浄', '受入検査', '三次元検査', '検査'],
    }


def _strs(a):
    return isinstance(a, list) and all(isinstance(s, str) for s in a)


def validate_sap_sort(reg):
    """登録の形の検査 → 日本語の理由の一覧(空なら通る)。知らない版・空・重なり・つなぎの切れを見つける(アプリの validateSapSort と同じ決まり)"""
    if not isinstance(reg, dict):
        return ['登録が空です']
    if reg.get('schema') != SCHEMA:
        return ['知らない版の登録です(%s)' % reg.get('schema')]
    cs = reg.get('commanders')
    if not isinstance(cs, list) or not cs:
        return ['司令塔が1つもありません']
    errs, keys, wc_seen, ranges = [], set(), {}, []
    for c in cs:
        if not isinstance(c, dict) or not isinstance(c.get('key'), str) or not isinstance(c.get('groups'), list):
            errs.append('司令塔の形が違います')
            continue
        for g in c['groups']:
            if not isinstance(g, dict) or not isinstance(g.get('key'), str) or not isinstance(g.get('name'), str):
                errs.append('%s: グループの形が違います' % c['key'])
                continue
            if g['key'] in keys:
                errs.append('グループの目印が重なっています: %s' % g['key'])
            keys.add(g['key'])
            if g.get('wc') is not None:
                if not _strs(g['wc']):
                    errs.append('%s: 作業区の一覧の形が違います' % g['key'])
                else:
                    for w in g['wc']:
                        if w in wc_seen:
                            errs.append('作業区 %s が %s と %s の両方に入っています' % (w, wc_seen[w], g['key']))
                        wc_seen[w] = g['key']
            for r in g.get('wcRanges') or []:
                if not (isinstance(r, list) and len(r) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in r) and r[0] <= r[1]):
                    errs.append('%s: 作業区の範囲の形が違います' % g['key'])
                    continue
                for o in ranges:
                    if r[0] <= o[1] and o[0] <= r[1]:
                        errs.append('作業区の範囲が重なっています: %s(%s〜%s) と %s' % (g['key'], r[0], r[1], o[2]))
                ranges.append((r[0], r[1], g['key']))
        gk = {g.get('key') for g in c['groups'] if isinstance(g, dict)}
        for tr in c.get('textRules') or []:
            if not (isinstance(tr, list) and len(tr) == 2 and isinstance(tr[0], str) and tr[0]):
                errs.append('%s: 言葉の決まりが空です' % c['key'])
            elif tr[1] not in gk:
                errs.append('%s: 言葉「%s」の行き先 %s が見つかりません' % (c['key'], tr[0], tr[1]))
        sp = c.get('special') or {}
        w, m, ch = sp.get('wash'), sp.get('misc'), sp.get('change')
        if w and not (_strs(w.get('textHas')) and w.get('to') in gk):
            errs.append('%s: 洗浄の決まりが壊れています' % c['key'])
        if m and not (isinstance(m.get('name'), str) and _strs(m.get('headStarts')) and _strs(m.get('textHas'))):
            errs.append('%s: 付帯作業の決まりが壊れています' % c['key'])
        if ch and not (_strs(ch.get('headStarts')) and ch.get('fallbackTo') in gk):
            errs.append('%s: 仕様変更の決まりが壊れています' % c['key'])
    if not any(isinstance(c, dict) and isinstance(c.get('special'), dict) and c['special'].get('misc') for c in cs):
        errs.append('付帯作業の決まりがありません(どれにも当たらない工程の行き先が決まりません)')
    if not _strs(reg.get('laneOrder')):
        errs.append('並び順 laneOrder がありません')
    return errs


def load_sap_sort(path=None):
    """登録を読む → (登録, 既定を使ったか, 理由の一覧)。path が None なら同梱の既定ファイル。
    ファイルが無い・JSON が壊れている・形の検査が赤、のどれでも 今と同じ分け方(同梱の既定→無ければコードの既定)で動く"""
    errs = []
    for i, p in enumerate(([path] if path else []) + [DEFAULT_PATH]):
        try:
            with open(p, encoding='utf-8') as f:
                reg = json.load(f)
        except (OSError, ValueError) as e:
            errs.append('%s を読めません(%s)' % (p, type(e).__name__))
            continue
        bad = validate_sap_sort(reg)
        if not bad:
            return reg, bool(path) and i > 0, errs
        errs += ['%s: %s' % (p, b) for b in bad]
    return code_default(), True, errs


_CACHE = {}


def _compile(reg):
    hit = _CACHE.get(id(reg))
    if hit and hit[0] is reg:
        return hit[1]
    inspect, ranges, text, wash, misc, change, mcm = {}, [], [], None, None, None, None
    for c in reg['commanders']:
        by = {g['key']: g for g in c['groups']}
        for g in c['groups']:
            for w, nm in (g.get('wcNames') or {}).items():
                inspect[float(w)] = {'name': nm, 'kind': 'inspect', 'group': g['key'], 'commander': c['key']}
            for a, b in g.get('wcRanges') or []:
                ranges.append((a, b, {'name': g['name'], 'kind': g.get('kind', 'machine'), 'group': g['key'], 'commander': c['key']}))
        for kw, gk in c.get('textRules') or []:
            g = by[gk]
            text.append((kw, {'name': g['name'], 'kind': g.get('kind', 'machine'), 'group': g['key'], 'commander': c['key']}))
        sp = c.get('special') or {}
        if sp.get('wash') and not wash:
            g = by[sp['wash']['to']]
            wash = (sp['wash']['textHas'], {'name': g['name'], 'kind': g.get('kind', 'wash'), 'group': g['key'], 'commander': c['key']})
        if sp.get('misc') and not misc:
            misc, mcm = sp['misc'], c['key']
        if sp.get('change') and not change:
            g = by[sp['change']['fallbackTo']]
            change = (sp['change']['headStarts'], {'name': g['name'], 'kind': g.get('kind', 'machine'), 'group': g['key'], 'commander': c['key']})
    out = (inspect, ranges, text, wash, misc, change, mcm)
    _CACHE[id(reg)] = (reg, out)
    return out


def classify_op(text, code, reg, same_as_app=True):
    """作業テキスト・作業区 → {name, kind, group, commander}(kind: machine / inspect / wash / misc)。アプリの classifyOp と同じ答え。
    当てる順: 検査の作業区 → 洗浄 → 付帯作業 → 作業区の範囲 → 仕様変更の言葉 → 工程名の言葉 → 付帯作業。
    same_as_app=False は規則を外した版(試験用): 作業区コードの範囲の表を使わない"""
    inspect, ranges, rules, wash, misc, change, mcm = _compile(reg)
    raw = re.sub(r'\s+', ' ', str(text or '').replace('：', ':')).strip()
    t = re.sub(r'^\d{4}[:\s]+', '', raw)
    c = js_number(code)
    if c in inspect:
        return dict(inspect[c])
    if wash and any(k in t for k in wash[0]):
        return dict(wash[1])
    head = t.split(':')[0]
    is_change = bool(change) and any(head.startswith(p) for p in change[0])
    mo = lambda nm: {'name': nm, 'kind': 'misc', 'group': 'misc', 'commander': mcm}   # noqa: E731
    if not is_change and (any(head.startswith(p) for p in misc['headStarts']) or any(k in t for k in misc['textHas'])):
        nt = misc.get('nameIfTextHas')
        return mo(nt[1] if nt and nt[0] in t else misc['name'])
    if same_as_app:
        for a, b, r in ranges:
            if a <= c <= b:
                return dict(r)
    if is_change:
        for k, r in rules:
            if k in t:
                return dict(r)
        return dict(change[1])
    for k, r in rules:
        if k in head or k in t:
            return dict(r)
    return mo(misc['name'])


def classify_work(text, code, reg, same_as_app=True):
    """classify_op の {name, kind} だけ(切り替え前の classify_work と同じ形)"""
    r = classify_op(text, code, reg, same_as_app)
    return {'name': r['name'], 'kind': r['kind']}


def app_wcs_of(reg):
    """アプリごとの作業区の表(旧 app_wcs.json の apps): {'product': ['2309'], ...}"""
    out = {}
    for c in reg['commanders']:
        for g in c['groups']:
            if g.get('type') == 'site' and g.get('app'):
                out[g['app']] = list(g['wc'])
    return out


def machine_kinds_of(reg):
    """束 machine に入れる工程の kind(旧 machine_rules.json の machine_kinds): 負荷に数えるグループの kind"""
    s = {g.get('kind', 'machine') for c in reg['commanders'] for g in c['groups'] if g.get('type') == 'process' and g.get('count')}
    return [k for k in ('machine', 'wash') if k in s]
