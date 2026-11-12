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
  asrMode: z.union([z.const('auto'), z.const('offline'), z.const('stream')]).default('auto'),
  stripTags: z.boolean().default(true),
  requestTimeoutMs: z.number().min(1000).default(300000),
  ffmpegPath: z.string().default('ffmpeg'),
  asrOptions: z.dict(z.union([z.string(), z.number(), z.boolean()])).default({}),
  ttsOptions: z.dict(z.union([z.string(), z.number(), z.boolean()])).default({})
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

/**
 * Read the server's transcription SSE stream into one final transcript.
 * Emits `transcript.text.delta` events and ends with `transcript.text.done`
 * (or `[DONE]`); returns undefined when the stream carried no usable result,
 * so the caller can fall back to a JSON body.
 */
async function readTranscriptionStream(body, signal) {
  if (body === null) return undefined
  const decoder = new TextDecoder()
  let buffer = ''
  let finalText
  let firstDeltaAt
  let ttftMs
  const started = Date.now()

  const handle = chunk => {
    const type = chunk?.type
    if (typeof type !== 'string') return
    if (type === 'transcript.text.delta' && firstDeltaAt === undefined) firstDeltaAt = Date.now()
    if (type === 'transcript.text.done') {
      finalText = String(chunk.text ?? '')
      ttftMs = chunk.timing?.ttft_ms
    }
    // A streamed failure ends without a done event; surface it instead of
    // silently returning partial text.
    if (type === 'error') {
      throw new Error(`audio.cpp streaming transcription failed: ${chunk.error?.message ?? 'unknown error'}`)
    }
  }

  for await (const part of body) {
    signal?.throwIfAborted()
    buffer += decoder.decode(part, { stream: true })
    let boundary = buffer.indexOf('\n')
    while (boundary !== -1) {
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        if (payload !== '') {
          try { handle(JSON.parse(payload)) } catch (error) {
            if (error instanceof SyntaxError) continue
            throw error
          }
        }
      }
      boundary = buffer.indexOf('\n')
    }
  }

  if (finalText === undefined) return undefined
  const elapsedMs = ttftMs ?? (firstDeltaAt === undefined ? undefined : firstDeltaAt - started)
  return {
    text: finalText,
    audioSeconds: 0,
    inferenceSeconds: 0,
    timeToFirstTextSeconds: elapsedMs === undefined ? undefined : elapsedMs / 1000
  }
}

/** One place that turns transport failures into actionable messages. */
/** Collect candidate error codes from fetch's single and aggregate causes. */
function failureCodes(error) {
  const codes = new Set()
  const visit = cause => {
    if (cause === null || typeof cause !== 'object' || codes.size > 16) return
    if (typeof cause.code === 'string') codes.add(cause.code)
    if (typeof cause.errno === 'string') codes.add(cause.errno)
    if (Array.isArray(cause.errors)) for (const nested of cause.errors) visit(nested)
    if (cause.cause !== undefined && cause.cause !== cause) visit(cause.cause)
  }
  visit(error)
  visit(error?.cause)
  return codes
}

