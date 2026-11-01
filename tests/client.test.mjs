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
        children,
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
  hidden: { count: 1, cost: 0.28 },
  search: { calls: 2, cost: 0.01 },
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
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  globalThis.document = document

  await import(`${BUNDLE.href}?t=${Math.random()}`)
  assert.ok(loaded, 'the bundle must call __ModuleLoader__.load')
  const plugin = loaded.factory((specifier) => {
    assert.ok(specifier in modules, `unexpected require(${specifier})`)
    return modules[specifier]
  })
  await plugin.apply(context)
  return { plugin, context, react }
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