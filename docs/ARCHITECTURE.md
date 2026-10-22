# 架构

三层，加起来很小：原生壳 **32 KB** 的 DEX（22 个类），前端 **170 KB** 的 JS/CSS/HTML，
其余 334 MB 全是美术素材。

```
┌──────────────────────────────────────────────┐
│  原生壳（Java 32 KB / 22 类）                  │
│  MainActivity  ── 应用内载体（设置/对话面板）    │
│  OverlayService ── 悬浮窗宿主（前台服务）        │
│  PetBridge     ── 22 个 @JavascriptInterface   │
└───────────────┬──────────────────────────────┘
                │  addJavascriptInterface(petBridge, "petHost")
                │  evaluateJavascript ← 触摸 / 网络回调 / 转屏
┌───────────────┴──────────────────────────────┐
│  WebView（file:///android_asset/web/）         │
│  index.html + 9 个 JS 模块 + CSS               │
│  ┌────────────────────────────────────────┐  │
│  │ 引擎：pet.js（单宠状态机+物理）          │  │
│  │      engine.js（场景/碰撞/输入/几何）    │  │
│  │ 交互：ui.js（菜单/面板） chat.js（AI）   │  │
│  │ 基础设施：settings.js（27 键+5 版迁移）  │  │
│  │          bridge.js（三宿主适配）        │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

## 双窗口拓扑（默认，`isStaticRender()==true`）

这是原实现抗抖动的核心，**不要**改成"窗口跟着宠物走"：

- **渲染窗**：整屏透明 WebView，初值 400×400，随即 `applyScreenSize()` 铺满整屏并置原点
  `(0,0)`，之后**永不动**。所以宠物坐标 = 屏幕坐标。
- **触摸窗**：一个 `new View(ctx)` + `setBackgroundColor(0)` 的空 View，由 JS 每帧（≥12 ms 节流）
  驱动成**宠物包围盒矩形**：`hw=round(pet.w)`、`hh=round(pet.h)`、`hx=pet.x-hw/2`、`hy=pet.y-hh`
  （底中锚点）→ `setWindowSize`（变了才发）+ `moveWindow`（Δ≥0.02 才发）。
- 窗口类型按 `int[]{2002, 2038}` 顺序回退；旗舰参数：`flags=0x808`
  （`FLAG_NOT_FOCUSABLE|FLAG_FORCE_NOT_FULLSCREEN`）、`format=-3`（TRANSLUCENT）、
  `gravity=0x800033`、`alpha=1.0`。

`crispMode`（`overlayCrisp`）是另一种拓扑：只有一个窗，尺寸 = min(宠物, 屏幕)，宠物钉在窗口原点，
屏幕位移由窗口位置承担。代价是窗口自身的延迟表现为整只滞后。

## 触摸链路：没有原生命中测试

```
手指 → 触摸窗 setOnTouchListener（无条件 return true）
     → OverlayService.forwardTouch(MotionEvent)
     → type = DOWN/MOVE/UP/CANCEL，x = event.getRawX()/density
     → ui.post { webView.evaluateJavascript("window.__petTouch&&window.__petTouch('<type>',<x>,<y>)") }
     → engine.js: document.elementFromPoint(x,y)，不是 .pet 就回退 pets[0].el
     → dispatch PointerEvent(pointerdown/move/up, pointerType:'touch')
