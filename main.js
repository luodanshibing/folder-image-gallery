'use strict';

/* ============================================================================
 * Folder Image Gallery v2.0.0 —— 高性能瀑布流画廊（虚拟滚动版）
 * ----------------------------------------------------------------------------
 * 用法：在任意笔记中写 ```gallery 代码块，指定 folder（或 path）即可。
 *
 * 为什么图片再多也不卡（性能三板斧）：
 *   1) 尺寸缓存 + 邻域预探测
 *      布局前就知道尽量多的宽高比（首次探测、之后走缓存），避免"先乱排、再重排"的抖动。
 *   2) 自算坐标布局（纯算术，无 DOM）
 *      justified 行 / 多列瀑布，一次性算出每张图的 (x, y, w, h) 与总高，
 *      布局不是让浏览器一张张图片去试，而是一次算完。
 *   3) 窗口化渲染
 *      只有视口附近（±OVERSCAN_PX）的几十张图会真正挂进 DOM；滚出视野的单元格直接卸载、
 *      并释放图片解码内存。DOM 节点数与图片总数解耦，几万张也只是几十个节点。
 *
 * 其它要点：
 *   - 零构建：本文件就是 Obsidian 直接加载的 main.js，不依赖任何打包工具；
 *   - 图片按需赋 src（滚动到附近才加载），失败自动回退二进制读取 + Blob；
 *   - 宽高比缓存持久化在插件 data.json，键为 路径@修改时间@大小，文件一变自动失效；
 *   - 文件夹增删改会自动刷新正在显示的画廊（防抖 500ms）。
 * ========================================================================== */

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const PluginSettingTab = obsidian.PluginSettingTab;
const Setting = obsidian.Setting;
const MarkdownRenderChild = obsidian.MarkdownRenderChild;
const TFile = obsidian.TFile;
const TFolder = obsidian.TFolder;

/* ---------------------------------------------------------------- 常量 --- */

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff', 'tif', 'ico',
]);
const SORT_KEYS = new Set(['name', 'mtime', 'ctime']);
const SORT_ORDERS = new Set(['asc', 'desc']);

const DEFAULT_RATIO = 1.4;      // 宽高比未知时的占位值（略偏横向，接近常见照片）
const MIN_RATIO = 0.12;         // 极端长图保护：不小于 1:8.3
const MAX_RATIO = 12;           // 极端宽图保护：不大于 12:1
const ROW_TOLERANCE = 0.3;      // justified 行高允许的偏差，越小越贴近目标行高
const MIN_ROW_HEIGHT = 40;
const V_MIN_COLUMN_WIDTH = 220; // vertical 自适应时的最小列宽

const OVERSCAN_PX = 900;        // 视口外多渲染的像素范围
const MAX_MOUNTED = 240;        // 同时挂在 DOM 里的单元格硬上限（安全阀）
const PROBE_AHEAD_PX = 2000;    // 向下预探测范围
const PROBE_BACK_PX = 600;      // 向上预探测范围
const PROBE_CONCURRENCY = 5;    // 尺寸探测并发
const PROBE_TIMEOUT_MS = 20000;
const PROBE_QUEUE_MAX = 600;

const CACHE_MAX_ENTRIES = 20000;   // 宽高比缓存条数上限（超出淘汰最早的）
const CACHE_SAVE_DELAY_MS = 3000;  // 缓存落盘防抖
const RESIZE_DEBOUNCE_MS = 120;

/* ------------------------------------------------------------ 小工具 --- */

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function normalizeRatio(ratio) {
  if (!isFinite(ratio) || ratio <= 0) return 0;
  return clamp(ratio, MIN_RATIO, MAX_RATIO);
}

function toInt(value) {
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? -1 : n;
}

/** 找到最近的可滚动祖先（没有则返回 null，表示用窗口视口）。 */
function findScrollParent(el) {
  let p = el.parentElement;
  while (p && p !== document.body && p !== document.documentElement) {
    const style = window.getComputedStyle(p);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 2) {
      return p;
    }
    p = p.parentElement;
  }
  return null;
}

/**
 * 把用户写的路径收拾成库内标准路径。
 * 用户经常直接从资源管理器复制 Windows 路径（`E Yearify\E3 项目\...`），
 * 而 Obsidian 的库内路径一律用正斜杠 —— 不转换的话 getFolderByPath 永远找不到。
 */
