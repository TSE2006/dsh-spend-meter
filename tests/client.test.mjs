// Client-half tests: the bundle is loaded exactly the way the Web kernel loads
// it, then the dock cell is rendered with mock slot props. This catches module
// body, factory, registration, dictionary and render errors without a browser.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../client.js', import.meta.url)

/** Timers the plugin starts must not keep the test process alive. */
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const stubTimers = () => {
  globalThis.setInterval = (fn, ms) => ({ fn, ms, unref() {} })
  globalThis.clearInterval = () => {}
}
const restoreTimers = () => {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}

/** A minimal React stand-in: hooks keep their slots across renders. */
const createReact = () => {
  const stateSlots = new Map()
  let renderIndex = 0

  class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }

    render() {
      return null
    }
  }
  Component.getDerivedStateFromError = () => ({ failed: true })

  const childrenOf = (children) => (children.length === 0 ? undefined : children.length === 1 ? children[0] : children)

  return {
    instance: {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...props, ...(children.length === 0 ? {} : { children: childrenOf(children) }) },
        // React flattens nested child arrays; a chart built with .map() relies on it.
        children: children.flat(Infinity),
      }),
      Component,
      Fragment: 'Fragment',
      useState: (initial) => {
        const slot = renderIndex++
        if (!stateSlots.has(slot)) stateSlots.set(slot, typeof initial === 'function' ? initial() : initial)
        return [
          stateSlots.get(slot),
          (next) => stateSlots.set(slot, typeof next === 'function' ? next(stateSlots.get(slot)) : next),
        ]
      },
      useRef: (initial) => ({ current: initial }),
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useEffect: () => {},
      useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    },
    /** Restart hook numbering so a render sees the same slots as the one before. */
    beginRender: () => { renderIndex = 0 },
  }
}

const isClassComponent = (type) => typeof type === 'function' && type.prototype?.render

const flatText = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatText).join('')
  if (typeof node.type === 'function' && !isClassComponent(node.type)) {
    return flatText(node.type(node.props ?? {}))
  }
  return flatText(node.children)
}

const findByClass = (node, className, found = []) => {
  if (!node || typeof node !== 'object') return found
  const own = node.props?.className
  if (typeof own === 'string' && own.includes(className)) found.push(node)
  for (const child of node.children ?? []) findByClass(child, className, found)
  return found
}

const findByType = (node, type, found = []) => {
  if (!node || typeof node !== 'object') return found
  if (node.type === type) found.push(node)
  for (const child of node.children ?? []) findByType(child, type, found)
  return found
}

const projection = () => ({
  currency: 'CNY',
  totals: { miss: 1200, hit: 500000, write: 0, out: 3400 },
  cost: { miss: 0.0024, hit: 0.01, out: 0.0272, hidden: 0.28, search: 0.01, total: 0.3296 },
  saved: 0.49,
  withoutCache: 0.5,
  hidden: {
    count: 1,
    cost: 0.28,
    byModel: [{ id: 'deepseek-official/deepseek-flash', count: 1, cost: 0.28 }],
  },
  search: {
    calls: 2,
    cost: 0.01,
    byTool: [
      { tool: 'web_search', calls: 1, cost: 0.005 },
      { tool: 'web_fetch', calls: 1, cost: 0.005 },
    ],
  },
  models: [
    {
      id: 'deepseek-official/deepseek-flash',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      priced: true,
      estimated: false,
      tokens: { miss: 1200, hit: 500000, write: 0, out: 3400 },
      cost: 0.3296,
      saved: 0.49,
    },
    {
      id: 'deepseek-account/deepseek-flash',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      priced: true,
      estimated: false,
      tokens: { miss: 10, hit: 0, write: 0, out: 10 },
      cost: 0.0001,
      saved: 0,
    },
  ],
  unpriced: [],
  estimated: [],
  turns: Array.from({ length: 11 }, (_, index) => ({ turn: index + 1, cost: 0.1 + index / 100 })),
  turnCount: 11,
  budget: {
    currency: 'CNY',
    warnRatio: 0.8,
    since: '2026-10-31T07:00:00.000Z',
    today: '2026-11-01',
    day: { limit: 5, spent: 4.2, ratio: 0.84 },
    month: { limit: 100, spent: 12.5, ratio: 0.125 },
  },
})

