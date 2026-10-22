# BRIDGE-SPEC —— 蓝色大肥鱼安卓桌宠 · Kotlin/Compose 对接规格

> **本文档的读者**：另一个仓库里实现 Compose 原生桌宠 App 的工程师。
> **本文档的写法**：以「Kotlin 侧必须实现什么」为主语。凡是原 APK 里由 WebView + 前端 JS 承担的职责，
> 这里都翻译成 Compose/Android 原生必须自己做的动作；凡是原实现里靠 `evaluateJavascript` 反向注入的，
> 这里都翻译成普通的函数调用。
> **不做的事**：不复刻 WebView、不引入 JS 运行时、不移植 bridge.js。

**样本锚点**（所有数字都可回溯到这一份）：

| 项 | 值 |
| --- | --- |
| APK | `蓝色大肥鱼-安卓桌宠-完整版.apk` |
| SHA256 | `6725a9556d9b819c56aca8fb3a67da1381bc82c10c7983b198645370d7fe6518` |
| 包名 / 版本 | `com.dshpet.webfish` / 1.9.4(95) |
| 前端入口 | `assets/web/index.html`（9580 B，`9b0efcd1…a60d2`） |
| 桥接层 | `assets/web/js/bridge.js`（8793 B，`7a53b539…1d19c`） |
| 反汇编证据 | `out/dex_full_dump.txt`（22 类 / 123 方法，含 `@JavascriptInterface` 注解与 code_off） |

---

## 0. 先记住这 8 条不可协商的事实

1. **原实现的「桥」有 22 个方法，注册名 `petHost`**（`WebView.addJavascriptInterface(PetBridge, "petHost")`），不是 `PetBridge`、不是 `JSBridge`。
2. **只有 3 个方向是原生 → JS 的**：`__petTouch(type,x,y)`、`__petHttp(id,payload)`、`__orientationChanged()`。**`__winApplied` 在安卓壳里根本不存在**（全量 DEX 计数 0），别照抄那条握手。
3. **触摸坐标 = 屏幕绝对 CSS 像素**（`getRawX()/density`），与窗口位置无关。窗口移动**不会**改变命中结果。
4. **反方向（窗口几何）的单位是 CSS 像素，原生侧要 ×density 再 round** 才变成 LayoutParams 的物理像素。两个方向的口径相反，写反了就是「拖拽漂移」。
5. **原生侧零 alpha 采样、零 mask 位图、零碰撞盒数组**（`Bitmap`/`getPixel`/`Canvas` 在 DEX 里各出现 0 次）。命中测试在原实现里是 DOM 的活；在 Compose 里必须由你重新实现（见 §3.3）。
6. **`Choreographer` 只干一件事**：把 `WindowManager.updateViewLayout` 对齐到下一帧（`scheduleApply → postFrameCallback → doFrame → applyPending`）。它不是逐帧命中测试循环。
7. **动画是 106 段 640×360、24fps、241 帧/段的动画 WebP**，不是 Live2D/Spine，没有骨骼、没有 mesh、没有帧序列文件。
8. **设置只有一个 JSON 字符串**，存在 `SharedPreferences("dsh_pet_kv")` 的 `"settings"` 键里；另有 `"onboarded"`。别自创 per-key 存储，否则老用户设置全丢。

---

## 1. 模块划分与依赖方向

Kotlin 侧建议 6 个模块，依赖单向向下（上层不知道下层怎么实现，下层不知道 UI）：

```
:app            Compose UI（浮层/设置页/对话页）、Activity、Service 装配
:host           PetHost 门面（本 spec §2）—— 唯一被 UI 调用的入口
:engine         行为层：状态机 + 物理 + 帧管线（原 pet.js + engine.js 的等价物）
:platform       平台层：悬浮窗(WindowManager)、触摸分发、TTS、Toast、SharedPreferences
:net            HttpURLConnection/OkHttp 的 POST 代理（原 httpPostAsync 的等价物）
:model          manifest.json / Settings 的 data class 与迁移（无 Android 依赖，可单测）
```

**硬约束**：`:engine` 与 `:model` 不许 import `android.view.*`。它们只处理 `Float` 坐标、`Long` 时间戳、纯数据类。这样行为层可以像原 JS 一样被单元测试直接驱动（原 JS 的价值就在这里：`tick(dt)` 是纯函数式的）。

---

## 2. PetHost：必须实现的 29 个入口（22 桥方法 + 3 反向回调 + 4 新增）

原 22 个 `@JavascriptInterface` 方法全部保留语义。下表左列是原桥签名（smali 原型），中列是 Kotlin 必须提供的签名，右列是**必须守住的行为**。

### 2.1 只读查询（同步、幂等、绝不抛）

| 原桥 | Kotlin | 必须守住的行为 |
| --- | --- | --- |
| `String getPlatform()` | `fun platform(): String` = `"android"` | 常量。前端用它做环境分支，静态返回即可。 |
| `String getMode()` | `fun mode(): HostMode` (`APP`/`OVERLAY`) | 由载体决定：Activity 内=true→`APP`；悬浮窗→`OVERLAY`。原实现靠构造参数 `overlay:Boolean`。 |
| `Z isNative()` | `fun isNative(): Boolean` = `true` | 常量。 |
| `Z isStaticRender()` | `fun isStaticRender(): Boolean` | `mode==OVERLAY && !crisp`。**这个值决定整个几何策略**（见 §4）。 |
| `Z isCrispWindow()` | `fun isCrispWindow(): Boolean` | `mode==OVERLAY && crisp`。与上一条互斥。 |
| `Z canOverlay()` | `fun canDrawOverlays(): Boolean` | `Settings.canDrawOverlays(context)`。**每次都要真查**，不要缓存：用户可能刚从系统设置页授权回来。 |
| `String getScreen()` | `fun screen(): ScreenMetrics` | 见 §2.2 的返回结构。原实现返回 JSON **字符串**，Kotlin 返回 data class，但**数值口径必须一致**：`w/h` 是可用区 CSS 像素（已减状态栏/导航栏、已除 density、已 round），`density` 是 `DisplayMetrics.density` 且 **≤0 时强制 1.0**。 |
| `String loadKV(key)` | `fun loadKV(key: String): String` | `getString(key, "")`，异常返回 `""`。键只有 `"settings"` 与 `"onboarded"`。 |
| `Z saveKV(key,value)` | `fun saveKV(key: String, value: String): Boolean` | `putString().apply()`，成功 true，任何异常 false（**不要 rethrow**）。 |

