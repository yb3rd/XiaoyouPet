# 小尤桌宠（XiaoyouPet）

一个独立运行的 VRM 桌面宠物：透明置顶、点击穿透、聊天、语音、新闻、在线点歌、长期记忆，还会主动找你说话。

基于 **Tauri v2 + WebView2 + three-vrm**，不依赖 Electron，也不会把聊天写进 OpenCode 的会话历史。

![screenshot](docs/screenshot.png)

## 功能

- 透明、无边框、置顶窗口；人物可拖动
- 双击换动作；跳舞/唱歌时双击立即停止
- 右键菜单：输入消息 / 点歌 / 点击穿透 / 主动聊天 / 朗读 / 静音 / 换模型 / 动作 / 跳舞 / 唱歌 / 设置
- `Ctrl+Alt+P` 或托盘菜单切换点击穿透，不挡其他窗口
- 通过本地 OpenCode 服务聊天，长期记忆保存在本机
- Edge TTS 语音，内置普通话、方言、粤语、台湾、日语、韩语、多语言女声
- 新闻：AI / 国际 / 二次元 / 游戏 / ACG，带「📰 详细」原文面板
- 在线点歌：说「播放 起风了」会自动搜索、缓存并播放
- 主动聊天：可调频率，会问带选项的问题，也会像真人一样吐槽、关心、播报
- 只上传默认模型和 3 个默认动作；个人模型、动作、音乐、记忆和密钥都不进仓库

## 环境

- Windows 10/11
- Node.js 20+
- Rust stable + Visual Studio Build Tools（Windows）
- 本地 OpenCode 服务（聊天推理用；Tauri 版默认读取本机 `~/.local/state/opencode/service.json`。这是后端依赖，不是项目品牌；要完全脱离可改直连模型 API）
- Python + `edge-tts`（可选，语音用；没有时回退系统语音）

```bash
pip install edge-tts
```

## 运行

```bash
npm install
npm run tauri dev
```

打包：

```bash
npm run tauri build
```

只构建带内置前端的 debug exe：

```bash
npm run build:debug
# 产物：src-tauri/target/debug/xiaoyou-pet.exe
```

> Release 打包如果遇到本机 rustc 的 `core` rlib 元数据问题，可先用 `build:debug` 产物；换一个 Rust stable 工具链后 `npm run tauri build` 即可。

## 默认资源

仓库自带：

```text
public/sample.vrm          ← 默认 VRM 模型 AvatarSample_A
animations/idle-maid.vrma  ← 默认待机
animations/idle-sitting.vrma
animations/grabbed.vrma
```

这些默认资源的授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

个人资源不会上传，放在本机即可：

```text
models/       ← 其他 *.vrm（已被 .gitignore）
animations/   ← 其他 *.vrma，例如 dance_*.vrma（已被 .gitignore）
mp3/          ← 本地歌曲（已被 .gitignore）
memory/       ← 对话记忆（运行时生成，已被 .gitignore）
music_cache/  ← 在线点歌缓存（运行时生成，已被 .gitignore）
```

便携版把 exe 和 `animations/` 放在同一目录即可。默认模型已经打进 exe 前端，不需要额外复制 `sample.vrm`。

## 交互

| 操作 | 功能 |
| --- | --- |
| 拖动人物 | 移动窗口 |
| **双击人物** | 随机换动作；跳舞/唱歌时停止并回到 `idle-maid` |
| **右键人物** | 输入消息 / 点歌 / 主动聊天 / 朗读 / 静音 / 换模型 / 动作 / 跳舞 / 唱歌 / 设置 / 退出；设置和退出固定在菜单底部 |

「换模型」会列出 `models/` 里的 VRM；「动作」会列出 `animations/` 里的 VRMA。没有「无/自然站立」，待机固定用 `idle-maid`。

设置里新增 **缩放**（80% / 100% / 150% / 210% / 270% / 350% / 490%）和 **点击穿透**。100% 以上窗口会跟着一起变大，人物保持完整；超过屏幕能放下的尺寸时会自动限制，并提示实际值。

窗口不显示在任务栏；右下角托盘图标左键菜单是 **设置 / 退出**，点设置会自动关闭点击穿透。

## 聊天与记忆

