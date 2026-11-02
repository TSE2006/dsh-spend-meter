#!/usr/bin/env node
/**
 * Cold-start smoke check.
 *
 * The desktop app treats "one entry did not activate" as fatal, so a plugin that
 * throws while loading takes the whole window with it. This script loads both
 * halves in a fresh process the way a cold start would — no dev server, no HMR,
 * no session baseline — and fails loudly on anything that would break that load:
 *
 *   - the shipped files promised by package.json are actually there,
 *   - the price table and the locale files parse,
 *   - index.js applies to a bare kernel and registers its projection,
 *   - client.js loads, registers one dock cell and renders before any data arrives,
 *   - every `t('…')` key in the client exists in both dictionaries.
 *
 * Run it with `npm run smoke` (also part of CI).
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const checks = []

const check = async (name, run) => {
  try {
    await run()
    checks.push(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}\n     ${String(error.message).split('\n').join('\n     ')}`)
  }
}

const read = (relative) => readFileSync(join(root, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))

/** Nothing here may keep the process alive: the plugin polls with real timers. */
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

const dictionaries = {}
const registrations = []
let hostDefinition
let clientDefinition

const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...props, ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
    children: children.flat(Infinity),
  }),
  Component: class {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  },
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
fakeReact.Component.getDerivedStateFromError = () => ({ failed: true })

const kernel = {
  effect: (run) => (typeof run === 'function' ? run() : undefined),
  on: () => {},
  get: () => undefined,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  timer: { interval: () => () => {}, timeout: () => () => {} },
  locale: {
    register: (namespace, table) => { dictionaries[namespace] = table },
    getSnapshot: () => ({ active: 'en' }),
    bind: () => (key) => key,
  },
  slots: {
    inject: (slot, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  sessionProjections: {
    register: (value) => { hostDefinition = value; return () => {} },
    onChanged: () => () => {},
  },
  remote: {},
}

globalThis.window = {
  __ModuleLoader__: { load: (value) => { clientDefinition = value } },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', style: {}, setAttribute: () => {} }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {}, removeChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}

await check('package.json ships files that exist', () => {
  assert.equal(manifest.name, '@local/spend-meter', 'the bundle id must stay stable')
  assert.equal(manifest.type, 'module', 'the Host half is ESM')
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(existsSync(join(root, manifest.dsh.bundle.patch)), 'the patch file must exist')
  for (const entry of manifest.files) {
    assert.ok(existsSync(join(root, entry)) || entry.includes('*'), `${entry} is listed but missing`)
  }
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'pricing.json', 'locale/en.json', 'locale/zh.json']) {
    const shipped = manifest.files.some((file) => (file.includes('*')
      ? entry.startsWith(file.split('*')[0])
      : file === entry))
    assert.ok(shipped, `${entry} must be shipped`)
  }
})

await check('the published price table has both tiers for every model', () => {
  const table = JSON.parse(read('pricing.json'))
  assert.match(table.updatedAt, /^\d{4}-\d{2}-\d{2}$/, 'updatedAt must be a date')
  const entries = Object.entries(table.models ?? {})
  assert.ok(entries.length > 0, 'at least one model must be listed')
  for (const [model, tiers] of entries) {
    for (const tier of ['peak', 'offPeak']) {
      const price = tiers[tier]
      assert.ok(price, `${model} has no ${tier} tier`)
      for (const field of ['cacheHit', 'cacheMiss', 'output']) {
        assert.ok(Number.isFinite(price[field]) && price[field] >= 0, `${model}.${tier}.${field} must be a number`)
      }
    }
  }
})

await check('locale files parse and carry a title', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const parsed = JSON.parse(read(file))
    assert.ok(parsed.meta?.title, `${file} needs meta.title`)
    assert.ok(parsed.meta?.description, `${file} needs meta.description`)
  }
})

await check('index.js applies to a bare kernel', async () => {
  const module = await import(pathToFileURL(join(root, 'index.js')).href)
  assert.equal(typeof module.apply, 'function', 'the package must export apply')
  // autoPricing:false keeps the check offline; a bare kernel has no network needs.
  await module.apply(kernel, { autoPricing: false })
  assert.ok(hostDefinition && hostDefinition.key === 'spendMeter', 'apply must register the projection')
})

await check('client.js loads and registers one dock cell', async () => {
  await import(`${pathToFileURL(join(root, 'client.js')).href}?smoke=${Date.now()}`)
  assert.ok(clientDefinition, 'client.js must call __ModuleLoader__.load')
  assert.equal(clientDefinition.id, manifest.name, 'the module id must match the package name')
  const plugin = clientDefinition.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require(${specifier})`)
  })
  await plugin.apply(kernel)
  assert.equal(registrations.length, 1, 'exactly one slot registration')
  assert.equal(registrations[0].options.id, 'spend-meter')
  assert.equal(registrations[0].options.name, 'conversation.composer.dock')
  assert.ok(dictionaries[registrations[0].options.locale], 'the cell must declare a registered namespace')
})

await check('the client cell renders before the first projection arrives', () => {
  const { options, component } = registrations[0]
  const injected = typeof options.inject === 'function' ? options.inject() : {}
  const tree = component({ t: (key) => key, ...(injected.hooks ?? {}), useProjection: () => undefined })
  assert.ok(tree, 'the cell must render with no projection')
  assert.equal(tree.type, 'span', 'the cell renders an inline anchor')
})

await check('every t(…) key in the client exists in both dictionaries', () => {
  const source = read('client.js')
  const keys = new Set()
  for (const match of source.matchAll(/\bt\(\s*'([^'\\]+)'/g)) keys.add(match[1])
  const table = dictionaries[registrations[0]?.options.locale] ?? Object.values(dictionaries)[0]
  assert.ok(table?.en && table?.zh, 'both dictionaries must be registered')
  const missing = []
  for (const key of keys) {
    if (!(key in table.en)) missing.push(`en.${key}`)
    if (!(key in table.zh)) missing.push(`zh.${key}`)
  }
  assert.deepEqual(missing, [], `missing translation keys: ${missing.join(', ')}`)
})

for (const line of checks) console.log(line)
if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed:\n`)
  for (const failure of failures) console.error(` - ${failure}\n`)
  process.exitCode = 1
} else {
  console.log(`\n${checks.length} checks passed.`)
}
