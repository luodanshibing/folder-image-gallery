/**
 * 画廊笔记自检：扫描库里的 ```gallery 代码块，逐块解析并核对文件夹是否真的存在。
 * 运行：node tools/check-notes.mjs [库路径...]        （默认 E:\Dnotes 与 E:\Enotes）
 *
 * 检查项：
 *   1. 代码块参数能否被插件解析（未知参数会点名，例如旧插件的 mobile:）
 *   2. folder/path 指向的文件夹在磁盘上是否真的存在（这是"画廊出不来"最常见的原因）
 *   3. 文件夹里有没有插件支持的图片
 *   4. 还留着多少旧插件语法的 ```img-gallery 块
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, '..', 'plugin', 'main.js');

/* ---- 用桩件加载 main.js，复用它的参数解析（与插件同一份代码） ---- */
const obsidianStub = {
  Plugin: class {}, PluginSettingTab: class {}, Setting: class {},
  MarkdownRenderChild: class { constructor(el) { this.containerEl = el; } },
  TFile: class {}, TFolder: class {},
};
const moduleShim = { exports: {} };
new Function('require', 'module', 'exports', 'window', 'document', fs.readFileSync(MAIN, 'utf8'))(
  (id) => { if (id === 'obsidian') return obsidianStub; throw new Error(`未知模块 ${id}`); },
  moduleShim, moduleShim.exports,
  { setTimeout, clearTimeout, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout, addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ overflowY: 'visible' }) },
  { addEventListener() {}, removeEventListener() {}, hidden: false },
);
const { parseGalleryOptions, normalizeVaultPath } = moduleShim.exports.__internals;

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff', 'tif', 'ico']);
const KNOWN_KEYS = new Set(['folder', 'path', 'type', 'columns', 'height', 'gap', 'gutter', 'sort', 'sortby', 'order', 'max', 'radius', 'border-radius', 'recursive', 'title']);

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['E:\\Dnotes', 'E:\\Enotes'];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.trash' || e.name === '.obsidian' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function blocks(text, lang) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (lines[i].trim() === '```' + lang) start = i;
    } else if (lines[i].trim().startsWith('```')) {
      out.push({ line: start + 1, body: lines.slice(start + 1, i).join('\n') });
      start = -1;
    }
  }
  return out;
}

let totalGallery = 0, totalLegacy = 0;
const problems = [];
const legacyFiles = [];

for (const root of roots) {
  if (!fs.existsSync(root)) { console.log(`跳过（不存在）：${root}`); continue; }
  const files = walk(root, []);
  console.log(`\n=== ${root}（${files.length} 篇 md）===`);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const legacy = blocks(text, 'img-gallery');
    if (legacy.length) {
      totalLegacy += legacy.length;
      legacyFiles.push(`${file}（第 ${legacy.map((b) => b.line).join(', ')} 行）`);
    }
    for (const blk of blocks(text, 'gallery')) {
      totalGallery++;
      const rel = path.relative(root, file);
      const opts = parseGalleryOptions(blk.body);
      const where = `${rel}:${blk.line}`;

      // 1) 未知参数
      for (const line of blk.body.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_-]+)\s*:/.exec(line);
        if (m && !KNOWN_KEYS.has(m[1].toLowerCase())) {
          problems.push(`${where} 参数「${m[1]}」插件不认识，会被忽略`);
        }
      }
      // 2) 文件夹是否存在
      if (!opts.folder) {
        problems.push(`${where} 没有写 folder/path`);
        continue;
      }
      const wanted = normalizeVaultPath(opts.folder);
      const abs = path.join(root, wanted);
      if (!fs.existsSync(abs)) {
        problems.push(`${where} 文件夹不存在：${wanted}`);
        continue;
      }
      // 3) 有没有认识的图片
      let count = 0;
      const scan = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { if (opts.recursive !== false) scan(full); }
          else {
            const ext = e.name.split('.').pop().toLowerCase();
            if (IMAGE_EXT.has(ext)) count++;
          }
        }
      };
      scan(abs);
      if (count === 0) problems.push(`${where} 文件夹里没有插件认识的图片：${wanted}`);
      else console.log(`  OK  ${where}  ${opts.type || 'horizontal'}  图片 ${count} 张  ${wanted}`);
    }
  }
}

console.log('\n================ 汇总 ================');
console.log(`gallery 代码块：${totalGallery} 个     img-gallery 残留：${totalLegacy} 个`);
if (legacyFiles.length) {
  console.log('\n仍是旧插件语法的笔记（本插件不处理，需要把代码块语言改成 gallery）：');
  for (const f of legacyFiles) console.log(`  - ${f}`);
}
if (problems.length) {
  console.log(`\n有问题的块 ${problems.length} 个：`);
  for (const p of problems) console.log(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log('\n所有 gallery 块都指向存在的文件夹，且都有图片。');
}
