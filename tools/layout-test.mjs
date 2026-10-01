/**
 * 布局引擎单测 + 大数量性能计时（不依赖 Obsidian，直接加载 plugin/main.js）
 * 运行：node tools/layout-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(here, '..', 'plugin', 'main.js');

/* ---- 用桩件加载 main.js（它 require('obsidian')） ---- */
const obsidianStub = {
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  MarkdownRenderChild: class { constructor(el) { this.containerEl = el; } },
  TFile: class {},
  TFolder: class {},
};
const windowStub = {
  setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  innerHeight: 900,
  addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ overflowY: 'visible' }),
};
const documentStub = {
  body: null, documentElement: null, hidden: false,
  addEventListener() {}, removeEventListener() {},
};

const source = fs.readFileSync(MAIN, 'utf8');
const moduleShim = { exports: {} };
const load = new Function('require', 'module', 'exports', 'window', 'document', source);
load(
  (id) => { if (id === 'obsidian') return obsidianStub; throw new Error(`unknown module ${id}`); },
  moduleShim, moduleShim.exports, windowStub, documentStub,
);

const P = moduleShim.exports;
const I = P.__internals;
if (typeof P !== 'function' || !I) throw new Error('main.js 未正确导出插件类 / __internals');
console.log(`已加载 main.js：默认导出 ${typeof P}，internals ${Object.keys(I).length} 项`);

/* ---- 迷你测试框架 ---- */
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name} → ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

/* ============================ 1. 参数解析 ============================ */
console.log('\n[1] 代码块参数解析（向后兼容 v1）');
check('v1 全参数', () => {
  const o = I.parseGalleryOptions([
    'folder: 附件/照片 # 注释',
    'type: horizontal',
    'height: 260',
    'columns: 4',
    'gap: 8',
    'sort: mtime',
    'order: desc',
    'max: 100',
    'recursive: true',
    'title: 我的照片',
  ].join('\n'));
  assert(o.folder === '附件/照片', 'folder 解析错');
  assert(o.type === 'horizontal', 'type 解析错');
  assert(o.height === 260 && o.columns === 4 && o.gap === 8 && o.max === 100, '数值解析错');
  assert(o.sort === 'mtime' && o.order === 'desc', '排序解析错');
  assert(o.recursive === true, 'recursive 解析错');
  assert(o.title === '我的照片', `title 解析错：${o.title}`);
});
check('别名 path / gutter / sortby / justified / masonry', () => {
  const o = I.parseGalleryOptions('path: pics\ngutter: 12\nsortby: name\ntype: masonry');
  assert(o.folder === 'pics', 'path 别名失效');
  assert(o.gap === 12, 'gutter 别名失效');
  assert(o.sort === 'name', 'sortby 别名失效');
  assert(o.type === 'vertical', 'masonry 别名失效');
  const o2 = I.parseGalleryOptions('type: justified');
  assert(o2.type === 'horizontal', 'justified 别名失效');
});
check('lucaorio 风格 sort: desc 落到 order', () => {
  const o = I.parseGalleryOptions('folder: a\nsort: desc');
  assert(o.order === 'desc' && o.sort === undefined, 'sort: desc 兼容失效');
});
check('社区插件（lucaorio）老语法块整块可解析', () => {
  const o = I.parseGalleryOptions([
    'path: F Craftlab/F2 项目/F.230301-工业设计作品集锦/附件',
    'type: vertical',
    'columns: 4',
    'radius: 8',
    'sortby: name',
    'sort: asc',
  ].join('\n'));
  assert(o.folder === 'F Craftlab/F2 项目/F.230301-工业设计作品集锦/附件', 'path 未识别');
  assert(o.type === 'vertical', 'type 未识别');
  assert(o.columns === 4, 'columns 未识别');
  assert(o.radius === 8, 'radius 未识别');
  assert(o.sort === 'name', 'sortby 未识别');
  assert(o.order === 'asc', 'sort: asc 未识别');
});
check('radius 有别名与上下限保护', () => {
  assert(I.parseGalleryOptions('radius: 999').radius === 64, 'radius 未封顶');
  assert(I.parseGalleryOptions('border-radius: 0').radius === 0, 'border-radius 别名失效');
  assert(I.parseGalleryOptions('radius: -3').radius === undefined, '负数 radius 不该被接受');
});
check('非法值被忽略而不是污染', () => {
  const o = I.parseGalleryOptions('type: 乱写\nsort: 乱写\nheight: -5');
  assert(o.type === undefined && o.sort === undefined && o.height === undefined, '非法值未忽略');
});
check('引号与行内注释', () => {
  const o = I.parseGalleryOptions('folder: "我的 照片"\ntitle: \'相册\' # 说明');
  assert(o.folder === '我的 照片', '引号未剥离');
  assert(o.title === '相册', `注释未剥离：${o.title}`);
});