```kotlin
data class ScreenMetrics(
    val widthCss: Int,     // 可用宽（CSS px，已减 insets，已 round）
    val heightCss: Int,    // 可用高
    val density: Float,    // DisplayMetrics.density，<=0 时用 1.0f
)
```

`screen()` 的实现口径（逐条对齐原 `PetBridge.getScreen`，296 条指令 / 2 个 try 块）：

- `density = resources.displayMetrics.density`；`if (density <= 0f) density = 1f`
- API ≥ 30：`wm.currentWindowMetrics`（注意：原实现用 `getMaximumWindowMetrics`）取 `bounds.width/height`，insets 用 `windowInsets.getInsets(Type.statusBars()).top`、`getInsets(Type.navigationBars()).bottom/left/right`
- API < 30 或抛异常：`display.getRealMetrics()` 的 `widthPixels/heightPixels`，insets 用 `Resources.getSystem().getIdentifier("status_bar_height"|"navigation_bar_height", "dimen", "android")` + `getDimensionPixelSize` 兜底
- 输出：`widthCss = round(max(1, w - insetLeft - insetRight) / density)`，高度同理

### 2.2 悬浮窗生命周期

| 原桥 | Kotlin | 必须守住的行为 |
| --- | --- | --- |
| `String enterOverlay()` | `fun enterOverlay(): EnterOverlayResult` | ① 没权限 → 主动拉起授权页并返回 `permission` 失败；② 有权限 → 起前台服务（action `SHOW`），记 `overlayLaunchedAt = SystemClock.elapsedRealtime()`；③ 若当前载体不是 overlay 且 Activity 存活 → **延迟 900ms** 再 `moveTaskToBack(true)`（给悬浮窗留出绘制时间，早了会黑一下）。 |
| `void exitOverlay()` | `fun exitOverlay()` | 发 `HIDE` 给服务，**不** finish Activity。 |
| `void exitApp()` | `fun exitApp()` | overlay 载体 → 等价 `exitOverlay()`；app 载体 → `finishAffinity()`（经主线程 Handler）。 |
| `void openApp()` | `fun openApp()` | `Intent(this, MainActivity::class.java).addFlags(NEW_TASK or RESET_TASK_IF_NEEDED).startActivity`，flags 值 `0x10020000`。 |
| `void requestOverlayPermission()` | `fun requestOverlayPermission()` | 已授权则**直接 return**（不要重复弹）；否则 `ACTION_MANAGE_OVERLAY_PERMISSION` + `data = Uri.parse("package:$pkg")` + `FLAG_ACTIVITY_NEW_TASK`。 |

```kotlin
sealed interface EnterOverlayResult {
    data object Ok : EnterOverlayResult                       // 原 JSON: {"ok":true}
    data object PermissionDenied : EnterOverlayResult          // 原 JSON: {"ok":false,"reason":"permission"}
}
```

### 2.3 窗口几何（**单位陷阱在这里**）

| 原桥 | Kotlin | 必须守住的行为 |
| --- | --- | --- |
| `void setWindowSize(int w, int h)` | `fun setWindowSize(widthCss: Int, heightCss: Int)` | `物理 = round(css * density)`；`物理 <= 0` 时**丢弃**（原实现 `if (w<=0 || h<=0) return`）；写入 pending 后请求「下一帧提交」。 |
| `void moveWindow(double x, double y)` | `fun moveWindow(xCss: Double, yCss: Double)` | `物理 = round(css * density)`；无正负校验，允许负坐标（窗口允许探出屏幕）。 |

提交策略（原实现的行为，必须复刻，否则拖拽会抖）：

```
setWindowSize / moveWindow
  → 写 pending.size / pending.pos，pendValid = true
  → scheduleApply(): if (applyScheduled) return;  applyScheduled = true
  → mainHandler.post {
        Choreographer.getInstance().postFrameCallback {          // ← 对齐下一帧
            applyScheduled = false
            applyPending()
        }
    }
applyPending():
  if (!pendValid) return
  pendValid = false
  target = if (crisp) renderWindow else touchWindow
  if (target == null || params == null) return
  changed = (params.width != pendW) || (params.height != pendH)
         || (params.x != pendX)     || (params.y != pendY)
  if (!changed) return                       // ← 值没变就一次系统调用都不发
  params.width = pendW; params.height = pendH; params.x = pendX; params.y = pendY
  wm.updateViewLayout(target, params)        // try/catch，异常只记日志
```

- `pendValid` 是**一个共享标志**：`setWindowSize` 与 `moveWindow` 写同一组字段，一次 `applyPending` 一起提交。
- 不要用 `View.animate()` / `setX()` 之类去「平滑」窗口移动——`updateViewLayout` 的延迟就是唯一真相，加了动画反而和 JS 侧坐标打架。

### 2.4 网络（见 §6 详解）

| 原桥 | Kotlin |
| --- | --- |
| `void httpPostAsync(String reqId, String url, String headersJson, String body)` | `fun httpPost(reqId: String, url: String, headersJson: String, body: String)`（**无返回值，结果走回调**） |