/** Boot the bundle against a fake kernel and return everything the tests need. */
const boot = async () => {
  const react = createReact()
  const modules = { react: react.instance }
  const context = {
    registrations: [],
    effect: (fn) => fn(),
    on: () => {},
    get: (name) => (name === 'remote'
      ? {
          account: {
            getBalance: async () => ({
              ok: true,
              value: {
                status: 'ready',
                value: [{ currency: 'CNY', balance: '12.34' }],
                bonusWallets: [{ currency: 'CNY', balance: '3.00' }],
              },
            }),
          },
        }
      : undefined),
    locale: {
      register: (ns, dictionaries) => { context.registered = { ns, dictionaries } },
      getSnapshot: () => ({ active: 'zh' }),
      bind: () => (key) => key,
    },
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => {
        context.registrations.push({ options, component })
        return () => {}
      },
    },
  }

  const document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    head: { appendChild: () => {} },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
  }

  let loaded
  const storage = createStorage()
  const copied = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { copied.push(text) } } },
  })
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { loaded = definition } },
    localStorage: storage,
  }
  globalThis.document = document

  await import(`${BUNDLE.href}?t=${Math.random()}`)
  assert.ok(loaded, 'the bundle must call __ModuleLoader__.load')
  const plugin = loaded.factory((specifier) => {
    assert.ok(specifier in modules, `unexpected require(${specifier})`)
    return modules[specifier]
  })
  await plugin.apply(context)
  return { plugin, context, react, storage, copied }
}

/** A minimal localStorage stand-in; the banner keys live in it. */
function createStorage() {
  const entries = new Map()
  return {
    entries,
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => { entries.set(key, String(value)) },
    removeItem: (key) => { entries.delete(key) },
  }
}

const translateWith = (context) => (key, params) => {
  const template = context.registered.dictionaries.zh[key] ?? `!!${key}`
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}

stubTimers()
test.after(() => {
  restoreTimers()
  delete globalThis.window
  delete globalThis.document
})

test('the bundle registers its dictionary and one dock cell', async () => {
  const { plugin, context } = await boot()

  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(context.registered.ns, 'spend-meter')
  assert.deepEqual(Object.keys(context.registered.dictionaries).sort(), ['en', 'zh'])

  assert.equal(context.registrations.length, 1)
  assert.deepEqual(context.registrations[0].options, {
    name: 'conversation.composer.dock',
    id: 'spend-meter',
    order: 2,
    locale: 'spend-meter',
  })
})

test('the dock cell renders the figure, the ledger and the budget', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  const { component } = context.registrations[0]
  const render = () => {
    react.beginRender()
    return component({ t: translate, useProjection: (key) => (key === 'spendMeter' ? view : undefined) })
  }

  const closed = render()
  assert.match(flatText(closed), /¥0\.330/)

  closed.children[0].props.onClick()
  const opened = render()
  const panel = opened.children[1]
  const text = flatText(panel)

  assert.match(text, /本对话花费/)
  assert.match(text, /缓存命中已省下/)
  // two models share a name, so both rows are qualified with their provider
  assert.match(text, /deepseek-official\/deepseek-flash/)
  assert.match(text, /deepseek-account\/deepseek-flash/)
  // budget rows carry their percentage and the limit
  assert.match(text, /84%/)
  assert.match(text, /¥4\.20 \/ ¥5\.00/)
  // only the latest eight turns are listed until the list is expanded
  assert.equal((text.match(/T\d+/g) ?? []).length, 8)
  assert.match(text, /展开更早 3 轮/)

  const [more] = findByClass(panel, 'sm-more')
  assert.ok(more, 'an expand control must exist')
  more.props.onClick()
  const expanded = flatText(render().children[1])
  assert.equal((expanded.match(/T\d+/g) ?? []).length, 11)
  assert.match(expanded, /收起/)
})

test('the platform links ask Electron to open a real browser', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  const { component } = context.registrations[0]
  react.beginRender()
  const closed = component({ t: translate, useProjection: () => view })
  closed.children[0].props.onClick()
  react.beginRender()
  const panel = component({ t: translate, useProjection: () => view })

  const anchors = findByType(panel, 'a')
  assert.deepEqual(anchors.map((anchor) => anchor.props.href), [
    'https://platform.deepseek.com/usage',
    'https://platform.deepseek.com/top_up',
  ])
  for (const anchor of anchors) assert.equal(typeof anchor.props.onClick, 'function')
})