/* ====================== 2. justified 行布局不变量 ====================== */
console.log('\n[2] justified 行布局');
const W = 900;
const GAP = 8;

function assertJustified(ratios, width, targetH, gap) {
  const tolerance = 0.3;
  const upper = targetH * (1 + tolerance);
  const res = I.layoutJustified(ratios.length, ratios, width, targetH, gap, tolerance, 1.4);
  assert(res.rects.length === ratios.length, '漏图');
  let cursor = 0;
  for (const row of res.rows) {
    const n = row.end - row.start;
    assert(row.start === cursor, '行区间不连续');
    cursor = row.end;
    assert(row.h > 0, '行高非正');
    let x = 0;
    for (let i = row.start; i < row.end; i++) {
      const r = res.rects[i];
      assert(near(r.x, x, 1e-6), `行内 x 不连续：${r.x} vs ${x}`);
      assert(near(r.h, row.h, 1e-6), '行内高度不一致');
      assert(near(r.y, row.y, 1e-6), '行内 y 不一致');
      x += r.w + gap;
    }
    const isLast = row.end === ratios.length;
    if (!row.leftAligned) {
      const last = res.rects[row.end - 1];
      assert(near(last.x + last.w, width, 1e-6), `整行未铺满：${last.x + last.w} vs ${width}`);
      assert(row.h <= upper + 1e-6, `行高超出容差上限：${row.h}`);
      // 行过矮只允许出现在两种情形：末行，或行内含极端比例（≥3:1 的全景 / ≤0.5:1 的长图）
      const extreme = ratios.slice(row.start, row.end).some((r) => r >= 3 || (r > 0 && r <= 0.5));
      if (!isLast && n > 1 && !extreme) {
        assert(row.h >= targetH * (1 - tolerance) - 1e-6, `行过矮：${row.h}`);
      }
    }
  }
  assert(cursor === ratios.length, '行区间未覆盖全部图片');
  assert(near(res.totalHeight, res.rows.reduce((s, r) => s + r.h, 0) + gap * (res.rows.length - 1), 1e-6), '总高不等于行高之和');
  return res;
}

check('横向照片统一比例', () => {
  const ratios = new Array(50).fill(1.5);
  assertJustified(ratios, W, 260, GAP);
});
check('混合横竖比例', () => {
  const ratios = [];
  for (let i = 0; i < 200; i++) ratios.push(i % 3 === 0 ? 0.75 : i % 3 === 1 ? 1.5 : 1.0);
  assertJustified(ratios, W, 260, GAP);
});
check('含超宽全景与超窄长图', () => {
  const ratios = [4.5, 0.4, 1.33, 3.0, 0.6, 8.0, 0.13, 1.0, 1.78, 2.4];
  assertJustified(ratios, W, 260, GAP);
});
check('窄容器 / 大间距不出负宽', () => {
  const ratios = [1, 1, 1, 1, 1, 1, 1, 1];
  const res = assertJustified(ratios, 150, 260, 20);
  for (const r of res.rects) assert(r.w >= 0 && r.h > 0, '出现负宽度');
});
check('所有行高落在容差区间（多行时）', () => {
  const ratios = Array.from({ length: 300 }, (_, i) => 0.6 + ((i * 37) % 100) / 60);
  assertJustified(ratios, W, 260, GAP);
});
check('未知比例用估计值兜底', () => {
  const res = assertJustified(new Array(20).fill(0), W, 260, GAP);
  assert(res.rects.every((r) => r.h > 0 && r.w > 0), '未知比例布局失败');
});