```

**原生侧零像素运算**：全包没有 `Bitmap.getPixel`、没有 alpha 采样、没有碰撞盒数组调用。
命中测试完全交给 DOM 的 `elementFromPoint`。

`Choreographer` 出现在这里，但它**只**用于把 `updateViewLayout` 对齐到下一帧
（`scheduleApply → postFrameCallback → doFrame → applyPending`，`applyScheduled` 防重入，
`pendValid` 单标志合并 move+resize，值没变不发系统调用），不是逐帧命中测试。

### ⚠️ 坐标口径是两个相反方向

| 用途 | 换算 |
|---|---|
| 触摸事件（Java→JS） | `event.getRawX() / density`（物理 → CSS） |
| 窗口几何（JS→Java） | `css * density` 后 `Math.round`（CSS → 物理） |

写反 = 拖拽漂移。

## 行为常量

物理与状态机全部自写，集中在 `pet.js` 顶部：

```
GRAVITY = 1400 px/s²        RESTITUTION = 0.68        GROUND_FRICTION = 2.5
SUB_DT_MAX = 0.008          THROW_CAP = 4800           MIN_THROW_SPEED = 500
P_IDLE = 0.20  P_TURN = 0.28  P_ACTS = 0.60（累计阈值）  IDLE_ROLL_MS = 3000
SQUASH_MS = 220   SQUASH_W = +10%   SQUASH_H = -15%
DRAG_THRESHOLD = max(6, 5*scale)    CLICK_MAX_MS = 520
LONG_PRESS_PET = 550 ms             LONG_PRESS_BLANK = 450 ms    DOUBLE_CLICK_VY = -1400
MAX_COMPANIONS = 4
```

累计阈值的意思是：`roll < 0.20` 待机；`< 0.28` 转向；`< 0.60` 播动作；否则走路。

> 注：桌面版 `dsh-pet-indesktop` 的 `pet/catalog.py` 用的是另一组值
> （`0.30 / 0.40 / 0.80`，且没有定时重掷）。两套真值同时存在是历史原因，
> 本仓库如实保留 APK 里的这一组，没有去"对齐"它。

## JSBridge：22 个方法

注册名 **`petHost`**（`addJavascriptInterface(petBridge, "petHost")`，MainActivity 与
OverlayService 各注册一次，销毁时各 `removeJavascriptInterface` 一次）。

| # | 方法 | 说明 |
|---|---|---|
| 1 | `boolean canOverlay()` | `Settings.canDrawOverlays` |
| 2 | `String enterOverlay()` | 无权限先拉授权页返回 `{"ok":false,"reason":"permission"}`；有权限 `startForegroundService(SHOW)`，并 `postDelayed(900ms)` 把应用切后台 |
| 3 | `void exitApp()` | overlay 载体走 `exitOverlay()`，否则 `finishAffinity()` |
| 4 | `void exitOverlay()` | `startService(HIDE)` |
| 5 | `String getMode()` | `"overlay"` / `"app"` |
| 6 | `String getPlatform()` | 常量 `"android"` |
| 7 | `String getScreen()` | JSON 串 `{"w":int,"h":int,"density":float}`，w/h 是**可用区 CSS px** |
| 8 | `void httpPostAsync(reqId, url, headersJson, body)` | 见下 |
| 9 | `boolean isCrispWindow()` | |
| 10 | `boolean isNative()` | 常量 `true` |
| 11 | `boolean isStaticRender()` | |
| 12 | `boolean keepAwake(boolean)` | 空实现，恒 `true` |
| 13 | `String loadKV(String key)` | `SharedPreferences("dsh_pet_kv")` |
| 14 | `void log(String)` | `Log.i("PetBridge", …)` |
| 15 | `void moveWindow(double x, double y)` | CSS px × density → round |
| 16 | `void openApp()` | `Intent(MainActivity)` + `NEW_TASK\|RESET_TASK_IF_NEEDED` |
| 17 | `void requestOverlayPermission()` | 已授权直接 return |
| 18 | `boolean saveKV(String key, String value)` | |
| 19 | `void setWindowSize(int w, int h)` | CSS px × density → round；w/h ≤ 0 丢弃 |
| 20 | `String speak(String text, double rate)` | 懒初始化 TTS，`Locale.SIMPLIFIED_CHINESE` |
| 21 | `void stopSpeak()` | |
| 22 | `void toast(String)` | |

**注意**：`goBackground()` 是 `MainActivity` 的方法，**不是**桥方法，由 `enterOverlay` 内部
`postDelayed(900ms)` 触发。

### 网络桥

因为页面是 `file://` 源，跨域请求由 Java 代发：

```
JS: PetBridge.httpPost(url, headers, body)      // bridge.js 把 22 个收敛成 Promise
  → native: httpPostAsync(reqId, url, headersJson, body)
  → HttpURLConnection 强制 POST，connect=15s / read=180s
  → main.post → evaluateJavascript("window.__petHttp(<reqId>, <result>)")
  → JS 查表 resolve
```

请求体是 OpenAI Chat Completions 兼容格式（用户在设置面板填 base/key/model）。
`temperature` **仅当**模型名不匹配 `/reasoner|-r1|thinking|v4-pro/i` 时才带。
URL 归一：`/\/v1$/ ? +'/chat/completions' : +'/v1/chat/completions'`。

### ⚠️ `__winApplied` 是不存在的契约

前端 `engine.js` 在等一个「窗口几何已应用」的回调 `window.__winApplied`，
而 DEX 里这个字符串出现 **0 次**——安卓壳从不发它。前端靠 400 ms 超时自愈。
这是原实现的技术债，如实保留；要修就得二选一：真的发这个回调，或者复刻乐观采纳。

## 存储契约

- Java 侧：`SharedPreferences("dsh_pet_kv")`，实际只用两个键——`settings`（整个设置 JSON
  字符串）与 `onboarded`（首次引导时间戳）。
- 前端：`Settings.KEY = "dsh-pet-harmony/settings/v1"` 是**浏览器 localStorage** 的键；
  file:// 下不可靠，主路径走原生 `loadKV('settings')`。
- 设置 SCHEMA 共 27 键，`__v=5`，带 5 段迁移逻辑。**改默认值必须 +1 并写迁移**。
- ⚠️ `OverlayService.readCrispSetting()` 不解析 JSON，直接
  `getString("settings","").contains("\"overlayCrisp\":true")` 做字符串嗅探。
  前端序列化时必须稳定产生这个子串，否则 crisp 设置失联。这是技术债，别照抄。

## 内存红线

单帧 `640×360 RGBA` = 921,600 B ≈ 0.9 MB；一段 241 帧 ≈ **222 MB**；106 段合计 ≈ **23.5 GB**。
WebView 的 `<img>` 换 `src` 方案靠内核的解码缓存扛，**只能常驻 ≤2 段**。
换原生渲染的话，这条是第一个会炸的地方。
