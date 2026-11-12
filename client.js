/**
 * Client half of dsh-audio-cpp-plugin: the plugin settings page shown on the
 * bundle's card in the Plugins page (`plugins.bundle.config`).
 *
 * Model-agnostic by design: the main form holds only fields that mean the same
 * thing for every audio.cpp model family (server, model ids, voice, language).
 * Model-specific request options live under Advanced as raw key = value lines,
 * so they work for any family without the UI knowing its parameters.
 *
 * Plain-JS React component; styles use only `--dsw-alias-*` theme tokens so
 * appearance follows the host in both light and dark themes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-audio-cpp-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'audio-cpp-plugin'

    const zh = {
      serverUrl: '服务器地址',
      serverUrlHint: 'audio.cpp 服务的 HTTP 地址',
      status: '连接状态',
      online: '已连接',
      offline: '无法连接',
      backend: '后端',
      asrModel: '语音识别模型（ASR）',
      ttsModel: '语音合成模型（TTS）',
      auto: '自动（第一个同类模型）',
      noModels: '服务端未返回模型，请检查地址',
      defaultVoice: '默认音色',
      serverDefaultVoice: '留空则由服务端决定',
      voiceHint: '填参考音色库名称，或模型自带的内置音色 ID（是否支持取决于所选模型）',
      referenceVoices: '参考音色库',
      noReferenceVoices: '本模型未提供参考音色；克隆类模型（如 CosyVoice3）必须要有参考音色才能合成',
      builtInNote: '内置音色（如 Kokoro 的 af_heart）打包在模型权重里，服务端不列出，需按该模型文档填写其 ID',
      voiceKindLibrary: '参考音色',
      voiceKindCustom: '自定义 / 内置 ID',
      voiceEffective: '当前将发送 voice = {voice}',
      voiceServerDefault: '当前不发送音色，由服务端选择；若模型要求参考音频且未配置默认音色，将自动使用参考音色库第一个',
      language: '识别语言',
      refresh: '刷新',
      refreshing: '刷新中…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，配置正在重新加载',
      saveFailed: '保存失败',
      advanced: '高级设置',
      advancedHint: '以下选项对所有 audio.cpp 模型通用，按需填写',
      asrOptions: '识别请求参数（options）',
      ttsOptions: '合成请求参数（options）',
      optionsHint: '每行一个 key = value，值原样传给服务端模型（只有 true/false 会按布尔发送）；留空表示用模型默认值',
      optionsPlaceholder: 'text_chunk_size = 400\nenable_itn = true\nseed = 1234',
      stripTags: '清理识别结果中的模型标签',
      stripTagsHint: '移除 <|zh|>、<|HAPPY|> 这类内联标签（不同模型标签形式不同）',
      requestTimeoutMs: '请求超时（毫秒）',
      ffmpegPath: 'ffmpeg 路径',
      ffmpegPathHint: '仅转写非 WAV 文件时使用',
      showAdvanced: '展开',
      hideAdvanced: '收起',
      parseError: '参数格式有误，请写成 key = value',
      errorLines: '问题行：'
    }

    const en = {
      serverUrl: 'Server URL',
      serverUrlHint: 'HTTP address of the audio.cpp server',
      status: 'Status',
      online: 'Connected',
      offline: 'Unreachable',
      backend: 'Backend',
      asrModel: 'Speech recognition model (ASR)',
      ttsModel: 'Speech synthesis model (TTS)',
      auto: 'Automatic (first of this task)',
      noModels: 'The server returned no models; check the URL',
      defaultVoice: 'Default voice',
      serverDefaultVoice: 'Empty: the server decides',
      voiceHint: 'A reference-library name, or a built-in voice id the selected model packages',
      referenceVoices: 'Reference library',
      noReferenceVoices: 'This model exposes no reference voices; cloning models such as CosyVoice3 cannot synthesize without one',
      builtInNote: 'Built-in voices (e.g. af_heart for Kokoro) are packaged in the model weights and are not listed by the server; enter the id its documentation specifies',
      voiceKindLibrary: 'reference voice',
      voiceKindCustom: 'custom / built-in id',
      voiceEffective: 'Requests will send voice = {voice}',
      voiceServerDefault: 'No voice is sent; the server decides, falling back to the first reference voice when the model requires reference audio',
      language: 'Recognition language',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; the configuration is reloading',
      saveFailed: 'Save failed',
      advanced: 'Advanced settings',
      advancedHint: 'These options are model-agnostic and are passed through as given',
      asrOptions: 'Transcription request options',
      ttsOptions: 'Synthesis request options',
      optionsHint: 'One key = value per line; values are forwarded as given (only true/false become booleans). Empty means the model default',
      optionsPlaceholder: 'text_chunk_size = 400\nenable_itn = true\nseed = 1234',
      stripTags: 'Strip model tags from transcripts',
      stripTagsHint: 'Removes inline tags such as <|zh|> or <|HAPPY|>; tag shapes differ per model family',
      requestTimeoutMs: 'Request timeout (ms)',
      ffmpegPath: 'ffmpeg path',
      ffmpegPathHint: 'Used only to convert non-WAV files',
      showAdvanced: 'Show',
      hideAdvanced: 'Hide',
      parseError: 'Invalid option line, expected key = value',
      errorLines: 'Lines: '
    }

    const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

    /** Parse `key = value` lines into a typed options object. */
    function parseOptions(text) {
      const options = {}
      const errors = []
      const lines = String(text ?? '').split('\n')
      lines.forEach((raw, index) => {
        const line = raw.trim()
        if (line === '' || line.startsWith('#') || line.startsWith('//')) return
        const at = line.indexOf('=')
        if (at <= 0) {
          errors.push({ line: index + 1, text: raw })
          return
        }
        const key = line.slice(0, at).trim()
        const rawValue = line.slice(at + 1).trim()
        if (key === '') {
          errors.push({ line: index + 1, text: raw })
          return
        }
        if (rawValue === 'true') options[key] = true
        else if (rawValue === 'false') options[key] = false
        else if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
          options[key] = rawValue.slice(1, -1).replaceAll('\\"', '"')
        } else options[key] = rawValue
      })
      return { options, errors }
    }

    /** Render an options object back into editable text. */
    function formatOptions(options) {
      if (options === null || typeof options !== 'object') return ''
      return Object.entries(options).map(([key, value]) => {
        if (typeof value === 'boolean') return `${key} = ${value}`
        const text = String(value)
        // Quote only values a reader could not retype unambiguously.
        if (text === '' || text.trim() !== text || text.includes('\n') ||
            /^["']/.test(text) || /^true$|^false$/.test(text)) {
          return `${key} = "${text.replaceAll('"', '\\"')}"`
        }
        return `${key} = ${text}`
      }).join('\n')
    }

    const css = `
.aac-root { display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.aac-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.aac-title { font-weight: 600; }
.aac-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.aac-dot.on { background: var(--dsw-alias-state-success-primary); }
.aac-dot.off { background: var(--dsw-alias-state-error-primary); }
.aac-muted { color: var(--dsw-alias-label-secondary); }
.aac-grid { display: grid; grid-template-columns: minmax(120px, 180px) minmax(0, 1fr); gap: 10px 14px; align-items: center; }
.aac-label { color: var(--dsw-alias-label-secondary); }
.aac-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.aac-control { box-sizing: border-box; width: 100%; padding: 6px 9px; border-radius: 7px; font: inherit;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); outline: none; }
.aac-control:focus { border-color: var(--dsw-alias-brand-primary); }
.aac-control:disabled { opacity: .6; }
.aac-textarea { min-height: 84px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; }
.aac-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.aac-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.aac-row { display: flex; align-items: center; gap: 8px; }
.aac-chip { flex: none; padding: 2px 7px; border-radius: 999px; font-size: 11px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.aac-check { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); }
.aac-section { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.aac-section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-weight: 600; }
.aac-actions { display: flex; align-items: center; gap: 10px; }
.aac-btn { padding: 6px 14px; border-radius: 7px; font: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.aac-btn:hover { border-color: var(--dsw-alias-border-l2); }
.aac-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.aac-btn:disabled { opacity: .55; cursor: default; }
.aac-msg.ok { color: var(--dsw-alias-state-success-primary); }
.aac-msg.err { color: var(--dsw-alias-state-error-primary); }
`

    function api(path) {
      const relative = path.replace(/^\/+/, '')
      return typeof document === 'undefined' ? `/${relative}` : new URL(relative, document.baseURI).pathname
    }

    /** One labelled control row. */
    function Row({ label, hint, children }) {
      return h(React.Fragment, null,
        h('div', { className: 'aac-label' }, label),
        h('div', { className: 'aac-field' }, children, hint ? h('div', { className: 'aac-hint' }, hint) : null)
      )
    }

    /** A free-form `key = value` editor for one options object. */
    function OptionEditor({ label, hint, placeholder, text, errors, disabled, onChange, t }) {
      return h('div', { className: 'aac-field' },
        h('div', { className: 'aac-label' }, label),
        h('textarea', {
          className: 'aac-control aac-textarea',
          value: text,
          placeholder,
          disabled,
          spellCheck: false,
          'aria-label': label,
          onChange: event => onChange(event.target.value)
        }),
        h('div', { className: 'aac-hint' }, hint),
        errors.length > 0
          ? h('div', { className: 'aac-error' },
            `${t('parseError')} — ${t('errorLines')}${errors.map(error => error.line).join(', ')}`)
          : null
      )
    }

    function Settings({ t }) {
      const [config, setConfig] = useState(null)
      const [server, setServer] = useState({ health: null, models: [], voices: [] })
      const [texts, setTexts] = useState({ asrOptions: '', ttsOptions: '' })
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [showAdvanced, setShowAdvanced] = useState(false)

      const apply = useCallback(body => {
        setConfig(body.config)
        setServer(body.server ?? { health: null, models: [], voices: [] })
        setTexts({
          asrOptions: formatOptions(body.config?.asrOptions),
          ttsOptions: formatOptions(body.config?.ttsOptions)
        })
      }, [])

      const reload = useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch(api('/audio-cpp-plugin/config'), { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          apply(await res.json())
          setMessage(null)
        } catch (error) {
          setMessage({ kind: 'err', text: `${t('offline')}: ${error.message}` })
        } finally {
          setLoading(false)
        }
      }, [apply, t])

      useEffect(() => { void reload() }, [reload])

      const patch = useCallback((key, value) => {
        setConfig(current => current === null ? current : { ...current, [key]: value })
        setMessage(null)
      }, [])

      const asrParsed = useMemo(() => parseOptions(texts.asrOptions), [texts.asrOptions])
      const ttsParsed = useMemo(() => parseOptions(texts.ttsOptions), [texts.ttsOptions])
      const hasErrors = asrParsed.errors.length > 0 || ttsParsed.errors.length > 0

      const models = Array.isArray(server.models) ? server.models : []
      const asrModels = models.filter(model => model.task === 'asr')
      const ttsModels = models.filter(model => model.task === 'tts')
      const voices = Array.isArray(server.voices) ? server.voices : []
      const online = server.health !== null && server.health !== undefined

      const save = useCallback(async () => {
        if (config === null || hasErrors) return
        setBusy(true)
        setMessage(null)
        try {
          const payload = {
            ...config,
            asrOptions: asrParsed.options,
            ttsOptions: ttsParsed.options
          }
          const res = await fetch(api('/audio-cpp-plugin/config/save'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: payload })
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
          setMessage({ kind: 'ok', text: t('saved') })
          window.setTimeout(() => { void reload() }, 1200)
        } catch (error) {
          setMessage({ kind: 'err', text: `${t('saveFailed')}: ${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [asrParsed, config, hasErrors, reload, t, ttsParsed])

      if (loading && config === null) {
        return h('div', { className: 'aac-root' }, h('div', { className: 'aac-hint' }, t('refreshing')))
      }
      if (config === null) {
        return h('div', { className: 'aac-root' },
          h('div', { className: `aac-msg ${message?.kind ?? 'err'}` }, message?.text ?? t('offline')),
          h('div', { className: 'aac-actions' }, h('button', { className: 'aac-btn', onClick: () => void reload() }, t('refresh')))
        )
      }

      return h('div', { className: 'aac-root' },
        h('style', null, css),

        h('div', { className: 'aac-head' },
          h('span', { className: `aac-dot ${online ? 'on' : 'off'}` }),
          h('span', { className: 'aac-title' }, t('status')),
          h('span', { className: 'aac-muted' }, online ? t('online') : t('offline')),
          online && server.health?.backend
            ? h('span', { className: 'aac-muted' }, `· ${t('backend')} ${server.health.backend}${server.health.version ? ` · ${server.health.version}` : ''}`)
            : null
        ),

        // Model-agnostic fields only: these mean the same thing for every family.
        h('div', { className: 'aac-grid' },
          h(Row, { label: t('serverUrl'), hint: t('serverUrlHint') },
            h('div', { className: 'aac-row' },
              h('input', {
                className: 'aac-control',
                type: 'text',
                value: config.serverUrl,
                disabled: busy,
                onChange: event => patch('serverUrl', event.target.value)
              }),
              h('button', {
                className: 'aac-btn',
                disabled: loading || busy,
                onClick: () => void reload()
              }, loading ? t('refreshing') : t('refresh'))
            )
          ),

          h(Row, { label: t('asrModel'), hint: models.length === 0 ? t('noModels') : null },
            h('select', {
              className: 'aac-control',
              value: config.asrModel,
              disabled: busy,
              onChange: event => patch('asrModel', event.target.value)
            },
              h('option', { value: '' }, `${t('auto')}${asrModels.length ? ` — ${asrModels[0].id}` : ''}`),
              asrModels.map(model => h('option', { key: model.id, value: model.id }, model.id))
            )
          ),

          h(Row, { label: t('ttsModel') },
            h('select', {
              className: 'aac-control',
              value: config.ttsModel,
              disabled: busy,
              onChange: event => patch('ttsModel', event.target.value)
            },
              h('option', { value: '' }, `${t('auto')}${ttsModels.length ? ` — ${ttsModels[0].id}` : ''}`),
              ttsModels.map(model => h('option', { key: model.id, value: model.id }, model.id))
            )
          ),

          h(Row, { label: t('defaultVoice'), hint: t('voiceHint') },
            h('div', { className: 'aac-row' },
              h('input', {
                className: 'aac-control',
                type: 'text',
                list: 'aac-voices',
                value: config.defaultVoice,
                placeholder: voices.length > 0 ? voices[0] : t('serverDefaultVoice'),
                disabled: busy,
                onChange: event => patch('defaultVoice', event.target.value)
              }),
              config.defaultVoice && voices.includes(config.defaultVoice)
                ? h('span', { className: 'aac-chip' }, t('voiceKindLibrary'))
                : null,
              config.defaultVoice && !voices.includes(config.defaultVoice)
                ? h('span', { className: 'aac-chip' }, t('voiceKindCustom'))
                : null
            ),
            // Reference-library names are enumerable; built-in voices are
            // packaged in the model weights and are not advertised by the server.
            voices.length > 0
              ? h('datalist', { id: 'aac-voices' }, voices.map(voice => h('option', { key: voice, value: voice })))
              : null,
            h('div', { className: 'aac-hint' },
              voices.length > 0
                ? `${t('referenceVoices')} (${voices.length}): ${voices.join(', ')}`
                : t('noReferenceVoices')),
            h('div', { className: 'aac-hint' }, t('builtInNote')),
            config.defaultVoice
              ? h('div', { className: 'aac-hint' }, t('voiceEffective').replace('{voice}', config.defaultVoice))
              : h('div', { className: 'aac-hint' }, t('voiceServerDefault'))
          ),

          h(Row, { label: t('language') },
            h('select', {
              className: 'aac-control',
              value: config.language,
              disabled: busy,
              onChange: event => patch('language', event.target.value)
            }, LANGUAGES.map(code => h('option', { key: code, value: code }, code)))
          )
        ),

        // Everything model-specific lives here, as raw values.
        h('section', { className: 'aac-section' },
          h('div', { className: 'aac-section-title' },
            h('span', null, t('advanced')),
            h('button', {
              className: 'aac-btn',
              onClick: () => setShowAdvanced(value => !value)
            }, showAdvanced ? t('hideAdvanced') : t('showAdvanced'))
          ),
          h('div', { className: 'aac-hint' }, t('advancedHint')),
          showAdvanced
            ? h(React.Fragment, null,
              h(OptionEditor, {
                label: t('asrOptions'),
                hint: t('optionsHint'),
                placeholder: t('optionsPlaceholder'),
                text: texts.asrOptions,
                errors: asrParsed.errors,
                disabled: busy,
                onChange: value => {
                  setTexts(current => ({ ...current, asrOptions: value }))
                  setMessage(null)
                },
                t
              }),
              h(OptionEditor, {
                label: t('ttsOptions'),
                hint: t('optionsHint'),
                placeholder: t('optionsPlaceholder'),
                text: texts.ttsOptions,
                errors: ttsParsed.errors,
                disabled: busy,
                onChange: value => {
                  setTexts(current => ({ ...current, ttsOptions: value }))
                  setMessage(null)
                },
                t
              }),
              h('div', { className: 'aac-grid' },
                h(Row, { label: t('stripTags'), hint: t('stripTagsHint') },
                  h('input', {
                    type: 'checkbox',
                    className: 'aac-check',
                    checked: config.stripTags,
                    disabled: busy,
                    onChange: event => patch('stripTags', event.target.checked)
                  })
                ),
                h(Row, { label: t('requestTimeoutMs') },
                  h('input', {
                    className: 'aac-control',
                    type: 'number',
                    min: 1000,
                    value: String(config.requestTimeoutMs),
                    disabled: busy,
                    onChange: event => {
                      const parsed = Number(event.target.value)
                      patch('requestTimeoutMs', Number.isFinite(parsed) ? parsed : config.requestTimeoutMs)
                    }
                  })
                ),
                h(Row, { label: t('ffmpegPath'), hint: t('ffmpegPathHint') },
                  h('input', {
                    className: 'aac-control',
                    type: 'text',
                    value: config.ffmpegPath,
                    disabled: busy,
                    onChange: event => patch('ffmpegPath', event.target.value)
                  })
                )
              )
            )
            : null
        ),

        h('div', { className: 'aac-actions' },
          h('button', {
            className: 'aac-btn primary',
            disabled: busy || hasErrors,
            onClick: () => void save()
          }, busy ? t('saving') : t('save')),
          message ? h('span', { className: `aac-msg ${message.kind}` }, message.text) : null
        )
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-audio-cpp-plugin',
          locale: NS
        }, Settings))
      }
    }
  }
})