/* ====================== 3. 多列瀑布布局不变量 ====================== */
console.log('\n[3] vertical 多列瀑布');
check('无重叠、无越界、列数正确', () => {
  const ratios = Array.from({ length: 400 }, (_, i) => 0.5 + ((i * 17) % 90) / 45);
  const res = I.layoutMasonry(ratios.length, ratios, W, 4, GAP, 220, 1.4);
  assert(res.columns === 4, '列数不对');
  assert(res.rects.length === ratios.length, '漏图');
  const boxes = res.rects.map((r, i) => ({ ...r, i }));
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a]; const B = boxes[b];
      const overlapX = A.x < B.x + B.w - 1e-6 && B.x < A.x + A.w - 1e-6;
      const overlapY = A.y < B.y + B.h - 1e-6 && B.y < A.y + A.h - 1e-6;
      assert(!(overlapX && overlapY), `图片 ${A.i} 与 ${B.i} 重叠`);
    }
  }
  const maxBottom = Math.max(...boxes.map((b) => b.y + b.h));
  assert(near(res.totalHeight, maxBottom, 1e-6), '总高不等于最低点');
});
check('自动列数随宽度变化', () => {
  const ratios = new Array(30).fill(1);
  const wide = I.layoutMasonry(30, ratios, 1200, 0, GAP, 220, 1.4);
  const narrow = I.layoutMasonry(30, ratios, 400, 0, GAP, 220, 1.4);
  assert(wide.columns > narrow.columns, `自动列数异常：${wide.columns} / ${narrow.columns}`);
  assert(narrow.columns >= 1, '列数至少为 1');
});
check('列高均衡（短列优先）', () => {
  const ratios = new Array(300).fill(1.5);
  const res = I.layoutMasonry(300, ratios, 1000, 4, 8, 220, 1.4);
  const perCol = [0, 0, 0, 0];
  res.rects.forEach((r) => { perCol[Math.round(r.x / (res.columnWidth + 8))] = Math.max(perCol[Math.round(r.x / (res.columnWidth + 8))], r.y + r.h); });
  const spread = Math.max(...perCol) - Math.min(...perCol);
  assert(spread <= 8 + 1e-6, `列高不均衡，差 ${spread.toFixed(2)}`);
});

/* ====================== 4. 视口检索正确性 ====================== */
console.log('\n[4] 可见区间检索（虚拟化的正确性根基）');
function bruteForce(layout, y0, y1) {
  const out = [];
  for (let i = 0; i < layout.rects.length; i++) {
    const r = layout.rects[i];
    if (r.y + r.h >= y0 && r.y <= y1) out.push(i);
  }
  return out.sort((a, b) => a - b);
}
check('随机扫描 200 次与暴力枚举一致（horizontal）', () => {
  const ratios = Array.from({ length: 600 }, (_, i) => 0.5 + ((i * 13) % 100) / 50);
  const layout = I.computeLayout(ratios.length, ratios, { type: 'horizontal', width: 900, height: 260, gap: 8, columns: 0, estimate: 1.4 });
  for (let t = 0; t < 200; t++) {
    const y0 = Math.random() * layout.totalHeight;
    const y1 = y0 + Math.random() * 1200;
    const got = I.visibleIndices(layout, y0, y1).slice().sort((a, b) => a - b);
    const want = bruteForce(layout, y0, y1);
    assert(JSON.stringify(got) === JSON.stringify(want), `t=${t} y=[${y0.toFixed(0)},${y1.toFixed(0)}] 得到 ${got.length} 张，应为 ${want.length} 张`);
  }
});
check('随机扫描 200 次与暴力枚举一致（vertical）', () => {
  const ratios = Array.from({ length: 600 }, (_, i) => 0.4 + ((i * 29) % 100) / 40);
  const layout = I.computeLayout(ratios.length, ratios, { type: 'vertical', width: 900, height: 260, gap: 8, columns: 5, estimate: 1.4 });
  for (let t = 0; t < 200; t++) {
    const y0 = Math.random() * layout.totalHeight;
    const y1 = y0 + Math.random() * 1200;
    const got = I.visibleIndices(layout, y0, y1).slice().sort((a, b) => a - b);
    const want = bruteForce(layout, y0, y1);
    assert(JSON.stringify(got) === JSON.stringify(want), `t=${t} 得到 ${got.length} 张，应为 ${want.length} 张`);
  }
});
check('上限裁剪：最多保留 MAX_MOUNTED 张', () => {
  const ratios = new Array(5000).fill(1.5);
  const layout = I.computeLayout(ratios.length, ratios, { type: 'horizontal', width: 900, height: 100, gap: 8, columns: 0, estimate: 1.4 });
  const got = I.visibleIndices(layout, 0, 1e9);
  const capped = I.nearestIndices(layout, got, 500, 240);
  assert(got.length > 240, '测试前提不成立');
  assert(capped.length === 240, `裁剪后应为 240，实为 ${capped.length}`);
  assert(new Set(capped).size === 240, '裁剪后出现重复');
});

