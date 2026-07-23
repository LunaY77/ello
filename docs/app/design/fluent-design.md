## 1. 设计原则

| Fluent 原则 | ello-app 规则                                                                               |
| ----------- | ------------------------------------------------------------------------------------------- |
| Light       | 默认背景不使用纯白/纯黑，内容表面与画布保持 4–8% 明度差                                     |
| Depth       | 通过 surface 层级、边框和三档阴影表达前后关系，不堆叠大阴影                                 |
| Material    | Acrylic/Mica 只用于顶栏、浮层和 command palette，正文卡片保持不透明                         |
| Motion      | 使用 150/200/300 ms 和 Fluent easing；状态变化短促、可预测                                  |
| Typography  | 使用 SF Pro,中文回退 PingFang SC |
| Harmony     | Tokenicode 只提供布局参考，品牌、颜色和文案全部替换为 ello                                  |

## 2. 颜色 token

### Canvas / surfaces

| Tailwind class | CSS variable     | Light 建议值      | Dark 建议值       |
| -------------- | ---------------- | ----------------- | ----------------- |
| `bg-canvas`    | `--bg-canvas`    | `#F3F3F3`         | `#202020`         |
| `bg-subtle`    | `--bg-subtle`    | `#F7F7F7`         | `#242424`         |
| `bg-surface-1` | `--bg-surface-1` | `#FFFFFF`         | `#2B2B2B`         |
| `bg-surface-2` | `--bg-surface-2` | `#F9F9F9`         | `#303030`         |
| `bg-surface-3` | `--bg-surface-3` | `#F0F0F0`         | `#383838`         |
| `bg-elevated`  | `--bg-elevated`  | `#FFFFFF`         | `#3A3A3A`         |
| `bg-overlay`   | `--bg-overlay`   | `rgba(0,0,0,.28)` | `rgba(0,0,0,.52)` |

### Cards / sidebar / borders

| Tailwind class              | CSS variable           | 建议值                                                               |
| --------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `bg-card-bg`                | `--card-bg`            | `color-mix(in srgb, var(--bg-surface-1) 92%, var(--fluent-blue) 8%)` |
| `border-card-border`        | `--card-border`        | `rgba(0,0,0,.08)` / dark `rgba(255,255,255,.08)`                     |
| `border-card-border-accent` | `--card-border-accent` | `color-mix(in srgb, var(--fluent-blue) 48%, transparent)`            |
| `bg-sidebar-bg`             | `--sidebar-bg`         | `#EBEBEB` / dark `#252525`                                           |
| `bg-sidebar-active`         | `--sidebar-active`     | `rgba(0,120,212,.12)` / dark `rgba(96,165,250,.18)`                  |
| `border-subtle`             | `--border-subtle`      | `rgba(0,0,0,.06)`                                                    |
| `border-default`            | `--border-default`     | `rgba(0,0,0,.12)`                                                    |
| `border-strong`             | `--border-strong`      | `rgba(0,0,0,.18)`                                                    |
| `divider`                   | `--divider`            | `rgba(0,0,0,.08)`                                                    |

### Text / semantic

| Tailwind class   | CSS variable           | Light 建议值          | Dark 建议值            |
| ---------------- | ---------------------- | --------------------- | ---------------------- |
| `text-primary`   | `--text-primary`       | `#1A1A1A`             | `#FFFFFF`              |
| `text-secondary` | `--text-secondary`     | `#444444`             | `#D6D6D6`              |
| `text-tertiary`  | `--text-tertiary`      | `#6B6B6B`             | `#AFAFAF`              |
| `text-disabled`  | `--text-disabled`      | `#999999`             | `#707070`              |
| `bg-fluent`      | `--fluent-blue`        | `#0078D4`             | `#60CDFF`              |
| `fluent-hover`   | `--fluent-blue-hover`  | `#106EBE`             | `#75D7FF`              |
| `fluent-active`  | `--fluent-blue-active` | `#005A9E`             | `#4CC2F1`              |
| `fluent-subtle`  | `--fluent-blue-subtle` | `rgba(0,120,212,.10)` | `rgba(96,205,255,.16)` |

语义色沿用配置中的 `success / warning / danger / info` 四组，但必须同时配合图标和文字，不能只依赖颜色。

## 3. Acrylic / Mica 使用边界

- **Mica-like 背景**：只用于顶栏的顶层背景，可使用低对比渐变或系统材质；不放在长文本后方。
- **Acrylic**：只用于 command palette、popover、审批浮层和 hover card；推荐 `backdrop-filter: blur(16–20px)`，并叠加 `--acrylic-tint`。
- **不透明 surface**：时间线、文件树、代码 diff 和 composer 必须使用不透明 surface，保证阅读和截图一致性。
- 任何 Acrylic 层都要有 `--highlight-stroke` 1 px 内描边，避免边缘融入背景。

