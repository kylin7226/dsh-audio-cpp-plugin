/**
 * dsh-audio-cpp-plugin: native audio capabilities for DeepSeek Harness,
 * backed by an audio.cpp server (OpenAI-compatible HTTP API).
 *
 * Current capabilities:
 * - A `speechToText` provider so the native GUI voice input (microphone)
 *   transcribes through the server's ASR model.
 * - `speech_transcribe` (audio file -> text) and `speech_synthesize`
 *   (text -> WAV file) agent tools.
 *
 * The server process, models, and voice library are owned externally; this
 * plugin is a stateless client and downloads nothing. Model ids are taken
 * from configuration or discovered from the server's /v1/models roster.
 */
import { dirname, extname } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Loader identity. */
export const name = 'audio-cpp-plugin'

/** Services this plugin consumes; activation waits for them. */
export const inject = ['tools', 'speechToText', 'fs', 'workingDirectory']

/** Validated client configuration. */
export const Config = z.object({
  serverUrl: z.string().default('http://127.0.0.1:8080'),
  asrModel: z.string().default(''),
  ttsModel: z.string().default(''),
  defaultVoice: z.string().default(''),
  language: z.string().default('auto'),
  stripTags: z.boolean().default(true),
  requestTimeoutMs: z.number().min(1000).default(300000),
  ffmpegPath: z.string().default('ffmpeg')
})

/** Language hints advertised to the GUI picker (SenseVoice set). */
const ASR_LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/** Remove inline model tags such as SenseVoice's <|zh|><|HAPPY|><|withitn|>. */
function stripModelTags(text) {
  return text.replace(/<\|[^|]*\|>/g, '').trim()
}

/** Round seconds for bounded tool output. */
function round3(value) {
  return Math.round(value * 1000) / 1000
}

/** Parse a PCM WAV buffer's duration in seconds; undefined when not WAV. */
function wavSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return undefined
  const byteRate = buf.readUInt32LE(28)
  if (byteRate <= 0) return undefined
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') return size / byteRate
    off += 8 + size + (size & 1)
  }
  return undefined
}