/* ====================== 5. 宽高比缓存 ====================== */
console.log('\n[5] 宽高比缓存');
check('读写与文件指纹失效', () => {
  const f = { path: 'a/b.jpg', stat: { mtime: 100, size: 2000 } };
  const cache = new I.RatioCache({});
  assert(cache.get(f) === 0, '初始应为空');
  cache.set(f, 1.5);
  assert(near(cache.get(f), 1.5, 1e-9), '读回失败');
  const moved = { path: 'a/b.jpg', stat: { mtime: 101, size: 2000 } };
  assert(cache.get(moved) === 0, '修改时间变化后应失效');
  const resized = { path: 'a/b.jpg', stat: { mtime: 100, size: 2001 } };
  assert(cache.get(resized) === 0, '文件大小变化后应失效');
});
check('持久化往返', () => {
  const cache = new I.RatioCache({});
  for (let i = 0; i < 100; i++) cache.set({ path: `p${i}.jpg`, stat: { mtime: i, size: i } }, 1 + i / 100);
  const restored = new I.RatioCache(JSON.parse(JSON.stringify(cache.map)));
  assert(restored.size === 100, `恢复后条数不对：${restored.size}`);
  assert(near(restored.get({ path: 'p50.jpg', stat: { mtime: 50, size: 50 } }), 1.5, 1e-9), '恢复值不对');
});
check('异常值不写坏缓存', () => {
  const cache = new I.RatioCache({});
  const f = { path: 'x.jpg', stat: { mtime: 1, size: 1 } };
  cache.set(f, 0);
  cache.set(f, NaN);
  cache.set(f, -3);
  assert(cache.get(f) === 0, '非法比例被写入');
  cache.set(f, 1e6);
  assert(cache.get(f) <= 12, '未做上限保护');
});

/* ============ 5.5 文件夹路径容错（2026-10-01 用户实测踩坑） ============ */
console.log('\n[5.5] 文件夹路径容错（反斜杠 / 绝对路径 / 大小写）');
function fakeFolder(folderPath) {
  const f = Object.create(obsidianStub.TFolder.prototype);
  f.path = folderPath;
  f.name = folderPath.split('/').pop();
  f.children = [];
  return f;
}
function fakeApp(folders, basePath) {
  return {
    vault: {
      getFolderByPath(p) { return folders[p] || null; },
      getAbstractFileByPath() { return null; },
      getAllLoadedFiles() { return Object.keys(folders).map((k) => folders[k]); },
      adapter: basePath ? { getBasePath: () => basePath } : {},
    },
  };
}
const REAL = 'E Yearify/E3 项目/E.200102-家庭数据中心设计与规划';
const realFolders = { [REAL]: fakeFolder(REAL) };

