/* 构建脚本：编译 → 压缩 → 内容哈希戳进 index.html
 *
 * 加哈希不是为了好看：静态托管（GitHub Pages / 本地 http）会缓存 css 与 js，
 * 改了样式却看到旧版本是真实踩过的坑 —— 内容变了 URL 就变，缓存自然失效。
 *
 *   node build.mjs           开发构建（不压缩，保留注释）
 *   node build.mjs --prod    生产构建（压缩 + 哈希）
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const prod = process.argv.includes('--prod');

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'js/app.js',
  format: 'iife',
  target: 'es2019',
  charset: 'utf8',
  minify: prod,
  legalComments: 'none',
  logLevel: 'info'
});

const hash = async (path) =>
  createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 8);

const [jsHash, cssHash] = await Promise.all([hash('js/app.js'), hash('css/style.css')]);

let html = await readFile('index.html', 'utf8');
// 先剥掉旧的 ?v=，保证可重复执行
html = html
  .replace(/(href="css\/style\.css)(\?v=[a-f0-9]+)?"/, `$1?v=${cssHash}"`)
  .replace(/(src="js\/app\.js)(\?v=[a-f0-9]+)?"/, `$1?v=${jsHash}"`);
await writeFile('index.html', html);

const size = (await readFile('js/app.js')).length;
console.log(`\n${prod ? '生产' : '开发'}构建完成`);
console.log(`  js/app.js       ${(size / 1024).toFixed(1)} KB  ?v=${jsHash}`);
console.log(`  css/style.css   ?v=${cssHash}`);