## 4. 间距、圆角、尺寸

| Tailwind token | Value  | 用法                    |
| -------------- | ------ | ----------------------- |
| `xs`           | 4 px   | 图标与文字、状态点      |
| `sm-s`         | 8 px   | 紧凑列表行、badge       |
| `md-s`         | 12 px  | 卡片内间距、控件间距    |
| `lg-s`         | 16 px  | panel padding、composer |
| `xl-s`         | 24 px  | 页面 padding、分组间距  |
| `2xl-s`        | 32 px  | 空状态、section 间距    |
| `sidebar-w`    | 280 px | 默认侧栏                |
| `header-h`     | 56 px  | 顶栏高度                |
| `input-h`      | 72 px  | 桌面 composer 最小高度  |

建议圆角：`sm=4px`、`md=6px`、`lg=8px`、`xl=12px`、`pill=9999px`。不要让每个元素都变成胶囊。

## 5. 阴影与层级

| Token         | 建议值                         | 用途                        |
| ------------- | ------------------------------ | --------------------------- |
| `shadow-1`    | `0 1px 2px rgba(0,0,0,.08)`    | 普通卡片、列表 hover        |
| `shadow-2`    | `0 2px 8px rgba(0,0,0,.12)`    | dropdown、浮层              |
| `shadow-3`    | `0 8px 24px rgba(0,0,0,.16)`   | command palette、审批 sheet |
| `shadow-card` | `0 2px 8px var(--shadow-card)` | tool/approval card          |

层级优先顺序：背景 < panel < card < popover < modal/approval。相邻层级优先用颜色和 border 区分，阴影只做第二信号。

## 6. 排版与字号

- `font-sans`：`Segoe UI`, `-apple-system`, `BlinkMacSystemFont`, `system-ui`, `PingFang SC`, `sans-serif`。
- `font-body`：`Inter`, `-apple-system`, `system-ui`, `sans-serif`，用于内容阅读。
- `font-mono`：`JetBrains Mono`, `Cascadia Code`, `Fira Code`, `ui-monospace`。
- 基础字号：`f-xs 11/16`、`f-sm 12/16`、`f-md 13/20`、`f-lg 14/20`、`f-xl 16/24`、`f-2xl 20/28`、`f-3xl 24/32`。
- 语义字号：`title-1 24/32`、`title-2 20/28`、`title-3 16/24`、`body-l 16/24`、`body-m 14/22`、`body-s 13/20`、`caption 12/16`、`micro 11/16`。
- 中文按钮保持 2–6 字；代码路径和命令必须使用 mono，不用全大写装饰。

## 7. 动效 token

```css
--ease-fluent: cubic-bezier(0.33, 0, 0.67, 1);
--ease-fluent-decelerate: cubic-bezier(0, 0, 0, 1);
--ease-fluent-accelerate: cubic-bezier(1, 0, 1, 1);
--duration-fast: 150ms;
--duration-base: 200ms;
--duration-slow: 300ms;
```

- hover/focus：`fast`。
- 面板展开、popover：`base`。
- 侧栏、页面切换：`slow`。
- `prefers-reduced-motion` 开启时，所有位移动画降级为 opacity/颜色变化。

## 8. 组件配方

### Fluent button

- Primary：`fluent` 背景、`on-accent` 文字、`shadow-fluent`，hover 进入 `fluent-hover`。
- Secondary：`surface-2` 背景 + `border-default`，hover 使用 `surface-3`。
- Subtle：透明背景，hover 使用 `fluent-subtle`。
- Danger：使用 `danger`，不把红色用于普通停止/关闭动作。

### Fluent card

- `card-bg` + `card-border` + `rounded-lg` + `shadow-card`。
- hover 只改变 `card-bg-hover` 和 border，不放大、不漂移。
- 活跃卡片使用 `card-border-accent` 或 2 px accent rail。

### Sidebar

- `sidebar-bg` 不使用纯白；active row 使用 `sidebar-active`。
- 宽度默认 `sidebar-w=280px`，收起后保留 48 px rail 和 tooltip。
- 分组标题用 `f-sm`/`tertiary`，session row 用 `body-m`。

### Approval / command palette

- 使用 Acrylic surface + `shadow-3` + `highlight-stroke`。
- 背景 scrim 使用 `bg-overlay`，不超过 52% opacity。
- approval primary action 使用 Fluent Blue；danger 只用于明确拒绝/删除。

## 9. 窗口布局

- 顶栏使用交通灯留位与 Fluent Acrylic bar。
- 字体以 SF Pro、PingFang SC 和系统字体为回退链。
- 侧栏 280 px 可折叠,输入区最小高度 72 px,弹层使用 centered popover。
- 窗口背景使用 Mica-like 材质,正文保持不透明 surface。
