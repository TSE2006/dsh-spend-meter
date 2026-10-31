/**
 * Spend meter — Host half.
 *
 * Publishes the client-visible `spendMeter` session projection: the token
 * buckets of this conversation, priced with the DeepSeek tariff (peak / off-peak
 * windows in Beijing time), plus the hidden compaction cost and the billed
 * search calls. Money is computed here, on the Host, because only the Host sees
 * every event with its own timestamp; the Client just formats what it reads.
 */

export const name = 'spend-meter'

export const inject = ['sessionProjections']

/** Breadcrumb file for Host-side wiring failures (diagnostics only). */
const DIAG_PATH = 'C:/Users/30617/Desktop/Deepseek_QQ/.tmp/spend-meter-host.json'

/** Both schemas are validated with `.parse()` only, so an identity schema suffices. */
const PASS_THROUGH = { parse: (value) => value }

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Yen per million tokens. Off-peak is exactly half of the peak price. */
const FLASH_PRICE = {
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
}

const PRO_PRICE = {
  peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
}

const DEFAULT_PRICING = {
  currency: 'CNY',
  models: {
    'deepseek-flash': FLASH_PRICE,
    'deepseek-v4-flash': FLASH_PRICE,
    'deepseek-v4-flash-vision-exp': FLASH_PRICE,
    'deepseek-v4-pro': PRO_PRICE,
  },
  /** Beijing-time peak windows, in hours. Everything else is off-peak. */
  windows: [{ start: 9, end: 12 }, { start: 14, end: 18 }],
  /** China public holidays: weekdays whose whole day bills as off-peak. */
  holidays: [],
  /** Search / fetch billing: 5 CNY per 1000 successful calls. */
  searchPerCall: 0.005,
  searchFreeUntil: Date.parse('2026-11-01T00:00:00+08:00'),
  /** Keep at most this many per-turn entries; older turns fold into the total. */
  turnHistory: 120,
}

const SEARCH_TOOLS = new Set(['web_search', 'web_fetch'])

//#region numbers

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

function bucket() {
  return { miss: 0, hit: 0, write: 0, out: 0 }
}

function addBucket(target, source) {
  return {
    miss: target.miss + source.miss,
    hit: target.hit + source.hit,
    write: target.write + source.write,
    out: target.out + source.out,
  }
}

function subBucket(target, source) {
  return {
    miss: Math.max(0, target.miss - source.miss),
    hit: Math.max(0, target.hit - source.hit),
    write: Math.max(0, target.write - source.write),
    out: Math.max(0, target.out - source.out),
  }
}

const isEmptyBucket = (value) => value.miss === 0 && value.hit === 0 && value.write === 0 && value.out === 0

function bucketsFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  return {
    miss: finite(usage.inputTokens),
    hit: finite(usage.cacheReadTokens),
    write: finite(usage.cacheWriteTokens),
    out: finite(usage.outputTokens),
  }
}

const money = (value) => Math.round((Number.isFinite(value) ? value : 0) * 1e6) / 1e6

//#endregion

//#region pricing

function beijingMoment(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS)
  return {
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600,
    date: shifted.toISOString().slice(0, 10),
  }
}

function isPeak(ms, pricing) {
  const moment = beijingMoment(ms)
  if (moment.weekday === 0 || moment.weekday === 6) return false
  if (pricing.holidaySet.has(moment.date)) return false
  return pricing.windows.some((window) => moment.hour >= window.start && moment.hour < window.end)
}

function tierOf(ms, pricing) {
  return isPeak(ms, pricing) ? 'peak' : 'offPeak'
}

/** Priced sample in CNY, split by the buckets the ledger shows. */
function priceOf(buckets, model, tier, pricing) {
  const table = pricing.models[model]
  if (!table) return undefined
  const price = table[tier]
  if (!price) return undefined
  return {
    miss: ((buckets.miss + buckets.write) * price.cacheMiss) / 1e6,
    hit: (buckets.hit * price.cacheHit) / 1e6,
    out: (buckets.out * price.output) / 1e6,
    /** What the cache saved: the same hit tokens at the miss price. */
    saved: (buckets.hit * (price.cacheMiss - price.cacheHit)) / 1e6,
  }
}

//#endregion

//#region state

function emptyModel(modelKey) {
  const slash = modelKey.indexOf('/')
  return {
    provider: slash > 0 ? modelKey.slice(0, slash) : '',
    model: slash > 0 ? modelKey.slice(slash + 1) : modelKey,
    priced: false,
    tokens: bucket(),
    cost: { miss: 0, hit: 0, out: 0 },
    saved: 0,
    hidden: { count: 0, cost: 0 },
  }
}