function normalizeVaultPath(raw) {
  let p = String(raw == null ? '' : raw).trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  p = p.replace(/\\/g, '/');        // 反斜杠 → 正斜杠
  p = p.replace(/\/{2,}/g, '/');    // 折叠重复斜杠
  p = p.replace(/^\.\//, '');       // 去掉开头的 ./
  p = p.replace(/^\/+|\/+$/g, '');  // 去掉首尾斜杠
  return p;
}

/**
 * 尽力找到文件夹，按容错顺序试：
 * 标准路径 → 剥掉库根绝对前缀 → 去掉盘符 → 大小写不敏感兜底扫一遍。
 */
function resolveFolder(app, raw) {
  const wanted = normalizeVaultPath(raw);
  if (!wanted) return null;

  const tryPath = (p) => {
    if (!p) return null;
    let found = null;
    try { found = app.vault.getFolderByPath(p); } catch (e) { found = null; }
    if (!found && typeof app.vault.getAbstractFileByPath === 'function') {
      try { found = app.vault.getAbstractFileByPath(p); } catch (e) { found = null; }
    }
    return found instanceof TFolder ? found : null;
  };

  let folder = tryPath(wanted);
  if (folder) return folder;

  const adapter = app.vault.adapter;
  const base = adapter && typeof adapter.getBasePath === 'function'
    ? normalizeVaultPath(adapter.getBasePath())
    : '';
  if (base && wanted.toLowerCase().indexOf(`${base.toLowerCase()}/`) === 0) {
    folder = tryPath(wanted.slice(base.length + 1));
    if (folder) return folder;
  }

  // 用户直接把整个 Windows 路径贴进来时：从后往前逐段当库内路径试
  if (/^[a-zA-Z]:\//.test(wanted)) {
    const parts = wanted.split('/');
    for (let i = 1; i < parts.length; i++) {
      folder = tryPath(parts.slice(i).join('/'));
      if (folder) return folder;
    }
  }

  const lower = wanted.toLowerCase();
  const all = typeof app.vault.getAllLoadedFiles === 'function' ? app.vault.getAllLoadedFiles() : [];
  for (const file of all) {
    if (!(file instanceof TFolder)) continue;
    const fp = file.path.toLowerCase();
    if (fp === lower || lower.endsWith('/' + fp)) return file;
  }
  return null;
}

/* ------------------------------------------------------- 代码块参数解析 --- */

function parseGalleryOptions(source) {
  const opts = {};
  for (const rawLine of String(source || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1);
    value = value.replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case 'folder':
      case 'path':
        opts.folder = value;
        break;
      case 'type':
        if (value === 'horizontal' || value === 'justified') opts.type = 'horizontal';
        else if (value === 'vertical' || value === 'masonry') opts.type = 'vertical';
        break;
      case 'columns': {
        const n = toInt(value);
        if (n >= 0) opts.columns = n;
        break;
      }
      case 'height': {
        const n = toInt(value);
        if (n >= 0) opts.height = n;
        break;
      }
      case 'gap':
      case 'gutter': {
        const n = toInt(value);
        if (n >= 0) opts.gap = n;
        break;
      }
      case 'sort':
      case 'sortby':
        if (SORT_KEYS.has(value)) opts.sort = value;
        else if (SORT_ORDERS.has(value)) opts.order = value;
        break;
      case 'order':
        if (SORT_ORDERS.has(value)) opts.order = value;
        break;
      case 'max': {
        const n = toInt(value);
        if (n >= 0) opts.max = n;
        break;
      }
      case 'recursive':
        opts.recursive = value === 'true' || value === '1' || value === 'yes';
        break;
      case 'title':
        opts.title = value;
        break;
    }
  }
  return opts;
}

/* ----------------------------------------------------------- 布局引擎 --- */
/* 输入：图片数量 + 宽高比数组 + 视图参数；输出：每张图的 (x,y,w,h) + 总高。
 * 纯算术、无 DOM、可单测；布局只在「尺寸/容器宽度变化」时重算一次。 */

/**
 * justified 行布局：把图片按宽高比依次装进一行，行内按比例分宽、等高，整行铺满容器。
 * 行高在 targetH 附近，偏差不超过 tolerance。
 */
function layoutJustified(count, ratios, width, targetH, gap, tolerance, estimate) {
  const rects = new Array(count);
  const rows = [];
  const avail = Math.max(width, 1);
  const upper = targetH * (1 + tolerance); // 行高上限：贪心最迟停在这里
  const heightCap = Math.max(targetH * 3, 600); // 孤图封顶（例如一张 1:8 的长图）
  let y = 0;
  let start = 0;

  while (start < count) {
    let sum = 0;
    let end = start + 1;
    let rowH = targetH;

    for (let i = start; i < count; i++) {
      const r = ratios[i] > 0 ? ratios[i] : estimate;
      const n = i - start + 1;
      const sumKeep = sum + r;
      const hKeep = (avail - gap * (n - 1)) / sumKeep;
      if (hKeep <= upper || i === count - 1) {
        end = i + 1;
        rowH = hKeep;
        // 再比一次"把本张留给下一行"：两者都填满整行，取更接近目标行高的那个
        if (n > 1) {
          const hDrop = (avail - gap * (n - 2)) / sum;
          if (Math.abs(hDrop - targetH) < Math.abs(hKeep - targetH)) {
            end = i;
            rowH = hDrop;
          }
        }
        break;
      }
      sum = sumKeep;
    }

    let rowSum = 0;
    for (let k = start; k < end; k++) rowSum += ratios[k] > 0 ? ratios[k] : estimate;
    rowSum = Math.max(rowSum, 1e-6);

    let leftAligned = false;
    if (end === count && rowH > upper) {
      rowH = targetH;          // 末行铺不满：按目标行高左对齐，不拉伸
      leftAligned = true;
    } else if (rowH > heightCap) {
      rowH = heightCap;        // 单张超高：封顶后左对齐
      leftAligned = true;
    }
    rowH = Math.max(1, rowH);

    let x = 0;
    for (let i = start; i < end; i++) {
      const r = ratios[i] > 0 ? ratios[i] : estimate;
      let w = r * rowH;
      if (i === end - 1 && !leftAligned) w = Math.max(0, avail - x); // 末张吃掉舍入误差，整行严丝合缝
      rects[i] = { x, y, w, h: rowH };
      x += w + gap;
    }
    rows.push({ y, h: rowH, start, end, leftAligned });
    y += rowH + gap;
    start = end;
  }

  return { rects, rows, totalHeight: Math.max(0, y - gap) };
}

