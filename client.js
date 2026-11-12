/**
 * Client half of dsh-audio-cpp-plugin: the plugin settings page shown on the
 * bundle's card in the Plugins page (`plugins.bundle.config`).
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
      title: '连接设置',
      serverUrl: '服务器地址',
      serverUrlHint: 'audio.cpp 服务的 HTTP 地址',
      status: '连接状态',
      online: '已连接',
      offline: '无法连接',
      backend: '后端',
      models: '模型',
      asrModel: '语音识别模型（ASR）',
      ttsModel: '语音合成模型（TTS）',
      auto: '自动（使用服务端第一个同类模型）',
      noModels: '服务端未返回模型，请检查地址',
      defaultVoice: '默认音色',
      serverDefaultVoice: '服务端默认',
      language: '识别语言',
      stripTags: '清理识别结果中的模型标签',
      stripTagsHint: '移除 <|zh|>、<|HAPPY|> 这类 SenseVoice 内联标签',
      requestTimeoutMs: '请求超时（毫秒）',
      ffmpegPath: 'ffmpeg 路径',
      ffmpegPathHint: '仅转写非 WAV 文件时使用',
      asrOptions: '识别模型选项',
      ttsOptions: '合成模型选项',
      optionsHint: '来自服务端声明的可用参数；留空表示使用模型默认值',
      noOptions: '该模型未声明可调参数',
      refresh: '刷新',
      refreshing: '刷新中…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，配置正在重新加载',
      saveFailed: '保存失败',
      advanced: '高级',
      collapse: '收起',
      unknown: '未知'
    }

    const en = {
      title: 'Connection settings',
      serverUrl: 'Server URL',
      serverUrlHint: 'HTTP address of the audio.cpp server',
      status: 'Status',
      online: 'Connected',
      offline: 'Unreachable',
      backend: 'Backend',
      models: 'Models',
      asrModel: 'Speech recognition model (ASR)',
      ttsModel: 'Speech synthesis model (TTS)',
      auto: 'Automatic (first model of this task)',
      noModels: 'The server returned no models; check the URL',
      defaultVoice: 'Default voice',
      serverDefaultVoice: 'Server default',
      language: 'Recognition language',
      stripTags: 'Strip model tags from transcripts',
      stripTagsHint: 'Removes SenseVoice inline tags such as <|zh|> or <|HAPPY|>',
      requestTimeoutMs: 'Request timeout (ms)',
      ffmpegPath: 'ffmpeg path',
      ffmpegPathHint: 'Used only to convert non-WAV files',
      asrOptions: 'Recognition model options',
      ttsOptions: 'Synthesis model options',
      optionsHint: 'Parameters declared by the server model; empty means the model default',
      noOptions: 'This model declares no configurable parameters',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved; the configuration is reloading',
      saveFailed: 'Save failed',
      advanced: 'Advanced',
      collapse: 'Collapse',
      unknown: 'unknown'
    }

    const LANGUAGES = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

    const css = `
.aac-root { display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.aac-head { display: flex; align-items: center; gap: 8px; }
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
.aac-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.aac-row { display: flex; align-items: center; gap: 8px; }
.aac-check { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); }
.aac-section { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.aac-section-title { display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
.aac-opts { display: flex; flex-direction: column; gap: 8px; }
.aac-opt { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr); gap: 10px; align-items: center; }
.aac-opt-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
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

    /** Model option controls, driven by the params the server declares. */
    function OptionsSection({ title, options, params, onChange, t, disabled }) {
      const rows = Array.isArray(params) ? params : []
      return h('section', { className: 'aac-section' },
        h('div', { className: 'aac-section-title' }, h('span', null, title)),
        rows.length === 0
          ? h('div', { className: 'aac-hint' }, t('noOptions'))
          : h('div', { className: 'aac-opts' }, rows.map(param => {
            const name = param.name
            const value = options[name]
            const common = {
              className: 'aac-control',
              disabled,
              'aria-label': name,
              title: param.description || name
            }
            let control
            if (Array.isArray(param.values) && param.values.length > 0) {
              control = h('select', {
                ...common,
                value: value === undefined ? '' : String(value),
                onChange: event => {
                  const next = event.target.value
                  onChange(name, next === '' ? undefined : next)
                }
              },
                h('option', { value: '' }, param.default !== undefined ? String(param.default) : ''),
                param.values.map(option => h('option', { key: String(option), value: String(option) }, String(option)))
              )
            } else if (param.type === 'bool') {
              const checked = value === undefined ? param.default === true : value === true
              return h('div', { className: 'aac-opt', key: name },
                h('div', { className: 'aac-opt-name', title: param.description || name }, name),
                h('div', { className: 'aac-field' },
                  h('label', { className: 'aac-row' },
                    h('input', {
                      type: 'checkbox',
                      className: 'aac-check',
                      checked,
                      disabled,
                      'aria-label': name,
                      onChange: event => onChange(name, event.target.checked)
                    }),
                    h('span', { className: 'aac-hint' }, checked ? 'true' : 'false')
                  ),
                  param.description ? h('div', { className: 'aac-hint' }, param.description) : null
                )
              )
            } else if (param.type === 'int' || param.type === 'float') {
              control = h('input', {
                ...common,
                type: 'number',
                value: value === undefined ? '' : String(value),
                placeholder: param.default !== undefined ? String(param.default) : '',
                onChange: event => {
                  const raw = event.target.value
                  if (raw === '') return onChange(name, undefined)
                  const parsed = Number(raw)
                  onChange(name, Number.isFinite(parsed) ? parsed : raw)
                }
              })
            } else {
              control = h('input', {
                ...common,
                type: 'text',
                value: value === undefined ? '' : String(value),
                placeholder: param.default !== undefined ? String(param.default) : '',
                onChange: event => onChange(name, event.target.value === '' ? undefined : event.target.value)
              })
            }
            return h('div', { className: 'aac-opt', key: name },
              h('div', { className: 'aac-opt-name', title: param.description || name }, name),
              h('div', { className: 'aac-field' },
                control,
                param.description ? h('div', { className: 'aac-hint' }, param.description) : null
              )
            )
          }))
      )
    }

    function Settings({ t }) {
      const [config, setConfig] = useState(null)
      const [server, setServer] = useState({ health: null, models: [], voices: [] })
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [showAdvanced, setShowAdvanced] = useState(false)

      const reload = useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch(api('/audio-cpp-plugin/config'), { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json()
          setConfig(body.config)
          setServer(body.server ?? { health: null, models: [], voices: [] })
          setMessage(null)
        } catch (error) {
          setMessage({ kind: 'err', text: `${t('offline')}: ${error.message}` })
        } finally {
          setLoading(false)
        }
      }, [t])

      useEffect(() => { void reload() }, [reload])

      const patch = useCallback((key, value) => {
        setConfig(current => current === null ? current : { ...current, [key]: value })
        setMessage(null)
      }, [])

      const patchOption = useCallback((key, name, value) => {
        setConfig(current => {
          if (current === null) return current
          const next = { ...(current[key] ?? {}) }
          if (value === undefined) delete next[name]
          else next[name] = value
          return { ...current, [key]: next }
        })
        setMessage(null)
      }, [])

      const models = Array.isArray(server.models) ? server.models : []
      const asrModels = models.filter(model => model.task === 'asr')
      const ttsModels = models.filter(model => model.task === 'tts')
      const asrId = config?.asrModel || asrModels[0]?.id
      const ttsId = config?.ttsModel || ttsModels[0]?.id
      const asr = models.find(model => model.id === asrId)
      const tts = models.find(model => model.id === ttsId)
      const voices = Array.isArray(server.voices) ? server.voices : []
      const online = server.health !== null && server.health !== undefined

      // Drop option values that the newly selected model does not declare.
      const visibleOptions = useCallback((key, params) => {
        const declared = new Set((params ?? []).map(param => param.name))
        const options = config?.[key] ?? {}
        const out = {}
        for (const [name, value] of Object.entries(options)) if (declared.has(name)) out[name] = value
        return out
      }, [config])

      const save = useCallback(async () => {
        if (config === null) return
        setBusy(true)
        setMessage(null)
        try {
          const res = await fetch(api('/audio-cpp-plugin/config/save'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config })
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
      }, [config, reload, t])

      if (loading && config === null) {
        return h('div', { className: 'aac-root' }, h('div', { className: 'aac-hint' }, t('refreshing')))
      }
      if (config === null) {
        return h('div', { className: 'aac-root' },
          h('div', { className: `aac-msg ${message?.kind ?? 'err'}` }, message?.text ?? t('offline')),
          h('div', { className: 'aac-actions' }, h('button', { className: 'aac-btn', onClick: () => void reload() }, t('refresh')))
        )
      }

      const asrParams = asr?.params
      const ttsParams = tts?.params

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

          h(Row, { label: t('defaultVoice') },
            h('input', {
              className: 'aac-control',
              type: 'text',
              list: 'aac-voices',
              value: config.defaultVoice,
              placeholder: t('serverDefaultVoice'),
              disabled: busy,
              onChange: event => patch('defaultVoice', event.target.value)
            }),
            voices.length > 0
              ? h('datalist', { id: 'aac-voices' }, voices.map(voice => h('option', { key: voice, value: voice })))
              : null
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

        h('section', { className: 'aac-section' },
          h('div', { className: 'aac-section-title' }, h('span', null, t('asrOptions'))),
          h('div', { className: 'aac-hint' }, t('optionsHint')),
          h(OptionsSection, {
            title: asrId ?? '',
            options: visibleOptions('asrOptions', asrParams),
            params: asrParams,
            onChange: (name, value) => patchOption('asrOptions', name, value),
            t,
            disabled: busy
          })
        ),

        h('section', { className: 'aac-section' },
          h('div', { className: 'aac-section-title' }, h('span', null, t('ttsOptions'))),
          h('div', { className: 'aac-hint' }, t('optionsHint')),
          h(OptionsSection, {
            title: ttsId ?? '',
            options: visibleOptions('ttsOptions', ttsParams),
            params: ttsParams,
            onChange: (name, value) => patchOption('ttsOptions', name, value),
            t,
            disabled: busy
          })
        ),

        h('section', { className: 'aac-section' },
          h('div', { className: 'aac-section-title' },
            h('span', null, t('advanced')),
            h('button', {
              className: 'aac-btn',
              onClick: () => setShowAdvanced(value => !value)
            }, showAdvanced ? t('collapse') : t('advanced'))
          ),
          showAdvanced
            ? h('div', { className: 'aac-grid' },
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
            : null
        ),

        h('div', { className: 'aac-actions' },
          h('button', {
            className: 'aac-btn primary',
            disabled: busy,
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