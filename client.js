/**
 * 设置 → WorkBuddy 模型网关（Client 半）。
 *
 * 设计上有三条硬约束，都是踩出来的：
 *
 * 1. **主题 token 必须用真实存在的那几个。** DSH 的 Theme 只注册了
 *    `--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-bg-base/layer-1/
 *    layer-2/overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-brand-primary` 与
 *    几个 `state-*`。写别的名字不会报错，只会**静默回退**，于是界面看起来"没样式"。
 *
 * 2. **掩码绝不可复制。** 曾把掩码当普通文本展示并给了复制按钮，用户复制到的
 *    `wbg-v1-9…VJq0` 里的 `…`（U+2026）放进 HTTP 头会让客户端直接抛
 *    `Cannot convert argument to a ByteString … value of 8230`。所以：掩码是
 *    `*` 号、不提供复制；只有明文（reveal 之后）才有复制按钮。
 *
 * 3. **地址要给成品。** 每种协议该填什么都算好了，用户点一下复制就行，
 *    不用自己判断要不要加 `/v1`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'workbuddy-gateway'
    const ADMIN = '/plugins/dsh-workbuddy-gateway'

    /* ── 文案 ───────────────────────────────────────────────────────── */

    const TEXT = {
      zh: {
        title: 'WorkBuddy 模型网关',
        subtitle: '本机任意应用都能用这些 WorkBuddy 模型。每把 API key 自带路由策略。',
        endpoints: '接口地址',
        endpointsHint: '按你用的客户端选一行，复制「Base URL」填进去即可。',
        baseUrl: 'Base URL',
        requestUrl: '实际请求',
        auth: '鉴权头',
        root: '网关根地址',
        keys: 'API keys',
        addKey: '新建 key',
        noKeys: '还没有 key。点「新建 key」创建第一把。',
        reveal: '显示明文',
        hide: '收起',
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
        currentDsh: 'DSH 默认',
        currentSession: '活跃会话',
        none: '不限',
        loading: '正在读取配置…',
        copy: '复制',
        copied: '已复制',
        secretHidden: '点「显示明文」后才有可复制的内容',
        secretCopied: '明文只在这个页面显示，刷新后需要重新点开',
        confirmRemove: '删除后这把 key 立即失效，且无法恢复。确定删除？',
        selectModel: '选择模型',
        selectAccount: '选择账号',
        needsModel: '还没选模型，这把 key 暂时不能用。',
        needsAccount: '还没选账号，这把 key 暂时不能用。',
        created: '已创建新 key，明文如下。请立刻复制保存 —— 关掉这个提示后需要重新点「显示明文」。',
        dismiss: '我知道了',
        guide: '怎么用',
        guideHint: '把上面某一行的 Base URL 和任意一把 key 的明文填进客户端；请求体里的 model 可以不写。',
        errorTitle: '出错了',
        configPath: '配置文件',
      },
      en: {
        title: 'WorkBuddy Gateway',
        subtitle: 'Any app on this machine can use these WorkBuddy models. Each API key carries its own routing policy.',
        endpoints: 'Endpoints',
        endpointsHint: 'Pick the row for your client and copy its Base URL.',
        baseUrl: 'Base URL',
        requestUrl: 'Actual request',
        auth: 'Auth header',
        root: 'Gateway root',
        keys: 'API keys',
        addKey: 'New key',
        noKeys: 'No keys yet. Use "New key" to create the first one.',
        reveal: 'Show secret',
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
        currentDsh: 'DSH default',
        currentSession: 'Active session',
        none: 'any',
        loading: 'Reading configuration…',
        copy: 'Copy',
        copied: 'Copied',
        secretHidden: 'Use "Show secret" to get something copyable',
        secretCopied: 'The secret stays on this page only; reopen it after a refresh',
        confirmRemove: 'The key stops working immediately and cannot be recovered. Delete it?',
        selectModel: 'Select model',
        selectAccount: 'Select account',
        needsModel: 'No model chosen yet, so this key cannot be used.',
        needsAccount: 'No account chosen yet, so this key cannot be used.',
        created: 'New key created. Copy the secret now — after dismissing this you will need "Show secret" again.',
        dismiss: 'Got it',
        guide: 'How to use',
        guideHint: 'Paste one Base URL above and any key’s secret into your client. model in the request body is optional.',
        errorTitle: 'Something failed',
        configPath: 'Config file',
      },
    }

    const MODES = ['dsh', 'session', 'current', 'named', 'account', 'first']
    const EFFORTS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    function texts() {
      return (typeof navigator === 'object' && /^zh/i.test(navigator.language ?? '')) ? TEXT.zh : TEXT.en
    }

    /* ── 样式：只用真实注册的 token，配明暗两套回退 ───────────────── */

    const CSS = `
.wbg{display:flex;flex-direction:column;gap:20px;padding:2px 0 32px;color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px;line-height:1.6}
.wbg *{box-sizing:border-box}
.wbg-head{display:flex;flex-direction:column;gap:6px}
.wbg-h1{font-size:17px;font-weight:600;margin:0;letter-spacing:-.01em}
.wbg-sub{color:var(--dsw-alias-label-secondary,#666);margin:0;font-size:12.5px}
.wbg-sec-title{font-size:13px;font-weight:600;margin:0}
.wbg-card{border:1px solid var(--dsw-alias-border-l1,#e3e3e3);border-radius:12px;padding:16px 18px;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;gap:12px}
.wbg-card-soft{background:var(--dsw-alias-bg-layer-2,#f6f6f6);border-style:dashed}
.wbg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.wbg-label{min-width:70px;flex:none;color:var(--dsw-alias-label-secondary,#666);font-size:12px}
.wbg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;line-height:1.5}
.wbg-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;line-height:1.5;transition:background .12s,border-color .12s,opacity .12s;white-space:nowrap}
.wbg-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f2f2f2);border-color:var(--dsw-alias-border-l2,#cfcfcf)}
.wbg-btn:disabled{opacity:.45;cursor:default}
.wbg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2f6df6);outline-offset:1px}
.wbg-btn-primary{background:var(--dsw-alias-brand-primary,#2f6df6);border-color:transparent;color:#fff;font-weight:500}
.wbg-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#2f6df6);filter:brightness(1.08)}
.wbg-btn-danger{color:var(--dsw-alias-state-error-primary,#d1242f)}
.wbg-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#d1242f);border-color:transparent;color:#fff}
.wbg-btn-sm{padding:3px 9px;font-size:11.5px;border-radius:7px}
.wbg-input,.wbg-select{appearance:none;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:8px;padding:6px 10px;font-size:12.5px;font-family:inherit;max-width:100%;line-height:1.5}
.wbg-input:focus,.wbg-select:focus{outline:2px solid var(--dsw-alias-brand-primary,#2f6df6);outline-offset:-1px;border-color:transparent}
.wbg-select{cursor:pointer;padding-right:26px;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-tertiary,#999) 50%),linear-gradient(135deg,var(--dsw-alias-label-tertiary,#999) 50%,transparent 50%);background-position:calc(100% - 14px) 52%,calc(100% - 9px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.wbg-hint{color:var(--dsw-alias-label-secondary,#666);font-size:12px;margin:0}
.wbg-caption{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11.5px;margin:0}
.wbg-warn{color:var(--dsw-alias-state-warn-primary,#9a6700);font-size:12px;margin:0}
.wbg-list{display:flex;flex-direction:column;gap:12px}
.wbg-ep{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2.2fr) auto;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1,#eee)}
.wbg-ep:first-of-type{border-top:none;padding-top:2px}
.wbg-ep-name{font-weight:500;font-size:12.5px}
.wbg-ep-hint{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11.5px;display:block}
.wbg-ep-url{min-width:0}
.wbg-ep-url code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbg-item{border:1px solid var(--dsw-alias-border-l1,#e3e3e3);border-radius:11px;padding:14px 16px;display:flex;flex-direction:column;gap:11px;background:var(--dsw-alias-bg-base,#fff);transition:border-color .12s}
.wbg-item:hover{border-color:var(--dsw-alias-border-l2,#cfcfcf)}
.wbg-item-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbg-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary,#b0b0b0)}
.wbg-dot-on{background:var(--dsw-alias-state-success-primary,#1a7f37);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 18%,transparent)}
.wbg-badge{font-size:11px;padding:1.5px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.wbg-secret{display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:8px 11px}
.wbg-secret code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666);letter-spacing:.3px}
.wbg-secret-live code{color:var(--dsw-alias-label-primary,#1a1a1a);letter-spacing:0}
.wbg-grow{flex:1;min-width:120px}
.wbg-spacer{flex:1}
.wbg-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px 18px}
.wbg-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.wbg-field > span{color:var(--dsw-alias-label-secondary,#666);font-size:11.5px}
.wbg-field .wbg-select,.wbg-field .wbg-input{width:100%}
.wbg-code{background:var(--dsw-alias-bg-layer-2,#f6f6f6);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:11px 13px;overflow-x:auto;white-space:pre;margin:0;font-size:11.5px;line-height:1.7}
.wbg-alert{display:flex;gap:10px;align-items:flex-start;border-radius:10px;padding:11px 13px;font-size:12px;border:1px solid transparent}
.wbg-alert-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d1242f) 30%,transparent);color:var(--dsw-alias-state-error-primary,#d1242f)}
.wbg-alert-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a6700) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a6700) 28%,transparent);color:var(--dsw-alias-state-warn-primary,#9a6700)}
.wbg-alert-icon{flex:none;font-weight:700;line-height:1.4}
.wbg-alert-body{flex:1;min-width:0}
.wbg-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;z-index:60;padding:24px}
.wbg-modal{background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,#cfcfcf);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.24);width:min(560px,100%);padding:20px 22px;display:flex;flex-direction:column;gap:14px}
.wbg-modal h3{margin:0;font-size:15px;font-weight:600}
.wbg-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.wbg-tag{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
@media (max-width:720px){
  .wbg-ep{grid-template-columns:1fr;gap:6px}
  .wbg-grid{grid-template-columns:1fr}
}
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

    /** 复制按钮：只在有真正可用的值时渲染。 */
    function CopyButton({ value, t, small }) {
      const [done, setDone] = useState(false)
      const timer = useRef(undefined)
      useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
      const copy = useCallback(() => {
        const finish = () => {
          setDone(true)
          timer.current = setTimeout(() => setDone(false), 1500)
        }
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(value).then(finish, () => finish())
          return
        }
        /* 兜底：临时 textarea，用完立刻移除，不留在 DOM 里。 */
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        try { document.execCommand('copy') } catch {}
        document.body.removeChild(area)
        finish()
      }, [value])
      return h('button', {
        type: 'button',
        className: `wbg-btn${small === true ? ' wbg-btn-sm' : ''}`,
        onClick: copy,
        'aria-label': `${t.copy} ${value}`,
      }, done ? t.copied : t.copy)
    }

    /** 一行「可复制的地址」。 */
    function EndpointRow({ entry, t, primary }) {
      return h('div', { className: 'wbg-ep' },
        h('div', null,
          h('span', { className: 'wbg-ep-name' }, entry.name),
          h('span', { className: 'wbg-ep-hint' }, entry.hint)),
        h('div', { className: 'wbg-ep-url' },
          h('code', { className: 'wbg-mono', title: entry.baseUrl }, entry.baseUrl),
          h('span', { className: 'wbg-caption' }, `${t.requestUrl}: ${entry.requestUrl}`)),
        h(CopyButton, { value: entry.baseUrl, t, small: true }),
      )
    }

    /** 一个表单字段（标签在上、控件在下）。 */
    function Field({ label, children }) {
      return h('label', { className: 'wbg-field' },
        h('span', null, label),
        children)
    }

    /** 明文弹窗：只在这个弹窗里给出可复制的明文。 */
    function SecretDialog({ secret, t, onClose, intro }) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        className: 'wbg-modal-mask',
        role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: 'wbg-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.reveal },
          h('h3', null, t.reveal),
          h('p', { className: 'wbg-hint' }, intro ?? t.secretCopied),
          h('div', { className: 'wbg-secret wbg-secret-live' },
            h('code', { className: 'wbg-mono' }, secret),
            h(CopyButton, { value: secret, t }),
          ),
          h('div', { className: 'wbg-modal-actions' },
            h('button', { type: 'button', className: 'wbg-btn wbg-btn-primary', onClick: onClose }, t.dismiss),
          ),
        ),
      )
    }

    /* ── 单把 key ───────────────────────────────────────────────────── */

    function KeyCard({ entry, state, t, onSave, onDelete, onRotate, onReveal }) {
      const [label, setLabel] = useState(entry.label)
      const [enabled, setEnabled] = useState(entry.enabled)
      const [policy, setPolicy] = useState(entry.policy)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [saved, setSaved] = useState(false)
      const [dialog, setDialog] = useState(undefined)

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

      const patchPolicy = (field, value) => {
        setPolicy((current) => {
          const next = { ...current, [field]: value }
          if (field === 'mode') {
            /* 切模式时清掉无关字段，免得留下一份读起来像还在用的残留。 */
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
          setSaved(true)
          setTimeout(() => setSaved(false), 1600)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }

      const reveal = async () => {
        setBusy(true)
        setError(undefined)
        try {
          const body = await onReveal(entry.id)
          setDialog({ secret: body.secret })
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }

      const rotate = async () => {
        setBusy(true)
        setError(undefined)
        try {
          const body = await onRotate(entry.id)
          setDialog({ secret: body.secret, intro: t.rotate })
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }

      const remove = () => {
        if (!window.confirm(t.confirmRemove)) return
        setBusy(true)
        onDelete(entry.id)
          .catch((caught) => setError(String(caught.message ?? caught)))
          .finally(() => setBusy(false))
      }

      const needsModel = (policy.mode === 'named' || policy.mode === 'account') && (policy.model ?? '') === ''
      const needsAccount = policy.mode === 'account' && (policy.accountId ?? '') === ''
      const visibleModels = policy.provider === undefined
        ? models
        : models.filter((model) => model.provider === policy.provider)

      return h('div', { className: 'wbg-item' },
        h('div', { className: 'wbg-item-head' },
          h('span', { className: `wbg-dot${enabled ? ' wbg-dot-on' : ''}`, 'aria-hidden': true }),
          h('input', {
            className: 'wbg-input wbg-grow',
            value: label,
            placeholder: t.labelPlaceholder,
            'aria-label': t.label,
            onChange: (event) => setLabel(event.target.value),
          }),
          h('span', { className: 'wbg-badge' }, t[`mode_${policy.mode}`] ?? policy.mode),
          h('span', { className: 'wbg-spacer' }),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: reveal, disabled: busy }, t.reveal),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: rotate, disabled: busy }, t.rotate),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm wbg-btn-danger', onClick: remove, disabled: busy }, t.remove),
        ),

        /*
         * 掩码是纯文本，**刻意不配复制按钮**：它含 `*` 占位，复制出去进 HTTP 头
         * 只会得到 401，或者像 U+2026 那样直接让客户端抛 ByteString 错误。
         */
        h('div', { className: 'wbg-secret' },
          h('code', { className: 'wbg-mono', 'aria-label': 'masked key' }, entry.masked),
          h('span', { className: 'wbg-caption' }, t.secretHidden),
        ),

        h('div', { className: 'wbg-grid' },
          h(Field, { label: t.policy },
            h('select', {
              className: 'wbg-select',
              value: policy.mode,
              onChange: (event) => patchPolicy('mode', event.target.value),
            }, modes.map((mode) => h('option', { key: mode, value: mode }, t[`mode_${mode}`] ?? mode))),
          ),

          h(Field, { label: t.effort },
            h('select', {
              className: 'wbg-select',
              value: policy.reasoningEffort ?? '',
              onChange: (event) => patchPolicy('reasoningEffort', event.target.value === '' ? undefined : event.target.value),
            }, EFFORTS.map((effort) => h('option', { key: effort, value: effort }, effort === '' ? t.effort_auto : effort))),
          ),

          (policy.mode === 'named' || policy.mode === 'account')
            ? h(Field, { label: t.provider },
              h('select', {
                className: 'wbg-select',
                value: policy.provider ?? '',
                onChange: (event) => patchPolicy('provider', event.target.value === '' ? undefined : event.target.value),
              },
                h('option', { value: '' }, t.none),
                providers.map((provider) => h('option', { key: provider.id, value: provider.id }, provider.label)),
              ))
            : null,

          policy.mode === 'account'
            ? h(Field, { label: t.account },
              h('select', {
                className: 'wbg-select',
                value: policy.accountId ?? '',
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
              ))
            : null,

          (policy.mode === 'named' || policy.mode === 'account')
            ? h(Field, { label: t.model },
              h('select', {
                className: 'wbg-select',
                value: policy.model ?? '',
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
                visibleModels.map((model) => h('option', { key: `${model.provider}:${model.id}`, value: model.id },
                  `${model.name}${model.region === undefined ? '' : ` · ${model.region}`}`)),
              ))
            : null,
        ),

        policy.mode === 'dsh' && state?.defaults?.dsh
          ? h('p', { className: 'wbg-caption' }, `${t.currentDsh}: ${state.defaults.dsh.provider} / ${state.defaults.dsh.model}`)
          : null,
        policy.mode === 'session' && state?.defaults?.session
          ? h('p', { className: 'wbg-caption' }, `${t.currentSession}: ${state.defaults.session.provider} / ${state.defaults.session.model}`)
          : null,

        needsModel ? h('p', { className: 'wbg-warn' }, t.needsModel) : null,
        needsAccount ? h('p', { className: 'wbg-warn' }, t.needsAccount) : null,
        error === undefined ? null : h('div', { className: 'wbg-alert wbg-alert-error' },
          h('span', { className: 'wbg-alert-icon', 'aria-hidden': true }, '!'),
          h('span', { className: 'wbg-alert-body' }, error)),

        h('div', { className: 'wbg-row' },
          h('label', { className: 'wbg-row', style: { gap: 6, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: (event) => setEnabled(event.target.checked),
            }),
            h('span', { className: 'wbg-hint' }, t.enabled),
          ),
          h('span', { className: 'wbg-spacer' }),
          saved ? h('span', { className: 'wbg-caption' }, t.saved) : null,
          h('button', {
            type: 'button',
            className: 'wbg-btn wbg-btn-primary',
            onClick: save,
            disabled: busy || !dirty,
          }, t.save),
        ),

        dialog === undefined ? null : h(SecretDialog, {
          secret: dialog.secret,
          intro: dialog.intro,
          t,
          onClose: () => setDialog(undefined),
        }),
      )
    }

    /* ── 页面 ───────────────────────────────────────────────────────── */

    function GatewaySection() {
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [created, setCreated] = useState(undefined)
      const t = texts()

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
        setError(undefined)
        try {
          const body = await adminPost('/keys', { label: '', policy: { mode: 'dsh' } })
          await reload()
          if (body?.created?.secret !== undefined) setCreated(body.created.secret)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setBusy(false)
        }
      }, [reload])

      const saveKey = useCallback(async (patch) => {
        await adminPost('/keys/update', patch)
        await reload()
      }, [reload])

      const deleteKey = useCallback(async (id) => {
        await adminPost('/keys/delete', { id })
        await reload()
      }, [reload])

      const rotateKey = useCallback(async (id) => {
        const body = await adminPost('/keys/rotate', { id })
        await reload()
        return body
      }, [reload])

      const revealKey = useCallback((id) => adminPost('/keys/reveal', { id }), [])

      if (state === undefined) {
        return h('div', { className: 'wbg' },
          h('style', null, CSS),
          error === undefined
            ? h('p', { className: 'wbg-hint' }, t.loading)
            : h('div', { className: 'wbg-alert wbg-alert-error' },
              h('span', { className: 'wbg-alert-icon', 'aria-hidden': true }, '!'),
              h('div', { className: 'wbg-alert-body' },
                h('strong', null, `${t.errorTitle}: `), error)))
      }

      const endpoints = state.endpoints ?? []

      const curlExample = [
        `curl ${endpoints[0]?.requestUrl ?? `${state.baseUrl}/v1/chat/completions`} \\`,
        '  -H "Authorization: Bearer <key secret>" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"messages":[{"role":"user","content":"hi"}]}'`,
      ].join('\n')

      return h('div', { className: 'wbg' },
        h('style', null, CSS),

        h('div', { className: 'wbg-head' },
          h('h2', { className: 'wbg-h1' }, t.title),
          h('p', { className: 'wbg-sub' }, t.subtitle),
        ),

        /* 四种协议的准确地址：每行一个成品，点一下就复制。 */
        h('div', { className: 'wbg-card' },
          h('div', { className: 'wbg-row' },
            h('strong', { className: 'wbg-sec-title' }, t.endpoints),
            h('span', { className: 'wbg-spacer' }),
            h('span', { className: 'wbg-caption' }, t.endpointsHint),
          ),
          h('div', null, endpoints.map((entry) => h(EndpointRow, { key: entry.id, entry, t }))),
          h('p', { className: 'wbg-caption', style: { marginTop: 2 } },
            `${t.root}: ${state.baseUrl}`),
        ),

        h('div', { className: 'wbg-row' },
          h('strong', { className: 'wbg-sec-title' }, t.keys),
          h('span', { className: 'wbg-spacer' }),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-primary', onClick: addKey, disabled: busy }, t.addKey),
        ),

        error === undefined ? null : h('div', { className: 'wbg-alert wbg-alert-error' },
          h('span', { className: 'wbg-alert-icon', 'aria-hidden': true }, '!'),
          h('div', { className: 'wbg-alert-body' },
            h('strong', null, `${t.errorTitle}: `), error)),

        h('div', { className: 'wbg-list' },
          state.keys.length === 0
            ? h('div', { className: 'wbg-card wbg-card-soft' }, h('p', { className: 'wbg-hint' }, t.noKeys))
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

        h('div', { className: 'wbg-card wbg-card-soft' },
          h('strong', { className: 'wbg-sec-title' }, t.guide),
          h('p', { className: 'wbg-hint' }, t.guideHint),
          h('pre', { className: 'wbg-code wbg-mono' }, curlExample),
          h('p', { className: 'wbg-caption' }, `${t.configPath}: ${state.configPath}`),
        ),

        created === undefined ? null : h(SecretDialog, {
          secret: created,
          intro: t.created,
          t,
          onClose: () => setCreated(undefined),
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 36,
          label: () => texts().title,
        }, GatewaySection))
      },
    }
  },
})