function emptyState() {
  return {
    totals: bucket(),
    cost: { miss: 0, hit: 0, out: 0 },
    saved: 0,
    hidden: { count: 0, cost: 0 },
    models: {},
    turns: {},
    search: { calls: 0, cost: 0 },
    last: null,
  }
}

function withModel(state, modelKey, unchanged, mutate) {
  const previous = state.models[modelKey] ?? emptyModel(modelKey)
  const next = mutate({ ...previous })
  if (next === unchanged) return state
  return { ...state, models: { ...state.models, [modelKey]: next } }
}

function describeSource(event) {
  const source = event?.data?.message?.source
  if (source && source.kind === 'model' && typeof source.model === 'string') {
    const provider = typeof source.provider === 'string' ? source.provider : ''
    return { modelKey: `${provider}/${source.model}`, model: source.model, provider }
  }
  return undefined
}

function usageOf(event) {
  const direct = event?.data?.usage
  if (direct && typeof direct === 'object') return direct
  const stream = event?.data?.stream
  if (Array.isArray(stream)) {
    for (let index = stream.length - 1; index >= 0; index -= 1) {
      const chunk = stream[index]
      if (chunk && chunk.type === 'usage' && chunk.usage) return chunk.usage
    }
  }
  return undefined
}

//#endregion

//#region fold

function applySample(state, pricing, sample, previous) {
  const priced = priceOf(sample.buckets, sample.model, sample.tier, pricing)
  let next = state

  if (previous) {
    next = {
      ...next,
      totals: subBucket(next.totals, previous.buckets),
      saved: Math.max(0, next.saved - (previous.price?.saved ?? 0)),
      cost: {
        miss: Math.max(0, next.cost.miss - (previous.price?.miss ?? 0)),
        hit: Math.max(0, next.cost.hit - (previous.price?.hit ?? 0)),
        out: Math.max(0, next.cost.out - (previous.price?.out ?? 0)),
      },
      turns: previous.turn === undefined
        ? next.turns
        : {
            ...next.turns,
            [previous.turn]: Math.max(
              0,
              (next.turns[previous.turn] ?? 0)
                - ((previous.price?.miss ?? 0) + (previous.price?.hit ?? 0) + (previous.price?.out ?? 0)),
            ),
          },
    }
    next = withModel(next, previous.modelKey, previous.model, (model) => {
      const tokens = subBucket(model.tokens, previous.buckets)
      const price = previous.price
      if (!price) {
        return { ...model, tokens }
      }
      return {
        ...model,
        tokens,
        saved: Math.max(0, model.saved - price.saved),
        cost: {
          miss: Math.max(0, model.cost.miss - price.miss),
          hit: Math.max(0, model.cost.hit - price.hit),
          out: Math.max(0, model.cost.out - price.out),
        },
      }
    })
  }

  next = { ...next, totals: addBucket(next.totals, sample.buckets) }
  if (priced) {
    next = {
      ...next,
      saved: next.saved + priced.saved,
      cost: {
        miss: next.cost.miss + priced.miss,
        hit: next.cost.hit + priced.hit,
        out: next.cost.out + priced.out,
      },
    }
  }
  if (sample.turn !== undefined) {
    const amount = priced ? priced.miss + priced.hit + priced.out : 0
    next = { ...next, turns: { ...next.turns, [sample.turn]: (next.turns[sample.turn] ?? 0) + amount } }
  }
  next = withModel(next, sample.modelKey, sample.model, (model) => {
    const updated = { ...model, tokens: addBucket(model.tokens, sample.buckets) }
    if (!priced) return updated
    return {
      ...updated,
      priced: true,
      saved: updated.saved + priced.saved,
      cost: {
        miss: updated.cost.miss + priced.miss,
        hit: updated.cost.hit + priced.hit,
        out: updated.cost.out + priced.out,
      },
    }
  })
  return { ...next, last: sample }
}

function applyUsage(state, event, pricing) {
  const usage = usageOf(event)
  const buckets = bucketsFromUsage(usage)
  if (!buckets || isEmptyBucket(buckets)) return state

  const source = describeSource(event)
  const modelKey = source?.modelKey ?? state.last?.modelKey ?? 'unknown/unknown'
  const model = source?.model ?? state.last?.model ?? 'unknown'
  const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
  const step = typeof event.data?.step === 'number' ? event.data.step : undefined
  const tier = tierOf(event.time, pricing)

  const previous = state.last && state.last.turn === turn && state.last.step === step ? state.last : undefined
  const sample = {
    modelKey,
    model,
    provider: source?.provider ?? '',
    turn,
    step,
    tier,
    buckets,
    price: priceOf(buckets, model, tier, pricing),
  }
  return applySample(state, pricing, sample, previous)
}