test('crossing the budget turns the figure red', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  view.budget.day = { limit: 5, spent: 6.1, ratio: 1.22 }
  const { component } = context.registrations[0]
  react.beginRender()
  const closed = component({ t: translate, useProjection: () => view })
  const [label] = findByClass(closed, 'sm-pill-label')
  assert.match(label.props.className, /sm-tone-danger/)

  closed.children[0].props.onClick()
  react.beginRender()
  const opened = component({ t: translate, useProjection: () => view })
  assert.match(flatText(opened.children[1]), /今日预算已用完/)
})

test('without a budget the figure keeps its own colour', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  view.budget = null
  const { component } = context.registrations[0]
  react.beginRender()
  const closed = component({ t: translate, useProjection: () => view })
  const [label] = findByClass(closed, 'sm-pill-label')
  assert.equal(label.props.className, 'sm-pill-label')
})

test('an exhausted budget raises one banner that stays dismissed', async () => {
  const { context, react, storage } = await boot()
  const translate = translateWith(context)
  const view = projection()
  view.budget.day = { limit: 5, spent: 6.1, ratio: 1.22 }
  const { component } = context.registrations[0]
  const render = () => {
    react.beginRender()
    return component({ t: translate, useProjection: () => view })
  }

  const closed = render()
  const [notice] = findByClass(closed, 'sm-notice')
  assert.ok(notice, 'the banner must appear next to the pill')
  const text = flatText(notice)
  assert.match(text, /今日预算已用完/)
  assert.match(text, /¥6\.10 \/ ¥5\.00/)

  const [close] = findByClass(notice, 'sm-notice-close')
  assert.equal(close.props['aria-label'], '关闭')
  close.props.onClick()

  assert.equal(findByClass(render(), 'sm-notice').length, 0, 'the banner must go away')
  assert.match(String(storage.getItem('spend-meter:notices')), /day:/)
})

test('the panel says which tariff priced the figures', async () => {
  // A fresh boot per case: the pill remembers whether it is open.
  const panelText = async (pricing) => {
    const { context, react } = await boot()
    const translate = translateWith(context)
    const view = projection()
    if (pricing !== undefined) view.pricing = pricing
    const { component } = context.registrations[0]
    react.beginRender()
    component({ t: translate, useProjection: () => view }).children[0].props.onClick()
    react.beginRender()
    return flatText(component({ t: translate, useProjection: () => view }).children[1])
  }

  // the built-in table is the default and stays unannounced
  assert.doesNotMatch(await panelText(undefined), /价目表/)

  const remote = await panelText({ source: 'remote', updatedAt: '2026-11-02T00:00:00.000Z', fetchedAt: '2026-11-02T01:00:00.000Z', error: null })
  assert.match(remote, /价目表：2026-11-02 更新/)

  const cache = await panelText({ source: 'cache', updatedAt: '2026-11-01T00:00:00.000Z', fetchedAt: '2026-11-02T01:00:00.000Z', error: null })
  assert.match(cache, /价目表：2026-11-01 更新/)

  const broken = await panelText({ source: 'builtin', updatedAt: null, fetchedAt: null, error: 'status=404' })
  assert.match(broken, /价目表更新失败：status=404/)
})

test('the turns-left figure follows whichever runs out first', async () => {
  // One boot per case: the pill remembers whether it is open.
  const panelText = async (view) => {
    const { context, react } = await boot()
    const translate = translateWith(context)
    const { component } = context.registrations[0]
    // let the wallet refresh that apply() kicked off settle
    await new Promise((resolve) => setTimeout(resolve, 0))
    react.beginRender()
    component({ t: translate, useProjection: () => view }).children[0].props.onClick()
    react.beginRender()
    return flatText(component({ t: translate, useProjection: () => view }).children[1])
  }

  // The average turn is about ¥0.15 and the wallet holds ¥15.34, so the wallet
  // alone would promise ~102 turns — today's budget leaves only ¥0.80.
  const tight = projection()
  assert.match(await panelText(tight), /今日预算内还能聊约 5 轮/)

  // Raise the limits above the wallet and the wallet becomes the limit again.
  const roomy = projection()
  roomy.budget = {
    ...roomy.budget,
    day: { limit: 1000, spent: 4.2, ratio: 0.0042 },
    month: { limit: 10000, spent: 12.5, ratio: 0.00125 },
  }
  assert.match(await panelText(roomy), /按当前速度还能聊约 102 轮/)
})

