"""🧊 切り替え前の classify_work(凍結した写し・直さない)
目的: 11-25 に分類表を登録 sap-sort/1 へ集約する前の Python の分類。表は同じフォルダの machine_rules.before.json(旧 machine_rules.json)。切り替え後との差 0 を比べる為だけに使う
入力: classify_work(作業テキスト, 作業区, 旧の表(dict), same_as_app)
出力: {name, kind}
触る外の物: なし(コミット 4e29a6f の scripts/sap_feed/feed.py からそのまま写した)
確かめ方: python -I scripts/sap_feed/selftest_sap_sort.py
"""
import re


def js_number(code):
    """JS の Number(code) と同じ(空=0・数でない=NaN)。sapProgress.js readWorkName の c と同じ値にする"""
    t = str(code if code is not None else '').strip()
    if t == '':
        return 0.0
    if re.fullmatch(r'[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?', t):
        return float(t)
    return float('nan')


def classify_work(text, code, mr, same_as_app=True):
    """作業テキスト・作業区 → {name, kind}(kind: machine / inspect / wash / misc)。src/domain/sapProgress.js の readWorkName と同じ答え(表は machine_rules.json)。
    same_as_app=False は規則を外した版(試験用): 作業区コードの範囲の表を使わない"""
    raw = re.sub(r'\s+', ' ', str(text or '').replace('：', ':')).strip()
    t = re.sub(r'^\d{4}[:\s]+', '', raw)
    c = js_number(code)
    ic = mr['inspect_codes']
    for k, nm in ic.items():
        if c == float(k):
            return {'name': nm, 'kind': 'inspect'}
    if re.search(mr['wash']['pattern'], t):
        return {'name': mr['wash']['name'], 'kind': 'wash'}
    head = t.split(':')[0]
    is_change = bool(re.search(mr['change']['head_pattern'], head))
    mi = mr['misc']
    if not is_change and (re.search(mi['head_pattern'], head) or re.search(mi['text_pattern'], t)):
        return {'name': mi['name_if_text_contains'][1] if mi['name_if_text_contains'][0] in t else mi['name'], 'kind': 'misc'}
    if same_as_app:
        for a, b, nm in mr['code_fallback']:
            if a <= c <= b:
                return {'name': nm, 'kind': 'machine'}
    if is_change:
        for k, nm in mr['name_rules']:
            if k in t:
                return {'name': nm, 'kind': 'machine'}
        return {'name': mr['change']['default_name'], 'kind': 'machine'}
    for k, nm in mr['name_rules']:
        if k in head or k in t:
            return {'name': nm, 'kind': 'machine'}
    return {'name': mi['default_name'], 'kind': 'misc'}
