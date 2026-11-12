# dsh-audio-cpp-plugin

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供原生音频能力，底层对接 [audio.cpp](https://github.com/0xShug0/audio.cpp) 服务。

audio.cpp 是纯 C++ 的 ggml 音频模型推理引擎（ASR、TTS、VAD、声音转换等），自带 OpenAI 兼容的 HTTP 服务。本插件把运行中的 audio.cpp 服务接入 DSH，变成 Harness 的原生能力——无 Python、不下载模型、不在插件内管理进程。

## 功能

- **GUI 语音输入** — 向 Harness 语音输入子系统注册 `speechToText` provider（`audio-cpp`），输入框的麦克风按钮直接走你的 audio.cpp ASR 模型转写。音频全程留在你自己的基础设施上。
- **`speech_transcribe` 工具** — 把本地音频文件转成文字。WAV 直传；mp3/flac/m4a/ogg 等格式经 ffmpeg 转换。返回文本及音频/推理时长。
- **`speech_synthesize` 工具** — 把文字合成为本地 WAV 文件，可选音色与语气指令。未指定音色时用服务端默认；对需要参考音频的零样本模型（如 CosyVoice3），自动取音色库第一个音色。Agent 可用 `present` 把音频交付给你。
- **模型自动发现** — 模型 id 可配置，也可留空时由插件从服务端 `/v1/models` 按任务（`asr` / `tts`）自动选取。
- **实时 / 非实时识别** — 可让服务端边解码边返回转写事件（`stream`），或整段解码后一次返回（`offline`）；`speech_transcribe` 结果会标明实际走的路径，流式时还给出首个文本耗时。
- **模型选项** — 可传入服务端模型声明的任意请求参数（`asrOptions` / `ttsOptions`），如 ITN、分块长度、采样控制等。
- **设置页面** — 插件在 **插件页** 的卡片上有配置表单：服务器地址与实时连接状态、ASR/TTS 模型选择、音色、识别语言。主表单保持模型无关：某个模型家族特有的参数放在 **高级设置** 里，按 `key = value` 逐行填写（`asrOptions` / `ttsOptions`），原样传给服务端。保存经官方配置编辑器写入，profile 补丁层仍是唯一事实来源。
- **干净转写** — 默认清理 SenseVoice 风格的内联标签（`<|zh|><|HAPPY|>...`），可配置关闭。

插件是无状态 HTTP 客户端：audio.cpp 服务、模型与音色库均由你自行拥有和管理。

## 环境要求

| 要求 | 说明 |
|---|---|
| DeepSeek Harness `>= 0.2.2-rc.1` | 使用 DSH 自带的实验性语音输入包 |
| 运行中的 [audio.cpp](https://github.com/0xShug0/audio.cpp) 服务 | 至少注册一个 ASR 模型和一个 TTS 模型，见下文 |
| ffmpeg（可选） | 仅转写非 WAV 文件时需要；在宿主 PATH 中或配置 `ffmpegPath` |

### 搭建 audio.cpp 服务

从 [audio.cpp releases](https://github.com/0xShug0/audio.cpp/releases) 下载预编译二进制（CPU、CUDA、Vulkan、Metal 等），从 [audio.cpp GGUF 仓库](https://huggingface.co/audio-cpp/audio.cpp-gguf) 安装模型，并在服务配置中注册：

```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "backend": "cpu",
  "lazy_load": true,
  "models": [
    {
      "id": "my-asr",
      "family": "sense_asr",
      "path": "/path/to/models/SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf",
      "task": "asr",
      "mode": "offline"
    },
    {
      "id": "my-tts",
      "family": "cosyvoice3",
      "path": "/path/to/models/CosyVoice3-GGUF/cosyvoice3-q8_0.gguf",
      "task": "tts",
      "mode": "offline"
    }
  ]
}
```

```sh
audiocpp_server --config server.json
```

audio.cpp 支持的任意 ASR/TTS 模型家族均可（Qwen3-ASR、Fun-ASR-Nano、Kokoro、Qwen3-TTS 等）。完整选项、音色库（`voice_dir`）与流式模式见 [audio.cpp 服务指南](https://github.com/0xShug0/audio.cpp/blob/main/app/server/README.md) 和 [模型文档](https://github.com/0xShug0/audio.cpp/blob/main/docs/usage.md)。

## 安装

npm（推荐）：

```sh
dsh plugin --profile web add dsh-audio-cpp-plugin
```

或从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:kylin7226/dsh-audio-cpp-plugin
```

收录进 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 目录后，也可在插件页的 [dsh-market](https://github.com/dsh-market/dsh-market) 市场中一键安装。

Bundle 会插入四行：插件本体、DSH 语音转写服务（默认 provider `audio-cpp`）、语音 Web Remote、语音输入 UI。安装后刷新浏览器页面，输入框即出现麦克风按钮。

## 配置

打开 **插件 → dsh-audio-cpp-plugin** 即为设置表单。主表单只放对所有 audio.cpp 模型家族含义一致的字段；模型特有参数放在 **高级设置** 中，每行一个 `key = value`，原样传给服务端（只有裸写的 `true` / `false` 转为布尔值；值首尾含空格时加引号）。这样换模型、换服务端都不用改插件——插件无需理解 `template_name` 或 `text_chunk_size` 的具体含义。

同样的字段也可在 profile 的 `cordis.patch.yml`（用户补丁层）中手工编辑：

```yaml
- id: audio-cpp-plugin
  name: dsh-audio-cpp-plugin
  config:
    serverUrl: http://127.0.0.1:8080
    asrModel: my-asr        # 可选；留空则从 /v1/models 自动发现
    ttsModel: my-tts        # 可选；留空则从 /v1/models 自动发现
    defaultVoice: demo_3_woman  # 可选；留空则用服务端默认
    ttsOptions:             # 可选；模型声明的请求参数
      text_chunk_size: 400
    asrOptions:             # 可选
      enable_itn: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8080` | audio.cpp 服务地址 |
| `asrModel` | `''`（自动） | 转写用的服务端模型 id；留空取第一个 `asr` 模型 |
| `ttsModel` | `''`（自动） | 合成用的服务端模型 id；留空取第一个 `tts` 模型 |
| `defaultVoice` | `''`（服务端默认） | 请求未指定音色时发送的音色——**参考音色库**名称或**内置音色** ID（见下） |
| `language` | `auto` | 默认 ASR 语言提示；`auto` 表示不发送提示 |
| `asrMode` | `auto` | `offline` 整段解码一次返回，`stream` 增量返回转写事件。`auto` 与 `offline` 都走非实时；GUI 语音输入始终走实时。 |
| `asrOptions` | `{}` | `/v1/audio/transcriptions` 的请求参数，以 `options` 表单字段发送 |
| `ttsOptions` | `{}` | `/v1/audio/speech` 的请求参数，以 `options` 发送 |
| `stripTags` | `true` | 清理转写文本中的 `<\|...\|>` 模型标签 |
| `requestTimeoutMs` | `300000` | 单请求超时 |
| `ffmpegPath` | `ffmpeg` | 非 WAV 转换用的 ffmpeg 可执行文件 |

模型选项的名称与取值范围由你服务端的模型家族决定——参见 [模型文档](https://github.com/0xShug0/audio.cpp/blob/main/docs/usage.md) 以及服务端的 `GET /v1/models?include_params=true`。

### 两类音色

audio.cpp 的 TTS 模型选音色方式不同，设置页对两者做了区分：

- **参考音色库** — 服务端 `voice_dir` 里的 WAV（或模型预设）。服务端通过 `GET /v1/audio/voices` 列出，设置页会标注「参考音色」并作为补全候选。CosyVoice3 这类克隆模型**必须**有参考音色；既没配音色也没给参考音频时，插件自动回退到音色库第一个。
- **内置音色** — 打包在模型权重里的说话人（如 Kokoro 的 `af_heart` / `zf_xiaoxiao`、Qwen3-TTS CustomVoice 的 `Vivian`）。服务端**不会**枚举它们，需按该模型文档填写 ID；设置页会把不在音色库里的值标为「自定义 / 内置 ID」。

若合成报 `requires reference audio`，说明所选模型没有内置音色，需要改用参考音色库中的音色。

### 实时与非实时识别

audio.cpp 提供两种转写方式，插件都支持：

- **非实时**（`asrMode: offline`，默认 `auto` 同此）— 服务端整段解码后一次返回，短音频最简单。
- **实时**（`asrMode: stream`）— 服务端在解码已上传音频的过程中持续推送 `transcript.text.delta` 事件，以 `transcript.text.done` 结束。插件把这些事件拼成最终文本，并报告 `timeToFirstText`；长音频下首个文本远早于整体解码完成。

实时需要服务端把 ASR 模型配置成 `"mode": "streaming"`。若模型只支持非实时，服务端会返回普通 JSON，插件透明读取。两种方式最终文本一致。插件没有使用 `/v1/audio/transcriptions/live`（边说边传 PCM）：DSH 语音输入是每句话提交一段完整录音，暂无增量音频可推送。

## 使用

**语音输入** — 点击输入框麦克风，说话，识别文本直接进入输入框。Provider 向 GUI 提供 SenseVoice 语言集（`auto, zh, en, yue, ja, ko`）；其他 ASR 模型可通过工具接受更多语言提示。

**Agent 工具** — 直接用自然语言吩咐，例如：

> “把 meeting.mp3 转成文字” → `speech_transcribe { path: "meeting.mp3" }`
>
> “把这段总结朗读出来给我” → `speech_synthesize { text: "...", output: "summary.wav" }` 然后 `present`

`speech_synthesize` 参数：`text`（必填）、`output`（WAV 路径，默认会话工作目录下 `tts-<id>.wav`）、`voice`（服务端音色库名或模型原生音色 id）、`instruct`（语气指令，仅 instruct 类模型生效）。

### 实时读取服务状态

设置页不缓存任何服务端事实，每次加载都重新读取其 API：

| 界面显示 | 数据来源 |
|---|---|
| 连接状态、后端、版本 | `GET /health` |
| ASR/TTS 模型及其 task、`mode`、`family`、`loaded` | `GET /v1/models?include_params=true` |
| 各类模型数量、支持实时的 ASR 数、配置但已不存在的模型 id | 由模型列表推导 |
| 所选 TTS 模型的参考音色 | `GET /v1/audio/voices?model=<id>` |

状态分三档：`ok`、`degraded`（`/health` 有响应但模型列表失败）、`unreachable`（并给出具体原因：连接被拒、DNS、TLS 或超时）。若配置里的模型 id 已不在服务端广播列表中，会明确列出，避免过期配置看起来一切正常。在表单中切换 TTS 模型会立即重新查询该模型的音色，无需先保存。

## 工作原理

```
GUI 麦克风 ──> DSH speechToText 服务 ──> provider "audio-cpp" ─┐
speech_transcribe 工具 ──────────────────────────────────────┤──> audio.cpp 服务
speech_synthesize 工具 ──────────────────────────────────────┘    /v1/audio/transcriptions
                                                                  /v1/audio/speech
```

- 转写以 multipart 上传 WAV 字节到 `/v1/audio/transcriptions`；非 WAV 输入先经 ffmpeg 转为 16 kHz 单声道 PCM16。
- 合成向 `/v1/audio/speech` 发送 JSON，把返回的 WAV 写入指定路径。
- 所有请求转发调用方的取消信号并受可配置超时约束；工具调用与 Harness 超时策略协作。
- 激活时探测一次 `/health` 与 `/v1/models` 并记录连接结果；不下载、不启动任何东西。

已在 audio.cpp v0.9.4（Vulkan 后端）上用 SenseVoice-Small（`sense_asr`）与 CosyVoice3（`cosyvoice3`）实测。

## 路线图

audio.cpp 的能力远不止 ASR/TTS——还有 VAD、说话人分离、声音转换、音源分离、音乐生成等。本插件的客户端架构与任务无关，可在同一服务连接上继续扩展工具。欢迎贡献。

## 开发

纯 JavaScript（ESM），无构建步骤。`@deepseek-ai/*` peer 包由宿主在运行时从 DSH 安装中解析。

```sh
node --check index.js
```

## 许可证

[MIT](LICENSE) · 基于 [audio.cpp](https://github.com/0xShug0/audio.cpp) 构建（引擎与模型权重的许可证见其仓库）。