test('each line shows the rate it was charged at', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  const { component } = context.registrations[0]
  react.beginRender()
  component({ t: translate, useProjection: () => view }).children[0].props.onClick()
  react.beginRender()
  const panel = component({ t: translate, useProjection: () => view }).children[1]

  const text = flatText(panel)
  // 1200 uncached tokens for ¥0.0024 is ¥2.00 per million; 500k cached for ¥0.01 is ¥0.02
  assert.match(text, /1\.2k × ¥2\.00\/M/)
  assert.match(text, /500\.0k × ¥0\.020\/M/)
  assert.match(text, /3\.4k × ¥8\.00\/M/)
})

test('the search and compaction lines name what paid for them', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  const { component } = context.registrations[0]
  react.beginRender()
  component({ t: translate, useProjection: () => view }).children[0].props.onClick()
  react.beginRender()
  const text = flatText(component({ t: translate, useProjection: () => view }).children[1])

  assert.match(text, /联网搜索：web_search 1 · ¥0\.0050\s+web_fetch 1 · ¥0\.0050/)
  assert.match(text, /自动压缩摘要：deepseek-official\/deepseek-flash 1 · ¥0\.280/)
})

test('the ledger copies out as CSV and as Markdown', async () => {
  const { context, react, copied } = await boot()
  const translate = translateWith(context)
  const view = projection()
  const { component } = context.registrations[0]
  react.beginRender()
  component({ t: translate, useProjection: () => view }).children[0].props.onClick()
  react.beginRender()

  const open1 = component({ t: translate, useProjection: () => view }).children[1]
  const buttons = findByType(open1, 'button')
  const csvButton = buttons.find((node) => node.props.title === '复制 CSV')
  const mdButton = buttons.find((node) => node.props.title === '复制 Markdown')
  assert.ok(csvButton, 'the popover must offer a CSV copy')
  assert.ok(mdButton, 'the popover must offer a Markdown copy')

  csvButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(copied[0], /^section,item,value,unit\n/)
  assert.match(copied[0], /cost,合计,0\.3296,CNY/)

  mdButton.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(copied[1], /^### 本对话花费 ¥0\.330/)
  assert.match(copied[1], /- 联网搜索: ¥0\.010/)
})

test('the panel charts the last two weeks and this week’s total', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  view.history = {
    currency: 'CNY',
    today: '2026-11-14',
    trend: Array.from({ length: 14 }, (_, index) => ({
      date: `2026-11-${String(index + 1).padStart(2, '0')}`,
      // a flat week followed by a spike on the last day
      cost: index === 13 ? 3.2 : 0.1,
    })),
    week: { start: '2026-11-09', spent: 3.5 },
  }
  const { component } = context.registrations[0]
  react.beginRender()
  component({ t: translate, useProjection: () => view }).children[0].props.onClick()
  react.beginRender()
  const panel = component({ t: translate, useProjection: () => view }).children[1]

  const text = flatText(panel)
  assert.match(text, /近期/)
  assert.match(text, /本周 ¥3\.50/)

  const [trend] = findByClass(panel, 'sm-trend')
  assert.ok(trend, 'the chart must render')
  assert.equal(trend.children.length, 14)
  assert.equal(trend.children.filter((bar) => String(bar.props.className).includes('sm-bar-today')).length, 1)
  // the spike is the tallest bar, and every bar carries its own tooltip
  assert.equal(trend.children[13].props.style.height, '100%')
  assert.match(trend.children[0].props.title, /^2026-11-01 ¥0\.100$/)
})

test('without history the chart is left out', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const view = projection()
  const { component } = context.registrations[0]
  react.beginRender()
  component({ t: translate, useProjection: () => view }).children[0].props.onClick()
  react.beginRender()
  const panel = component({ t: translate, useProjection: () => view }).children[1]
  assert.equal(findByClass(panel, 'sm-trend').length, 0)
})

test('a broken projection degrades to a dash instead of throwing', async () => {
  const { context, react } = await boot()
  const translate = translateWith(context)
  const exploding = {
    get budget() {
      throw new Error('boom')
    },
  }
  const { component } = context.registrations[0]
  react.beginRender()
  const closed = component({ t: translate, useProjection: () => exploding })
  assert.match(flatText(closed), /—/)
})

test('the bundle stays within the module contract the kernel expects', () => {
  const source = readFileSync(BUNDLE, 'utf8')
  assert.match(source, /__ModuleLoader__\.load\(/)
  assert.doesNotMatch(source, /\bimport\s+[^(]/, 'client bundles cannot use static imports')
})