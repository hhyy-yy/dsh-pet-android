# 声明与署名

本仓库的代码与美术素材适用**不同的**许可，请勿混用。

## 1. 代码 —— MIT

`android/app/src/main/assets/web/**` 下的全部 HTML / CSS / JavaScript，以及 `tools/` 下的脚本，
适用仓库根目录的 [LICENSE](LICENSE)（MIT）。

包括但不限于：`pet.js`、`engine.js`、`ui.js`、`chat.js`、`settings.js`、`bridge.js`、`util.js`、
`index.html`、`app.css`、`extract-assets.py`。

## 2. 角色动画素材 —— 保留权利，仅限个人非商业使用

**这不适用 MIT。**

- **角色 OC**：溟月 —— 原作出自画师 **上善无形**。
- **素材整理**：由社区成员制作整理。
- **条款**：此类同人素材按 **CC BY-NC-SA 类条款**发布，**仅限个人非商业使用**。
- **适用范围**：`assets/web/assets/anim/**` 下的 106 段动画 WebP、`assets/web/assets/icon/**`、
  `assets/web/assets/chat/**` 背景图，以及由它们派生的一切（含应用图标）。

**本仓库不直接分发这些文件**：`tools/extract-assets.py` 只是从你自己持有的 APK 里按原字节
抽取，不解码、不转码、不改写。因此上面的条款作用于你从 APK 抽出来的那份素材，而不是
本仓库里的文字或代码。

转载、再分发角色素材时请保留：**角色：溟月 / 画师：上善无形 / 仅限个人非商业使用**。

## 3. 音效 —— MIT（第三方）

| 文件 | 来源 | 许可 |
|---|---|---|
| `assets/web/assets/sounds/duck/Ya1.mp3` | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | MIT，Copyright (c) 2025 MeteorNOX |
| `assets/web/assets/sounds/duck/Ya2.mp3` | 同上 | 同上 |

完整 MIT 正文：

```text
MIT License

Copyright (c) 2025 MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 4. DeepSeek 鲸鱼标识

`assets/web/assets/chat/ds_whale.png` 为 DeepSeek 的品牌标识，仅作标识用途。
DeepSeek 及相关标识归其权利人所有，本项目与 DeepSeek 官方无隶属或背书关系。

## 5. 运行时依赖

本 App **零第三方 SDK**（597 条 DEX 字符串中不含任何商业 SDK 包名），网络层直接使用
`java.net.HttpURLConnection`。原生侧不打包任何 GPL 组件。

---

若你是上述任一素材的权利人并认为本仓库的使用方式需要调整，请开 issue 联系。