function describeFailure(error, serverUrl) {
  const codes = failureCodes(error)
  const has = (...names) => names.some(name => codes.has(name))
  if (error?.name === 'AbortError') return 'Cancelled.'
  if (error?.name === 'TimeoutError' || has('UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT')) {
    return `The audio.cpp server at ${serverUrl} timed out.`
  }
  if (has('ECONNREFUSED')) {
    return `Cannot reach the audio.cpp server at ${serverUrl} (connection refused). Check that audiocpp_server is running and the port is right.`
  }
  if (has('ENOTFOUND', 'EAI_AGAIN')) return `Cannot resolve the audio.cpp server host in ${serverUrl}.`
  if (has('CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT')) {
    return `TLS certificate verification failed for ${serverUrl}.`
  }
  if (has('ERR_INVALID_URL')) return `Malformed server URL: ${serverUrl}`
  const cause = error?.cause?.message
  const detail = cause && cause !== 'fetch failed' ? cause : error?.message
  return `audio.cpp request failed for ${serverUrl}: ${detail ?? 'unknown error'}`
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
  async function transcribe(wavBytes, { language, model, signal, filename = 'audio.wav', stream } = {}) {
    const modelId = model ?? await resolveModel('asr', config.asrModel, signal)
    const form = new FormData()
    form.append('model', modelId)
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), filename)
    const hint = language ?? config.language
    if (hint && hint !== 'auto') form.append('language', hint)
    if (config.asrOptions && Object.keys(config.asrOptions).length > 0) {
      form.append('options', JSON.stringify(config.asrOptions))
    }
    // Streaming asks the server to emit transcript deltas while it decodes the
    // already-uploaded recording; it shortens time-to-first-text but never
    // changes the final transcript.
    const wantStream = stream ?? config.asrMode === 'stream'
    if (wantStream) form.append('stream', 'true')

    const res = await request('/v1/audio/transcriptions', { method: 'POST', body: form }, signal)
    if (wantStream && (res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const streamed = await readTranscriptionStream(res.body, signal)
      if (streamed !== undefined) {
        const text = config.stripTags ? stripModelTags(streamed.text) : streamed.text
        return {
          text,
          audioSeconds: streamed.audioSeconds || wavSeconds(wavBytes) || 0,
          inferenceSeconds: streamed.inferenceSeconds,
          timeToFirstTextSeconds: streamed.timeToFirstTextSeconds,
          mode: 'stream'
        }
      }
    }

    const json = await res.json()
    const raw = String(json.text ?? '')
    const text = config.stripTags ? stripModelTags(raw) : raw
    const timing = json.timing ?? {}
    return {
      text,
      audioSeconds: (timing.audio_duration_ms ?? 0) / 1000 || wavSeconds(wavBytes) || 0,
      inferenceSeconds: (timing.wall_ms ?? 0) / 1000,
      mode: 'offline'
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
    let voiceSource = selectedVoice ? 'configured' : undefined
    if (!selectedVoice && !voiceRef) {
      // Zero-shot models (e.g. CosyVoice3) require reference audio; when the
      // server has no default preset, fall back to its first library voice.
      const voices = await listVoices(modelId, signal)
      if (voices.length > 0) {
        selectedVoice = voices[0]
        voiceSource = 'library'
      }
    }
    if (selectedVoice) body.voice = selectedVoice
    if (instruct) body.instruct = instruct
    if (config.ttsOptions && Object.keys(config.ttsOptions).length > 0) {
      body.options = { ...config.ttsOptions }
    }
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
    return { buf, voice: selectedVoice, voiceSource }
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

/** Send one JSON response on a raw carrier socket. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/** Read a bounded JSON request body. */
function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

/**
 * Same-origin fence for the configuration routes, mirroring the host's own
 * trust model: the Host authority must be loopback, the carrier's bind
 * address, a declared trusted host, or the carrier origin; a browser-stated
 * Origin must additionally match that authority.
 */
function createOriginFence(ctx) {
  const authorityName = host => {
    const lower = String(host).toLowerCase()
    return lower.startsWith('[') ? lower.slice(1, lower.indexOf(']')) : lower.split(':')[0]
  }
  const trusted = host => {
    const name = authorityName(host)
    if (name === 'localhost' || name === '::1' || name.startsWith('127.')) return true
    const bind = ctx.get('webServer')?.host
    if (typeof bind === 'string' && bind !== '' && name === authorityName(bind)) return true
    const declared = ctx.get('connection')?.trustedHosts
    if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (typeof entry === 'string' && authorityName(entry) === name) return true
      }
    }
    try {
      if (new URL(ctx.get('webServer').getOrigin()).host === String(host).toLowerCase()) return true
    } catch { /* carrier origin unavailable */ }
    return false
  }
  return req => {
    const host = req.headers.host
    if (host !== undefined && !trusted(host)) return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      try {
        if (new URL(origin).host !== host) return false
      } catch { return false }
    }
    return true
  }
}

