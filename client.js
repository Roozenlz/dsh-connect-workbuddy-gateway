/**
 * 设置 → WorkBuddy 模型网关（Client 半）。
 *
 * 三条来自真实故障的硬约束：
 *
 * 1. **主题 token 必须用真实存在的那几个。** DSH 的 Theme 只注册了
 *    `--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-bg-base/layer-1/
 *    layer-2/overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-brand-primary` 与
 *    几个 `state-*`。写别的名字不会报错，只会**静默回退**，界面看起来"没样式"。
 *
 * 2. **掩码绝不可复制。** 掩码里的 `…`（U+2026）放进 HTTP 头会让客户端抛
 *    `Cannot convert argument to a ByteString … value of 8230`。所以掩码是 `*` 号、
 *    不提供复制；只有明文（reveal 之后）才有复制按钮。
 *
 * 3. **地址要给成品。** 每种协议该填什么都算好了，用户点一下复制就行。
 *
 * 这一版的模型配置是「勾选清单」：**没有策略模式**，用户直接勾要暴露哪些
 * （账号, 模型）组合，列表就返回哪些。重名的模型名后面自动挂账号后缀。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const NS = 'workbuddy-gateway'
    const ADMIN = '/plugins/dsh-workbuddy-gateway'

    /* ── 文案 ───────────────────────────────────────────────────────── */

    const TEXT = {
      zh: {
        title: 'WorkBuddy 模型网关',
        subtitle: '本机任意应用都能用这些 WorkBuddy 模型。每把 API key 勾选自己对外开放的模型。',
        endpoints: '接口地址',
        endpointsHint: '按你用的客户端选一行，复制「Base URL」填进去即可。',
        requestUrl: '实际请求',
        root: '网关根地址',
        keys: 'API keys',
        addKey: '新建 key',
        noKeys: '还没有 key。点「新建 key」创建第一把。',
        reveal: '显示明文',
        rotate: '重置',
        remove: '删除',
        label: '名称',
        labelPlaceholder: '例如：Codex CLI',
        models: '对外提供的模型',
        modelsHint: '勾选要暴露给这个 key 的模型。同名模型会自动加账号后缀区分。',
        currentDefault: '默认账号',
        pickAccount: '选择账号',
        allAccounts: '全部账号（默认）',
        groupDefault: '默认账号（跟随插件设置）',
        unavailable: '个账号当前不可用',
        unavailableHint: '上游判定这些账号暂时不能用，已从可勾选列表移除；恢复后会自动回来。',
        healthFresh: '账号状态读取于',
        healthStale: '尚未读到上游账号状态',
        selected: '已选',
        noneSelected: '还没有勾选任何模型，这把 key 暂时不能用。',
        willExpose: '客户端会看到',
        save: '保存',
        saved: '已保存',
        enabled: '启用',
        loading: '正在读取配置…',
        copy: '复制',
        copied: '已复制',
        secretHidden: '点「显示明文」后才有可复制的内容',
        secretCopied: '明文只在这个页面显示，刷新后需要重新点开',
        confirmRemove: '删除后这把 key 立即失效，且无法恢复。确定删除？',
        created: '已创建新 key，明文如下。请立刻复制保存 —— 关掉这个提示后需要重新点「显示明文」。',
        dismiss: '我知道了',
        guide: '怎么用',
        guideHint: '把上面某一行的 Base URL 和任意一把 key 的明文填进客户端。',
        errorTitle: '出错了',
        configPath: '配置文件',
        search: '搜索模型…',
        selectAll: '全选当前',
        clearAll: '清空',
        reasoning: '推理',
        noEfforts: '上游未声明推理档',
        regionCn: '国内版',
        regionGlobal: '国际版',
        dupSuffix: '重名后缀',
        dupSuffixHint: '纯英文账号名直接用昵称，否则用序号。',
        accountSafe: '可直接用昵称作后缀',
        accountUnsafe: '昵称含非 ASCII，将用序号',
      },
      en: {
        title: 'WorkBuddy Gateway',
        subtitle: 'Any app on this machine can use these WorkBuddy models. Each API key picks the models it exposes.',
        endpoints: 'Endpoints',
        endpointsHint: 'Pick the row for your client and copy its Base URL.',
        requestUrl: 'Actual request',
        root: 'Gateway root',
        keys: 'API keys',
        addKey: 'New key',
        noKeys: 'No keys yet. Use "New key" to create the first one.',
        reveal: 'Show secret',
        rotate: 'Rotate',
        remove: 'Delete',
        label: 'Label',
        labelPlaceholder: 'e.g. Codex CLI',
        models: 'Models this key serves',
        modelsHint: 'Tick the models this key should expose. Duplicate names get an account suffix.',
        currentDefault: 'Default account',
        pickAccount: 'Pick an account',
        allAccounts: 'All accounts (default)',
        groupDefault: 'Default account (follows the plugin)',
        unavailable: 'accounts unavailable right now',
        unavailableHint: 'The upstream marks these accounts unusable, so they are not offered for ticking. They return automatically once healthy.',
        healthFresh: 'Account state read at',
        healthStale: 'No upstream account state yet',
        selected: 'selected',
        noneSelected: 'No models ticked yet, so this key cannot be used.',
        willExpose: 'The client will see',
        save: 'Save',
        saved: 'Saved',
        enabled: 'Enabled',
        loading: 'Reading configuration…',
        copy: 'Copy',
        copied: 'Copied',
        secretHidden: 'Use "Show secret" to get something copyable',
        secretCopied: 'The secret stays on this page only; reopen it after a refresh',
        confirmRemove: 'The key stops working immediately and cannot be recovered. Delete it?',
        created: 'New key created. Copy the secret now — after dismissing this you will need "Show secret" again.',
        dismiss: 'Got it',
        guide: 'How to use',
        guideHint: 'Paste one Base URL above and any key’s secret into your client.',
        errorTitle: 'Something failed',
        configPath: 'Config file',
        search: 'Search models…',
        selectAll: 'Select all shown',
        clearAll: 'Clear',
        reasoning: 'Reasoning',
        noEfforts: 'upstream declares no effort levels',
        regionCn: 'CN',
        regionGlobal: 'Intl',
        dupSuffix: 'Duplicate suffix',
        dupSuffixHint: 'An ASCII account name is used as-is; anything else falls back to an ordinal.',
        accountSafe: 'name is usable as a suffix',
        accountUnsafe: 'non-ASCII name, will use an ordinal',
      },
    }

    function texts() {
      return (typeof navigator === 'object' && /^zh/i.test(navigator.language ?? '')) ? TEXT.zh : TEXT.en
    }

    /* ── 样式：只用真实注册的 token ─────────────────────────────────── */

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
.wbg-select{cursor:pointer}
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
.wbg-badge-count{color:var(--dsw-alias-brand-primary,#2f6df6);border-color:currentColor}
.wbg-badge-global{color:var(--dsw-alias-brand-primary,#2f6df6);border-color:currentColor}
.wbg-badge-cn{color:var(--dsw-alias-state-success-primary,#1a7f37);border-color:currentColor}
.wbg-secret{display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);border:1px solid var(--dsw-alias-border-l1,#eee);border-radius:8px;padding:8px 11px}
.wbg-secret code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666);letter-spacing:.3px}
.wbg-secret-live code{color:var(--dsw-alias-label-primary,#1a1a1a);letter-spacing:0}
.wbg-grow{flex:1;min-width:120px}
.wbg-spacer{flex:1}
.wbg-picker{border:1px solid var(--dsw-alias-border-l1,#e3e3e3);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);max-height:320px;overflow-y:auto;display:flex;flex-direction:column}
.wbg-picker-head{position:sticky;top:0;z-index:1;display:flex;gap:8px;align-items:center;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,#f6f6f6);border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}
.wbg-group{border-top:1px solid var(--dsw-alias-border-l1,#eee)}
.wbg-group:first-child{border-top:none}
      .wbg-group-title{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,#fafafa)}
.wbg-opt{display:flex;align-items:center;gap:9px;padding:6px 10px 6px 22px;cursor:pointer;border-radius:6px}
.wbg-opt:hover{background:var(--dsw-alias-bg-layer-2,#f6f6f6)}
.wbg-opt-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.wbg-opt-meta{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:11px;white-space:nowrap}
.wbg-chips{display:flex;flex-wrap:wrap;gap:6px}
.wbg-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f2f2f2);border:1px solid var(--dsw-alias-border-l1,#e8e8e8);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.wbg-chip-x{cursor:pointer;color:var(--dsw-alias-label-tertiary,#999);font-weight:700;line-height:1}
.wbg-chip-x:hover{color:var(--dsw-alias-state-error-primary,#d1242f)}
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
@media (max-width:720px){
  .wbg-ep{grid-template-columns:1fr;gap:6px}
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
          navigator.clipboard.writeText(value).then(finish, finish)
          return
        }
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

    function EndpointRow({ entry, t }) {
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

    /**
     * 模型勾选器：按账号分组，组内列出该组可选的模型。
     *
     * 分组是刻意的：用户的心智模型是「哪个账号能跑哪个模型」，而不是
     * 「模型属于哪个 provider」。每组第一行是「默认账号」（`accountId: ''`，
     * 走宿主通道，账号池/换号都生效）。
     */
    function ModelPicker({ available, accounts, selected, onChange, t }) {
      const [query, setQuery] = useState('')

      /* 勾选键：`accountId\u0000modelId`，与后端 normalizeSelections 一致。 */
      const keyOf = (accountId, modelId) => `${accountId}\u0000${modelId}`
      const selectedKeys = useMemo(
        () => new Set(selected.map((row) => keyOf(row.accountId ?? '', row.modelId))),
        [selected],
      )

      /*
       * 分组顺序与标题。
       *
       * 用户反馈「默认账号把国内的国际的都放到一起了，不便区分」——所以默认账号也
       * **按区域拆成两组**。分组键带上区域前缀（`cn:` / `global:`），于是同一个
       * 「默认账号」在两个区是两个独立分组，各列各的模型。
       *
       * 不可用账号（上游限流/停权）由 `/state` 的 `available` 表筛掉了，所以这里
       * 不需要再过滤一次；`unavailable` 只在页头提示，避免用户以为账号丢了。
       */
      const groups = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const match = (model) => needle === ''
          || model.modelId.toLowerCase().includes(needle)
          || (model.displayName ?? '').toLowerCase().includes(needle)

        const byGroup = new Map()
        const push = (groupKey, row) => {
          if (!byGroup.has(groupKey)) byGroup.set(groupKey, [])
          byGroup.get(groupKey).push(row)
        }
        const accountById = new Map(accounts.map((account) => [account.id, account]))

        for (const model of available) {
          if (!match(model)) continue
          if ((model.accountId ?? '') === '') {
            /* 默认账号：按区域分开。 */
            push(`default:${model.region ?? 'cn'}`, { ...model, accountId: '' })
            continue
          }
          const account = accountById.get(model.accountId)
          push(
            `account:${model.accountId}`,
            { ...model, accountName: account?.name ?? model.accountName ?? model.accountId.slice(0, 8) },
          )
        }

        const order = { cn: 0, global: 1 }
        return [...byGroup.entries()]
          .map(([groupKey, models]) => {
            const [kind, id] = groupKey.split(':')
            const region = kind === 'default' ? id : (accountById.get(id)?.region ?? 'cn')
            return {
              groupKey,
              kind,
              region,
              accountId: kind === 'default' ? '' : id,
              accountName: kind === 'default' ? null : (accountById.get(id)?.name ?? id.slice(0, 8)),
              models,
              /* 排序：默认账号在前，然后国内版、国际版。 */
              sort: (kind === 'default' ? 0 : 10) + (order[region] ?? 9),
            }
          })
          .sort((a, b) => (a.sort - b.sort) || String(a.accountName ?? '').localeCompare(String(b.accountName ?? '')))
      }, [available, accounts, query])

      const toggle = (accountId, model) => {
        const key = keyOf(accountId, model.modelId)
        if (selectedKeys.has(key)) {
          onChange(selected.filter((row) => keyOf(row.accountId ?? '', row.modelId) !== key))
          return
        }
        onChange([
          ...selected,
          {
            accountId,
            region: model.region,
            modelId: model.modelId,
            displayName: model.displayName,
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
            reasoningEfforts: model.reasoningEfforts ?? [],
            inputModalities: model.inputModalities ?? ['text'],
          },
        ])
      }

      const selectAllShown = () => {
        const added = [...selected]
        const have = new Set(added.map((row) => keyOf(row.accountId ?? '', row.modelId)))
        for (const group of groups) {
          for (const model of group.models) {
            const key = keyOf(group.accountId, model.modelId)
            if (have.has(key)) continue
            have.add(key)
            added.push({
              accountId: group.accountId,
              region: model.region,
              modelId: model.modelId,
              displayName: model.displayName,
              ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
              ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
              reasoningEfforts: model.reasoningEfforts ?? [],
              inputModalities: model.inputModalities ?? ['text'],
            })
          }
        }
        onChange(added)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { className: 'wbg-row' },
          h('input', {
            className: 'wbg-input wbg-grow',
            placeholder: t.search,
            value: query,
            'aria-label': t.search,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: selectAllShown }, t.selectAll),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: () => onChange([]) }, t.clearAll),
        ),
        h('div', { className: 'wbg-picker' },
          groups.length === 0
            ? h('p', { className: 'wbg-hint', style: { padding: 12 } }, t.noneSelected)
            : groups.map((group) => h('div', { key: group.groupKey, className: 'wbg-group' },
              h('div', { className: 'wbg-group-title' },
                h('span', null, group.kind === 'default' ? t.groupDefault : group.accountName),
                /* 区域徽标：默认账号也带，用户才分得清国内的与国外的。 */
                h('span', { className: group.region === 'global' ? 'wbg-badge wbg-badge-global' : 'wbg-badge' },
                  group.region === 'global' ? t.regionGlobal : t.regionCn),
                h('span', { className: 'wbg-spacer' }),
                h('span', { style: { fontWeight: 400 } }, `${group.models.filter((model) => selectedKeys.has(keyOf(group.accountId, model.modelId))).length}/${group.models.length}`),
              ),
              group.models.map((model) => {
                const key = keyOf(group.accountId, model.modelId)
                const checked = selectedKeys.has(key)
                const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : []
                return h('label', { key, className: 'wbg-opt' },
                  h('input', { type: 'checkbox', checked, onChange: () => toggle(group.accountId, model) }),
                  h('span', { className: 'wbg-opt-label', title: model.modelId }, model.modelId),
                  h('span', { className: 'wbg-opt-meta' },
                    efforts.length === 0 ? '' : `${t.reasoning}: ${efforts.join('/')}`),
                )
              }),
            )),
        ),
      )
    }

    /* ── 单把 key ───────────────────────────────────────────────────── */

    function KeyCard({ entry, state, t, onSave, onDelete, onRotate, onReveal }) {
      const [label, setLabel] = useState(entry.label)
      const [enabled, setEnabled] = useState(entry.enabled)
      const [selections, setSelections] = useState(entry.selections ?? [])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const [saved, setSaved] = useState(false)
      const [dialog, setDialog] = useState(undefined)
      const [open, setOpen] = useState(false)

      useEffect(() => {
        setLabel(entry.label)
        setEnabled(entry.enabled)
        setSelections(entry.selections ?? [])
      }, [entry])

      const dirty = label !== entry.label
        || enabled !== entry.enabled
        || JSON.stringify(selections) !== JSON.stringify(entry.selections ?? [])

      const save = async () => {
        setBusy(true)
        setError(undefined)
        try {
          await onSave({ id: entry.id, label, enabled, selections })
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

      const catalog = entry.catalog ?? []
      const count = (entry.selections ?? []).length

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
          h('span', { className: 'wbg-badge wbg-badge-count' }, `${count} ${t.selected}`),
          h('span', { className: 'wbg-spacer' }),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: reveal, disabled: busy }, t.reveal),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: rotate, disabled: busy }, t.rotate),
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm wbg-btn-danger', onClick: remove, disabled: busy }, t.remove),
        ),

        /* 掩码：纯文本，刻意不配复制按钮（见文件头第 2 条）。 */
        h('div', { className: 'wbg-secret' },
          h('code', { className: 'wbg-mono', 'aria-label': 'masked key' }, entry.masked),
          h('span', { className: 'wbg-caption' }, t.secretHidden),
        ),

        count === 0 ? h('p', { className: 'wbg-warn' }, t.noneSelected) : null,

        /* 用户实际会看到的名字（含重名后缀），让他核对而不是自己推算。 */
        count === 0 ? null : h('div', null,
          h('p', { className: 'wbg-caption', style: { marginBottom: 6 } }, t.willExpose),
          h('div', { className: 'wbg-chips' },
            catalog.slice(0, 24).map((model) => h('span', { key: model.name, className: 'wbg-chip', title: model.modelId },
              model.name,
              model.name === model.modelId ? null : h('span', { className: 'wbg-caption' }, `← ${model.modelId}`),
            )),
            catalog.length > 24 ? h('span', { className: 'wbg-caption' }, `+${catalog.length - 24}`) : null,
          ),
        ),

        h('div', { className: 'wbg-row' },
          h('button', { type: 'button', className: 'wbg-btn wbg-btn-sm', onClick: () => setOpen(!open) },
            `${t.models} (${count})`),
          h('span', { className: 'wbg-spacer' }),
        ),

        open ? h(ModelPicker, {
          available: state?.available ?? [],
          accounts: state?.accounts ?? [],
          selected: selections,
          onChange: setSelections,
          t,
        }) : null,

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
          const body = await adminPost('/keys', { label: '', selections: [] })
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
        `  -d '{"model":"<model from the list>","messages":[{"role":"user","content":"hi"}]}'`,
      ].join('\n')

      return h('div', { className: 'wbg' },
        h('style', null, CSS),

        h('div', { className: 'wbg-head' },
          h('h2', { className: 'wbg-h1' }, t.title),
          h('p', { className: 'wbg-sub' }, t.subtitle),
        ),

        h('div', { className: 'wbg-card' },
          h('div', { className: 'wbg-row' },
            h('strong', { className: 'wbg-sec-title' }, t.endpoints),
            h('span', { className: 'wbg-spacer' }),
            h('span', { className: 'wbg-caption' }, t.endpointsHint),
          ),
          h('div', null, endpoints.map((entry) => h(EndpointRow, { key: entry.id, entry, t }))),
          h('p', { className: 'wbg-caption', style: { marginTop: 2 } }, `${t.root}: ${state.baseUrl}`),
        ),

        /*
         * 上游账号状态提示。
         *
         * 用户明确要求「账号不可用时从可勾选列表移除，并与上游保持同步」，所以
         * 这里把「移除了几个、为什么、状态有多新」直接说出来 —— 否则用户只会
         * 发现某个账号凭空消失。
         */
        (state.unavailableAccounts?.length ?? 0) === 0 ? null : h('div', { className: 'wbg-alert wbg-alert-warn' },
          h('span', { className: 'wbg-alert-icon', 'aria-hidden': true }, '!'),
          h('div', { className: 'wbg-alert-body' },
            h('div', null, `${state.unavailableAccounts.length} ${t.unavailable}`),
            h('p', { className: 'wbg-caption', style: { margin: '2px 0 6px' } }, t.unavailableHint),
            h('div', { className: 'wbg-chips' },
              state.unavailableAccounts.map((account) => h('span', {
                key: `${account.region}:${account.id}`,
                className: 'wbg-chip',
                title: account.reason,
              },
                account.name === '' ? account.id.slice(0, 8) : account.name,
                h('span', { className: 'wbg-caption' }, account.region === 'global' ? t.regionGlobal : t.regionCn),
              )),
            ),
          ),
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
