/**
 * 设置 → WorkBuddy Gateway 页面（Client 半）。
 *
 * 这是插件的配置界面：一个 API key 列表，每把 key 自带路由策略。策略从模型名里
 * 搬到这里，就是为了这件事——用户在界面上点几下就能决定「这把 key 用哪个模型」，
 * 而不是去改别人客户端里的模型名。
 *
 * 页面通过 `/plugins/dsh-workbuddy-gateway/*` 管理接口读写自己的配置；那些路由
 * 只接受 loopback，与 DSH 自己的设置页是同一条信任边界。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'workbuddy-gateway'
    const ADMIN = '/plugins/dsh-workbuddy-gateway'

    /* ── 文案 ───────────────────────────────────────────────────────── */

    const TEXT = {
      zh: {
        title: 'WorkBuddy 模型网关',
        subtitle: '本机任意应用都能用这些 WorkBuddy 模型。每把 API key 自带路由策略。',
        baseUrl: 'Base URL',
        configPath: '配置文件',
        copy: '复制',
        copied: '已复制',
        keys: 'API keys',
        addKey: '新建 key',
        noKeys: '还没有 key。点「新建 key」创建第一把。',
        reveal: '显示',
        hide: '隐藏',
        rotate: '重置',
        remove: '删除',
        label: '名称',
        labelPlaceholder: '例如：Codex CLI',
        policy: '路由策略',
        mode_dsh: '跟随 DSH 默认模型',
        mode_session: '跟随最近活跃会话',
        mode_current: '跟随当前在用的模型',
        mode_named: '固定模型',
        mode_account: '固定账号',
        mode_first: '目录第一个模型',
        provider: '区域',
        model: '模型',
        account: '账号',
        effort: '推理强度',
        effort_auto: '模型默认',
        save: '保存',
        saved: '已保存',
        enabled: '启用',
        disabled: '已停用',
        currentDsh: 'DSH 默认',
        currentSession: '活跃会话',
        none: '未设置',
        loading: '加载中…',
        example: '用法',
        exampleHint: '把 Base URL 与某把 key 的 secret 填进客户端即可；请求体里的 model 可以不写。',
        confirmRemove: '删除后这把 key 立即失效，且无法恢复。确定删除？',
        selectModel: '选择模型',
        selectAccount: '选择账号',
        notConfigured: '还没选',
        needsModel: '这把 key 选了固定模型策略，请选择模型。',
        needsAccount: '这把 key 选了固定账号策略，请选择账号。',
      },
      en: {
        title: 'WorkBuddy Gateway',
        subtitle: 'Any app on this machine can use these WorkBuddy models. Each API key carries its own routing policy.',
        baseUrl: 'Base URL',
        configPath: 'Config file',
        copy: 'Copy',
        copied: 'Copied',
        keys: 'API keys',
        addKey: 'New key',
        noKeys: 'No keys yet. Use “New key” to create the first one.',
        reveal: 'Show',
        hide: 'Hide',
        rotate: 'Rotate',
        remove: 'Delete',
        label: 'Label',
        labelPlaceholder: 'e.g. Codex CLI',
        policy: 'Routing policy',
        mode_dsh: 'Follow the DSH default model',
        mode_session: 'Follow the active session',
        mode_current: 'Follow whatever is in use now',
        mode_named: 'Fixed model',
        mode_account: 'Fixed account',
        mode_first: 'First catalog model',
        provider: 'Region',
        model: 'Model',
        account: 'Account',
        effort: 'Reasoning effort',
        effort_auto: 'Model default',
        save: 'Save',
        saved: 'Saved',
        enabled: 'Enabled',
        disabled: 'Disabled',
        currentDsh: 'DSH default',
        currentSession: 'Active session',
        none: 'not set',
        loading: 'Loading…',
        example: 'Usage',
        exampleHint: 'Put the Base URL and one key’s secret into your client; model in the request body is optional.',
        confirmRemove: 'The key stops working immediately and cannot be recovered. Delete it?',
        selectModel: 'Select model',
        selectAccount: 'Select account',
        notConfigured: 'not chosen',
        needsModel: 'This key uses a fixed model policy; choose a model.',
        needsAccount: 'This key pins an account; choose one.',
      },
    }

    const MODES = ['dsh', 'session', 'current', 'named', 'account', 'first']
    const EFFORTS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    /* ── 样式（只用主题 token，随明暗切换） ─────────────────────────── */

    const CSS = `
.wbg-page{display:flex;flex-direction:column;gap:18px;padding:2px 0 28px;color:var(--dsw-alias-text-primary);font-size:13px;line-height:1.55}
.wbg-head{display:flex;flex-direction:column;gap:4px}
.wbg-h1{font-size:16px;font-weight:600;margin:0}
.wbg-sub{color:var(--dsw-alias-text-secondary);margin:0}
.wbg-card{border:1px solid var(--dsw-alias-border-subtle);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-elevated)}
.wbg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wbg-row-tight{gap:8px}
.wbg-label{min-width:76px;color:var(--dsw-alias-text-secondary);flex:none}
.wbg-mono{font-family:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;word-break:break-all}
.wbg-btn{appearance:none;border:1px solid var(--dsw-alias-border-subtle);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-text-primary);border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.wbg-btn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12))}
.wbg-btn:disabled{opacity:.5;cursor:default}
.wbg-btn-primary{background:var(--dsw-alias-brand-primary,#2f6df6);border-color:transparent;color:#fff}
.wbg-btn-danger{color:var(--dsw-alias-danger,#e5484d);border-color:var(--dsw-alias-border-subtle)}
.wbg-input,.wbg-select{appearance:none;border:1px solid var(--dsw-alias-border-subtle);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-text-primary);border-radius:7px;padding:5px 9px;font-size:12px;font-family:inherit;max-width:100%}
.wbg-input:focus,.wbg-select:focus{outline:2px solid var(--dsw-alias-brand-primary,#2f6df6);outline-offset:-1px}
.wbg-hint{color:var(--dsw-alias-text-secondary);font-size:12px}
.wbg-warn{color:var(--dsw-alias-warning,#b26a00);font-size:12px}
.wbg-list{display:flex;flex-direction:column;gap:10px}
.wbg-item{border:1px solid var(--dsw-alias-border-subtle);border-radius:9px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.wbg-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbg-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-subtle);color:var(--dsw-alias-text-secondary)}
.wbg-badge-on{color:var(--dsw-alias-success,#127a4b);border-color:currentColor}
.wbg-badge-off{color:var(--dsw-alias-text-secondary)}
.wbg-grow{flex:1;min-width:120px}
.wbg-spacer{flex:1}
.wbg-code{background:var(--dsw-alias-bg-sunken,rgba(127,127,127,.09));border-radius:7px;padding:9px 11px;overflow-x:auto;white-space:pre;margin:0}
.wbg-error{color:var(--dsw-alias-danger,#e5484d);font-size:12px}
`

    /* ── 数据访问 ───────────────────────────────────────────────────── */

    async function adminGet(path) {
      const response = await fetch(`${ADMIN}${path}`, { headers: { Accept: 'application/json' } })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    async function adminPost(path, payload) {
      const response = await fetch(`${ADMIN}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    /* ── 小组件 ─────────────────────────────────────────────────────── */

    function CopyText({ value, t }) {
      const [done, setDone] = useState(false)
      const copy = useCallback(() => {
        const done2 = () => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        }
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(value).then(done2, () => {})
          return
        }
        const area = document.createElement('textarea')
        area.value = value
        document.body.appendChild(area)
        area.select()
        try { document.execCommand('copy') } catch {}
        document.body.removeChild(area)
        done2()
      }, [value])
      return h('button', {
        type: 'button',
        className: 'wbg-btn',
        onClick: copy,
        'aria-label': `${t.copy} ${value}`,
      }, done ? t.copied : t.copy)
    }

    function Field({ label, children }) {
      return h('div', { className: 'wbg-row wbg-row-tight' },
        h('span', { className: 'wbg-label' }, label),
        children)
    }

    /* ── 单把 key ───────────────────────────────────────────────────── */

    function KeyCard({ entry, state, t, onSave, onDelete, onRotate, onReveal }) {
      const [label, setLabel] = useState(entry.label)
      const [enabled, setEnabled] = useState(entry.enabled)
      const [policy, setPolicy] = useState(entry.policy)
      const [secret, setSecret] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [savedAt, setSavedAt] = useState(0)

      useEffect(() => {
        setLabel(entry.label)
        setEnabled(entry.enabled)
        setPolicy(entry.policy)
      }, [entry])

      const modes = state?.policyModes ?? MODES
      const models = state?.models ?? []
      const accounts = state?.accounts ?? []
      const providers = state?.providers ?? []

      const dirty = label !== entry.label
        || enabled !== entry.enabled
        || JSON.stringify(policy) !== JSON.stringify(entry.policy)

      const setPolicyField = (field, value) => {
        setPolicy((current) => {
          const next = { ...current, [field]: value }
          if (field === 'mode') {
            /*
             * 切模式时清掉与新模式无关的字段：留着上一种模式的残留值会让
             * 「固定账号」key 带着一个上个模式挑的 provider，读起来像是还在用。
             */
            if (value !== 'named' && value !== 'account') {
              delete next.provider
              delete next.model
            }
            if (value !== 'account') {
              delete next.accountId
              delete next.region
            }
          }
          return next
        })
      }

      const save = async () => {
        setBusy(true)
        setError(undefined)
        try {
          await onSave({ id: entry.id, label, enabled, policy })
          setSavedAt(Date.now())
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }

      const doReveal = async () => {
        if (secret !== undefined) {
          setSecret(undefined)
          return
        }
        setBusy(true)
        setError(undefined)
        try {
          const body = await onReveal(entry.id)
          setSecret(body.secret)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }

      const doRotate = async () => {
        setBusy(true)
        setError(undefined)
        try {
          const body = await onRotate(entry.id)
          setSecret(body.secret ?? body.keys?.find?.((row) => row.id === entry.id)?.secret)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }

      const removed = () => {
        if (!window.confirm(t.confirmRemove)) return
        setBusy(true)
        onDelete(entry.id).catch((caught) => setError(String(caught.message ?? caught))).finally(() => setBusy(false))
      }

      const shownSecret = secret ?? entry.masked
      const modeNeedsModel = policy.mode === 'named' && (policy.model ?? '') === ''
      const modeNeedsAccount = policy.mode === 'account' && (policy.accountId ?? '') === ''

      return h('div', { className: 'wbg-item' },
        h('div', { className: 'wbg-item-head' },
          h('input', {
            className: 'wbg-input wbg-grow',
            value: label,
            placeholder: t.labelPlaceholder,
            'aria-label': t.label,
            onChange: (event) => setLabel(event.target.value),
          }),
          h('span', { className: `wbg-badge ${enabled ? 'wbg-badge-on' : 'wbg-badge-off'}` }, enabled ? t.enabled : t.disabled),
          h('span', { className: 'wbg-badge' }, policy.mode),
          h('span', { className: 'wbg-spacer' }),
          h('button', { type: 'button', className: 'wbg-btn', onClick: doReveal, disabled: busy }, secret === undefined ? t.reveal : t.hide),
          h('button', { type: 'button', className: 'wbg-btn', onClick: doRotate, disabled: busy }, t.rotate),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-danger', onClick: removed, disabled: busy }, t.remove),
        ),

        h('div', { className: 'wbg-row wbg-row-tight' },
          h('code', { className: 'wbg-mono wbg-grow' }, shownSecret),
          h(CopyText, { value: shownSecret, t }),
        ),

        h(Field, { label: t.policy },
          h('select', {
            className: 'wbg-select',
            value: policy.mode,
            'aria-label': t.policy,
            onChange: (event) => setPolicyField('mode', event.target.value),
          }, modes.map((mode) => h('option', { key: mode, value: mode }, t[`mode_${mode}`] ?? mode))),
        ),

        (policy.mode === 'named' || policy.mode === 'account') ? h('div', { className: 'wbg-row wbg-row-tight' },
          h('span', { className: 'wbg-label' }, t.provider),
          h('select', {
            className: 'wbg-select',
            value: policy.provider ?? '',
            'aria-label': t.provider,
            onChange: (event) => {
              const provider = event.target.value
              setPolicyField('provider', provider === '' ? undefined : provider)
            },
          },
            h('option', { value: '' }, t.none),
            providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.label)),
          ),
        ) : null,

        policy.mode === 'account' ? h('div', { className: 'wbg-row wbg-row-tight' },
          h('span', { className: 'wbg-label' }, t.account),
          h('select', {
            className: 'wbg-select',
            value: policy.accountId ?? '',
            'aria-label': t.account,
            onChange: (event) => {
              const accountId = event.target.value
              const found = accounts.find((account) => account.id === accountId)
              setPolicy((current) => ({
                ...current,
                accountId,
                ...(found === undefined ? {} : { region: found.region }),
              }))
            },
          },
            h('option', { value: '' }, t.selectAccount),
            accounts.map((account) => h('option', { key: `${account.region}:${account.id}`, value: account.id },
              `${account.name || account.id.slice(0, 8)} · ${account.region === 'global' ? '国际版' : '国内版'}`)),
          ),
        ) : null,

        (policy.mode === 'named' || policy.mode === 'account') ? h('div', { className: 'wbg-row wbg-row-tight' },
          h('span', { className: 'wbg-label' }, t.model),
          h('select', {
            className: 'wbg-select wbg-grow',
            value: policy.model ?? '',
            'aria-label': t.model,
            onChange: (event) => {
              const model = event.target.value
              const found = models.find((row) => row.id === model)
              setPolicy((current) => ({
                ...current,
                model,
                ...(found === undefined ? {} : { provider: found.provider }),
              }))
            },
          },
            h('option', { value: '' }, t.selectModel),
            models
              .filter((model) => (policy.provider === undefined ? true : model.provider === policy.provider))
              .map((model) => h('option', { key: `${model.provider}:${model.id}`, value: model.id },
                `${model.name}${model.region === undefined ? '' : ` · ${model.region}`}`)),
          ),
        ) : null,

        h(Field, { label: t.effort },
          h('select', {
            className: 'wbg-select',
            value: policy.reasoningEffort ?? '',
            'aria-label': t.effort,
            onChange: (event) => setPolicyField('reasoningEffort', event.target.value === '' ? undefined : event.target.value),
          }, EFFORTS.map((effort) => h('option', { key: effort, value: effort }, effort === '' ? t.effort_auto : effort))),
        ),

        policy.mode === 'dsh' && state?.defaults?.dsh ? h('div', { className: 'wbg-hint' },
          `${t.currentDsh}：${state.defaults.dsh.provider} / ${state.defaults.dsh.model}`) : null,
        policy.mode === 'session' && state?.defaults?.session ? h('div', { className: 'wbg-hint' },
          `${t.currentSession}：${state.defaults.session.provider} / ${state.defaults.session.model}`) : null,

        modeNeedsModel ? h('div', { className: 'wbg-warn' }, t.needsModel) : null,
        modeNeedsAccount ? h('div', { className: 'wbg-warn' }, t.needsAccount) : null,
        error === undefined ? null : h('div', { className: 'wbg-error' }, error),

        h('div', { className: 'wbg-row wbg-row-tight' },
          h('label', { className: 'wbg-row wbg-row-tight', style: { gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: (event) => setEnabled(event.target.checked),
            }),
            h('span', { className: 'wbg-hint' }, t.enabled),
          ),
          h('span', { className: 'wbg-spacer' }),
          savedAt === 0 ? null : h('span', { className: 'wbg-hint' }, t.saved),
          h('button', {
            type: 'button',
            className: 'wbg-btn wbg-btn-primary',
            onClick: save,
            disabled: busy || !dirty,
          }, t.save),
        ),
      )
    }

    /* ── 页面 ───────────────────────────────────────────────────────── */

    function GatewaySection() {
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)

      /*
       * 默认中文：这个插件的用户是国内 DSH 用户。宿主没有把 locale 透传到
       * ownerProps，所以这里按浏览器语言判断一次；不做实时切换（用户切语言
       * 重开设置页即可）。
       */
      const lang = (typeof navigator === 'object' && /^zh/i.test(navigator.language ?? '')) ? 'zh' : 'en'
      const t = TEXT[lang]

      const reload = useCallback(async () => {
        try {
          setState(await adminGet('/state'))
          setError(undefined)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        }
      }, [])

      useEffect(() => { void reload() }, [reload])

      const addKey = useCallback(async () => {
        setBusy(true)
        try {
          const body = await adminPost('/keys', { label: '', policy: { mode: 'dsh' } })
          setState(await adminGet('/state'))
          if (body?.created?.secret) {
            window.alert(`${t.addKey}: ${body.created.id}\n\n${body.created.secret}`)
          }
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }, [t])

      const saveKey = useCallback(async (patch) => {
        await adminPost('/keys/update', patch)
        setState(await adminGet('/state'))
      }, [])

      const deleteKey = useCallback(async (id) => {
        await adminPost('/keys/delete', { id })
        setState(await adminGet('/state'))
      }, [])

      const rotateKey = useCallback(async (id) => {
        const body = await adminPost('/keys/rotate', { id })
        setState(await adminGet('/state'))
        return body
      }, [])

      const revealKey = useCallback((id) => adminPost('/keys/reveal', { id }), [])

      if (state === undefined) {
        return h('div', { className: 'wbg-page' },
          h('style', null, CSS),
          h('div', { className: 'wbg-hint' }, error ?? t.loading))
      }

      const example = [
        `curl ${state.baseUrl}/v1/chat/completions \\`,
        '  -H "Authorization: Bearer <your-key-secret>" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"messages":[{"role":"user","content":"hi"}]}'`,
      ].join('\n')

      return h('div', { className: 'wbg-page' },
        h('style', null, CSS),

        h('div', { className: 'wbg-head' },
          h('h2', { className: 'wbg-h1' }, t.title),
          h('p', { className: 'wbg-sub' }, t.subtitle),
        ),

        h('div', { className: 'wbg-card' },
          h(Field, { label: t.baseUrl },
            h('code', { className: 'wbg-mono wbg-grow' }, state.baseUrl),
            h(CopyText, { value: state.baseUrl, t }),
          ),
          h('div', { className: 'wbg-row', style: { marginTop: 8 } },
            h('span', { className: 'wbg-label' }, t.configPath),
            h('code', { className: 'wbg-mono', style: { flex: 1 } }, state.configPath),
          ),
        ),

        h('div', { className: 'wbg-row' },
          h('strong', null, t.keys),
          h('span', { className: 'wbg-spacer' }),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-primary', onClick: addKey, disabled: busy }, t.addKey),
        ),

        error === undefined ? null : h('div', { className: 'wbg-error' }, error),

        h('div', { className: 'wbg-list' },
          state.keys.length === 0
            ? h('div', { className: 'wbg-hint' }, t.noKeys)
            : state.keys.map((entry) => h(KeyCard, {
              key: entry.id,
              entry,
              state,
              t,
              onSave: saveKey,
              onDelete: deleteKey,
              onRotate: rotateKey,
              onReveal: revealKey,
            })),
        ),

        h('div', { className: 'wbg-card' },
          h('div', { className: 'wbg-row' },
            h('strong', null, t.example),
            h('span', { className: 'wbg-spacer' }),
          ),
          h('p', { className: 'wbg-hint', style: { margin: '4px 0 8px' } }, t.exampleHint),
          h('pre', { className: 'wbg-code wbg-mono' }, example),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 36,
          label: () => TEXT.zh.title,
        }, GatewaySection))
      },
    }
  },
})