参数顺序是 `(reqId, url, headersJson, body)` —— 已用 D8 lambda 捕获链 + JS 调用点双向验证。写错顺序会把 reqId 当 URL 请求出去。

### 2.5 语音 / 提示 / 日志

| 原桥 | Kotlin | 必须守住的行为 |
| --- | --- | --- |
| `String speak(String text, double rate)` | `fun speak(text: String, rate: Double): SpeakResult` | 懒初始化 TTS（第一次调用才 init）；`setLanguage(Locale.SIMPLIFIED_CHINESE)` 返回 `-1`(LANG_MISSING_DATA) 或 `-2`(LANG_NOT_SUPPORTED) → `ttsReady=false`，返回 `Unavailable`；`rate > 0` 用它否则 1.0；`speak(text, QUEUE_FLUSH, null, "fish")`。 |
| `void stopSpeak()` | `fun stopSpeak()` | `tts.stop()`；tts 未初始化时静默。 |
| `void toast(String msg)` | `fun toast(msg: String)` | 必须 post 到主线程再 `Toast.makeText(...).show()`。原实现 `LENGTH_SHORT`。 |
| `void log(String msg)` | `fun log(msg: String)` | `Log.i("PetBridge", msg)`。这个通道被前端重度使用（几何诊断 40+ 处），**建议原样保留 tag**，方便对照本文档排查。 |
| `Z keepAwake(Z on)` | `fun keepAwake(on: Boolean): Boolean` | 原实现是空壳直接 `return true`。建议真实现成 `FLAG_KEEP_SCREEN_ON`/`setKeepScreenOn`，但**必须同步返回**。 |

```kotlin
sealed interface SpeakResult {
    data object Ok : SpeakResult                                   // 原 JSON: {"ok":true}
    data object TtsUnavailable : SpeakResult                       // 原 JSON: {"ok":false,"reason":"tts-unavailable"}
    data class Failed(val message: String) : SpeakResult           // 原 JSON: {"ok":false,"reason":"<msg>"}
}
```

### 2.6 原「原生 → JS」三个回调，在 Kotlin 里变成三个显式调用

```kotlin
// ① 触摸注入（原 window.__petTouch）
fun onPetPointer(type: PetPointerType, xCss: Float, yCss: Float)

enum class PetPointerType { DOWN, MOVE, UP, CANCEL }

// ② 转屏（原 window.__orientationChanged）
fun onOrientationChanged()

// ③ HTTP 回包（原 window.__petHttp）
fun onHttpResult(reqId: String, result: HttpBridgeResult)
```

- ①的调用者：悬浮窗触摸窗的 `OnTouchListener`（见 §3）。
- ②的调用者：服务的 `onConfigurationChanged`；**顺序必须是先重铺整屏窗口（applyScreenSize）再通知行为层**，原实现就是这个顺序，反过来会按旧屏幕尺寸重排。
- ③的调用者：`:net` 的 IO 线程在拿到结果后 post 到主线程。

原实现里 `__petTouch` / `__petHttp` 的这些字符串拼接**不再需要**（没有 JS 了），但**类型与顺序必须保持**：`(type, x, y)` 和 `(reqId, payload)`。

### 2.7 新增的 4 个入口（原实现缺失或不足，Kotlin 必须补）

| 新入口 | 为什么必须加 |
| --- | --- |
| `fun onWindowGeometryApplied(xCss: Float, yCss: Float, wCss: Float, hCss: Float)` | 原 `__winApplied` **从未被调用**，导致前端只能靠「400ms 超时后自己采纳目标几何」自愈（engine.js:339-341 / 416-421）。Kotlin 侧应真正在 `updateViewLayout` 之后回调一次，把这段抖动消掉。**如果你选择不加，就必须复刻那 400ms 乐观采纳逻辑**，否则拖拽结束时物体会瞬移。 |
| `fun onWindowInsetsChanged(insetsCss: InsetsCss)` | 键盘弹出/手势导航切换时可用区会变；原实现只在 `onConfigurationChanged` 里更新，键盘弹出会漏。 |
| `fun onBackPressureFrame(droppedFrames: Int)` | 原实现 `dt > 0.1s` 直接截断到 0.1（防切前台时间跳变）。Kotlin 侧应显式统计并降级动画质量。 |
| `suspend fun awaitFirstFrame()` | 原实现用「webView 加载完成」隐式同步；Compose 里必须显式知道第一帧何时可画，否则会出现「窗口在、宠物没出来」。 |

---

## 3. 触摸与命中测试

### 3.1 事件来源（必须照抄的结构）

悬浮模式下有**两个窗口**（crisp 模式只有一个，见 §4）：

| 窗口 | 内容 | 触摸策略 |
| --- | --- | --- |
| 渲染窗 `renderWindow` | 整屏透明 `FrameLayout`，内含宠物的绘制面 | `FLAG_NOT_TOUCHABLE` —— **永不接收触摸** |
| 触摸窗 `touchWindow` | 一个**空 View**（`View(context)` + `setBackgroundColor(0)`），**不承载任何内容** | `OnTouchListener` → `onPetPointer(...)`，且**无条件 `return true` 消费事件** |

`onTouch` 必须返回 `true`（原实现 `lambda$createWindows$0` 就是 `const/4 v0,#1; return v0`），否则事件会穿透到下层 App。

### 3.2 触摸窗的几何（由行为层驱动，不是反过来）

行为层每帧（节流 ≥12ms）算：

```
hw = round(pet.widthPx)          // pet.widthPx = manifest.crop.w * scale
hh = round(pet.heightPx)
hx = pet.x - hw / 2              // 底中锚点：pet.x/pet.y 是「脚底中点」
hy = pet.y - hh
if (hw,hh) 变了 → setWindowSize(hw, hh)
moveWindow(hx, hy)               // 只在 |Δ| >= 0.02 时才发
```