- 右键 →「输入消息」，Enter 发送
- 聊天通过本机 OpenCode 服务完成，支持 OpenAI 兼容来源和 OpenCode Go
- 对话写入本机 `memory/memory.json`：最近 100 条历史，发送给模型时取最近 24 条
- 每 4 轮自动整理一段长期记忆摘要（称呼、偏好、习惯、约定等）
- 记忆只在本地，不随仓库上传

## 语音

默认使用 Edge TTS，设置里可选：

- 普通话：晓晓、晓伊、云健、云希、云夏、云扬
- 方言：晓北（东北）、晓妮（陕西）
- 粤语：曉佳、曉曼、雲龍
- 台湾：曉臻、曉雨、雲哲
- 日语：七海
- 韩语：SunHi
- 多语言：Ava、Emma、Vivienne、Seraphina、Thalita
- 系统语音（离线回退）

如果本机 `voices/piper/` 里有 Piper + `zh_CN-huayan-medium` 模型，设置里会多出 **华颜 · 温柔甜美（离线）**。Piper 和音色文件不上传仓库；华颜只支持中文，音调设置对它无效，语速有效。

支持语速和音调。语音只是 TTS 朗读；唱歌模式是「播放原曲 + 对口型/动作」，不是真正的歌声合成。

## 新闻

右键「朗读下一条」或等待主动聊天，会随机播报：

- AI 新闻（Hacker News）
- 国际新闻（Hacker News）
- 二次元 / 游戏（B 站排行榜）
- ACG（机核 RSS）

播报后气泡下方会出现「📰 详细」，点开可看标题、来源，并用默认浏览器打开原文。

## 在线点歌

直接输入：

```text
播放 起风了
唱一首 大鱼
我想听 光年之外
点歌 周深
```

宠物会搜索网易云音乐，把可播放版本下载到 `music_cache/`，然后播放 + 随机动作 + 对口型。重复点同一首会使用缓存；网上找不到时会尝试本地 `mp3/` 的同名歌曲。

- 只是播放原曲 + 动作 + 对口型，不是让宠物用自己的声音重新唱
- 网易云没有版权的歌可能只能找到翻唱，或直接提示找不到
- 在线源受版权、VIP 和网络影响，不保证每首都成功
- 本仓库不包含任何 MP3 或缓存文件

## 主动聊天

默认「经常」，每 1–2 分钟主动说话；设置或右键菜单可切换关闭 / 普通 / 经常 / 很频繁。

- 大约三分之一是带 2–3 个选项的提问，点选项就会继续聊
- 同一道题不会短时间重复；已回答的问题会记很久
- 会按早上/中午/下午/晚上和最近聊过的话题挑问题
- 一部分问题由模型结合长期记忆和实时对话生成
- 其余时间是日常吐槽、关心、天气或新闻，不会一直追问
- 提问之间至少间隔约 4 分钟

## 点击穿透

如果宠物挡住其他窗口：

- 设置 →「点击穿透」，或按 `Ctrl+Alt+P`
- 开启后窗口完全忽略鼠标；再按一次关闭
- 窗口本身点不到时，点击右下角托盘图标 → **设置**，会自动关闭穿透并打开设置
- 托盘菜单：**设置 / 退出**；窗口不占任务栏，托盘图标是主要入口
- 开关状态会记住

## 凭证与隐私

- 运行时只读取本机 `~/.local/state/opencode/service.json`，不会复制到仓库
- 仓库不含 API Key、token、cookie、`.env`、`auth.json`、`*.pem`
- `.gitignore` 已屏蔽个人模型、个人动作、MP3、记忆、歌曲缓存和密钥文件
- 默认模型和 3 个默认动作是例外，仅用于让项目开箱可运行

## 已知限制

- 口型是按音节随机切换的近似动画，不是精确音素同步
- 聊天依赖本机 OpenCode 服务；要完全脱离 OpenCode，需要改成直连模型 API
- 默认只带待机/抓取动作；舞蹈和更丰富的动作需要自己往 `animations/` 放 `.vrma`
- 目前主要验证 Windows 透明窗口、点击穿透和托盘
- 在线点歌依赖第三方音乐服务，可能因版权或网络失效

## 协议

代码使用 [MIT License](LICENSE)。

默认 VRM 模型和默认动作来自第三方，使用它们各自的授权，详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。个人模型、动作、音乐和记忆不在本仓库中。