/** 多列瀑布：每张图落到当前最矮的列，保持原始宽高比（不裁切形变）。 */
function layoutMasonry(count, ratios, width, columns, gap, minColumnWidth, estimate) {
  const cols = columns > 0
    ? Math.max(1, Math.floor(columns))
    : Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
  const colW = Math.max(1, (width - gap * (cols - 1)) / cols);
  const colH = new Array(cols).fill(0);
  const rects = new Array(count);

  for (let i = 0; i < count; i++) {
    let c = 0;
    for (let k = 1; k < cols; k++) {
      if (colH[k] < colH[c] - 0.5) c = k;
    }
    const r = ratios[i] > 0 ? ratios[i] : estimate;
    const h = colW / r;
    rects[i] = { x: c * (colW + gap), y: colH[c], w: colW, h };
    colH[c] += h + gap;
  }

  let maxH = 0;
  for (let k = 0; k < cols; k++) if (colH[k] > maxH) maxH = colH[k];
  return {
    rects,
    columns: cols,
    columnWidth: colW,
    totalHeight: Math.max(0, maxH - gap),
  };
}

/**
 * 统一入口：产出 rects / totalHeight / 供视口检索用的 order 索引。
 * order 按 y 升序，便于二分定位可见区间。
 */
function computeLayout(count, ratios, view) {
  const width = Math.max(40, view.width);
  const gap = Math.max(0, view.gap);
  const estimate = view.estimate > 0 ? view.estimate : DEFAULT_RATIO;
  const type = view.type === 'vertical' ? 'vertical' : 'horizontal';

  const result = type === 'vertical'
    ? layoutMasonry(count, ratios, width, view.columns, gap, V_MIN_COLUMN_WIDTH, estimate)
    : layoutJustified(count, ratios, width, Math.max(MIN_ROW_HEIGHT, view.height), gap, ROW_TOLERANCE, estimate);

  const order = new Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  if (type === 'vertical') {
    order.sort((a, b) => (result.rects[a].y - result.rects[b].y) || (a - b));
  }

  const orderY = new Float64Array(count);
  let maxHeight = 0;
  for (let i = 0; i < count; i++) {
    const rect = result.rects[i];
    orderY[i] = result.rects[order[i]].y;
    if (rect.h > maxHeight) maxHeight = rect.h;
  }

  return {
    type,
    rects: result.rects,
    totalHeight: result.totalHeight,
    order,
    orderY,
    maxHeight,
    meta: result,
  };
}