**触摸窗 = 宠物包围盒矩形**（含透明边），不做任何形状裁剪。原实现就是靠这个「窗口比宠物大一点点、或者正好等于宠物」来把触摸限制在宠物附近，剩下的精度交给命中测试。

### 3.3 命中测试（原实现是 DOM 的活，Kotlin 必须自己实现）

原逻辑（`window.__petTouch` 的 `down` 分支）：`document.elementFromPoint(x,y)` → `closest('.pet')` → 不中就回退到 `pets[0]`。也就是说：**点空白处会被当成点了主宠**。

Kotlin 等价实现（建议直接放在 `:engine`，纯函数）：

```kotlin
fun hitTest(pets: List<PetState>, xCss: Float, yCss: Float): PetState {
    // 后加入的宠物在上层 → 反向遍历
    for (p in pets.asReversed()) {
        val l = p.x - p.widthPx / 2f
        val t = p.y - p.heightPx
        if (xCss >= l && xCss < l + p.widthPx && yCss >= t && yCss < t + p.heightPx) {
            if (alphaHit(p, xCss, yCss)) return p      // 可选：见下
            // 不透就继续找下一只，都透则回退主宠
        }
    }
    return pets.first()                                // ← 对齐原实现的「回退 pets[0]」
}
```

**关于 alpha 采样**：原实现**没有**。但你的窗口是真正的透明浮层，用矩形命中会出现「点到宠物周围的空气也算点到」。三种做法按代价排序：

1. **不做**（最省）：矩形命中 + 回退主宠。与原 App 行为完全一致。**推荐先这样对齐**。
2. **缩水矩形**：命中盒子缩到 `manifest.body_box`（640×360 坐标系里的身体框，`[x1,y1,x2,y2]`），配合 `crop` 偏移与 `scale` 换算。代价几乎为零，能消掉大部分「空气命中」。**推荐第二步优化**。
3. **真 alpha 采样**：给每个 clip 预生成 1/8 分辨率的 alpha mask 位图（241 帧 × 80×45 bit = 每段 108KB，可接受），命中时查表。只有当 (2) 仍被投诉时才做。

如果做 (3)，**mask 必须由离线脚本从 WebP 生成并随素材分发**，不要在运行时 `Bitmap.getPixel` 逐帧采样——原实现的 24fps × 全屏解码已经吃满内存（见 §5.3）。

### 3.4 手势判定（数字别改，是观感调出来的）

| 手势 | 判据 |
| --- | --- |
| 按下 | `pointerdown` 落在宠物上 → `beginDrag()`（立即，不等位移） |
| 点击 | 松手时：累计位移 < `max(6f, 5f * scale)` **且** 按下时长 < 520ms |
| 拖拽 | 位移 ≥ 上述阈值的瞬间起算；拖拽中每帧 `dragTo(x + grabDx, y + grabDy)`，其中 `grab = (pet.x - downX, pet.y - downY)` |
| 长按（宠物上） | 550ms 未达拖拽阈值 → 取消拖拽 + 弹菜单 |
| 长按（空白处） | 450ms → 弹菜单 |
| 双击 | `vy = -1400`（向上弹一下）+ 播 idle + `state = "thrown"` |

### 3.5 坐标换算（三处，一处都不能错）

```
① 原生 → 行为层（触摸）:  xCss = event.rawX / density        // 屏幕绝对坐标
② 行为层 → 原生（窗口）:  xPx  = round(xCss * density)       // ← 与 ① 相反的运算
③ 拖拽跟手:              pet.x = xCss + grabDx              // 全程在 CSS 坐标里算
```

叠加窗口原点的情况（非 staticRender 拓扑才需要）：

```
localX = pet.x - windowOriginX      // 渲染面在窗口内的坐标
```

**默认拓扑（staticRender）下 `windowOrigin = (0,0)` 恒成立**，所以 `localX == pet.x`，宠物坐标就是屏幕坐标 —— 这正是原实现选这条路的原因：**窗口移动永远不影响宠物在屏幕上的位置感知**，也就没有「窗口延迟导致的位移闪烁」。

---

## 4. 悬浮窗：参数照抄表

```kotlin
// 候选类型，按顺序尝试，第一个成功即用
val tryTypes = intArrayOf(2002 /* TYPE_SYSTEM_ALERT, API<26 遗留 */,
                          2038 /* TYPE_APPLICATION_OVERLAY, API>=26 唯一合法 */)

// 渲染窗
renderParams = WindowManager.LayoutParams(
    width  = 400,                       // 初值，随后被 applyScreenSize() 改成整屏
    height = 400,
    type   = tryType,
    flags  = 0x808,                     // FLAG_NOT_FOCUSABLE | FLAG_FORCE_NOT_FULLSCREEN
    format = PixelFormat.TRANSLUCENT    // -3
).apply {
    gravity = 8388659                 // 0x800033 = START|TOP|RELATIVE_LAYOUT_DIRECTION
    x = 0; y = 0
    alpha = 1.0f                      // 0x3F800000
}
// 触摸窗
touchParams = WindowManager.LayoutParams(240, 300, tryType, 0x808, PixelFormat.TRANSLUCENT).apply {
    gravity = 8388659; x = 0; y = 0; alpha = 1.0f
}
// crisp 模式的 flags 是 0x808 shl 16 = 0x08080000，且不建触摸窗（touchWindow = null, touchParams = renderParams）
```

