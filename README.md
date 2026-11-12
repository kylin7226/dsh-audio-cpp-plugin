# dsh-audio-cpp-plugin

English | [中文](README.zh.md)

Native audio capabilities for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), backed by an [audio.cpp](https://github.com/0xShug0/audio.cpp) server.

audio.cpp is a pure-C++ ggml inference engine for audio models (ASR, TTS, VAD, voice conversion, and more) with an OpenAI-compatible HTTP server. This plugin connects DSH to a running audio.cpp server and turns it into native Harness capabilities — no Python, no model downloads, no process management inside the plugin.

## Features

- **GUI voice input** — registers a `speechToText` provider (`audio-cpp`) with the Harness voice-input subsystem, so the composer's microphone button transcribes through your audio.cpp ASR model. Audio stays on your infrastructure.
- **`speech_transcribe` agent tool** — transcribe a local audio file to text. WAV is sent directly; mp3/flac/m4a/ogg and other formats are converted with ffmpeg. Returns text plus audio/inference durations.
- **`speech_synthesize` agent tool** — synthesize text to a local WAV file, with optional voice selection and speaking-style instruction. When no voice is given, the server default applies; for zero-shot models that require reference audio (e.g. CosyVoice3), the first voice-library entry is used. The agent can deliver the file to you with `present`.
- **Model auto-discovery** — model ids come from configuration, or are discovered from the server's `/v1/models` roster by task (`asr` / `tts`).
- **Model options** — pass any request option your server model declares (`asrOptions` / `ttsOptions`), e.g. ITN, chunk size, sampling controls.
- **Settings page** — the plugin's card under **Plugins** has a configuration form: server URL with a live connection status, ASR/TTS model pickers, voice picker, and language. It stays model-agnostic: anything specific to one model family goes under **Advanced settings** as plain `key = value` lines (`asrOptions` / `ttsOptions`), forwarded to the server unchanged. Values are written through the official config editor, so the profile patch stays the source of truth.
- **Clean transcripts** — SenseVoice-style inline tags (`<|zh|><|HAPPY|>...`) are stripped by default (configurable).

The plugin is a stateless HTTP client: the audio.cpp server, its models, and its voice library are owned and managed by you.

## Requirements

| Requirement | Notes |
|---|---|
| DeepSeek Harness `>= 0.2.2-rc.1` | Uses the experimental voice-input packages shipped with DSH |
| A running [audio.cpp](https://github.com/0xShug0/audio.cpp) server | With at least one ASR model and one TTS model registered; see below |
| ffmpeg (optional) | Only for transcribing non-WAV files; must be on the Host's PATH or set `ffmpegPath` |

### Set up an audio.cpp server

Download a prebuilt binary from the [audio.cpp releases](https://github.com/0xShug0/audio.cpp/releases) (CPU, CUDA, Vulkan, Metal, ...), install models from the [audio.cpp GGUF repository](https://huggingface.co/audio-cpp/audio.cpp-gguf), and register them in a server config:

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

Any ASR/TTS families supported by audio.cpp work (Qwen3-ASR, Fun-ASR-Nano, Kokoro, Qwen3-TTS, ...). See the [audio.cpp server guide](https://github.com/0xShug0/audio.cpp/blob/main/app/server/README.md) and [model docs](https://github.com/0xShug0/audio.cpp/blob/main/docs/usage.md) for the full options, voice libraries (`voice_dir`), and streaming modes.

## Install

From npm (recommended):

```sh
dsh plugin --profile web add dsh-audio-cpp-plugin
```

Or from GitHub source:

```sh
dsh plugin --profile web add github:kylin7226/dsh-audio-cpp-plugin
```

Once listed in the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) catalog, it is also one-click installable from [dsh-market](https://github.com/dsh-market/dsh-market) inside the Plugins page.

The bundle inserts four rows: the plugin itself, the DSH speech-to-text service (default provider `audio-cpp`), the speech Web Remote, and the voice-input UI. Refresh the browser page after installation; the microphone button appears in the composer.

## Configure

Open **Plugins → dsh-audio-cpp-plugin** for the settings form. The main form holds only fields that mean the same thing for every audio.cpp model family. Model-specific request options live under **Advanced settings**: one `key = value` per line, forwarded to the server as given (only bare `true` / `false` become booleans; quote a value that needs surrounding spaces). This keeps the page working across model families — the plugin never has to know what `template_name` or `text_chunk_size` means.

The same fields are editable by hand in the profile's `cordis.patch.yml` (the user patch layer):

```yaml
- id: audio-cpp-plugin
  name: dsh-audio-cpp-plugin
  config:
    serverUrl: http://127.0.0.1:8080
    asrModel: my-asr        # optional; discovered from /v1/models when empty
    ttsModel: my-tts        # optional; discovered from /v1/models when empty
    defaultVoice: demo_3_woman  # optional; server default when empty
    ttsOptions:             # optional; request options declared by the model
      text_chunk_size: 400
    asrOptions:             # optional
      enable_itn: true
```

| Field | Default | Meaning |
|---|---|---|
| `serverUrl` | `http://127.0.0.1:8080` | Base URL of the audio.cpp server |
| `asrModel` | `''` (auto) | Server model id for transcription; empty picks the first `asr` model |
| `ttsModel` | `''` (auto) | Server model id for synthesis; empty picks the first `tts` model |
| `defaultVoice` | `''` (server default) | Voice sent when a request omits one — a **reference-library** name or a **built-in** voice id (see below) |
| `language` | `auto` | Default ASR language hint; `auto` omits the hint |
| `asrOptions` | `{}` | Request options for `/v1/audio/transcriptions`, sent as the `options` form field |
| `ttsOptions` | `{}` | Request options for `/v1/audio/speech`, sent as `options` |
| `stripTags` | `true` | Strip `<\|...\|>` model tags from transcripts |
| `requestTimeoutMs` | `300000` | Per-request timeout |
| `ffmpegPath` | `ffmpeg` | ffmpeg executable for non-WAV conversion |

Model option names and accepted values are defined by your server's model family — see [model docs](https://github.com/0xShug0/audio.cpp/blob/main/docs/usage.md) and `GET /v1/models?include_params=true` on your server for what each one accepts.

### Two kinds of voice

audio.cpp TTS models differ in how a voice is selected, and the settings page distinguishes them:

- **Reference-library voices** — files in the server's `voice_dir` (or its model presets). Your server lists these through `GET /v1/audio/voices`, and the settings page shows them with a `reference voice` chip and offers them as autocomplete. Cloning families such as CosyVoice3 *require* one; when neither a voice nor a reference is configured, the plugin falls back to the first library voice.
- **Built-in voices** — speaker packs packaged inside the model weights (for example Kokoro's `af_heart` / `zf_xiaoxiao`, or Qwen3-TTS CustomVoice's `Vivian`). The server does **not** enumerate them; enter the id the model's documentation specifies. The page marks anything outside the reference library as `custom / built-in id`.

If a synthesis fails with `requires reference audio`, the selected model has no built-in voice and needs a reference-library entry instead.

## Usage

**Voice input** — click the microphone in the composer, speak, and the recognized text lands in the input box. The provider advertises the SenseVoice language set (`auto, zh, en, yue, ja, ko`); other ASR models may accept more hints through the tool.

**Agent tools** — ask the agent naturally, e.g.:

> "Transcribe meeting.mp3" → `speech_transcribe { path: "meeting.mp3" }`
>
> "Read this summary aloud and give me the audio" → `speech_synthesize { text: "...", output: "summary.wav" }` then `present`

`speech_synthesize` parameters: `text` (required), `output` (WAV path, defaults to `tts-<id>.wav` in the session working directory), `voice` (server voice-library name or model-native voice id), `instruct` (speaking-style instruction for instruct-capable models).

## How it works

```
GUI microphone ──> DSH speechToText service ──> provider "audio-cpp" ─┐
speech_transcribe tool ──────────────────────────────────────────────┤──> audio.cpp server
speech_synthesize tool ──────────────────────────────────────────────┘    /v1/audio/transcriptions
                                                                          /v1/audio/speech
```

- Transcription uploads WAV bytes as multipart to `/v1/audio/transcriptions`; non-WAV inputs are converted to 16 kHz mono PCM16 with ffmpeg first.
- Synthesis posts JSON to `/v1/audio/speech` and writes the returned WAV to the requested path.
- All requests forward the caller's cancellation signal and a configurable timeout; tool calls are cooperative with the Harness timeout policy.
- Activation probes `/health` and `/v1/models` once and logs the connection result; nothing is downloaded or started.

Tested with SenseVoice-Small (`sense_asr`) and CosyVoice3 (`cosyvoice3`) on audio.cpp v0.9.4, Vulkan backend.

## Roadmap

audio.cpp supports far more than ASR/TTS — VAD, speaker diarization, voice conversion, source separation, music generation. The client architecture here is task-agnostic; additional tools can be added on the same server connection. Contributions welcome.

## Development

Plain JavaScript (ESM), no build step. The Host resolves `@deepseek-ai/*` peer packages from the DSH installation at runtime.

```sh
node --check index.js
```

## License

[MIT](LICENSE) · Built on [audio.cpp](https://github.com/0xShug0/audio.cpp) (see its license for the engine and model weights).