/** 二分：orderY 中第一个 >= target 的下标。 */
function lowerBound(orderY, target) {
  let lo = 0;
  let hi = orderY.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (orderY[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 返回与 [y0, y1] 相交的图片下标（按 y 升序）。
 * 从 y0 - maxHeight 处开始扫，保证"起点在视口上方、但底部伸进视口"的大图不漏。
 */
function visibleIndices(layout, y0, y1) {
  const order = layout.order;
  const n = order.length;
  const out = [];
  const start = lowerBound(layout.orderY, y0 - layout.maxHeight);
  for (let i = start; i < n; i++) {
    if (layout.orderY[i] > y1) break;
    const idx = order[i];
    const rect = layout.rects[idx];
    if (rect.y + rect.h >= y0) out.push(idx);
  }
  return out;
}

/** 数量超上限时，保留离视口中心最近的若干张。 */
function nearestIndices(layout, indices, centerY, cap) {
  if (indices.length <= cap) return indices;
  const arr = indices.slice();
  arr.sort((a, b) => {
    const ra = layout.rects[a];
    const rb = layout.rects[b];
    return Math.abs(ra.y + ra.h / 2 - centerY) - Math.abs(rb.y + rb.h / 2 - centerY);
  });
  arr.length = cap;
  return arr;
}

/* -------------------------------------------------------- 宽高比缓存 --- */

class RatioCache {
  constructor(raw) {
    this.map = Object.create(null);
    this.dirty = false;
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        const ratio = raw[key];
        if (typeof ratio === 'number' && isFinite(ratio) && ratio > 0) {
          this.map[key] = ratio;
        }
      }
    }
  }

  key(file) {
    const stat = file && file.stat ? file.stat : null;
    const mtime = stat && stat.mtime ? stat.mtime : 0;
    const size = stat && stat.size ? stat.size : 0;
    return `${file.path}\u0000${mtime}\u0000${size}`;
  }

  get(file) {
    const ratio = this.map[this.key(file)];
    return typeof ratio === 'number' && ratio > 0 ? ratio : 0;
  }

  set(file, ratio) {
    const normalized = normalizeRatio(ratio);
    if (!normalized) return;
    const key = this.key(file);
    if (!(key in this.map)) {
      const keys = Object.keys(this.map);
      if (keys.length >= CACHE_MAX_ENTRIES) {
        for (let i = 0; i < keys.length - CACHE_MAX_ENTRIES + 1; i++) delete this.map[keys[i]];
      }
    }
    this.map[key] = Math.round(normalized * 1000) / 1000;
    this.dirty = true;
  }

  get size() {
    return Object.keys(this.map).length;
  }

  clear() {
    this.map = Object.create(null);
    this.dirty = true;
  }
}

/* ---------------------------------------------------------- 尺寸探测 --- */

/** 只加载不解码进页面的方式拿到宽高比；超时/失败返回 0。 */
function probeRatio(src, timeoutMs) {
  return new Promise((resolve) => {
    if (!src) { resolve(0); return; }
    const img = new Image();
    let settled = false;
    let timer = 0;
    const finish = (ratio) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      resolve(ratio);
    };
    img.onload = () => {
      finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? normalizeRatio(img.naturalWidth / img.naturalHeight) : 0);
    };
    img.onerror = () => finish(0);
    timer = window.setTimeout(() => finish(0), timeoutMs || PROBE_TIMEOUT_MS);
    img.decoding = 'async';
    img.src = src;
  });
}

/* ------------------------------------------------------- 画廊渲染器 --- */

class GalleryRenderer extends MarkdownRenderChild {
  constructor(plugin, el, opts) {
    super(el);
    this.plugin = plugin;
    this.app = plugin.app;
    this.opts = opts;

    this.cancelled = false;
    this.items = [];
    this.ratios = [];
    this.known = null;
    this.layout = null;
    this.viewportEl = null;
    this.mounted = new Map();

    this.probeQueue = [];
    this.probePending = new Set();
    this.probeActive = 0;

    this.dirty = false;
    this.geomDirty = false;
    this.rafId = 0;
    this.frameId = 0;
    this.resizeTimer = 0;

    this.attached = false;
    this.scrollParent = null;
    this.scrollRetries = 0;
    this.resizeObserver = null;
    this.lastWidth = 0;
    this.onScrollBound = () => this.requestUpdate();
  }

  /* ---- 生命周期 ---- */

  start() {
    this.render();
  }

  onunload() {
    this.cancelled = true;
    this.probeQueue.length = 0;
    this.probePending.clear();
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    if (this.frameId) window.cancelAnimationFrame(this.frameId);
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.rafId = 0;
    this.frameId = 0;
    if (this.attached) {
      document.removeEventListener('scroll', this.onScrollBound, true);
      window.removeEventListener('resize', this.onScrollBound);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.unmountAll();
    this.plugin.forgetRenderer(this);
  }

  /* ---- 主流程 ---- */

  render() {
    const el = this.containerEl;
    this.unmountAll();
    el.empty();
    el.addClass('fg-gallery');
    // 重扫时先把上一轮的引用清掉：下面任何提前 return 都不会再往"已摘下的容器"里加载图片
    this.viewportEl = null;
    this.layout = null;
    this.items = [];
    this.ratios = [];

    if (this.opts.title) {
      el.createDiv({ cls: 'fg-title', text: this.opts.title });
    }
    if (!this.opts.folder) {
      el.createDiv({ cls: 'fg-empty', text: '缺少 folder/path 参数：请指定要展示图片的文件夹。' });
      return;
    }
    const wantedPath = normalizeVaultPath(this.opts.folder);
    if (!wantedPath) {
      el.createDiv({ cls: 'fg-empty', text: 'folder/path 是空的：请填相对库根目录的文件夹名。' });
      return;
    }
    const folder = resolveFolder(this.app, wantedPath);
    if (!folder) {
      el.createDiv({
        cls: 'fg-empty',
        text: `未找到文件夹：“${wantedPath}”。反斜杠 \\ 已自动换算成正斜杠，若仍找不到，请核对它确实是相对库根目录的路径`
          + `（不要带盘符或库名）；值中 # 之后是注释，会被忽略。`,
      });
      return;
    }
    this.folderPath = folder.path;

    const files = [];
    collectImages(folder, this.opts.recursive, files);
    if (files.length === 0) {
      el.createDiv({ cls: 'fg-empty', text: `文件夹 ${folder.path} 中没有图片（支持的格式见插件说明）。` });
      return;
    }
    sortFiles(files, this.opts.sort, this.opts.order);
    this.items = this.opts.max > 0 ? files.slice(0, this.opts.max) : files;

    const count = this.items.length;
    this.ratios = new Array(count);
    this.known = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const cached = this.plugin.getCachedRatio(this.items[i]);
      this.ratios[i] = cached;
      if (cached > 0) this.known[i] = 1;
    }

    this.viewportEl = el.createDiv({ cls: 'fg-viewport' });
    this.layout = null;
    this.geomDirty = true;
    this.attachListeners();
    this.scrollParent = findScrollParent(this.containerEl);
    this.relayout(-1);
  }

