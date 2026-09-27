// 単独部品も本番設定で束ねて確かめる。出力は既存distを上書きしない一時ディレクトリ。
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = await mkdtemp(path.join(tmpdir(), 'skill-grid-build-'));
await build({ root, build: { outDir, emptyOutDir: false, rollupOptions: { input: fileURLToPath(new URL('./preview.html', import.meta.url)) } } });
console.log(`SKILL_GRID_BUILD=${outDir}`);