/** One place that turns transport failures into actionable messages. */
function describeFailure(error, serverUrl) {
  const code = error?.cause?.code ?? error?.code
  if (code === 'ECONNREFUSED') return `Cannot reach the audio.cpp server at ${serverUrl} (connection refused). Check that audiocpp_server is running.`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Cannot resolve the audio.cpp server host in ${serverUrl}.`
  if (error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return `The audio.cpp server at ${serverUrl} timed out.`
  if (error?.name === 'AbortError') return 'Cancelled.'
  return `audio.cpp request failed: ${error?.message ?? String(error)}`
}

/** Build the shared HTTP client bound to one validated config. */
function createClient(config) {
  const base = config.serverUrl.replace(/\/+$/, '')
  let modelsCache
  let modelsCachedAt = 0
  let voicesCache
  let voicesCachedAt = 0

  async function request(path, init, signal) {
    const timeout = AbortSignal.timeout(config.requestTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let res
    try {
      res = await fetch(base + path, { ...init, signal: combined })
    } catch (error) {
      if (signal?.aborted) throw new Error('Cancelled.')
      throw new Error(describeFailure(error, config.serverUrl))
    }
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.text()).slice(0, 400) } catch { /* body unreadable */ }
      throw new Error(`audio.cpp server returned HTTP ${res.status} for ${path}${detail ? `: ${detail}` : ''}`)
    }
    return res
  }

  /** The server's model roster, cached briefly so discovery stays cheap. */
  async function listModels(signal) {
    if (modelsCache && Date.now() - modelsCachedAt < 60000) return modelsCache
    const res = await request('/v1/models', {}, signal)
    const json = await res.json()
    modelsCache = Array.isArray(json.data) ? json.data : []
    modelsCachedAt = Date.now()
    return modelsCache
  }

  /** The server's voice library for one TTS model, cached briefly. */
  async function listVoices(model, signal) {
    if (voicesCache && Date.now() - voicesCachedAt < 60000) return voicesCache
    const res = await request(`/v1/audio/voices?model=${encodeURIComponent(model)}`, {}, signal)
    const json = await res.json()
    voicesCache = Array.isArray(json.voices) ? json.voices : []
    voicesCachedAt = Date.now()
    return voicesCache
  }

  /** Configured model id, or the first server model registered for the task. */
  async function resolveModel(task, configured, signal) {
    if (configured) return configured
    const models = await listModels(signal)
    const found = models.find(model => model.task === task)
    if (!found) {
      throw new Error(`No ${task} model is registered on the audio.cpp server at ${config.serverUrl}. Register one in the server config, or set ${task === 'asr' ? 'asrModel' : 'ttsModel'} in the plugin configuration.`)
    }
    return found.id
  }

  /** Transcribe complete WAV bytes; returns text plus measured durations. */
  async function transcribe(wavBytes, { language, model, signal, filename = 'audio.wav' } = {}) {
    const form = new FormData()
    form.append('model', model ?? await resolveModel('asr', config.asrModel, signal))
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), filename)
    const hint = language ?? config.language
    if (hint && hint !== 'auto') form.append('language', hint)
    const res = await request('/v1/audio/transcriptions', { method: 'POST', body: form }, signal)
    const json = await res.json()
    const raw = String(json.text ?? '')
    const text = config.stripTags ? stripModelTags(raw) : raw
    const timing = json.timing ?? {}
    return {
      text,
      audioSeconds: (timing.audio_duration_ms ?? 0) / 1000 || wavSeconds(wavBytes) || 0,
      inferenceSeconds: (timing.wall_ms ?? 0) / 1000
    }
  }

  /** Synthesize text to WAV bytes. */
  async function synthesize({ text, voice, instruct, voiceRef, referenceText, model, signal }) {
    const modelId = model ?? await resolveModel('tts', config.ttsModel, signal)
    const body = {
      model: modelId,
      input: text,
      response_format: 'wav'
    }
    let selectedVoice = voice ?? config.defaultVoice
    if (!selectedVoice && !voiceRef) {
      // Zero-shot models (e.g. CosyVoice3) require reference audio; when the
      // server has no default preset, fall back to its first library voice.
      const voices = await listVoices(modelId, signal)
      if (voices.length > 0) selectedVoice = voices[0]
    }
    if (selectedVoice) body.voice = selectedVoice
    if (instruct) body.instruct = instruct
    if (voiceRef) {
      body.voice_ref = voiceRef
      if (referenceText) body.reference_text = referenceText
    }
    const res = await request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, signal)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
      throw new Error(`audio.cpp returned non-WAV data: ${buf.subarray(0, 200).toString('utf8')}`)
    }
    return { buf, voice: selectedVoice }
  }

  async function health(signal) {
    const res = await request('/health', {}, signal)
    return res.json()
  }

  return { base, transcribe, synthesize, health, listModels }
}

/** Convert any non-WAV audio to 16 kHz mono PCM16 WAV with ffmpeg. */
async function convertToWav(config, inputPath, signal) {
  const dir = await mkdtemp(`${tmpdir()}/audio-cpp-plugin-`)
  const out = `${dir}/input-16k.wav`
  await new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, [
      '-nostdin', '-y', '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    proc.stderr.on('data', chunk => {
      err += chunk.toString()
      if (err.length > 4000) err = err.slice(-4000)
    })
    const onAbort = () => proc.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (fn, arg) => {
      signal?.removeEventListener('abort', onAbort)
      fn(arg)
    }
    proc.on('error', error => settle(reject, new Error(`ffmpeg is unavailable (${error.message}). Install ffmpeg or pass a WAV file.`)))
    proc.on('close', code => {
      if (signal?.aborted) settle(reject, new Error('Cancelled.'))
      else if (code === 0) settle(resolve, undefined)
      else settle(reject, new Error(`ffmpeg conversion failed (exit ${code}): ${err.slice(-400)}`))
    })
  })
  return { path: out, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** Resolve a model-supplied path against the session working directory. */
async function resolveHostPath(ctx, exec, path) {
  const cwd = exec.agent
    ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    : process.cwd()
  const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal })
  return ctx.fs.processPath(target)
}

/**
 * Register the speech provider and the two agent tools.
 * @param ctx - Host context with tools, speechToText, fs, workingDirectory.
 * @param config - validated client configuration.
 */
export function apply(ctx, config) {
  const url = new URL(config.serverUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`dsh-audio-cpp-plugin serverUrl must be http(s): ${config.serverUrl}`)
  }
  const client = createClient(config)
  const log = ctx.logger('audio-cpp-plugin')

  ctx.effect(() => {
    // Native GUI voice input: the browser records 16 kHz mono WAV and the
    // api layer validates it before this provider sees the bytes.
    const unregister = ctx.speechToText.register({
      info: {
        id: 'audio-cpp',
        name: 'audio.cpp ASR',
        location: 'host-local',
        languages: ASR_LANGUAGES
      },
      transcribe: async (input, signal) => {
        const result = await client.transcribe(input.audio, { language: input.language, signal })
        return {
          text: result.text,
          audioSeconds: result.audioSeconds,
          inferenceSeconds: result.inferenceSeconds
        }
      }
    })

    const disposeTranscribe = ctx.tools.register(defineTool({
      name: 'speech_transcribe',
      description: 'Transcribe speech from a local audio file to text with an audio.cpp ASR server. WAV is sent directly; other formats (mp3, flac, m4a, ogg, ...) are converted with ffmpeg. Returns the recognized text.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Audio file path; relative paths resolve against the session working directory.'
        },
        language: {
          type: 'string',
          description: 'Optional language hint accepted by the configured ASR model, e.g. auto, zh, en, yue, ja, ko for SenseVoice. Omit to let the server decide.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true, description: 'Recognized text; empty when no speech was found.' },
            audioSeconds: { type: 'number', required: true, description: 'Input audio duration.' },
            inferenceSeconds: { type: 'number', required: true, description: 'Server inference wall time.' }
          }
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.text || '(no speech recognized)'
        }]
      },
      timeoutMs: 600000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = exec.agent
          ? await ctx.workingDirectory.ensure(exec.agent, exec.signal)
          : process.cwd()
        const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined || info.type !== 'file') {
          throw new Error(`Audio file not found: ${args.path}`)
        }
        const hostPath = ctx.fs.processPath(target)
        let wavBytes
        let cleanup = async () => {}
        if (extname(hostPath).toLowerCase() === '.wav') {
          wavBytes = await readFile(hostPath)
        } else {
          const converted = await convertToWav(config, hostPath, exec.signal)
          cleanup = converted.cleanup
          wavBytes = await readFile(converted.path)
        }
        try {
          exec.signal.throwIfAborted()
          const result = await client.transcribe(wavBytes, { language: args.language, signal: exec.signal })
          return {
            text: result.text,
            audioSeconds: round3(result.audioSeconds),
            inferenceSeconds: round3(result.inferenceSeconds)
          }
        } finally {
          await cleanup()
        }
      }
    }))

    const disposeSynthesize = ctx.tools.register(defineTool({
      name: 'speech_synthesize',
      description: 'Synthesize speech from text to a local WAV file with an audio.cpp TTS server. Voice names come from the server voice library; omit voice to use the server default, or the first library voice when the model requires a reference. Returns the written file path; deliver the audio to the user with present.',
      parameters: {
        text: {
          type: 'string',
          required: true,
          description: 'Text to speak. Long text is chunked by the server automatically.'
        },
        output: {
          type: 'string',
          description: 'Output WAV path; relative paths resolve against the session working directory. Default tts-<id>.wav there.'
        },
        voice: {
          type: 'string',
          description: 'Voice name from the audio.cpp server voice library or a model-native voice id. Omit for the server default (or the first library voice when the model requires a reference).'
        },
        instruct: {
          type: 'string',
          description: 'Optional speaking-style instruction, e.g. "用温柔平静的语气说". Only honored by instruct-capable models.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Absolute path of the written WAV file.' },
            bytes: { type: 'integer', required: true, description: 'File size in bytes.' },
            audioSeconds: { type: 'number', required: true, description: 'Generated speech duration.' },
            voice: { type: 'string', required: true, description: 'Voice used for synthesis; empty when the server default applied.' }
          }
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Speech saved to ${value.path} (${value.audioSeconds}s${value.voice ? `, voice ${value.voice}` : ''})`
        }]
      },
      timeoutMs: 600000,
      async execute(args, exec) {
        if (args.text.trim().length === 0) throw new Error('speech_synthesize requires non-empty text')
        const hostPath = await resolveHostPath(ctx, exec, args.output ?? `tts-${randomUUID().slice(0, 8)}.wav`)
        const { buf, voice } = await client.synthesize({
          text: args.text,
          voice: args.voice,
          instruct: args.instruct,
          signal: exec.signal
        })
        exec.signal.throwIfAborted()
        await mkdir(dirname(hostPath), { recursive: true })
        await writeFile(hostPath, buf)
        return {
          path: hostPath,
          bytes: buf.length,
          audioSeconds: round3(wavSeconds(buf) ?? 0),
          voice
        }
      }
    }))

    // Non-blocking activation probe: surfaces a wrong URL early in the log
    // and reports which models discovery will use.
    void (async () => {
      try {
        const health = await client.health()
        const models = await client.listModels()
        const asr = config.asrModel || models.find(m => m.task === 'asr')?.id || '(none)'
        const tts = config.ttsModel || models.find(m => m.task === 'tts')?.id || '(none)'
        log.info(`connected to audio.cpp ${health.version ?? ''} (${health.backend ?? 'unknown backend'}), ASR model ${asr}, TTS model ${tts}`)
      } catch (error) {
        log.warn(`${describeFailure(error, config.serverUrl)} Speech tools and voice input will retry on first use.`)
      }
    })()

    return async () => {
      disposeTranscribe()
      disposeSynthesize()
      await unregister()
    }
  })
}