check('normalizeVaultPath：反斜杠 → 正斜杠', () => {
  assert(I.normalizeVaultPath('E Yearify\\E3 项目\\E.200102-家庭数据中心设计与规划') === REAL,
    '反斜杠未转换：' + I.normalizeVaultPath('a\\b\\c'));
});
check('normalizeVaultPath：引号 / 首尾斜杠 / 重复斜杠 / ./', () => {
  assert(I.normalizeVaultPath('  "附件/照片"  ') === '附件/照片', '引号与空格未处理');
  assert(I.normalizeVaultPath('/附件//照片/') === '附件/照片', '斜杠未收敛');
  assert(I.normalizeVaultPath('./附件') === '附件', './ 未去掉');
  assert(I.normalizeVaultPath("'a\\\\b'") === 'a/b', '单引号 + 反斜杠未处理');
});
check('resolveFolder：用户那种反斜杠路径必须能找到（本次 bug 的回归测试）', () => {
  const app = fakeApp(realFolders, 'E:\\Dnotes');
  const f = I.resolveFolder(app, 'E Yearify\\E3 项目\\E.200102-家庭数据中心设计与规划');
  assert(f && f.path === REAL, '反斜杠路径没解析到文件夹');
});
check('resolveFolder：正斜杠路径照常能找到', () => {
  const app = fakeApp(realFolders, 'E:\\Dnotes');
  assert(I.resolveFolder(app, REAL) !== null, '正斜杠路径反而找不到');
});
check('resolveFolder：剥掉库根绝对前缀', () => {
  const app = fakeApp(realFolders, 'E:\\Dnotes');
  const f = I.resolveFolder(app, 'E:\\Dnotes\\E Yearify\\E3 项目\\E.200102-家庭数据中心设计与规划');
  assert(f && f.path === REAL, '绝对路径未被剥成库内路径');
});
check('resolveFolder：没有库根时按去盘符兜底', () => {
  const app = fakeApp(realFolders, '');
  const f = I.resolveFolder(app, 'E:\\Dnotes\\E Yearify\\E3 项目\\E.200102-家庭数据中心设计与规划');
  assert(f && f.path === REAL, '去盘符兜底失败：得到 ' + (f && f.path));
});
check('resolveFolder：大小写不敏感兜底', () => {
  const app = fakeApp(realFolders, 'E:\\Dnotes');
  const f = I.resolveFolder(app, 'e yearify\\e3 项目\\e.200102-家庭数据中心设计与规划');
  assert(f && f.path === REAL, '大小写不同就找不到了');
});
check('resolveFolder：真不存在时返回 null（不能乱认）', () => {
  const app = fakeApp(realFolders, 'E:\\Dnotes');
  assert(I.resolveFolder(app, '不存在的目录/abc') === null, '不该找到却找到了');
  assert(I.resolveFolder(app, '') === null, '空路径应返回 null');
});

/* ====================== 6. 大数量性能计时 ====================== */
console.log('\n[6] 性能计时（本机 Node，仅证明布局本身不是瓶颈）');
function bench(label, fn) {
  fn(); // 预热
  const t0 = performance.now();
  const out = fn();
  const dt = performance.now() - t0;
  console.log(`  ${label}：${dt.toFixed(2)} ms`);
  return { dt, out };
}

for (const n of [1000, 10000, 50000]) {
  const ratios = Array.from({ length: n }, (_, i) => 0.5 + ((i * 31) % 100) / 50);
  const h = bench(`horizontal ${n} 张：布局`, () => I.computeLayout(n, ratios, { type: 'horizontal', width: 900, height: 260, gap: 8, columns: 0, estimate: 1.4 }));
  const v = bench(`vertical   ${n} 张：布局`, () => I.computeLayout(n, ratios, { type: 'vertical', width: 900, height: 260, gap: 8, columns: 5, estimate: 1.4 }));
  const layout = h.out;
  bench(`horizontal ${n} 张：可见区间检索 ×1000`, () => {
    let total = 0;
    for (let k = 0; k < 1000; k++) total += I.visibleIndices(layout, (k * layout.totalHeight) / 1000, (k * layout.totalHeight) / 1000 + 900).length;
    return total;
  });
  const budget = 350;
  check(`${n} 张布局耗时 < ${budget}ms（实际 ${h.dt.toFixed(1)}/${v.dt.toFixed(1)}ms）`, () => {
    assert(h.dt < budget && v.dt < budget, '布局超预算');
  });
}

/* ---- 汇总 ---- */
console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