function applyCompaction(state, event, pricing) {
  const buckets = bucketsFromUsage(event.data?.usage)
  if (!buckets || isEmptyBucket(buckets)) return state

  const model = typeof event.data?.model === 'string' ? event.data.model : 'unknown'
  const provider = typeof event.data?.provider === 'string' ? event.data.provider : ''
  const modelKey = `${provider}/${model}`
  const tier = tierOf(event.time, pricing)
  const priced = priceOf(buckets, model, tier, pricing)
  const amount = priced ? priced.miss + priced.hit + priced.out : 0

  const next = withModel(state, modelKey, undefined, (entry) => ({
    ...entry,
    tokens: addBucket(entry.tokens, buckets),
    priced: entry.priced || priced !== undefined,
    hidden: { count: entry.hidden.count + 1, cost: entry.hidden.cost + amount },
  }))
  return {
    ...next,
    hidden: { count: next.hidden.count + 1, cost: next.hidden.cost + amount },
  }
}

function applyToolCall(state, event, pricing) {
  const toolName = event.data?.name
  if (typeof toolName !== 'string' || !SEARCH_TOOLS.has(toolName)) return state
  if (typeof event.time === 'number' && event.time < pricing.searchFreeUntil) return state
  const amount = pricing.searchPerCall
  return {
    ...state,
    search: { calls: state.search.calls + 1, cost: state.search.cost + amount },
  }
}

//#endregion

//#region view

function summarise(state, pricing, wallet) {
  const models = []
  for (const [modelKey, entry] of Object.entries(state.models)) {
    const total = entry.cost.miss + entry.cost.hit + entry.cost.out
    models.push({
      id: modelKey,
      provider: entry.provider,
      model: entry.model,
      priced: entry.priced,
      tokens: entry.tokens,
      cost: money(total),
      saved: money(entry.saved),
      hidden: { count: entry.hidden.count, cost: money(entry.hidden.cost) },
    })
  }
  models.sort((left, right) => right.cost - left.cost)

  const turns = Object.entries(state.turns)
    .map(([turn, cost]) => ({ turn: Number(turn), cost: money(cost) }))
    .filter((entry) => Number.isFinite(entry.turn))
    .sort((left, right) => left.turn - right.turn)

  const kept = turns.length > pricing.turnHistory ? turns.slice(-pricing.turnHistory) : turns
  const total = state.cost.miss + state.cost.hit + state.cost.out + state.hidden.cost + state.search.cost

  return {
    currency: pricing.currency,
    totals: state.totals,
    cost: {
      miss: money(state.cost.miss),
      hit: money(state.cost.hit),
      out: money(state.cost.out),
      hidden: money(state.hidden.cost),
      search: money(state.search.cost),
      total: money(total),
    },
    saved: money(state.saved),
    withoutCache: money(total + state.saved),
    hidden: { count: state.hidden.count, cost: money(state.hidden.cost) },
    search: { calls: state.search.calls, cost: money(state.search.cost) },
    models,
    unpriced: models.filter((entry) => !entry.priced).map((entry) => entry.id),
    turns: kept,
    turnCount: turns.length,
    wallet: wallet ?? { status: 'loading' },
    pricing: {
      windows: pricing.windows,
      holidays: [...pricing.holidaySet],
      searchPerCall: pricing.searchPerCall,
      currency: pricing.currency,
    },
  }
}

//#endregion

/** Merge the row config over the built-in tariff. */
function resolvePricing(config) {
  const source = config && typeof config === 'object' ? config : {}
  const models = { ...DEFAULT_PRICING.models }
  if (source.models && typeof source.models === 'object') {
    for (const [model, table] of Object.entries(source.models)) {
      if (table && typeof table === 'object' && table.peak && table.offPeak) models[model] = table
    }
  }
  const windows = Array.isArray(source.windows) && source.windows.length > 0 ? source.windows : DEFAULT_PRICING.windows
  const holidays = Array.isArray(source.holidays) ? source.holidays : DEFAULT_PRICING.holidays
  return {
    currency: typeof source.currency === 'string' ? source.currency : DEFAULT_PRICING.currency,
    models,
    windows,
    holidays,
    holidaySet: new Set(holidays.filter((day) => typeof day === 'string')),
    searchPerCall: Number.isFinite(source.searchPerCall) ? source.searchPerCall : DEFAULT_PRICING.searchPerCall,
    searchFreeUntil: Number.isFinite(source.searchFreeUntil) ? source.searchFreeUntil : DEFAULT_PRICING.searchFreeUntil,
    turnHistory: Number.isFinite(source.turnHistory) ? source.turnHistory : DEFAULT_PRICING.turnHistory,
  }
}

