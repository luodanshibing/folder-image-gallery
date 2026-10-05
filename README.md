# Folder Image Gallery

[English](#english) · [简体中文](#简体中文)

---

## English

Render an entire folder of images as a **masonry gallery** inside any note, with a single ```` ```gallery ```` code block.

One goal only: **stay smooth no matter how many images** — thousands, tens of thousands.

> What changed in 2.0: instead of putting every image into the DOM at once, it now uses **virtual scrolling**.
> Only a few dozen cells near the viewport are ever mounted; the rest live neither in the DOM nor in memory.
> The look of [lucaorio/obsidian-image-gallery](https://github.com/lucaorio/obsidian-image-gallery) is preserved,
> but the "60 4K images and it stutters" path is gone.

### Why it is fast

| Technique | How | Effect |
|---|---|---|
| Virtual scrolling | Layout is computed up front (x, y, w, h per image); only cells within ~900px above/below the viewport are mounted, and unmounted (with decoded image memory released) as they scroll away | DOM node count is **decoupled** from image count: 20,000 images ≈ 15–30 cells |
| Self-computed layout | Justified rows / columns are plain arithmetic, computed in one pass — the browser never has to decode images one by one and guess | 50,000-image layout in < 10 ms, zero reflow while scrolling |
| Size cache | Aspect ratios cached in the plugin's `data.json`, keyed by `path@mtime@size` | Reopening the same folder lays out precisely, no re-probing |
| Neighbourhood probing | Only probes sizes in a window around the viewport (concurrency 5, scroll has priority) | First screen appears immediately; no pre-reading of the whole folder |
| Lazy `src` | `src` is set only when a cell nears the viewport; failures fall back to binary read + Blob | Never reads thousands of originals at once |
| Scroll anchoring | When a size correction changes layout, scroll compensation pins the picture you are looking at | No "jump" while scrolling |

### Install (manual)

1. Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/folder-image-gallery/`.
2. Restart Obsidian (or `Ctrl/Cmd+P` → "Reload app without saving").
3. Settings → Community plugins → enable **Folder Image Gallery**.

> Coming from the older `folder-gallery`? Delete that old folder first (the plugin id changed).
> This plugin does not conflict with lucaorio's `obsidian-image-gallery`; you can install both and compare.

### Usage (a hand-written code block)

````markdown
```gallery
folder: attachments/photos   # required, path relative to the vault root (alias: path:)
type: horizontal             # horizontal (default, equal-height rows) | vertical (columns, natural ratio)
height: 260                  # row height in px, used by horizontal
columns: 4                   # column count, used by vertical; 0 = fit container width
gap: 8                       # spacing in px (alias: gutter:)
radius: 8                    # corner radius in px (alias: border-radius:); omit = theme default
sort: mtime                  # name | mtime | ctime (alias: sortby:)
order: desc                  # asc | desc
max: 0                       # max images; 0 = all
recursive: true              # include subfolders
title: My photos             # optional caption
```
````

Minimal form:

````markdown
```gallery
folder: attachments
```
````

- In a value, everything after `#` is a comment. Values may be quoted (recommended when they contain spaces).
- **Use forward slashes `/` as separators.** Windows backslash paths pasted from Explorer are converted automatically, and full absolute paths (`E:\Dnotes\...`) have the vault-root prefix stripped before lookup.
- `type` also accepts `justified` (= horizontal) and `masonry` (= vertical).
- lucaorio-compatible spellings are accepted: `path:`, `gutter:`, `sortby:`, `sort: asc|desc`, `radius:`.
  **Migrating from `obsidian-image-gallery`**: change the code-block language from ` ```img-gallery ` to ` ```gallery ` — no other edit needed.
- A gallery note can still be embedded into other notes with `![[note]]`; it renders there too.

### Settings

Settings → Community plugins → Folder Image Gallery: default layout / row height / columns / gap / sort / recursion, plus **clear the image size cache**.  
Values written in a code block override the settings defaults.

### Performance (measured on the bundled bench)

Open `test/stress.html` in a browser — the bench runs `main.js` itself:

| Images | Layout | Peak mounted cells | Peak DOM nodes | Scroll-position check |
|---|---|---|---|---|
| 5,000 | horizontal | 15 | 32 | images visible at 9/9 positions |
| 20,000 | horizontal | 15 | 32 | — |
| 8,000 | vertical | 36 | 74 | — |
| 3,000 | horizontal | 28 | — | 9/9 passed (including bottom) |

For comparison: mounting every image at once (the old approach) reaches ~6,000 nodes at 3,000 images, growing linearly.

> The bench reuses synthetic images, so it stresses **layout / virtualisation / scrolling**. For real-photo decoding cost, judge by feel with your own folder inside Obsidian.

### Files

| File | Purpose |
|---|---|
| `main.js` | The plugin itself (**single file, zero build** — edit and it takes effect, no npm/bundler) |
| `styles.css` | Styles (`.fg-viewport` is the positioning container, `.fg-cell` is absolutely positioned) |
| `manifest.json` | Plugin manifest |
| `test/stress.html` | Bench: synthetic images, automated long scans and random jumps; reports FPS, DOM ceiling, long tasks |
| `test/preview.html` | Static preview: compare horizontal vs vertical layout side by side |

`test/` is development-only; it does not affect plugin loading and can be omitted when installing.

### FAQ

**Nothing shows up?** Three cases:
1. **The code block is not even rendered** (still a grey code block) → the plugin is not enabled: Settings → Community plugins → turn on **Folder Image Gallery**, or restart Obsidian.
2. **"Folder not found: …"** → the path is wrong. It is **relative to the vault root** — no drive letter, no vault name. Prefer `/` as separator (backslashes are converted). To be sure, right-click the folder in the file explorer → "Copy path".
3. **"No images in folder …"** → the path is right, but the folder has no image the plugin recognises. Supported: `jpg jpeg png gif webp bmp svg avif tiff tif ico`. `.heic`, `.psd`, `.dwg`, `.drawio` and similar are not (Obsidian itself cannot display them).

**Images "grow in" on first scroll through a new area?** Expected. Aspect ratios there have not been probed yet, so an average ratio is used as a placeholder and corrected once probing returns. Corrections only happen below the viewport and never move what you are looking at.

**Where is the cache, and does it keep growing?** In the plugin's own `data.json` (`ratioCache`), keyed with file mtime and size, so a changed image invalidates itself. Cap: 20,000 entries, oldest evicted first. Clear it with one click in settings.

**Does it work on mobile?** Yes — it uses Obsidian's `getResourcePath` and no Node/desktop-only APIs.

**Do I need to reopen the note after adding images?** No. Vault create/rename/delete events refresh visible galleries after a 500 ms debounce.

### Development

`main.js` is the source — edit and reload, no build step. To verify:

```bash
node tools/layout-test.mjs     # layout unit tests + 50,000-image timing (needs Node)
```

(`tools/` lives in the project repository, not in the plugin's runtime folder.)

### License

[MIT](LICENSE) © 2026 luodanshibing

---

## 简体中文

在任意笔记中写一个 ```` ```gallery ```` 代码块，把指定文件夹的图片聚合成**瀑布流画廊**。
目标只有一个：**图片再多也不卡**——几千上万张也保持顺滑。

> 2.0 的核心变化：从「一次性把所有图片塞进 DOM」改成**虚拟滚动**。DOM 里始终只挂视口附近的几十张，
> 其余图片既不在 DOM 里、也不在内存里。参考项目 [lucaorio/obsidian-image-gallery](https://github.com/lucaorio/obsidian-image-gallery)
> 的观感被完整保留，但那条「60 张 4K 就卡」的路被换掉了。

### 为什么快

| 手段 | 做法 | 效果 |
|---|---|---|
| 虚拟滚动 | 布局先算好每张图的 (x, y, 宽, 高)，只把视口上下各约 900px 内的单元格挂进 DOM，滚出去的立即卸载并释放图片解码内存 | DOM 节点数与图片总数**解耦**：2 万张 ≈ 15~30 个单元格 |
| 自算布局 | justified 行 / 多列瀑布都是纯算术，一次算完整页；不让浏览器「一张张图片解码后自己试」 | 5 万张布局 < 10ms，滚动时零重排 |
| 尺寸缓存 | 图片宽高比按 `路径@修改时间@大小` 存进插件 data.json | 第二次打开同一文件夹直接精确布局，不再探测 |
| 邻域预探测 | 只对视口前后一段范围探测尺寸（并发 5，滚动优先），不去碰几万张以外的图 | 首屏立刻成型，不预读整个文件夹 |
| 按需赋 src | 图片进入视口附近才设置 `src`；失败自动回退二进制读取 + Blob | 不再一次性读几千个原图 |
| 滚动锚定 | 尺寸修正导致布局变化时，用滚动补偿把正在看的画面钉住 | 不会「滚着滚着跳一下」 |

### 安装

1. 把 `main.js`、`manifest.json`、`styles.css` 拷进库的
   `<库根目录>/.obsidian/plugins/folder-image-gallery/`。
2. 重启 Obsidian（或 `Ctrl/Cmd+P` → 「重新加载应用而不保存」）。
3. 设置 → 第三方插件 → 启用 **Folder Image Gallery**。

> 旧版 `folder-gallery` 请先在 plugins 目录删掉旧文件夹（插件 id 变过）。
> 本插件与 lucaorio 的 `obsidian-image-gallery` 互不冲突，可同时安装对比。

### 用法（只用手写代码块）

````markdown
```gallery
folder: 附件/照片      # 必填，相对库根目录的路径（也可写 path:）
type: horizontal       # horizontal（默认，等高铺满）| vertical（多列原比例）
height: 260            # 行高 px，horizontal 用
columns: 4             # 列数，vertical 用；0 = 按容器宽度自适应
gap: 8                 # 间距 px（也可写 gutter:）
radius: 8              # 圆角 px（也可写 border-radius:）；不写 = 用主题默认圆角
sort: mtime            # name | mtime | ctime（也可写 sortby:）
order: desc            # asc | desc
max: 0                 # 最多展示张数；0 = 全部
recursive: true        # 是否包含子文件夹
title: 我的照片        # 可选标题
```
````

最简写法：

````markdown
```gallery
folder: 附件
```
````

- 值里 `#` 之后是注释，会被忽略；值可以用引号包起来（含空格时建议加）。
- **路径分隔符用正斜杠 `/`**（例 `E Yearify/E3 项目/xxx`）。直接从资源管理器复制的 Windows 反斜杠路径（`E Yearify\E3 项目\xxx`）会自动换算，整条绝对路径（`E:\Dnotes\...`）也会尽量剥掉库根前缀再找。
- `type` 也接受 `justified`（= horizontal）和 `masonry`（= vertical）。
- 兼容 lucaorio 的写法：`path:`、`gutter:`、`sortby:`、`sort: asc|desc`、`radius:` 都认。
  **从社区插件 `obsidian-image-gallery` 迁过来**：把代码块语言从 ` ```img-gallery ` 改成 ` ```gallery ` 即可，参数不用动。
- 画廊文档本身仍可被别的笔记用 `![[文件名]]` 嵌入，嵌入后照样渲染。

### 设置

设置 → 第三方插件 → Folder Image Gallery：

默认布局 / 默认行高 / 默认列数 / 默认间距 / 默认排序 / 默认递归，以及**清空图片尺寸缓存**。
代码块里写了的参数优先于设置里的默认值。

### 性能实测（本机压测台）

用仓库自带的 `test/stress.html`（浏览器直接打开，画面里跑的就是 `main.js` 本体）：

| 图片数量 | 布局 | 峰值挂载单元格 | 峰值 DOM 节点 | 滚动位置校验 |
|---|---|---|---|---|
| 5 000 | horizontal | 15 | 32 | 9/9 个位置可视区都有图 |
| 20 000 | horizontal | 15 | 32 | — |
| 8 000 | vertical | 36 | 74 | — |
| 3 000 | horizontal | 28 | — | 9/9 通过（含滚到底部） |

对照：把同样的图片一次性全部挂进 DOM（旧做法），3 000 张就有约 6 000 个节点，且随数量线性增长。

> 压测台的图片是合成图循环复用，主要压「布局 / 虚拟化 / 滚动」；真实照片的解码开销请用实际文件夹在 Obsidian 里体感。

### 文件说明

| 文件 | 说明 |
|---|---|
| `main.js` | 插件本体（**单文件、零构建**，改完直接生效，不需要 npm/打包） |
| `styles.css` | 样式（`.fg-viewport` 是定位容器，`.fg-cell` 绝对定位） |
| `manifest.json` | 插件清单 |
| `test/stress.html` | 压测台：合成图 + 自动长扫 + 随机跳跃，给出帧率、DOM 上限、长任务数 |
| `test/preview.html` | 静态预览：并排看 horizontal / vertical 排得对不对 |

`test/` 只是开发辅助，不影响插件加载，装进库时可以不带。

### 常见问题

**写了 gallery 却什么都不显示？**
分三种情况看：
1. **连代码块都没渲染**（还是灰底代码）→ 插件没启用：设置 → 第三方插件 → 打开 **Folder Image Gallery**，或重启 Obsidian。
2. **出现「未找到文件夹：…」** → 路径没写对。它是**相对库根目录**的路径，不要带盘符和库名；分隔符建议用正斜杠 `/`（反斜杠会自动换算）。想确认，在左侧文件列表里右键文件夹 →「复制路径」。
3. **出现「文件夹 … 中没有图片」** → 路径对了，但这文件夹里没有插件认识的图片。支持 `jpg jpeg png gif webp bmp svg avif tiff tif ico`；`.heic`、`.psd`、`.dwg`、`.drawio` 这类不算（Obsidian 自己也显示不了）。

**第一次滚动到没看过的位置，图片会「长出来」？**
正常。那一段的宽高比还没探测过，先用平均比例占位，探测回来后布局会修正；修正只发生在视口下方，不会动你正在看的画面。

**缓存存在哪？会不会越来越大？**
存在插件自己的 `data.json`（`ratioCache` 字段），键含文件修改时间和大小，图片一改就自动失效。上限 2 万条，超出淘汰最早的。设置页可一键清空。

**手机上能用吗？**
能。用的是 Obsidian 的 `getResourcePath`，没有 Node/桌面专属调用。

**新增图片要重新打开笔记吗？**
不用。库内文件增删改名会防抖 500ms 后自动刷新正在显示的画廊。

### 开发

`main.js` 就是源码，直接改、直接生效，无需构建。想验证：

```bash
node tools/layout-test.mjs     # 布局算法单测 + 5 万张性能计时（需 Node）
```

（`tools/` 在项目仓库里，不在插件运行目录。）

### 许可证

[MIT](LICENSE) © 2026 luodanshibing
