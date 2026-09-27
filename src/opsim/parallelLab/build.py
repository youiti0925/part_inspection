from pathlib import Path
p = Path(__file__).resolve().parent
# encoding='utf-8' を明示する(Windows の既定 cp932 だと日本語が化ける／読めない)
s = (p/'template.html').read_text(encoding='utf-8').replace('/*FONT*/', '')
s = s.replace('/*ENGINE*/', (p/'engine.mjs').read_text(encoding='utf-8').replace('export ', ''))
s = s.replace('/*UI*/', (p/'ui.js').read_text(encoding='utf-8'))
(p/'parallel-lab.html').write_text(s, encoding='utf-8')