- 全部建窗失败 → `Toast("悬浮窗没起来：多半是「显示在其他应用上层」没开")` + `stopSelf()`。**不要**静默失败。
- 两窗都要尝试 `setColorMode(1)`（SDR），**失败只记日志**（原实现用反射，`Class.getMethod("setColorMode", Integer.TYPE)`，抛异常就 `Log.w("colorMode not set: " + e)`）。作用是对抗某些 ROM 把透明层渲染成偏色/80% 不透明。
- 服务必须 `startForeground` + 常驻通知（channel id `"pet_overlay"`，channel 名「桌宠悬浮」，`setShowBadge(false)`，通知标题「蓝色大肥鱼」/正文「正在陪着你（点这里回到应用）」/`setOngoing(true)`/点击回到 MainActivity）。`startForeground` 失败不影响悬浮本身（原实现就只记日志「通知栏常驻失败（不影响悬浮）：」）。

**两种拓扑，选一个实现，但状态机必须知道自己是哪种**：

| 拓扑 | 窗口 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A. 双窗静态渲染**（默认推荐） | 渲染窗整屏不动 + 触摸窗跟随宠物 | 宠物坐标 = 屏幕坐标，**零闪烁** | 两个 WindowManager 窗口；整屏透明层的合成开销 |
| **B. crisp 单窗**（用户可开 `overlayCrisp`） | 只有一个窗，尺寸 = min(宠物, 屏幕)，窗口位置承担屏幕位移 | 一个窗口、透明面积小、颜色更准（部分 ROM 下单窗不被压成 80% 不透明） | 窗口自身的更新延迟会表现为「整只略滞后」 |

---

## 5. 帧与动画管线

### 5.1 素材契约（`manifest.json` → data class）

```kotlin
@Serializable
data class PetManifest(
    val canvas: Box,                  // {"w":640,"h":360}
    val crop: RectI,                  // {"x","y","w","h"} —— 有效区域；宠物显示尺寸 = crop.w/h * scale
    val union_box: RectI,             // 全片段包围盒并集
    val fps: Int,                     // 24
    val body_box: List<Int>,          // [x1,y1,x2,y2] 身体框（物理/夹取/自动缩放）
    val head_box: List<Int>,          // [x1,y1,x2,y2] 头顶框（气泡定位）
    val clips: List<Clip>,            // 106
    val sounds: Map<String, String>,  // click / duck_ya1 / duck_ya2 / agent_start / agent_done / agent_error
    val chat_bg: List<String>,        // 11
    val icon: String,                 // "icon/app_icon.png"
)

@Serializable
data class Clip(
    val id: String,        // "click/点击回应-傲娇生气"
    val name: String,      // "点击回应-傲娇生气"
    val cat: ClipCat,      // IDLE(1) MOVE(3) TURN(1) CLICK(5) DRAG(1) EVENTS(6) RANDOM(89)
    val file: String,      // "anim/click_006.webp"
    val frames: Int,       // 241
    val fps: Float,        // 24.0
    val loop: Boolean,
    val stride: Float?,    // 仅 move 类有值（60..240）：一步位移多少 **源像素**；移动距离 = stride * scale
    val no_mirror: Boolean,// true = 该片段禁止镜像（默认素材朝左，facing>0 才 scaleX=-1）
    val bytes: Int,
)
```

`clipDurationMs = frames / fps * 1000`（241/24 ≈ 10042ms）。**不要**用 WebP 里自带的时长，用这个算——重播、循环、`_after` 回调都依赖它。

### 5.2 必须实现的播放语义

1. **同一时刻只播一个 clip**（每只宠物）。
2. **重播同一 clip 必须能重新触发**。原实现的招数是 URL 加 `?v=0/1` 两个 nonce 变体，逼 WebView 在两份解码缓存间切换。Compose 的等价物：**为每个 clip 保留两个可复用的播放器实例**（`AnimatedImageDrawable` / 帧序列播放器 / video 播放器皆可），轮换使用；或者显式 `seekTo(0)` + `start()`。
3. **首帧优先**：`play()` 之后必须先出一帧，再允许位置更新——原实现为此专门放弃了「每次换 nonce」（注释：会「位移先动、动画后出来」）。
4. **帧驱动**：原实现是 `requestAnimationFrame` 主循环（`dt` 上限 0.1s 防切前台跳变）。Compose 侧用 `withFrameNanos` + `dt` 截断。
5. **兜底**：manifest 里 `framesDir` 字段存在时走逐帧图片。本包未提供该字段，但**建议保留这条分支**——硬解/软解在某些机型上对透明动画 WebP 支持很差。

### 5.3 ⚠️ 内存预算（这条不解决会直接 OOM）

单帧 `640×360 RGBA8888 = 921,600 B ≈ 0.9MB`；一段 241 帧 ≈ **222MB**。106 段合计 ≈ 23.5GB。

- **绝不允许**「预加载全部 clip」。
- 常驻段数控制：当前 + 下一段（`≤2`），其余必须显式释放（`AnimatedImageDrawable` 要 `stop()` 并丢引用；video 要 `release()`）。
- 随机小动作有 89 段，切换频繁 —— 建议对 `RANDOM` 类**不做预取**，宁可接受首次 100~200ms 的解码延迟，也不要缓存 89 段。
- 若目标机型内存吃紧：改用帧序列（PNG/WebP 单帧 + 双缓冲）或带 alpha 的视频（`webm`/`vp9` alpha），这两条路原实现都留了口子（`framesDir` 分支 / 只是 `<img>` 换 src）。

---

## 6. 网络：`httpPost` 契约

```kotlin
/** 原 PetBridge.httpPostAsync(String reqId, String url, String headersJson, String body) */
fun httpPost(reqId: String, url: String, headersJson: String, body: String)
// 结果必须回到： fun onHttpResult(reqId: String, result: HttpBridgeResult)

data class HttpBridgeResult(
    val status: Int,   // HTTP 状态码；异常用 -1
    val body: String,  // 原始响应体文本（UTF-8）；异常用异常 toString 或 "error"
)
```

**必须守住的 7 条**：

