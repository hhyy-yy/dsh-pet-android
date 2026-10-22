# 蓝色大肥鱼 · 安卓桌宠

一只住在 Android 悬浮窗里的蓝色小鲸鱼。整屏透明 WebView 渲染 + 原生前台服务宿主，
**106 段烘焙动画**、25,423 帧、约 17.6 分钟不重复动作。

<p align="center">
  <img src="android/app/src/main/assets/web/assets/icon/app_icon.png" width="140" alt="蓝色大肥鱼">
</p>

## 它是什么

- **悬浮在任意应用之上**：`SYSTEM_ALERT_WINDOW` + 前台服务，双窗口拓扑
  （整屏透明渲染窗 + 跟随宠物包围盒的隐形触摸窗）。
- **会自己玩**：待机时掷骰决定继续发呆、转身、还是播一段随机小动作
  （写代码、吃西瓜、涮火锅、玩水枪、放烟花……89 段里随机）。
- **母宠 + 最多 4 只小鲸鱼**：每只独立窗口、独立位置与游走，出生为母宠 75%，
  互相挤开、撞后弹开（三圆链碰撞体）。
- **自带 AI 对话**（BYO key）：设置面板里填任意 OpenAI Chat Completions 兼容接口
  （DeepSeek / OpenAI / 自建都行），API Key 存在应用私有存储里。
- **零第三方 SDK**：597 条 DEX 字符串里搜不到任何商业 SDK 包名；网络层直接用
  `java.net.HttpURLConnection`。没有统计、没有后台服务、没有开机自启。

## 目录

```
android/app/src/main/assets/web/      前端（WebView 的 document root）
  index.html                          入口
  js/pet.js        单宠状态机 + 物理 + 动画播放
  js/engine.js     场景：素材加载 / 逐帧 / 碰撞 / 输入 / 窗口几何同步
  js/ui.js         工具条 / 菜单 / 设置面板 / 对话面板
  js/chat.js       AI 对话
  js/settings.js   27 键设置 + 5 段版本迁移
  js/bridge.js     三宿主（Android / Harmony / 浏览器）桥适配
  js/util.js       工具集
  css/app.css
  assets/manifest.json                权威素材清单（106 段）
  assets-stub/                        开发桩素材（无 APK 也能跑）
docs/                                 架构、素材契约、桥接规格、反汇编
tools/extract-assets.py               从 APK 还原 334 MiB 动画素材
```

## 快速开始

**只想看界面**（不需要 APK，用 3.4 MB 的开发桩素材）：

```bash
cd android/app/src/main/assets/web
python -m http.server 8000
# 打开 http://localhost:8000/index.html?assets=assets-stub&fakehost=1
```

`?fakehost=1` 会用 JS 桩替换原生桥，让页面在没有 Android 壳的情况下跑起来。

**要完整素材**：见下一节。

## 素材：为什么不进仓库

106 段动画合计 **350,667,518 字节（334.4 MiB）**，占 APK 体积的 99.04%，单个文件最大 7.4 MB。
git 装不下也不该装。

仓库里放的是**清单**（`manifest.json`，48 KB）和**提取脚本**；素材由脚本从你手里的 APK
按原字节抽出来，**不重新编码**：

```bash
python tools/extract-assets.py --apk <你的APK> --verify
```

`--verify` 会拿每段动画的字节数与清单逐条比对，对不上就报错退出。跑通即代表
「这份素材和清单同源」。跑完素材落在 `android/app/src/main/assets/web/assets/`，
可以直接构建。

细节见 [`docs/ASSETS.md`](docs/ASSETS.md)。

## 构建

需要 JDK 17 + Android SDK（compileSdk 36）。用你习惯的方式打开 `android/` 即可；
命令行：

```bash
cd android
./gradlew assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/`。

> 本仓库开放的是**已发布 APK 的源码**：前端 9 个 JS 模块零压缩零混淆、中文注释完整，
> 可以直接读、直接改；原生壳的 22 个类以反汇编形式提供（见 `docs/`），
> 因为它们只有 32 KB 且不含业务逻辑——真正的东西全在前端。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 三层结构、双窗口拓扑、触摸链路、行为常量、22 个桥方法、存储契约、内存红线 |
| [`docs/ASSETS.md`](docs/ASSETS.md) | 素材清单结构、106 段分段统计、命名规律、为什么不分发大文件 |
| [`docs/BRIDGE-SPEC.md`](docs/BRIDGE-SPEC.md) | 逐方法的 Kotlin 侧实现规格（29 个入口、悬浮窗参数照抄表、验收清单） |
| [`docs/dex-disassembly.txt`](docs/dex-disassembly.txt) | 22 个类的完整反汇编（162 KB，含注解） |
| [`docs/anim-clips.txt`](docs/anim-clips.txt) | 106 行剪辑表 |

## 已知技术债（如实记录，未修）

1. **`__winApplied` 是不存在的契约**：前端在等这个回调，DEX 里它出现 0 次，
   前端靠 400 ms 超时自愈。
2. **`crisp` 设置靠字符串嗅探**：`readCrispSetting()` 不解析 JSON，直接
   `contains("\"overlayCrisp\":true")`，前端序列化格式一变就失联。
3. **两套掷骰真值**：本 APK 是 `0.20/0.28/0.60`（累计）+ 3 秒定时重掷；
   桌面版 `dsh-pet-indesktop` 是 `0.30/0.40/0.80` + 无定时器。本仓库保留 APK 这一组。
4. **动画内存**：一段 241 帧 × 0.9 MB ≈ 222 MB，106 段合计 ≈ 23.5 GB。
   现在的 `<img>` 换 `src` 方案靠内核解码缓存扛，只能常驻 ≤2 段。

## 许可

- **代码**（`android/app/src/main/assets/web/**` 下的 HTML/CSS/JS、`tools/`）：MIT，见 [LICENSE](LICENSE)。
- **美术素材**（角色动画、图标、聊天背景）：见 [NOTICE.md](NOTICE.md)，**保留权利，仅限个人非商业使用**。
  素材不随本仓库分发，脚本只是从你自己持有的 APK 里抽取。
- **音效**：见 [NOTICE.md](NOTICE.md) 的第三方声明。

---

同系列：桌面版（Windows / Linux / macOS）见 [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop)。