/** Keep only known configuration fields with sane types; reject bad URLs. */
function sanitizeConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be an object')
  }
  const out = {}
  if (input.serverUrl !== undefined) {
    if (typeof input.serverUrl !== 'string') throw new Error('serverUrl must be a string')
    let url
    try { url = new URL(input.serverUrl) } catch { throw new Error('serverUrl is not a valid URL') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('serverUrl must be http(s)')
    out.serverUrl = input.serverUrl
  }
  for (const key of ['asrModel', 'ttsModel', 'defaultVoice', 'language', 'ffmpegPath']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error(`${key} must be a string`)
      out[key] = input[key]
    }
  }
  if (input.asrMode !== undefined) {
    if (!['auto', 'offline', 'stream'].includes(input.asrMode)) {
      throw new Error('asrMode must be auto, offline, or stream')
    }
    out.asrMode = input.asrMode
  }
  if (input.stripTags !== undefined) {
    if (typeof input.stripTags !== 'boolean') throw new Error('stripTags must be a boolean')
    out.stripTags = input.stripTags
  }
  if (input.requestTimeoutMs !== undefined) {
    if (typeof input.requestTimeoutMs !== 'number' || !Number.isFinite(input.requestTimeoutMs) || input.requestTimeoutMs < 1000) {
      throw new Error('requestTimeoutMs must be a number >= 1000')
    }
    out.requestTimeoutMs = Math.round(input.requestTimeoutMs)
  }
  for (const key of ['asrOptions', 'ttsOptions']) {
    if (input[key] !== undefined) {
      if (input[key] === null || typeof input[key] !== 'object' || Array.isArray(input[key])) {
        throw new Error(`${key} must be an object`)
      }
      const options = {}
      for (const [name, value] of Object.entries(input[key])) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(`${key}.${name} must be a string, number, or boolean`)
        }
        options[name] = value
      }
      out[key] = options
    }
  }
  return out
}

/** The configuration fields the settings page reads and writes. */
function configView(config) {
  return {
    serverUrl: config.serverUrl,
    asrModel: config.asrModel,
    ttsModel: config.ttsModel,
    defaultVoice: config.defaultVoice,
    language: config.language,
    asrMode: config.asrMode,
    stripTags: config.stripTags,
    requestTimeoutMs: config.requestTimeoutMs,
    ffmpegPath: config.ffmpegPath,
    asrOptions: config.asrOptions ?? {},
    ttsOptions: config.ttsOptions ?? {}
  }
}

/**
 * Register the same-origin configuration routes when the carrier and the
 * config editor are present (web profiles). The settings page reads the
 * effective config plus live server discovery, and writes through the
 * official config editor so the profile patch stays the source of truth.
 */