1. **线程**：请求在 IO 线程池执行（原实现 `Executors.newFixedThreadPool(3)`），**结果 post 回主线程**再交付行为层。
2. **方法**：永远 `POST`。
3. **超时**：`connectTimeout = 15_000ms`，`readTimeout = 180_000ms`（3 分钟——思考型模型首字很慢）。调用方还有一层 200s 总超时，先到先结束。
4. **请求头**：
   - 先 `Content-Type: application/json; charset=utf-8`；
   - 再把 `headersJson` 解析成对象，逐键 `setRequestProperty(k, optString(k))`；
   - `headersJson` 为空/解析失败 → **退化为只有默认头**，不要报错。
5. **请求体**：`body.toByteArray(UTF_8)` → `doOutput = true` → `setFixedLengthStreamingMode(len)` → 写出 → close。
6. **响应**：`code >= 400` 用 `errorStream`，否则 `inputStream`；**两者都读成文本**，逐行 append（原实现不加分隔符）。非 2xx **不抛异常**，把 status 原样交回。
7. **错误映射**（照抄，前端/行为层依赖这些值做文案）：

| 情况 | status | body |
| --- | --- | --- |
| 正常收包 | HTTP code | 响应体原文 |
| 内层异常（IO/解析） | `-1` | `异常.toString()` |
| 外层异常（unknown） | `-1` | `"error"` |
| 桥未就绪（Kotlin 侧不应出现） | `-1` | `"桥未就绪（no-bridge）"` |
| 总超时（200s） | `-1` | `"请求超时"` |

**请求体结构**（`ChatClient.buildBody`，OpenAI Chat Completions 兼容）：

```json
{
  "model": "<用户填>",
  "messages": [
    {"role": "system",    "content": "<人格提示词>\n\n<时间上下文>"},
    {"role": "user",      "content": "[HH:MM] <历史用户消息>"},
    {"role": "assistant", "content": "<历史回复>"},
    {"role": "user",      "content": "<本次输入>"}
  ],
  "stream": false,
  "max_tokens": 2048,
  "temperature": 0.9
}
```

- `max_tokens = max(256, 用户设置 ?: 2048)`
- `temperature` **仅当**模型名不匹配 `/reasoner|-r1|thinking|v4-pro/i` 时才带（思考类模型不接受采样参数）
- 历史条数 = `historyTurns`（默认 8 轮）
- URL 归一：若 base 以 `/v1` 结尾 → `base + "/chat/completions"`，否则 → `base + "/v1/chat/completions"`
- 有 key 时加 `Authorization: Bearer <key>`
- 响应解析：`choices[0].message.content`（兼容 `delta.content`；`content` 为数组时分片 join），空则按「接口返回里没有 content 字段」失败

---

## 7. 存储与设置

```kotlin
// 存储位置（必须与旧版兼容，否则老用户升级后设置全丢）
const val PREFS_NAME = "dsh_pet_kv"      // SharedPreferences
const val KEY_SETTINGS = "settings"      // 整包 JSON 字符串
const val KEY_ONBOARDED = "onboarded"    // 首次引导时间戳
// 浏览器 localStorage 用的键名（仅记录，Kotlin 侧不用）
//   "dsh-pet-harmony/settings/v1"  /  "dsh-pet-harmony/chat/v1"
```

```kotlin
@Serializable
data class PetSettings(
    @SerialName("__v") val version: Int = 5,
    // 外观
    val scale: Float = 0f,              // 0 = 自动：shortSide*0.24 / bodyWidth，clamp(0.25, 1.6)
    val showToolbar: Boolean = true,
    val transparentBg: Boolean = false,
    // 互动
    val wander: Boolean = true,
    val randomActions: Boolean = true,
    val speech: Boolean = true,
    val bubbleSeconds: Float = 3.2f,
    val intervalMin: Int = 20,
    val intervalMax: Int = 60,
    val phrases: String = "",
    // 音效
    val clickSound: Boolean = true,
    val clickVolume: Float = 0.7f,
    // 小鲸鱼与碰撞
    val companions: Boolean = false,     // ← v2 起默认 false
    val collision: Boolean = true,
    val restitution: Float = 0.82f,
    val gravity: Boolean = true,
    val overlayCrisp: Boolean = false,
    val overlayPunch: Float = 0.5f,
    // AI 与语音
    val aiBase: String = "",
    val aiKey: String = "",
    val aiModel: String = "",
    val aiTemp: Float = 0.9f,
    val aiMaxTokens: Int = 2048,
    val aiPrompt: String = "",
    val tts: Boolean = true,
    val ttsRate: Float = 1.0f,
    val historyTurns: Int = 8,
)
```

**迁移规则（`version` 5，缺一条就会把老用户的设置改错）**：

| 从 | 到 | 动作 |
| --- | --- | --- |
| < 2 | 2 | `companions = false`（老版本默认开，升级统一关，避免一开 App 一大两小） |
| < 3 | 3 | `dragCamera = true`（该字段已废弃，只需不报错） |
| < 4 | 4 | `dragCamera = true` |
| < 5 | 5 | `dragCamera = true` |

未知字段**必须保留**（原实现用 SCHEMA 过滤，未知键被丢弃后再次保存就永久丢了）。若要与旧版双向兼容，建议保留一份 `unknown: Map<String, JsonElement>` 原样写回。

**⚠️ 一处隐蔽耦合（原实现的技术债，别照抄）**：悬浮服务判断「颜色优先模式」不解析 JSON，而是
`prefs.getString("settings","").contains("\"overlayCrisp\":true")`。
Kotlin 侧请**改成独立布尔键**（例如 `PREFS_NAME` 里加 `"overlayCrisp"`），否则你会被 JSON 序列化的键序/空格绑死。若必须双向兼容旧数据，读的时候两种都认：新键优先，缺失时回退到子串嗅探。

