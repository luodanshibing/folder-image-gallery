# Folder Image Gallery · Obsidian 文件夹图片瀑布流画廊

在任意笔记中写一个 ```` ```gallery ```` 代码块，把指定文件夹的图片聚合成**瀑布流画廊**。
目标只有一个：**图片再多也不卡**——几千上万张也保持顺滑。

> 2.0 的核心变化：从「一次性把所有图片塞进 DOM」改成**虚拟滚动**。DOM 里始终只挂视口附近的几十张，
> 其余图片既不在 DOM 里、也不在内存里。参考项目 [lucaorio/obsidian-image-gallery](https://github.com/lucaorio/obsidian-image-gallery)
> 的观感被完整保留，但那条「60 张 4K 就卡」的路被换掉了。

---

## 为什么快

| 手段 | 做法 | 效果 |
|---|---|---|
| 虚拟滚动 | 布局先算好每张图的 (x, y, 宽, 高)，只把视口上下各约 900px 内的单元格挂进 DOM，滚出去的立即卸载并释放图片解码内存 | DOM 节点数与图片总数**解耦**：2 万张 ≈ 15~30 个单元格 |
| 自算布局 | justified 行 / 多列瀑布都是纯算术，一次算完整页；不让浏览器「一张张图片解码后自己试」 | 5 万张布局 < 10ms，滚动时零重排 |
| 尺寸缓存 | 图片宽高比按 `路径@修改时间@大小` 存进插件 data.json | 第二次打开同一文件夹直接精确布局，不再探测 |
| 邻域预探测 | 只对视口前后一段范围探测尺寸（并发 5，滚动优先），不去碰几万张以外的图 | 首屏立刻成型，不预读整个文件夹 |
| 按需赋 src | 图片进入视口附近才设置 `src`；失败自动回退二进制读取 + Blob | 不再一次性读几千个原图 |
| 滚动锚定 | 尺寸修正导致布局变化时，用滚动补偿把正在看的画面钉住 | 不会「滚着滚着跳一下」 |

---

## 安装

1. 把 `main.js`、`manifest.json`、`styles.css` 拷进库的
   `<库根目录>/.obsidian/plugins/folder-image-gallery/`。
2. 重启 Obsidian（或 `Ctrl/Cmd+P` → 「重新加载应用而不保存」）。
3. 设置 → 第三方插件 → 启用 **Folder Image Gallery**。

> 旧版 `folder-gallery` 请先在 plugins 目录删掉旧文件夹（插件 id 变过）。
> 本插件与 lucaorio 的 `obsidian-image-gallery` 互不冲突，可同时安装对比。

---

## 用法（只用手写代码块）

````markdown
```gallery
folder: 附件/照片      # 必填，相对库根目录的路径（也可写 path:）
type: horizontal       # horizontal（默认，等高铺满）| vertical（多列原比例）
height: 260            # 行高 px，horizontal 用
columns: 4             # 列数，vertical 用；0 = 按容器宽度自适应
gap: 8                 # 间距 px（也可写 gutter:）
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
- 兼容 lucaorio 的写法：`path:`、`gutter:`、`sortby:`、`sort: desc`（会被识别为排序方向）。
- 画廊文档本身仍可被别的笔记用 `![[文件名]]` 嵌入，嵌入后照样渲染。

---

## 设置

设置 → 第三方插件 → Folder Image Gallery：

默认布局 / 默认行高 / 默认列数 / 默认间距 / 默认排序 / 默认递归，以及**清空图片尺寸缓存**。
代码块里写了的参数优先于设置里的默认值。

---

## 性能实测（本机压测台）

用仓库自带的 `test/stress.html`（浏览器直接打开，画面里跑的就是 `main.js` 本体）：

| 图片数量 | 布局 | 峰值挂载单元格 | 峰值 DOM 节点 | 滚动位置校验 |
|---|---|---|---|---|
| 5 000 | horizontal | 15 | 32 | 9/9 个位置可视区都有图 |
| 20 000 | horizontal | 15 | 32 | — |
| 8 000 | vertical | 36 | 74 | — |
| 3 000 | horizontal | 28 | — | 9/9 通过（含滚到底部） |

对照：把同样的图片一次性全部挂进 DOM（旧做法），3 000 张就有约 6 000 个节点，且随数量线性增长。

> 压测台的图片是合成图循环复用，主要压「布局 / 虚拟化 / 滚动」；真实照片的解码开销请用实际文件夹在 Obsidian 里体感。

---

## 文件说明

| 文件 | 说明 |
|---|---|
| `main.js` | 插件本体（**单文件、零构建**，改完直接生效，不需要 npm/打包） |
| `styles.css` | 样式（`.fg-viewport` 是定位容器，`.fg-cell` 绝对定位） |
| `manifest.json` | 插件清单 |
| `test/stress.html` | 压测台：合成图 + 自动长扫 + 随机跳跃，给出帧率、DOM 上限、长任务数 |
| `test/preview.html` | 静态预览：并排看 horizontal / vertical 排得对不对 |

`test/` 只是开发辅助，不影响插件加载，装进库时可以不带。

---

## 常见问题

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

---

## 开发

`main.js` 就是源码，直接改、直接生效，无需构建。想验证：

```bash
node tools/layout-test.mjs     # 布局算法单测 + 5 万张性能计时（需 Node）
```

（`tools/` 在项目仓库里，不在插件运行目录。）