function registerConfigRoutes(ctx, config) {
  ctx.inject(['webServer', 'configEditor'], child => {
    const fence = createOriginFence(child)
    const base = config.serverUrl.replace(/\/+$/, '')

    /** Best-effort short-timeout probe of the audio.cpp server for the UI. */
    async function probe(path) {
      try {
        const res = await fetch(base + path, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) return { ok: false, status: res.status }
        return { ok: true, body: await res.json() }
      } catch (error) {
        return { ok: false, error: describeFailure(error, config.serverUrl) }
      }
    }

    child.effect(() => {
      const disposeRead = child.webServer.register({
        kind: 'exact',
        path: '/audio-cpp-plugin/config',
        handler: async (req, res) => {
          if (!fence(req)) return sendJson(res, 403, { error: 'untrusted origin' })
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })

          // Everything below is read live from the server on every request:
          // nothing about models, capabilities, voices, or readiness is cached.
          const healthProbe = await probe('/health')
          const modelsProbe = await probe('/v1/models?include_params=true')
          const list = modelsProbe.ok && Array.isArray(modelsProbe.body?.data) ? modelsProbe.body.data : []

          // Voice discovery must follow the model the page is showing right now, so an
      // unsaved pick in the model selector still lists that model's voices.
      // `?model=` overrides the stored configuration for this read only.
      const requestedTts = typeof req.url === 'string' ? new URL(req.url, 'http://localhost').searchParams.get('model') : null
      const ttsId = requestedTts || config.ttsModel || list.find(m => m.task === 'tts')?.id
          const voicesProbe = ttsId ? await probe(`/v1/audio/voices?model=${encodeURIComponent(ttsId)}`) : undefined

          let status
          if (!healthProbe.ok) {
            status = { state: 'unreachable', detail: healthProbe.error ?? (healthProbe.status ? `HTTP ${healthProbe.status}` : 'no response') }
          } else if (!modelsProbe.ok) {
            status = { state: 'degraded', detail: modelsProbe.error ?? `HTTP ${modelsProbe.status}` }
          } else {
            status = { state: 'ok', detail: undefined }
          }

          const asrModels = list.filter(m => m.task === 'asr')
          const ttsModels = list.filter(m => m.task === 'tts')
          // Model ids configured on the server but absent from its advertise
          // list mean the stored config no longer matches what is running.
          const missing = []
          if (config.asrModel && !list.some(m => m.id === config.asrModel)) missing.push(config.asrModel)
          if (config.ttsModel && !list.some(m => m.id === config.ttsModel)) missing.push(config.ttsModel)

          sendJson(res, 200, {
            status,
            config: configView(config),
            server: {
              health: healthProbe.ok ? healthProbe.body : null,
              models: list,
              capabilities: {
                asr: asrModels.length,
                tts: ttsModels.length,
                streamingAsr: asrModels.filter(m => m.mode === 'streaming').length,
                loaded: list.filter(m => m.loaded === true).length,
                missing
              },
              voiceModel: ttsId ?? null,
              voicesAvailable: voicesProbe !== undefined && voicesProbe.ok,
              // Only the shared reference library is enumerable; built-in
              // voices are packaged inside model weights and never listed.
              voices: voicesProbe?.ok && Array.isArray(voicesProbe.body?.voices) ? voicesProbe.body.voices : [],
              voiceKinds: {
                library: voicesProbe?.ok && Array.isArray(voicesProbe.body?.voices) ? voicesProbe.body.voices : [],
                builtIn: 'not-enumerable'
              }
            }
          })
        }
      })
      const disposeWrite = child.webServer.register({
        kind: 'exact',
        path: '/audio-cpp-plugin/config/save',
        handler: async (req, res) => {
          if (!fence(req)) return sendJson(res, 403, { error: 'untrusted origin' })
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
          const entry = child.fiber.entry
          const editor = child.get('configEditor')
          if (entry === undefined || editor === undefined) {
            return sendJson(res, 503, { error: 'Configuration cannot be saved in this profile' })
          }
          let sanitized
          try {
            const body = await readJsonBody(req)
            sanitized = sanitizeConfig(body.config)
          } catch (error) {
            return sendJson(res, 400, { error: error.message })
          }
          try {
            await editor.edit(entry, current => ({ ...current, ...sanitized }))
          } catch (error) {
            return sendJson(res, 409, { error: `Configuration write rejected: ${error.message}` })
          }
          sendJson(res, 200, { ok: true })
        }
      })
      return () => {
        disposeRead()
        disposeWrite()
      }
    })
  })
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

  // GUI settings page backend; inactive in profiles without a web carrier.
  registerConfigRoutes(ctx, config)

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
            inferenceSeconds: { type: 'number', required: true, description: 'Server inference wall time.' },
            mode: { type: 'string', required: true, description: 'Recognition path used: stream (incremental transcript events) or offline.' },
            timeToFirstTextSeconds: { type: 'number', description: 'Stream mode only: time until the first transcript event.' }
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
          const value = {
            text: result.text,
            audioSeconds: round3(result.audioSeconds),
            inferenceSeconds: round3(result.inferenceSeconds),
            mode: result.mode
          }
          if (result.timeToFirstTextSeconds !== undefined) {
            value.timeToFirstTextSeconds = round3(result.timeToFirstTextSeconds)
          }
          return value
        } finally {
          await cleanup()
        }
      }
    }))

    const disposeSynthesize = ctx.tools.register(defineTool({
      name: 'speech_synthesize',
      description: 'Synthesize speech from text to a local WAV file with an audio.cpp TTS server. Voice accepts either a reference-library name or a built-in voice id packaged with the model; omit it to use the configured default, the server default, or the first reference voice when the model requires a reference. Returns the written file path; deliver the audio to the user with present.',
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
          description: 'Either a reference-library name (for cloning models) or a built-in voice id packaged in the model weights (e.g. af_heart for Kokoro, Vivian for Qwen3-TTS CustomVoice). Built-in voices are not listed by the server, so pass the id the model documents. Omit for the configured default, the server default, or the first reference voice when the model requires a reference.'
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