export function apply(ctx, config) {
  const diag = {
    at: new Date().toISOString(),
    stage: 'start',
    register: null,
    service: null,
    hasGetter: typeof ctx?.get === 'function',
    error: null,
  }

  /** Host-side breadcrumb, so a failed wiring step is visible without a debugger. */
  const reportDiag = (payload) => {
    try {
      import('node:fs')
        .then((fs) => {
          try {
            fs.writeFileSync(DIAG_PATH, JSON.stringify(payload, null, 2))
          } catch {
            // diagnostics are best effort
          }
        })
        .catch(() => {})
    } catch {
      // diagnostics are best effort
    }
  }

  // A Host half that throws during apply fails its Cordis entry; keep the failure
  // local so a pricing or projection defect costs the meter, never the app.
  try {
    const pricing = resolvePricing(config)

    // The wallet is Host state: the Client reads it through the projection view
    // instead of making a Remote call of its own.
    let wallet = { status: 'loading' }
    const readService = (name) => {
      try {
        if (typeof ctx.get === 'function') {
          const found = ctx.get(name)
          if (found) return found
        }
      } catch {
        // an un-injected property throws; the store read above is the safe path
      }
      try {
        return ctx[name]
      } catch {
        return undefined
      }
    }
    const normaliseWallet = (balance) => {
      if (balance === null) return { status: 'signed-out' }
      if (!balance || balance.status !== 'ready') {
        return { status: 'failed', reason: balance && balance.status ? `status=${balance.status}` : 'no balance' }
      }
      const rows = (list) =>
        (Array.isArray(list) ? list : [])
          .filter((entry) => entry && typeof entry.currency === 'string')
          .map((entry) => ({ currency: entry.currency, balance: String(entry.balance) }))
      return { status: 'ready', wallets: rows(balance.value), bonus: rows(balance.bonusWallets) }
    }
    const readWallet = () => {
      try {
        const account = readService('deepseekAccount')
        if (!account || typeof account.getBalance !== 'function') {
          wallet = { status: 'unsupported', reason: 'no account service' }
          return
        }
        Promise.resolve(
          account.getBalance({
            version: '0.2.1-rc.5',
            locale: 'zh',
            timezoneOffsetSeconds: 8 * 60 * 60,
          }),
        )
          .then((balance) => {
            wallet = normaliseWallet(balance)
          })
          .catch((error) => {
            wallet = { status: 'failed', reason: String((error && error.message) || error) }
          })
      } catch (error) {
        wallet = { status: 'failed', reason: String((error && error.message) || error) }
      }
    }

    const definition = {
      key: 'spendMeter',
      version: 1,
      stateVersion: 1,
      stateSchema: PASS_THROUGH,
      init: () => emptyState(),
      apply(state, event) {
        if (!event || typeof event !== 'object') return state
        diag.applyCalls = (diag.applyCalls ?? 0) + 1
        diag.lastEvent = event.type
        switch (event.type) {
          case 'llm/retry-started': {
            if (!state.last) return state
            const turn = event.data?.turn
            const step = event.data?.step
            if (state.last.turn === turn && state.last.step === step) return { ...state, last: null }
            return state
          }
          case 'assistant/message':
          case 'assistant/attempt':
            return applyUsage(state, event, pricing)
          case 'compaction/summary':
            return applyCompaction(state, event, pricing)
          case 'tool/call':
            return applyToolCall(state, event, pricing)
          default:
            return state
        }
      },
      wire: {
        viewSchema: PASS_THROUGH,
        view: (state) => {
          diag.viewCalls = (diag.viewCalls ?? 0) + 1
          diag.wallet = wallet
          const now = Date.now()
          if (diag.writtenAt === undefined || now - diag.writtenAt > 800) {
            diag.writtenAt = now
            reportDiag(diag)
          }
          return summarise(state, pricing, wallet)
        },
      },
    }

    const projections = ctx.sessionProjections ?? ctx.get?.('sessionProjections')
    diag.service = projections ? typeof projections.register : 'absent'
    if (!projections || typeof projections.register !== 'function') {
      diag.stage = 'no-service'
      reportDiag(diag)
      return
    }

    try {
      ctx.effect(() => projections.register(definition), 'spend-meter: projection')
      diag.register = 'ok'
    } catch (error) {
      diag.register = 'threw'
      diag.error = String((error && error.stack) || error)
    }

    diag.stage = 'done'
    reportDiag(diag)

    // Keep the wallet fresh: one read now, then one a minute while the row lives.
    try {
      readWallet()
      ctx.effect(() => {
        const handle = setInterval(readWallet, 60000)
        if (handle && typeof handle.unref === 'function') handle.unref()
        return () => clearInterval(handle)
      }, 'spend-meter: wallet polling')
    } catch (error) {
      diag.walletPolling = String((error && error.message) || error)
      reportDiag(diag)
    }
  } catch (error) {
    diag.stage = 'failed'
    diag.error = String((error && error.stack) || error)
    reportDiag(diag)
    console.error('[spend-meter] apply failed:', error)
  }
}