  /** 文件夹内容变化时重扫（由插件统一调度）。 */
  rescan() {
    if (this.cancelled) return;
    const anchor = this.anchorIndex();
    this.render();
    this.relayout(anchor);
  }

  /* ---- 布局 ---- */

  measureWidth() {
    let width = 0;
    if (this.containerEl) width = this.containerEl.clientWidth;
    if (!width && this.viewportEl) width = this.viewportEl.clientWidth;
    if (!width) width = 700; // 尚未上屏时的兜底宽度，ResizeObserver 会纠正
    return Math.max(120, width);
  }

  estimateRatio() {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.ratios.length && n < 80; i++) {
      const r = this.ratios[i];
      if (r > 0) { sum += r; n++; }
    }
    return n >= 5 ? clamp(sum / n, 0.5, 3) : DEFAULT_RATIO;
  }

  buildLayout() {
    const width = this.measureWidth();
    this.lastWidth = width;
    return computeLayout(this.items.length, this.ratios, {
      type: this.opts.type,
      width,
      height: this.opts.height,
      columns: this.opts.columns,
      gap: this.opts.gap,
      estimate: this.estimateRatio(),
    });
  }

  /**
   * 重算布局。anchorIndex 是"当前视口里最上面那张图"：
   * 布局变化若把它推走，就用滚动补偿抵掉，保证正在看的画面不跳。
   */
  relayout(anchorIndex) {
    if (this.cancelled || !this.items.length || !this.viewportEl) return;
    const prev = this.layout;
    const prevY = prev && anchorIndex >= 0 ? prev.rects[anchorIndex].y : 0;

    this.layout = this.buildLayout();
    this.viewportEl.style.height = `${Math.round(this.layout.totalHeight)}px`;
    this.viewportEl.style.width = '100%';

    // 首次渲染时容器还没有高度，祖先可能"看起来不可滚动"；布局出来后再认一次滚动容器
    if (!this.scrollParent && this.scrollRetries < 5) {
      this.scrollRetries++;
      this.scrollParent = findScrollParent(this.containerEl);
    }

    if (prev && anchorIndex >= 0 && this.mounted.has(anchorIndex)) {
      const dy = this.layout.rects[anchorIndex].y - prevY;
      if (Math.abs(dy) >= 2) {
        const scroller = this.scrollParent;
        if (scroller) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
      }
    }

    this.geomDirty = true;
    this.updateWindow();
  }

  /* ---- 视口与窗口化 ---- */

  band() {
    if (!this.viewportEl || !this.layout) return null;
    const rect = this.viewportEl.getBoundingClientRect();
    let top = 0;
    let bottom = window.innerHeight || 800;
    const scroller = this.scrollParent;
    if (scroller && scroller.isConnected) {
      const r = scroller.getBoundingClientRect();
      top = r.top;
      bottom = r.bottom;
    }
    const y0 = top - rect.top;
    const y1 = bottom - rect.top;
    return {
      y0,
      y1,
      visible: y1 > -OVERSCAN_PX && y0 < this.layout.totalHeight + OVERSCAN_PX,
    };
  }

  requestUpdate() {
    if (this.frameId || this.cancelled) return;
    this.frameId = window.requestAnimationFrame(() => {
      this.frameId = 0;
      this.updateWindow();
    });
  }

  updateWindow() {
    if (this.cancelled || !this.layout || !this.viewportEl) return;
    const band = this.band();
    if (!band) return;

    let indices = visibleIndices(this.layout, band.y0 - OVERSCAN_PX, band.y1 + OVERSCAN_PX);
    if (indices.length > MAX_MOUNTED) {
      indices = nearestIndices(this.layout, indices, (band.y0 + band.y1) / 2, MAX_MOUNTED);
    }
    const needed = new Set(indices);

    for (const index of Array.from(this.mounted.keys())) {
      if (!needed.has(index)) this.unmount(index);
    }

    let added = 0;
    const fragment = document.createDocumentFragment();
    for (const index of indices) {
      const cell = this.mounted.get(index);
      if (!cell) {
        fragment.appendChild(this.createCell(index));
        added++;
      } else if (this.geomDirty) {
        this.applyGeometry(cell, this.layout.rects[index]);
      }
    }
    if (added > 0) this.viewportEl.appendChild(fragment);
    this.geomDirty = false;

    this.scheduleProbes(band);
  }

  applyGeometry(cell, rect) {
    cell.style.transform = `translate(${Math.round(rect.x)}px, ${Math.round(rect.y)}px)`;
    cell.style.width = `${Math.round(rect.w)}px`;
    cell.style.height = `${Math.round(rect.h)}px`;
  }

  createCell(index) {
    const file = this.items[index];
    const cell = document.createElement('div');
    cell.className = `fg-cell ${this.opts.type === 'vertical' ? 'fg-v' : 'fg-h'}`;
    cell.title = file.basename || file.name || '';
    this.applyGeometry(cell, this.layout.rects[index]);

    const img = document.createElement('img');
    img.className = 'fg-img';
    img.alt = file.basename || '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('load', () => this.onImageLoad(index, img, cell), { once: true });
    img.addEventListener('error', () => this.onImageError(index, img, cell), { once: true });
    img.src = this.srcFor(file);
    // 命中缓存时 load 可能已经过去，补一次状态
    if (img.complete && img.naturalWidth > 0) this.onImageLoad(index, img, cell);

    cell.appendChild(img);
    this.mounted.set(index, cell);
    return cell;
  }

  unmount(index) {
    const cell = this.mounted.get(index);
    if (!cell) return;
    this.mounted.delete(index);
    const img = cell.querySelector('img');
    if (img) {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src'); // 释放解码位图
    }
    if (cell.__fgBlobUrl) {
      try { URL.revokeObjectURL(cell.__fgBlobUrl); } catch (e) { /* 忽略 */ }
      cell.__fgBlobUrl = null;
    }
    cell.remove();
  }

  unmountAll() {
    for (const index of Array.from(this.mounted.keys())) this.unmount(index);
  }

  srcFor(file) {
    try {
      return this.app.vault.getResourcePath(file);
    } catch (e) {
      return '';
    }
  }

  anchorIndex() {
    const band = this.band();
    if (!band || !this.layout) return -1;
    let best = -1;
    let bestY = Infinity;
    for (const index of this.mounted.keys()) {
      const rect = this.layout.rects[index];
      if (rect.y + rect.h < band.y0 || rect.y > band.y1) continue;
      if (rect.y < bestY) { bestY = rect.y; best = index; }
    }
    return best;
  }

  /* ---- 图片事件 ---- */

  onImageLoad(index, img, cell) {
    if (img.dataset.fgDone === '1') return;
    img.dataset.fgDone = '1';
    img.classList.add('fg-loaded');

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w > 0 && h > 0) {
      const ratio = normalizeRatio(w / h);
      const old = this.ratios[index];
      if (ratio > 0 && Math.abs(ratio - old) > 0.01) {
        this.ratios[index] = ratio;
        this.known[index] = 1;
        this.plugin.setCachedRatio(this.items[index], ratio);
        this.dirty = true;
        this.flushDirty();
      }
    }
  }

  onImageError(index, img, cell) {
    if (img.dataset.fgFallback === '1') {
      cell.classList.add('fg-error');
      return;
    }
    img.dataset.fgFallback = '1';
    const file = this.items[index];
    Promise.resolve()
      .then(() => this.app.vault.readBinary(file))
      .then((data) => {
        if (this.cancelled || !cell.isConnected) return;
        const url = URL.createObjectURL(new Blob([data]));
        cell.__fgBlobUrl = url;
        img.src = url; // 原来的 load 监听会接手后续状态
      })
      .catch(() => {
        if (cell.isConnected) cell.classList.add('fg-error');
      });
  }

  /* ---- 尺寸预探测 ---- */

  scheduleProbes(band) {
    if (this.cancelled || document.hidden || !band.visible) return;
    const indices = visibleIndices(this.layout, band.y0 - PROBE_BACK_PX, band.y1 + PROBE_AHEAD_PX);
    let queued = 0;
    for (const index of indices) {
      if (this.known[index] || this.probePending.has(index)) continue;
      this.probePending.add(index);
      this.probeQueue.push(index);
      if (++queued >= PROBE_QUEUE_MAX) break;
    }
    if (this.probeQueue.length > 1) {
      const centerY = band.y0;
      const rects = this.layout.rects;
      this.probeQueue.sort((a, b) => {
        const da = Math.abs(rects[a].y - centerY);
        const db = Math.abs(rects[b].y - centerY);
        return da - db;
      });
    }
    this.pumpProbes();
  }

  pumpProbes() {
    while (this.probeActive < PROBE_CONCURRENCY && this.probeQueue.length) {
      const index = this.probeQueue.shift();
      if (this.cancelled) return;
      if (this.known[index]) {
        this.probePending.delete(index);
        continue;
      }
      this.probeActive++;
      probeRatio(this.srcFor(this.items[index]), PROBE_TIMEOUT_MS).then((ratio) => {
        this.probeActive--;
        this.probePending.delete(index);
        if (this.cancelled) return;
        if (ratio > 0 && !this.known[index]) {
          this.ratios[index] = ratio;
          this.known[index] = 1;
          this.plugin.setCachedRatio(this.items[index], ratio);
          this.dirty = true;
          this.flushDirty();
        }
        this.pumpProbes();
      });
    }
  }

  flushDirty() {
    if (this.rafId || this.cancelled) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.cancelled || !this.dirty) return;
      this.dirty = false;
      this.relayout(this.anchorIndex());
    });
  }

  /* ---- 事件绑定 ---- */

  attachListeners() {
    if (this.attached) return;
    this.attached = true;
    document.addEventListener('scroll', this.onScrollBound, true);
    window.addEventListener('resize', this.onScrollBound);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(this.containerEl);
    }
    this.plugin.trackRenderer(this);
  }

  onResize() {
    if (this.cancelled) return;
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = 0;
      if (this.cancelled) return;
      this.scrollParent = findScrollParent(this.containerEl);
      const width = this.measureWidth();
      if (Math.abs(width - this.lastWidth) > 1) {
        this.relayout(this.anchorIndex());
      } else {
        this.updateWindow();
      }
    }, RESIZE_DEBOUNCE_MS);
  }

  /** 文件夹路径是否影响本画廊（用于自动刷新）。 */
  affectedBy(path) {
    const folder = this.folderPath || normalizeVaultPath(this.opts.folder);
    if (!folder) return false;
    const p = normalizeVaultPath(path);
    if (p === folder) return true; // 文件夹自身被删/改名
    if (this.opts.recursive) return p.startsWith(folder + '/');
    const idx = p.lastIndexOf('/');
    const parent = idx === -1 ? '' : p.slice(0, idx);
    return parent === folder;
  }
}

