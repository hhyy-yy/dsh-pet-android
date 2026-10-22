# 素材与数据契约

角色素材是整段烘焙好的**动画 WebP**（VP8X + alpha，单文件 241 帧 @24fps），
不是 Live2D / Spine / 骨骼动画，也不是序列帧目录。

## 为什么素材不进仓库

106 段合计 **350,667,518 字节（334.4 MiB）**，占 APK 体积的 99.04%。单个文件
最大的是 `anim/random_077.webp`（7.4 MB，"放烟花"）。这不适合放进 git。

仓库里的做法：

- `android/app/src/main/assets/web/assets/manifest.json` 与 `manifest.js` **随仓库分发**
  （它们只有 ~48 KB，是权威清单）；
- 106 个 `.webp` 由 [`tools/extract-assets.py`](../tools/extract-assets.py) 从你自己手里的
  APK 里按原字节抽取（**不重新编码**），一条命令还原成可直接构建的状态。

```bash
python tools/extract-assets.py --apk <你的APK> --verify
```

`--verify` 会拿每个 clip 的字节数与 manifest 声明逐条比对，对不上直接报错退出——
所以「脚本跑通了」等于「这份素材和清单是同一次构建」。

仓库另外带了一套 **开发桩素材**（`assets-stub/`，3.4 MB，6 段低帧数占位动画），
没有 APK 也能把页面跑起来看布局与交互：

```
index.html?assets=assets-stub
```

## 清单结构

`manifest.json` 顶层字段：

| 字段 | 值 | 含义 |
|---|---|---|
| `canvas` | `{"w":640,"h":360}` | 所有动画的统一画布 |
| `crop` | `{"x":0,"y":0,"w":640,"h":360}` | 从画布裁出的有效区域 |
| `union_box` | `{"x":5,"y":0,"w":626,"h":360}` | 全片段包围盒并集 |
| `fps` | `24` | 基准帧率 |
| `body_box` | `[212,60,428,330]` | 身体框（物理碰撞 / 屏幕夹取 / 自动缩放锚点） |
| `head_box` | `[185,60,436,195]` | 头顶框（气泡定位） |
| `clips` | 106 项 | 见下 |
| `sounds` | 6 项 | `click` / `duck_ya1` / `duck_ya2` / `agent_start` / `agent_done` / `agent_error` |
| `chat_bg` | 11 项 | 对话面板背景图文件名 |
| `icon` | `icon/app_icon.png` | 应用图标 |

单条 clip：

```json
{
  "id": "idle/待机呼吸休闲",
  "name": "待机呼吸休闲",
  "cat": "idle",
  "file": "anim/idle_001.webp",
  "frames": 241,
  "fps": 24.0,
  "loop": true,
  "stride": null,
  "no_mirror": false,
  "bytes": 3008258
}
```

- `stride`：只有 `move` 类有值，一步位移多少**源像素**；移动距离 = `stride × scale`。
- `no_mirror`：为 `true` 表示该段不可左右镜像（素材默认朝左，`facing>0` 时整体 `scaleX=-1` 翻转）。
- `frames / fps`：`clipDuration = frames / fps × 1000`（241 帧 / 24fps ≈ 10,042 ms）。

## 分段统计

| 类别 | 段数 | 用途 |
|---|---|---|
| `idle` | 1 | 待机呼吸循环 |
| `move` | 3 | 左转奔跑 / 漂浮踏步 / 螃蟹走路 |
| `turn` | 1 | 东张西望（转向过渡） |
| `click` | 5 | 点击回应：傲娇生气 / 元气挥手 / 害羞惊讶 / 开心跃动 / 挠痒咯咯笑 |
| `drag` | 1 | 被拖拽悬空反馈 |
| `events` | 6 | 余额档位：钱袋满溢 → 钱袋如常 → 金袋叮当 → 数金皱眉 → 袋空如洗 → 分文不剩 |
| `random` | 89 | 随机小动作（吃 / 玩 / 节日 / 工作状态 / 碎碎念 …） |
| **合计** | **106** | **25,423 帧 / 350,667,518 B** |

完整 106 行清单见 [`anim-clips.txt`](anim-clips.txt)（类别 / 中文名 / 文件名 / 帧数 / 帧率 / 是否循环 / 字节）。

## 素材之外的资源

| 资源 | 位置 | 说明 |
|---|---|---|
| 聊天背景 | `web/assets/chat/`（11 张 JPG/PNG，2.2 MB） | 对话面板可选背景 |
| 音效 | `web/assets/sounds/`（8 个 WAV/MP3，64 KB） | 点击音、Agent 状态音 |
| 图标 | `web/assets/icon/app_icon.png`（286 KB） | 应用内图标 |
| 开发桩 | `web/assets-stub/`（6 段 webp + 2 个 mp3，3.4 MB） | 无 APK 时的占位素材 |

## 命名规律

`anim/<cat>_<NNN>.webp`，`NNN` 是 **001..106 的全局连续序号**（跨类别递增，不是各类自增）。
可读的中文名只存在于 `manifest.json` 的 `clips[].name` / `clips[].id`。

```
anim/idle_001.webp      待机呼吸休闲
anim/move_002.webp      左转奔跑
anim/turn_005.webp      东张西望
anim/click_006.webp     点击回应-傲娇生气
anim/drag_011.webp      被鼠标拖拽悬空反馈
anim/events_012.webp    余额-分文不剩
anim/random_061.webp    工作状态-垂头叹气冒汗（118 帧，唯一的非 241 帧片段）
anim/random_106.webp    鲸鱼吐泡泡特效
```