**聊天记录**：原实现单独存 localStorage（`dsh-pet-harmony/chat/v1`），**没走原生 KV**，所以「换机/清缓存」会丢。Kotlin 侧建议直接落 Room/文件，并在设置迁移里提供导入入口（可选）。

---

## 8. 行为层必须复刻的常量（观感全靠这些数字）

```kotlin
object Physics {                          // 对应原 pet.js 顶部常量
    const val GRAVITY = 1400f              // px/s²
    const val RESTITUTION = 0.68f          // 碰屏幕边缘恢复系数
    const val GROUND_FRICTION = 2.5f       // /s
    const val GROUND_BOUNCE_STOP_VY = 120f // 落地 |vy| 低于它直接停
    const val REST_VX = 15f                // 地面上认为静止
    const val SUB_DT_MAX = 0.008f          // 物理子步上限（8ms）
    // 松手初速估计（按 0.15s 轨迹，峰值加权 0.5）
    const val TRAIL_KEEP_SEC = 0.15f
    const val RELEASE_WINDOW_SEC = 0.12f
    const val RELEASE_STALE_SEC = 0.15f
    const val MIN_SPAN_SEC = 0.02f
    const val PEAK_WEIGHT = 0.5f
    const val ACCEL_REF = 8000f
    const val ACCEL_GAIN_MAX = 0.6f
    const val DEAD_ZONE_SPEED = 500f
    const val THROW_CAP_STANDARD = 4800f   // 抛掷速度上限
}

object Behaviour {
    const val P_IDLE = 0.20f               // 掷骰：待机
    const val P_TURN = 0.28f               //       转向（累计）
    const val P_ACTS = 0.60f               //       随机动作（累计）→ 剩 40% 走路
    const val IDLE_ROLL_MS = 3000L         // 待机最多 3 秒就重新掷骰
    const val MOVE_MIN_PX = 60f            // 单次移动距离下限（源像素 × scale）
    const val MOVE_MAX_PX = 240f
    const val MOVE_MARGIN = 20f
    const val MOVE_STRIDE_DEFAULT_PX = 120f
    const val FACING_RATIO = 0.07f          // inwardFacing 的中线滞回带：(right-left)*0.07；
                                            // x < center-band → 应朝右(1)，x > center+band → 应朝左(-1)，带内不纠正(0)
}

object Feedback {
    const val SQUASH_MS = 220L             // 点击 Q 弹时长
    const val SQUASH_W = 0.10f             // 宽 +10%
    const val SQUASH_H = 0.15f             // 高 -15%
    const val DRAG_THRESHOLD = 5f          // × scale，且下限 6px
    const val LONG_PRESS_PET_MS = 550L
    const val LONG_PRESS_BG_MS = 450L
    const val CLICK_MAX_MS = 520L
    const val DBLCLICK_JUMP_VY = -1400f
}

object Collision {                          // 宠物之间（原 resolveCollisions）
    const val MAX_COMPANIONS = 4
    const val FRICTION = 0.08f
    const val IMPULSE_CAP = 9000f
    const val SLOP = 0.5f
    // 形状：把 body_box 内切成沿长轴的 3 个等半径圆，r = min(w,h)/2
    // 低速接触 (vn >= -1.0) 改非弹性 e = 0
    // 位置分离：sep = clamp((overlap - SLOP) * 0.6, 1.0, 12.0)，按逆质量分摊
}
```

- 每次点击的挤压动画：`sx = 1 + 0.10*sin(πp)`、`sy = 1 - 0.15*sin(πp)`（`p = t/220ms`），**锚点在底中**（`transform-origin: 50% 100%`）。
- 镜像：素材默认朝左；`facing > 0 && !clip.no_mirror` 时 `scaleX = -1`，与挤压叠加成 `scale(flip*sx, sy)`。
- 边界：悬浮模式 `floor = screenHeightCss - 2`，`x ∈ [w/2, max(w/2, screenW - w/2)]`；非悬浮模式 `floorPad = max(6, round(h*0.012))`。
- 副宠：`scale = 0.75 × 主宠`，`mass = 0.75`，落点与已有宠物至少相距 `0.72 × 宽度`。
- 气泡：锚到 `head_box` 顶部中心（减 `crop` 偏移、乘 scale），水平 clamp 到 `[bw/2+8, screenW - bw/2 - 8]`，垂直 `≥ 气泡高 + 8`；停留 `bubbleSeconds`（默认 3.2s）；**悬浮模式下不画气泡，改发 toast**（原实现 `if (overlay) { toast(text); return; }`）。

---

## 9. 时序预算总表

| 动作 | 预算 | 说明 |
| --- | --- | --- |
| 主循环 | 每帧（`withFrameNanos`） | `dt` 上限 0.1s，`dt <= 0` 直接 return |
| 物理子步 | ≤ 8ms | 大 dt 拆成多步，避免穿透 |
| 触摸窗几何更新 | ≥ 12ms 节流 | 原实现 `now - _winTick < 12 → return`；`force=true` 时绕过（拖拽松手、转屏） |
| 窗口几何提交 | 下一帧 | `Choreographer.postFrameCallback`，见 §2.3 |
| 进悬浮窗后回退后台 | 900ms | `enterOverlay` 里 `postDelayed(900)` |
| 悬浮窗刚起时 Activity onResume | 2000ms 内 → 发 HIDE 自撤 | 防止「悬浮窗和 Activity 同时活着」 |
| 动画帧率 | 24fps（素材原生） | 不要插帧到 60，会让 241 帧的节奏变味 |
| HTTP 连接 / 读取 / 总超时 | 15s / 180s / 200s | 见 §6 |
| 首字等待提示 | 8s 后换文案 | 「她还在认真想…（思考模型首字会比较慢）」 |
| 气泡停留 | 默认 3.2s（可配 1..30s） | |
| 说话间隔 | 默认 20~60s（可配 5..600s） | |

---

## 10. 失败处理总表