/* ------------------------------------------------- 文件收集 / 排序 --- */

function collectImages(folder, recursive, out) {
  for (const child of folder.children) {
    if (child instanceof TFolder) {
      if (recursive) collectImages(child, recursive, out);
    } else if (child instanceof TFile) {
      if (IMAGE_EXTENSIONS.has(child.extension.toLowerCase())) out.push(child);
    }
  }
}

function sortFiles(files, key, order) {
  const dir = order === 'desc' ? -1 : 1;
  files.sort((a, b) => {
    let cmp = 0;
    if (key === 'name') {
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else if (key === 'mtime') {
      cmp = a.stat.mtime - b.stat.mtime;
    } else {
      cmp = a.stat.ctime - b.stat.ctime;
    }
    return cmp * dir;
  });
}

/* -------------------------------------------------------------- 设置 --- */

const DEFAULT_SETTINGS = {
  defaultType: 'horizontal',
  defaultColumns: 0,
  defaultHeight: 260,
  defaultGap: 8,
  defaultSort: 'mtime',
  defaultOrder: 'desc',
  defaultRecursive: true,
  ratioCache: {},
};

class FolderGallerySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('默认布局')
      .setDesc('horizontal：等高弹性铺满整行的对齐式瀑布流（虚拟滚动）；vertical：多列保持原比例。')
      .addDropdown((d) => d
        .addOption('horizontal', 'horizontal（等高铺满）')
        .addOption('vertical', 'vertical（多列原比例）')
        .setValue(this.plugin.settings.defaultType)
        .onChange(async (v) => {
          this.plugin.settings.defaultType = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认行高 px（horizontal）')
      .addSlider((s) => s
        .setLimits(100, 600, 10)
        .setValue(this.plugin.settings.defaultHeight)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.defaultHeight = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认列数（vertical）')
      .setDesc('0 表示按容器宽度自适应。')
      .addText((t) => t
        .setValue(String(this.plugin.settings.defaultColumns))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.defaultColumns = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认单元格间距（px）')
      .addSlider((s) => s
        .setLimits(0, 24, 1)
        .setValue(this.plugin.settings.defaultGap)
        .setDynamicTooltip()
        .onChange(async (v) => {
          this.plugin.settings.defaultGap = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认排序')
      .addDropdown((d) => d
        .addOption('name', '文件名')
        .addOption('mtime', '修改时间')
        .addOption('ctime', '创建时间')
        .setValue(this.plugin.settings.defaultSort)
        .onChange(async (v) => {
          this.plugin.settings.defaultSort = v;
          await this.plugin.saveSettings();
        }))
      .addDropdown((d) => d
        .addOption('desc', '降序')
        .addOption('asc', '升序')
        .setValue(this.plugin.settings.defaultOrder)
        .onChange(async (v) => {
          this.plugin.settings.defaultOrder = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('默认包含子文件夹')
      .setDesc('画廊代码块未指定 recursive 时，是否递归收集子文件夹中的图片。')
      .addToggle((t) => t
        .setValue(this.plugin.settings.defaultRecursive)
        .onChange(async (v) => {
          this.plugin.settings.defaultRecursive = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('图片尺寸缓存')
      .setDesc(`已记录 ${this.plugin.ratioCache.size} 张图片的宽高比。缓存让画廊第二次打开时无需再探测，直接精确布局。`)
      .addButton((b) => b
        .setButtonText('清空缓存')
        .onClick(async () => {
          this.plugin.ratioCache.clear();
          await this.plugin.saveSettings();
          this.display();
        }));
  }
}

/* -------------------------------------------------------------- 插件 --- */

class FolderGalleryPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.ratioCache = new RatioCache(this.settings.ratioCache);
    this.renderers = new Set();
    this._saveTimer = 0;
    this._vaultTimer = 0;

    this.registerMarkdownCodeBlockProcessor('gallery', (source, el, ctx) => {
      const opts = this.resolveOptions(source);
      const renderer = new GalleryRenderer(this, el, opts);
      ctx.addChild(renderer);
      renderer.start();
    });

    this.addSettingTab(new FolderGallerySettingTab(this.app, this));

    // 只在"受影响的画廊"上重扫：批量导入照片时，别让每张照片都去重算无关的画廊
    const onVaultChange = (file) => this.scheduleVaultRefresh(file && file.path ? file.path : '');
    this.registerEvent(this.app.vault.on('create', onVaultChange));
    this.registerEvent(this.app.vault.on('delete', onVaultChange));
    this.registerEvent(this.app.vault.on('rename', onVaultChange));
  }

  onunload() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    if (this._vaultTimer) window.clearTimeout(this._vaultTimer);
    this._saveTimer = 0;
    this._vaultTimer = 0;
    this.persistCache();
  }

  /** 合并：设置默认值 < 代码块显式参数。 */
  resolveOptions(source) {
    const parsed = parseGalleryOptions(source);
    const s = this.settings;
    return {
      folder: parsed.folder != null ? parsed.folder : '',
      type: parsed.type != null ? parsed.type : s.defaultType,
      columns: parsed.columns != null ? parsed.columns : s.defaultColumns,
      height: parsed.height != null ? parsed.height : s.defaultHeight,
      gap: parsed.gap != null ? parsed.gap : s.defaultGap,
      sort: parsed.sort != null ? parsed.sort : s.defaultSort,
      order: parsed.order != null ? parsed.order : s.defaultOrder,
      max: parsed.max != null ? parsed.max : 0,
      recursive: parsed.recursive != null ? parsed.recursive : s.defaultRecursive,
      title: parsed.title != null ? parsed.title : '',
    };
  }

  getCachedRatio(file) {
    return this.ratioCache.get(file);
  }

  setCachedRatio(file, ratio) {
    this.ratioCache.set(file, ratio);
    this.scheduleCacheSave();
  }

  scheduleCacheSave() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = 0;
      this.persistCache();
    }, CACHE_SAVE_DELAY_MS);
  }

  persistCache() {
    if (!this.ratioCache || !this.ratioCache.dirty) return;
    this.ratioCache.dirty = false;
    this.settings.ratioCache = this.ratioCache.map;
    this.saveData(this.settings);
  }

  trackRenderer(renderer) {
    if (this.renderers) this.renderers.add(renderer);
  }

  forgetRenderer(renderer) {
    if (this.renderers) this.renderers.delete(renderer);
  }

  /** 库里新增/删除/改名后，防抖刷新受影响的画廊。 */
  scheduleVaultRefresh(path) {
    if (!this._changedPaths) this._changedPaths = new Set();
    this._changedPaths.add(path || '*');
    if (this._vaultTimer) window.clearTimeout(this._vaultTimer);
    this._vaultTimer = window.setTimeout(() => {
      this._vaultTimer = 0;
      if (!this.renderers) return;
      const paths = Array.from(this._changedPaths);
      this._changedPaths.clear();
      const all = paths.indexOf('*') !== -1;
      for (const renderer of Array.from(this.renderers)) {
        if (renderer.cancelled) {
          this.renderers.delete(renderer);
          continue;
        }
        if (all || paths.some((p) => renderer.affectedBy(p))) renderer.rescan();
      }
    }, 500);
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!this.settings.ratioCache || typeof this.settings.ratioCache !== 'object') {
      this.settings.ratioCache = {};
    }
  }

  async saveSettings() {
    this.settings.ratioCache = this.ratioCache ? this.ratioCache.map : (this.settings.ratioCache || {});
    if (this.ratioCache) this.ratioCache.dirty = false;
    await this.saveData(this.settings);
  }
}

/* Obsidian 读 exports.default；测试/压测脚本读 __internals。 */
module.exports = FolderGalleryPlugin;
module.exports.default = FolderGalleryPlugin;
module.exports.__internals = {
  DEFAULT_SETTINGS,
  DEFAULT_RATIO,
  OVERSCAN_PX,
  MAX_MOUNTED,
  RatioCache,
  GalleryRenderer,
  parseGalleryOptions,
  computeLayout,
  layoutJustified,
  layoutMasonry,
  visibleIndices,
  nearestIndices,
  normalizeRatio,
  normalizeVaultPath,
  resolveFolder,
  collectImages,
  sortFiles,
};
