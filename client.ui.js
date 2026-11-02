/**
 * Spend meter — Client half.
 *
 * One compact cell in the composer dock: this conversation's priced spend and the
 * remaining platform balance. Clicking it opens the ledger the Host projection
 * (`spendMeter`) already computed, rendered like the Harness' own stat dialogs.
 *
 * Three hard rules learned the hard way:
 *  - never let `apply` throw (a client half that throws costs the desktop shell
 *    its boot), and never throw during render (the slot runtime "abdicates" a
 *    cell that throws, so it silently disappears from the dock);
 *  - `style` must always be an object — a colour string passed as `style` makes
 *    React throw, which is exactly how this cell used to vanish;
 *  - the wallet comes from the Host projection, never from a Remote call.
 */

window.__ModuleLoader__.load({
  id: '@local/spend-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'spend-meter'
    const PROJECTION_KEY = 'spendMeter'
    const CLIENT_VERSION = '0.2.1-rc.5'
    const USAGE_URL = 'https://platform.deepseek.com/usage'
    const TOPUP_URL = 'https://platform.deepseek.com/top_up'
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
    const DAY_MS = 24 * 60 * 60 * 1000

    const FALLBACK_PRICING = {
      windows: [{ start: 9, end: 12 }, { start: 14, end: 18 }],
      holidays: [],
    }

    /** Collected failures; rendered in the panel instead of thrown. */
    const problems = []

    const describeError = (error) => {
      if (!error) return 'unknown error'
      if (typeof error === 'string') return error
      const message = error.message || String(error)
      if (!error.stack) return message
      return String(error.stack).split('\n').slice(0, 2).join(' ')
    }

    const note = (where, error) => {
      const message = `${where}: ${describeError(error)}`
      if (!problems.includes(message)) problems.push(message)
      try {
        console.error('[spend-meter]', message)
      } catch {
        // console is best effort
      }
    }

    //#region dictionaries

    const EN = {
      'pill.title': 'Spend and balance',
      'pill.cost': 'this chat',
      'pill.balance': 'balance',
      'panel.title': 'This conversation',
      'panel.tier.peak': 'Peak hours',
      'panel.tier.offPeak': 'Off-peak (half price)',
      'panel.tier.toPeak': 'peak in {time}',
      'panel.tier.toOffPeak': 'half price in {time}',
      'panel.inputMiss': 'Input · cache miss',
      'panel.inputHit': 'Input · cache hit',
      'panel.output': 'Output',
      'panel.search': 'Web search',
      'panel.hidden': 'Auto-compaction',
      'panel.calls': '{count} calls',
      'panel.times': '{count} times',
      'panel.cacheSaved': 'Cache reads saved {amount}',
      'panel.cacheSavedAlt': '· without caching {amount}',
      'panel.balancePaid': 'Top-up balance',
      'panel.balanceTitle': 'Balance',
      'panel.bonus': 'Bonus balance',
      'panel.runsLeft': '≈ {count} more turns at this pace',
      'panel.models': 'By model',
      'panel.turns': 'Per turn',
      'panel.turnsMore': 'Show {count} earlier',
      'panel.turnsLess': 'Show fewer',
      'panel.usage': 'Platform usage',
      'panel.topUp': 'Top up',
      'panel.unpriced': 'No tariff for {models}',
      'panel.estimated': 'Estimated at the model-family rate: {models}',
      'panel.balanceSignedOut': 'Sign in to see the balance',
      'panel.balanceFailed': 'Balance unavailable',
      'panel.balanceLoading': 'Loading balance…',
      'panel.problems': 'Plugin problem',
      'panel.budgetTitle': 'Budget',
      'panel.budgetToday': 'Today',
      'panel.budgetMonth': 'This month',
      'panel.budgetOverDay': 'Today’s budget is used up',
      'panel.budgetOverMonth': 'This month’s budget is used up',
      'panel.budgetSince': 'Counting since {date}',
      'panel.noticeDay': 'Today’s budget is used up ({amount})',
      'panel.noticeMonth': 'This month’s budget is used up ({amount})',
      'panel.noticeDismiss': 'Dismiss',
      'panel.pricingRemote': 'Prices: updated {date}',
      'panel.pricingError': 'Price update failed: {reason}',
      'time.hours': '{hours}h {minutes}m',
      'time.minutes': '{minutes}m',
      'turn.label': 'T{turn}',
    }

    const ZH = {
      'pill.title': '花费与余额',
      'pill.cost': '本对话',
      'pill.balance': '余额',
      'panel.title': '本对话花费',
      'panel.tier.peak': '高峰时段',
      'panel.tier.offPeak': '空闲时段（半价）',
      'panel.tier.toPeak': '距高峰 {time}',
      'panel.tier.toOffPeak': '距半价 {time}',
      'panel.inputMiss': '输入 · 未命中缓存',
      'panel.inputHit': '输入 · 命中缓存',
      'panel.output': '输出',
      'panel.search': '联网搜索',
      'panel.hidden': '自动压缩摘要',
      'panel.calls': '{count} 次',
      'panel.times': '{count} 次',
      'panel.cacheSaved': '缓存命中已省下 {amount}',
      'panel.cacheSavedAlt': '· 若无缓存需 {amount}',
      'panel.balancePaid': '充值余额',
      'panel.balanceTitle': '余额',
      'panel.bonus': '赠送余额',
      'panel.runsLeft': '按当前速度还能聊约 {count} 轮',
      'panel.models': '按模型',
      'panel.turns': '逐轮成本',
      'panel.turnsMore': '展开更早 {count} 轮',
      'panel.turnsLess': '收起',
      'panel.usage': '平台用量',
      'panel.topUp': '去充值',
      'panel.unpriced': '{models} 没有价目，未计价',
      'panel.estimated': '按模型族近似计价：{models}',
      'panel.balanceSignedOut': '未登录，无法读取余额',
      'panel.balanceFailed': '余额获取失败',
      'panel.balanceLoading': '正在读取余额…',
      'panel.problems': '插件异常',
      'panel.budgetTitle': '预算',
      'panel.budgetToday': '今日',
      'panel.budgetMonth': '本月',
      'panel.budgetOverDay': '今日预算已用完',
      'panel.budgetOverMonth': '本月预算已用完',
      'panel.budgetSince': '自 {date} 起统计',
      'panel.noticeDay': '今日预算已用完（{amount}）',
      'panel.noticeMonth': '本月预算已用完（{amount}）',
      'panel.noticeDismiss': '关闭',
      'panel.pricingRemote': '价目表：{date} 更新',
      'panel.pricingError': '价目表更新失败：{reason}',
      'time.hours': '{hours}小时{minutes}分',
      'time.minutes': '{minutes}分',
      'turn.label': 'T{turn}',
    }

    /** Locale service captured at apply time, for the fallback translator. */
    let localeService

    /** Active locale id, defaulting to zh when the service is not readable yet. */
    function activeLocale() {
      try {
        const active = localeService.getSnapshot().active
        return typeof active === 'string' && active.length > 0 ? active : 'zh'
      } catch {
        return 'zh'
      }
    }

    function fallbackTranslate(key, params) {
      const language = activeLocale()
      const dictionary = language === 'en' ? EN : ZH
      const template = dictionary[key] ?? EN[key] ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
    }

    //#endregion

    //#region styles

    /**
     * Mirrors the Harness' own stat-dialog rules so the cell reads as part of the
     * composer bar rather than as a bolted-on widget: a bare tertiary pill, and a
     * popover on --dsw-specific-menu with the shared elevation and radius tokens.
     */
    const CSS = `
.sm-anchor{min-width:0;display:inline-flex;position:relative;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.sm-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
.sm-pill:hover,.sm-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sm-pill svg{flex:none;width:14px;height:14px}
.sm-icon{display:inline-flex}
.sm-pill-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.sm-sep{color:var(--dsw-alias-separator-primary);margin:0 -2px}
.sm-tone-peak{color:var(--dsw-alias-state-warn-primary)}
.sm-tone-warn{color:var(--dsw-alias-state-warn-primary)}
.sm-tone-danger{color:var(--dsw-alias-state-error-primary)}
.sm-panel{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 48px);max-height:min(70vh,520px);overflow-y:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;text-align:left}
.sm-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}
.sm-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
.sm-title-value{font-variant-numeric:tabular-nums}
.sm-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.sm-note{color:var(--dsw-alias-label-tertiary);margin:-2px 0 10px}
.sm-note-tight{color:var(--dsw-alias-label-tertiary);margin:6px 0 0}
.sm-notice{display:inline-flex;align-items:center;gap:4px;max-width:100%;margin-left:8px;padding:0 2px 0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:18px;white-space:nowrap}
.sm-notice-text{overflow:hidden;text-overflow:ellipsis}
.sm-notice-close{font:inherit;color:inherit;background:0 0;border:none;padding:0 2px;cursor:pointer;opacity:.7;line-height:1}
.sm-notice-close:hover{opacity:1}
.sm-rows{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr) auto;gap:6px 16px;margin:0;display:grid}
.sm-rows dt,.sm-rows dd{min-width:0;margin:0}
.sm-rows dt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-rows .sm-hint{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}
.sm-rows .sm-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.sm-section{color:var(--dsw-alias-label-primary);font-weight:500;margin:12px 0 6px}
.sm-turns{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:2px 14px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.sm-turns span{display:flex;justify-content:space-between;gap:8px}
.sm-turns b{color:var(--dsw-alias-label-secondary);font-weight:400}
.sm-footer{display:flex;gap:16px;margin-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.sm-footer a{color:var(--dsw-alias-brand-primary);text-decoration:none;display:inline-flex;align-items:center;gap:2px}
.sm-footer a:hover{text-decoration:underline}
.sm-external{font-size:10px;line-height:1;opacity:.75}
.sm-more{font:inherit;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;padding:0;margin-top:6px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.sm-more:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.sm-problem{margin-top:10px;color:var(--dsw-alias-state-warn-primary);white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:16px}
`

    const STYLE_ID = `${NS}/style.css`

    function insertStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const selector = `style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`
      if (document.querySelector(selector)) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/spend-meter'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        try {
          tag.remove()
        } catch (error) {
          note('style cleanup', error)
        }
      }
    }

    /** A ¥ coin, drawn at the 14px the shipped pills use. */
    function CoinIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.15,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 8, cy: 8, r: 6.1 }),
        h('path', { d: 'M5.9 5.2 8 8.2l2.1-3' }),
        h('path', { d: 'M8 8.2v3' }),
        h('path', { d: 'M6.5 9.7h3' }),
      )
    }

    //#endregion

    //#region format

    function formatMoney(value) {
      const amount = Number.isFinite(value) ? value : 0
      const abs = Math.abs(amount)
      if (abs === 0) return '0.00'
      if (abs >= 1) return amount.toFixed(2)
      if (abs >= 0.01) return amount.toFixed(3)
      return amount.toFixed(4)
    }

    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1e6) return `${(value / 1000).toFixed(1)}k`
      return `${(value / 1e6).toFixed(2)}M`
    }

    function formatSpan(ms) {
      const total = Math.max(0, ms)
      let hours = Math.floor(total / 3600000)
      let minutes = Math.round((total - hours * 3600000) / 60000)
      if (minutes === 60) {
        hours += 1
        minutes = 0
      }
      return { hours, minutes }
    }

    const symbolOf = (currency) => (currency === 'CNY' ? '¥' : '$')

    //#endregion

    //#region notices

    const NOTICE_KEY = 'spend-meter:notices'

    /** Dismissed banners, keyed by period (`day:2026-11-02`, `month:2026-11`). */
    function readNotices() {
      try {
        const raw = window.localStorage.getItem(NOTICE_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        note('notices', error)
        return {}
      }
    }

    function markNotice(key) {
      try {
        const notices = readNotices()
        notices[key] = Date.now()
        // Keep the file from growing forever: 90 days of keys is plenty.
        const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
        for (const [entry, at] of Object.entries(notices)) {
          if (!Number.isFinite(at) || at < cutoff) delete notices[entry]
        }
        window.localStorage.setItem(NOTICE_KEY, JSON.stringify(notices))
      } catch (error) {
        note('notices', error)
      }
    }

    /** An exhausted budget deserves one banner per period, not one per render. */
    function budgetNotice(budget, t) {
      if (!budget || typeof budget.today !== 'string') return null
      const symbol = symbolOf(budget.currency)
      const dismissed = readNotices()
      const amount = (entry) => `${symbol}${formatMoney(entry.spent)} / ${symbol}${formatMoney(entry.limit)}`
      const dayKey = `day:${budget.today}`
      if (budget.day && budget.day.ratio >= 1 && !dismissed[dayKey]) {
        return { key: dayKey, text: t('panel.noticeDay', { amount: amount(budget.day) }) }
      }
      const monthKey = `month:${budget.today.slice(0, 7)}`
      if (budget.month && budget.month.ratio >= 1 && !dismissed[monthKey]) {
        return { key: monthKey, text: t('panel.noticeMonth', { amount: amount(budget.month) }) }
      }
      return null
    }

    //#endregion

    function beijingMoment(ms) {
      const shifted = new Date(ms + BEIJING_OFFSET_MS)
      return {
        weekday: shifted.getUTCDay(),
        hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60,
        date: shifted.toISOString().slice(0, 10),
      }
    }

    function windowsOf(pricing) {
      const source = pricing && Array.isArray(pricing.windows) && pricing.windows.length > 0
        ? pricing.windows
        : FALLBACK_PRICING.windows
      return source.filter((window) => window && Number.isFinite(window.start) && Number.isFinite(window.end))
    }

    function isPeakAt(ms, pricing) {
      const moment = beijingMoment(ms)
      if (moment.weekday === 0 || moment.weekday === 6) return false
      const holidays = pricing && Array.isArray(pricing.holidays) ? pricing.holidays : FALLBACK_PRICING.holidays
      if (holidays.includes(moment.date)) return false
      return windowsOf(pricing).some((window) => moment.hour >= window.start && moment.hour < window.end)
    }

    /** First instant whose peak flag differs from `ms`, scanning 20 days of boundaries. */
    function nextTransition(ms, pricing) {
      const moment = beijingMoment(ms)
      const midnight = Date.parse(`${moment.date}T00:00:00+08:00`)
      if (!Number.isFinite(midnight)) return undefined
      const current = isPeakAt(ms, pricing)
      const marks = new Set([0, 24])
      for (const window of windowsOf(pricing)) {
        marks.add(window.start)
        marks.add(window.end)
      }
      const sorted = [...marks].sort((left, right) => left - right)
      for (let day = 0; day < 20; day += 1) {
        for (const hour of sorted) {
          const at = midnight + day * DAY_MS + hour * 3600000
          if (at <= ms) continue
          if (isPeakAt(at, pricing) !== current) return { at, peak: !current }
        }
      }
      return undefined
    }

    function describeBalance(balance) {
      if (!balance || balance.status === 'loading') return { status: 'loading', currency: 'CNY' }
      if (balance.status !== 'ready') {
        return { status: balance.status, currency: 'CNY', reason: balance.reason }
      }
      const wallets = Array.isArray(balance.wallets) ? balance.wallets : []
      const bonusWallets = Array.isArray(balance.bonus) ? balance.bonus : []
      const first = wallets.concat(bonusWallets).find((wallet) => wallet && wallet.currency === 'CNY')
      const currency = first?.currency ?? wallets[0]?.currency ?? bonusWallets[0]?.currency ?? 'CNY'
      const sum = (list) => list
        .filter((wallet) => wallet && wallet.currency === currency)
        .reduce((total, wallet) => total + (Number(wallet.balance) || 0), 0)
      const paid = sum(wallets)
      const bonus = sum(bonusWallets)
      return { status: 'ready', currency, paid, bonus, available: paid + bonus }
    }

    /**
     * The Host projection carries the wallet, so the Client never needs a Remote
     * call of its own; normalising here keeps the panel's rendering unchanged.
     */
    function walletOf(view) {
      const wallet = view && view.wallet
      if (!wallet || typeof wallet !== 'object') return { status: 'loading' }
      return wallet
    }

    //#endregion

    //#region wallet

    /**
     * A Host projection only re-publishes when a session event changes its state,
     * so a wallet read after boot would never reach an idle page: the cell would
     * sit on whatever the baseline happened to capture. The Client therefore asks
     * the account Remote itself (the call the settings page makes) and keeps the
     * projection's `wallet` as a fallback while that request is in flight.
     */
    /**
     * The account namespace arrives as `ctx.remote.account`; depending on how the
     * Remote root is assembled it can also be its own service. Accept either.
     *
     * Deliberately resolved through `ctx.get`: a hard `inject` on a Remote name
     * would leave this entry pending whenever the namespace is not mounted yet,
     * and the desktop boot audit treats a non-active entry as fatal.
     */
    function resolveAccount(ctx) {
      const usable = (candidate) => candidate && typeof candidate.getBalance === 'function'
      try {
        if (typeof ctx.get === 'function') {
          const dotted = ctx.get('remote.account')
          if (usable(dotted)) return dotted
          const root = ctx.get('remote')
          if (root && usable(root.account)) return root.account
        }
      } catch {
        // ignore: the namespace may not be mounted yet
      }
      try {
        if (usable(ctx['remote.account'])) return ctx['remote.account']
      } catch {
        // dotted service access is not allowed on every Cordis build
      }
      try {
        if (usable(ctx.remote && ctx.remote.account)) return ctx.remote.account
      } catch {
        // ignore
      }
      return undefined
    }

    function createWalletSource(ctx) {
      let snapshot = { status: 'loading' }
      const listeners = new Set()
      let inFlight = false

      const publish = (next) => {
        snapshot = next
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            note('wallet listener', error)
          }
        }
      }

      const describe = (result) => {
        if (!result || result.ok !== true) {
          const error = result && result.error
          const reason = error && (error.message || error.code)
          return { status: 'failed', reason: String(reason || 'remote error') }
        }
        if (result.value == null) return { status: 'signed-out' }
        const details = result.value
        if (details.status !== 'ready') return { status: 'failed', reason: `status=${details.status}` }
        return {
          status: 'ready',
          wallets: Array.isArray(details.value) ? details.value : [],
          bonus: Array.isArray(details.bonusWallets) ? details.bonusWallets : [],
        }
      }

      const refresh = () => {
        const account = resolveAccount(ctx)
        if (!account) {
          publish({ status: 'failed', reason: 'account remote unavailable' })
          return Promise.resolve()
        }
        if (inFlight) return Promise.resolve()
        inFlight = true
        const metadata = {
          version: CLIENT_VERSION,
          locale: activeLocale(),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        }
        return Promise.resolve()
          .then(() => account.getBalance(metadata))
          .then((result) => publish(describe(result)))
          .catch((error) => publish({ status: 'failed', reason: describeError(error) }))
          .then(() => {
            inFlight = false
          })
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        getSnapshot: () => snapshot,
        refresh,
      }
    }

    /** Prefer a live Remote answer, else whatever the projection last carried. */
    function pickWallet(remote, view) {
      const carried = walletOf(view)
      const settled = (wallet) => wallet !== undefined && wallet !== null && wallet.status !== 'loading'
      if (settled(remote) && remote.status !== 'failed') return remote
      if (settled(carried) && carried.status === 'ready') return carried
      if (settled(remote)) return remote
      if (settled(carried)) return carried
      return { status: 'loading' }
    }

    /**
     * Opens a platform page outside the app. The shell turns `window.open` into
     * `shell.openExternal`; a browser tab is the worst case. Never throws.
     */
    function openExternal(event, url) {
      try {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
      } catch (error) {
        note('link', error)
      }
      try {
        // Electron denies the popup and forwards the URL to `shell.openExternal`,
        // so the null return is expected and must not be treated as a failure.
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        note('link', error)
      }
    }

    //#endregion

    //#region components

    /** One `dt`/`dd`/`dd` triple of the shared two-column detail grid. */
    function DetailRow({ label, hint, value, tone }) {
      const valueClass = tone === undefined ? 'sm-value' : `sm-value sm-tone-${tone}`
      return h(
        React.Fragment,
        null,
        h('dt', null, label),
        h('dd', { className: 'sm-hint' }, hint === undefined ? '' : hint),
        h('dd', { className: valueClass }, value),
      )
    }

    /** Catches a broken panel so the pill survives. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        note('panel', error)
      }

      render() {
        if (this.state.failed) {
          return h(
            'div',
            { className: 'sm-problem' },
            `${fallbackTranslate('panel.problems')}: ${problems.join(' | ')}`,
          )
        }
        return this.props.children
      }
    }

    /** Pure panel body: no hooks of its own, called from a guarded render. */
    function buildPanel({ t, view, wallet, now, open, turnsExpanded, onToggleTurns }) {
      const pricing = (view && view.pricing) || FALLBACK_PRICING
      const currency = (view && view.currency) || 'CNY'
      const symbol = symbolOf(currency)
      const total = (view && view.cost && view.cost.total) || 0
      const cost = (view && view.cost) || {}
      const totals = (view && view.totals) || {}
      const balanceInfo = describeBalance(wallet)
      const balanceSymbol = symbolOf(balanceInfo.currency || 'CNY')
      const peak = isPeakAt(now, pricing)

      const balanceLabel = balanceInfo.status === 'ready'
        ? `${balanceSymbol}${formatMoney(balanceInfo.available)}`
        : '—'

      const balanceTone = balanceInfo.status !== 'ready'
        ? undefined
        : balanceInfo.available < 1
          ? 'danger'
          : balanceInfo.available < 5
            ? 'warn'
            : undefined

      const transition = nextTransition(now, pricing)
      const span = transition ? formatSpan(transition.at - now) : undefined
      const countdown = span === undefined
        ? undefined
        : span.hours > 0
          ? t('time.hours', { hours: span.hours, minutes: span.minutes })
          : t('time.minutes', { minutes: span.minutes })
      const tierText = peak ? t('panel.tier.peak') : t('panel.tier.offPeak')
      const tierHint = countdown === undefined
        ? undefined
        : transition.peak
          ? t('panel.tier.toPeak', { time: countdown })
          : t('panel.tier.toOffPeak', { time: countdown })

      const turns = view && Array.isArray(view.turns) ? view.turns : []
      const latestTurns = turns.slice(-8)
      const shownTurns = turnsExpanded ? turns.slice(-80) : latestTurns
      const hiddenTurns = Math.max(0, turns.length - latestTurns.length)
      const models = view && Array.isArray(view.models) ? view.models : []
      // The same model can show up twice when a session switched provider (e.g. an
      // official key and an account-backed one). Only then is `provider/model` worth
      // the extra width; otherwise the bare model name reads better.
      const modelNameCounts = new Map()
      for (const entry of models) {
        const name = String(entry.model || entry.id)
        modelNameCounts.set(name, (modelNameCounts.get(name) || 0) + 1)
      }
      const modelLabel = (entry) => {
        const name = String(entry.model || entry.id)
        return (modelNameCounts.get(name) || 0) > 1 && entry.provider
          ? `${entry.provider}/${name}`
          : name
      }
      const unpriced = view && Array.isArray(view.unpriced) ? view.unpriced : []
      const estimated = view && Array.isArray(view.estimated) ? view.estimated : []

      const budget = view && view.budget ? view.budget : undefined
      const warnRatio = budget && Number.isFinite(budget.warnRatio) ? budget.warnRatio : 0.8
      const budgetTone = (entry) => {
        if (!entry) return undefined
        if (entry.ratio >= 1) return 'danger'
        return entry.ratio >= warnRatio ? 'warn' : undefined
      }
      const budgetPercent = (entry) => `${Math.round((entry?.ratio ?? 0) * 100)}%`
      const sinceDate = budget && typeof budget.since === 'string' ? budget.since.slice(0, 10) : undefined
      // Only worth saying when bookkeeping started mid-month: on the first of the
      // month the "this month" figure is complete anyway.
      const startedMidMonth = sinceDate !== undefined && budget.today !== undefined
        && sinceDate.slice(0, 7) === budget.today.slice(0, 7)
        && sinceDate !== `${budget.today.slice(0, 7)}-01`
      const budgetNote = startedMidMonth ? t('panel.budgetSince', { date: sinceDate }) : undefined

      // Which tariff priced these numbers. The built-in table is the documented
      // default, so only a downloaded table or a failed download is worth a line.
      const priceInfo = view && view.pricing ? view.pricing : undefined
      const pricingNote = priceInfo === undefined
        ? undefined
        : typeof priceInfo.error === 'string' && priceInfo.error
          ? t('panel.pricingError', { reason: priceInfo.error.slice(0, 60) })
          : priceInfo.source === 'remote' || priceInfo.source === 'cache'
            ? t('panel.pricingRemote', {
                date: typeof priceInfo.updatedAt === 'string' ? priceInfo.updatedAt.slice(0, 10) : '—',
              })
            : undefined

      let runsLeft
      if (balanceInfo.status === 'ready' && turns.length > 0) {
        const average = turns.reduce((sum, entry) => sum + entry.cost, 0) / turns.length
        if (average > 0) runsLeft = Math.floor(balanceInfo.available / average)
      }

      const tokensIn = (entry) => (entry.tokens?.miss || 0) + (entry.tokens?.hit || 0) + (entry.tokens?.write || 0)

      const panel = open
        ? h(
            'div',
            { className: 'sm-panel', role: 'dialog', 'aria-label': t('panel.title'), 'data-spend-panel': '' },
            h(
              'div',
              { className: 'sm-title' },
              h('span', { className: 'sm-title-label' }, CoinIcon(), t('panel.title')),
              h('span', { className: 'sm-title-value' }, `${symbol}${formatMoney(total)}`),
            ),
            h('div', { className: 'sm-rule', 'aria-hidden': true }),
            h('div', { className: 'sm-note' }, tierHint === undefined ? tierText : `${tierText} · ${tierHint}`),

            h(
              'dl',
              { className: 'sm-rows' },
              h(DetailRow, {
                label: t('panel.inputMiss'),
                hint: formatTokens(totals.miss || 0),
                value: `${symbol}${formatMoney(cost.miss || 0)}`,
              }),
              h(DetailRow, {
                label: t('panel.inputHit'),
                hint: formatTokens(totals.hit || 0),
                value: `${symbol}${formatMoney(cost.hit || 0)}`,
              }),
              h(DetailRow, {
                label: t('panel.output'),
                hint: formatTokens(totals.out || 0),
                value: `${symbol}${formatMoney(cost.out || 0)}`,
              }),
              view && view.search && view.search.calls > 0
                ? h(DetailRow, {
                    label: t('panel.search'),
                    hint: t('panel.calls', { count: view.search.calls }),
                    value: `${symbol}${formatMoney(cost.search || 0)}`,
                  })
                : null,
              view && view.hidden && view.hidden.count > 0
                ? h(DetailRow, {
                    label: t('panel.hidden'),
                    hint: t('panel.times', { count: view.hidden.count }),
                    value: `${symbol}${formatMoney(cost.hidden || 0)}`,
                  })
                : null,
            ),

            view && view.saved > 0
              ? h(
                  'div',
                  { className: 'sm-note-tight' },
                  t('panel.cacheSaved', { amount: `${symbol}${formatMoney(view.saved)}` }),
                  h(
                    'span',
                    null,
                    ` ${t('panel.cacheSavedAlt', { amount: `${symbol}${formatMoney(view.withoutCache)}` })}`,
                  ),
                )
              : null,

            budget && (budget.day || budget.month)
              ? h(
                  'div',
                  null,
                  h('div', { className: 'sm-section' }, t('panel.budgetTitle')),
                  h(
                    'dl',
                    { className: 'sm-rows' },
                    budget.day
                      ? h(DetailRow, {
                          label: t('panel.budgetToday'),
                          hint: budgetPercent(budget.day),
                          value: `${symbol}${formatMoney(budget.day.spent)} / ${symbol}${formatMoney(budget.day.limit)}`,
                          tone: budgetTone(budget.day),
                        })
                      : null,
                    budget.month
                      ? h(DetailRow, {
                          label: t('panel.budgetMonth'),
                          hint: budgetPercent(budget.month),
                          value: `${symbol}${formatMoney(budget.month.spent)} / ${symbol}${formatMoney(budget.month.limit)}`,
                          tone: budgetTone(budget.month),
                        })
                      : null,
                  ),
                  budget.day && budget.day.ratio >= 1
                    ? h('div', { className: 'sm-note-tight sm-tone-danger' }, t('panel.budgetOverDay'))
                    : null,
                  budget.month && budget.month.ratio >= 1
                    ? h('div', { className: 'sm-note-tight sm-tone-danger' }, t('panel.budgetOverMonth'))
                    : null,
                  budgetNote === undefined ? null : h('div', { className: 'sm-note-tight' }, budgetNote),
                )
              : null,

            h('div', { className: 'sm-section' }, t('panel.balanceTitle')),

            balanceInfo.status === 'ready'
              ? h(
                  'dl',
                  { className: 'sm-rows' },
                  h(DetailRow, {
                    label: t('panel.balancePaid'),
                    value: `${balanceSymbol}${formatMoney(balanceInfo.paid)}`,
                    tone: balanceTone,
                  }),
                  balanceInfo.bonus > 0
                    ? h(DetailRow, {
                        label: t('panel.bonus'),
                        value: `+${balanceSymbol}${formatMoney(balanceInfo.bonus)}`,
                      })
                    : null,
                )
              : h(
                  'dl',
                  { className: 'sm-rows' },
                  h(DetailRow, {
                    label: balanceInfo.status === 'signed-out'
                      ? t('panel.balanceSignedOut')
                      : balanceInfo.status === 'loading'
                        ? t('panel.balanceLoading')
                        : t('panel.balanceFailed'),
                    hint: balanceInfo.reason === undefined ? undefined : String(balanceInfo.reason).slice(0, 80),
                    value: '—',
                  }),
                ),

            runsLeft !== undefined && runsLeft > 0
              ? h('div', { className: 'sm-note-tight' }, t('panel.runsLeft', { count: runsLeft }))
              : null,

            models.length > 1
              ? h(
                  'div',
                  null,
                  h('div', { className: 'sm-section' }, t('panel.models')),
                  h(
                    'dl',
                    { className: 'sm-rows' },
                    models.slice(0, 6).map((entry) =>
                      h(DetailRow, {
                        key: entry.id,
                        label: modelLabel(entry),
                        hint: `${formatTokens(tokensIn(entry))} in / ${formatTokens(entry.tokens?.out || 0)} out`,
                        value: `${symbol}${formatMoney(entry.cost)}`,
                        tone: entry.priced ? undefined : 'warn',
                      }),
                    ),
                  ),
                )
              : null,

            unpriced.length > 0
              ? h('div', { className: 'sm-problem' }, t('panel.unpriced', { models: unpriced.join(', ') }))
              : null,

            estimated.length > 0
              ? h('div', { className: 'sm-note-tight' }, t('panel.estimated', { models: estimated.join(', ') }))
              : null,

            turns.length > 0
              ? h(
                  'div',
                  null,
                  h('div', { className: 'sm-section' }, t('panel.turns')),
                  h(
                    'div',
                    { className: 'sm-turns' },
                    shownTurns.map((entry) =>
                      h(
                        'span',
                        { key: entry.turn },
                        h('span', null, t('turn.label', { turn: entry.turn })),
                        h('b', null, `${symbol}${formatMoney(entry.cost)}`),
                      ),
                    ),
                  ),
                  hiddenTurns > 0
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'sm-more',
                          'aria-expanded': turnsExpanded ? 'true' : 'false',
                          onClick: onToggleTurns,
                        },
                        turnsExpanded
                          ? t('panel.turnsLess')
                          : t('panel.turnsMore', { count: hiddenTurns }),
                      )
                    : null,
                )
              : null,

            pricingNote === undefined ? null : h('div', { className: 'sm-note-tight' }, pricingNote),

            h(
              'div',
              { className: 'sm-footer' },
              h(
                'a',
                {
                  href: USAGE_URL,
                  target: '_blank',
                  rel: 'noreferrer',
                  title: USAGE_URL,
                  onClick: (event) => openExternal(event, USAGE_URL),
                },
                t('panel.usage'),
                h('span', { className: 'sm-external', 'aria-hidden': 'true' }, '↗'),
              ),
              h(
                'a',
                {
                  href: TOPUP_URL,
                  target: '_blank',
                  rel: 'noreferrer',
                  title: TOPUP_URL,
                  onClick: (event) => openExternal(event, TOPUP_URL),
                },
                t('panel.topUp'),
                h('span', { className: 'sm-external', 'aria-hidden': 'true' }, '↗'),
              ),
            ),

            problems.length > 0
              ? h('div', { className: 'sm-problem' }, `${t('panel.problems')}: ${problems.join(' | ')}`)
              : null,
          )
        : null

      const costTone = (() => {
        const entries = [budget?.day, budget?.month].filter(Boolean)
        if (entries.some((entry) => entry.ratio >= 1)) return 'danger'
        if (entries.some((entry) => entry.ratio >= warnRatio)) return 'warn'
        return undefined
      })()
      const budgetTitle = budget?.day
        ? ` · ${t('panel.budgetToday')} ${budgetPercent(budget.day)}`
        : undefined

      return {
        chipCost: view === undefined || view === null ? '—' : `${symbol}${formatMoney(total)}`,
        balanceLabel,
        balanceTone,
        costTone,
        budgetTitle,
        peak,
        panel,
      }
    }

    /**
     * The dock cell. Uses only standard slot props (`useProjection`, `t`); spend
     * rides inside the projection view, the wallet comes from the Remote source.
     */
    function createSpendEntry(walletSource) {
      function SpendEntry(props) {
        const t = typeof props.t === 'function' ? props.t : fallbackTranslate

        let view
        try {
          view = typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : undefined
        } catch (error) {
          note('projection', error)
          view = undefined
        }

        let remoteWallet
        try {
          remoteWallet = React.useSyncExternalStore(walletSource.subscribe, walletSource.getSnapshot)
        } catch (error) {
          note('wallet', error)
          remoteWallet = undefined
        }
        const wallet = pickWallet(remoteWallet, view)

      const [open, setOpen] = React.useState(false)
      const [turnsExpanded, setTurnsExpanded] = React.useState(false)
      // Bumped after a dismissal so the banner is recomputed from storage.
      const [, setNoticeRevision] = React.useState(0)
      const [now, setNow] = React.useState(() => Date.now())
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        if (typeof setInterval !== 'function') return undefined
        const handle = setInterval(() => setNow(Date.now()), 15000)
        return () => clearInterval(handle)
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined') return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root && !root.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      let model
      try {
        model = buildPanel({
          t,
          view,
          wallet,
          now,
          open,
          turnsExpanded,
          onToggleTurns: () => setTurnsExpanded((previous) => !previous),
        })
      } catch (error) {
        note('render', error)
        model = { chipCost: '—', balanceLabel: '—', balanceTone: undefined, costTone: undefined, budgetTitle: undefined, peak: false, panel: null }
      }

      const iconClass = model.peak ? 'sm-tone-peak' : undefined
      const balanceClass = model.balanceTone === undefined ? undefined : `sm-tone-${model.balanceTone}`
      const costClass = model.costTone === undefined ? 'sm-pill-label' : `sm-pill-label sm-tone-${model.costTone}`
      const pillTitle = `${t('pill.title')}${model.budgetTitle === undefined ? '' : model.budgetTitle}`
      const notice = view === undefined || view === null
        ? null
        : (() => {
            try {
              return budgetNotice(view.budget, t)
            } catch (error) {
              note('notice', error)
              return null
            }
          })()
      const icon = h(
        'span',
        { className: iconClass === undefined ? 'sm-icon' : `sm-icon ${iconClass}` },
        CoinIcon(),
      )

      return h(
        'span',
        { ref: rootRef, className: 'sm-anchor', 'data-spend-meter': '' },
        h(
          'button',
          {
            type: 'button',
            className: 'sm-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': pillTitle,
            title: pillTitle,
            onClick: () => {
              setOpen(!open)
              if (!open) walletSource.refresh()
            },
          },
          icon,
          h('span', { className: costClass }, `${model.chipCost} ${t('pill.cost')}`),
          h('span', { className: 'sm-sep', 'aria-hidden': true }, '·'),
          h(
            'span',
            { className: balanceClass },
            `${t('pill.balance')} ${model.balanceLabel}`,
          ),
        ),
        model.panel === null ? null : h(PanelBoundary, null, model.panel),
        notice === null
          ? null
          : h(
              'span',
              { className: 'sm-notice', role: 'status' },
              h('span', { className: 'sm-notice-text' }, notice.text),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sm-notice-close',
                  'aria-label': t('panel.noticeDismiss'),
                  title: t('panel.noticeDismiss'),
                  onClick: () => {
                    markNotice(notice.key)
                    setNoticeRevision((previous) => previous + 1)
                  },
                },
                '×',
              ),
            ),
      )
      }

      return SpendEntry
    }

    //#endregion

    //#region apply

    function guard(label, run) {
      try {
        return run()
      } catch (error) {
        note(label, error)
        return undefined
      }
    }

    function apply(ctx) {
      localeService = ctx.locale

      guard('locale', () => {
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'spend-meter: dictionaries')
      })

      guard('styles', () => {
        ctx.effect(() => insertStyles(), 'spend-meter: styles')
      })

      const walletSource = createWalletSource(ctx)

      guard('wallet', () => {
        walletSource.refresh()
        ctx.effect(() => {
          if (typeof setInterval !== 'function') return undefined
          const handle = setInterval(() => walletSource.refresh(), 15000)
          return () => clearInterval(handle)
        }, 'spend-meter: wallet polling')
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const onVisible = () => {
            if (document.visibilityState === 'visible') walletSource.refresh()
          }
          document.addEventListener('visibilitychange', onVisible)
          return () => document.removeEventListener('visibilitychange', onVisible)
        }, 'spend-meter: wallet visibility')
      })

      guard('dock', () => {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'spend-meter', order: 2, locale: NS },
            createSpendEntry(walletSource),
          ),
        )
      })
    }

    //#endregion

    return { inject: ['slots', 'locale'], apply }
  },
})