| 场景 | 必须的行为 |
| --- | --- |
| 无悬浮窗权限 | `enterOverlay` 返回 `PermissionDenied` **并主动拉起授权页**；UI 提示「请在弹出的系统页面里允许「显示在其他应用上层」，然后回来再点一次」 |
| 建窗失败（两类型都抛） | toast「悬浮窗没起来：多半是「显示在其他应用上层」没开」+ `stopSelf()`；不要留下僵尸服务 |
| `startForeground` 失败 | 只记日志「通知栏常驻失败（不影响悬浮）：…」，**悬浮继续工作** |
| 素材加载失败 | 展示错误卡片「素材加载失败：<msg>」，不要白屏 |
| manifest 缺字段 | 用兜底默认：`crop = Rect(0,0,640,360)`、`body_box = [212,60,428,330]`、`head_box = [185,60,436,195]` |
| TTS 初始化失败 / 无中文 | `ttsReady = false`；`speak` 返回 `TtsUnavailable`；日志「TTS 中文不可用」/「TTS 初始化失败」；**不弹错误** |
| AI 未配置（base 或 model 为空） | 不发请求，toast「先在设置里填 AI 接口地址与模型名」 |
| HTTP 非 2xx | 不抛异常；把 `status` + 错误体交回，UI 显示 `HTTP <code> · <error.message>`（截断 300 字） |
| 请求超时 | `{status:-1, body:"请求超时"}`，气泡位置替换成失败提示 |
| `updateViewLayout` 抛异常 | 只 `Log.w`，不 crash；下一次几何变更继续尝试 |
| 窗口对象被系统回收（instance 为空） | `setWindowSize`/`moveWindow` **静默丢弃**，不抛 |
| 配置变更（转屏） | 先 `applyScreenSize()` 重铺整屏，再 `onOrientationChanged()`（顺序不能反） |
| 重复 boot | 幂等锁：第二次启动直接 return（原实现 `global.__booted`，防止「一只变两只」） |

---

## 11. 验收清单（可自动化的部分）

在一台 1080×2400 / density 3.0 的模拟器上逐条验：

- [ ] `screen()` 返回 `{360, 约 (2400-insets)/3, 3.0}`，与 `decorView` 实测可用区一致（误差 ≤1px）
- [ ] 悬浮模式首帧：窗口出现后 500ms 内可见宠物，无「黑一下」
- [ ] 触摸窗尺寸 = `round(crop.w × scale)` × `round(crop.h × scale)`，位置 = `(pet.x - w/2, pet.y - h)`
- [ ] 拖拽跟手：手指移动 100px，宠物位移 100px（误差 ≤2px），无累计漂移
- [ ] 点宠物周围 5px 的空白：**仍然命中**（与原实现一致，矩形命中）
- [ ] 点屏幕另一角的空白：**命中主宠**（回退行为，与原实现一致）
- [ ] 双击宠物：向上弹起，`vy ≈ -1400`
- [ ] 同段动画连续播 5 次：每次都从头播（不出现「第二次不播」）
- [ ] 连续切换 20 段随机动作：内存不单调上涨（≤2 段常驻）
- [ ] 转屏：宠物重新落到新屏幕的 floor，无穿模、无残留旧坐标
- [ ] `httpPost` 打一个 400 的接口：UI 显示 `HTTP 400 · …`，不 crash
- [ ] `httpPost` 打一个 190s 才返回的接口：成功；打 210s：`请求超时`
- [ ] 设置改 `scale` 后杀进程重启：值保持（走 `dsh_pet_kv/settings`）
- [ ] 老版本（`__v` 缺失）的设置 JSON 灌进去：不崩、`companions` 变 false
- [ ] 关掉「显示在其他应用上层」后再点悬浮：拉起系统设置页，回到 App 后能正常进悬浮

---

## 12. 已知坑（原实现踩过的，别重踩）

1. **JS 桥调用必须 bind**：`host[name]` 直接取方法引用再调，Chromium 会抛「Java bridge method can't be invoked on a non-injected object」。Kotlin 侧没有这问题，但**如果你保留了任何 JS 兼容层，必须 bind**。
2. **`__winApplied` 是幽灵契约**：前端在等它，安卓壳从不发。→ Kotlin 侧要么真发（§2.7），要么复刻 400ms 乐观采纳。
3. **每次换 nonce 会「位移先动、动画后出来」**：两个固定变体才是对的（§5.2）。
4. **`crispMode` 靠子串嗅探**：`contains("\"overlayCrisp\":true")`。改用独立键（§7）。
5. **拖拽期间窗口固定成整屏**（`setWindowSize(screenW, screenH)` + `moveWindow(0,0)`），宠物在窗口内纯 CSS 平移 —— 这样「窗口还没到位、坐标已乐观更新」的错位根本不存在。这是原实现最关键的抗抖设计，**必须保留**。
6. **`_geoHide` 是空实现**（注释写着「改由原生侧负责」，但原生只改了尺寸，没做 alpha 隐藏）。所以原 App 在几何切换那一刻其实会闪一下，只是被 400ms 兜底掩盖。Kotlin 侧可以真做：`renderParams.alpha = 0f → apply → alpha = 1f`。
7. **`onTouch` 必须 return true**，否则事件穿透到下层 App（桌面宠物场景下这是致命的）。
8. **别用 `setLayoutParams` 平滑移动窗口**：`updateViewLayout` 才是唯一真相，任何「渐变」都会与行为层的坐标计算打架。
9. **`getRawX/getRawY` 与窗口位置无关**：如果你用 `getX()`（视图内坐标），在触摸窗跟随时会得到错误值 —— 这是「拖拽一格一格跳」的经典成因，原实现为此专门写了注释（engine.js:566-567）。
10. **241 帧 × 640×360 的透明 WebP 不能全量预解码**（§5.3）。
