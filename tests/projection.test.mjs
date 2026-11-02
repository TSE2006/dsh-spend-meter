// Host-half tests: the projection is driven with the same event shapes DSH
// writes to a session log, and every money figure it produces is asserted.
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, normaliseModelMap, resolvePricing } from '../index.js'

const OFF_PEAK = Date.parse('2026-10-31T20:00:00+08:00') // Saturday
const PEAK = Date.parse('2026-11-03T10:00:00+08:00') // Tuesday 10:00
const HOLIDAY = Date.parse('2026-11-02T10:00:00+08:00') // a Monday listed as a holiday

/** Register a projection with a throwaway context and hand back its definition. */
const install = (config) => {
  let definition
  apply(
    {
      sessionProjections: { register: (def) => { definition = def; return () => {} } },
      effect: (fn) => fn(),
      get: () => undefined,
    },
    // Tests never touch the network: the published table stays off unless a
    // test opts in by inspecting the resolver directly.
    { autoPricing: false, ...config },
  )
  assert.ok(definition, 'the projection must register synchronously')
  return definition
}

const sample = (options) => ({
  type: 'assistant/message',
  time: options.time,
  data: {
    turn: options.turn ?? 1,
    step: options.step ?? 1,
    message: { source: { kind: 'model', provider: options.provider ?? 'deepseek-official', model: options.model } },
    ...(options.stream === undefined ? { usage: options.usage } : { stream: [{ type: 'usage', usage: options.stream }] }),
  },
})

const viewOf = (definition, events, header) => {
  let state = definition.init(header)
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state) }
}

test('one conversation prices its turns, searches and compaction', () => {
  const definition = install({ holidays: ['2026-11-02'] })
  const { view } = viewOf(definition, [
    { type: 'turn/start', time: OFF_PEAK, data: { turn: 1 } },
    sample({ time: OFF_PEAK, model: 'deepseek-flash', stream: { inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 500000 } }),
    { type: 'tool/call', time: PEAK, data: { turn: 1, step: 1, callId: 'a', name: 'web_search', arguments: {} } },
    { type: 'tool/call', time: PEAK, data: { turn: 1, step: 1, callId: 'b', name: 'web_fetch', arguments: {} } },
    { type: 'tool/call', time: PEAK, data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: {} } },
    sample({ time: PEAK, turn: 2, model: 'deepseek-v4-pro', usage: { inputTokens: 1000000, outputTokens: 100000 } }),
    {
      type: 'compaction/summary',
      time: OFF_PEAK,
      data: { provider: 'deepseek-official', model: 'deepseek-flash', usage: { inputTokens: 200000, outputTokens: 20000 } },
    },
  ])

  // flash off-peak: 1M miss @1 + 100k out @4 + 500k hit @0.02
  assert.equal(view.turns[0].cost, 1.41)
  // pro peak: 1M miss @9 + 100k out @27
  assert.equal(view.turns[1].cost, 11.7)
  assert.equal(view.cost.hidden, 0.28)
  assert.equal(view.search.calls, 2) // `read` is not a billed search
  assert.equal(view.cost.search, 0.01)
  assert.ok(Math.abs(view.cost.total - (1.41 + 11.7 + 0.28 + 0.01)) < 1e-9, 'the total adds every line up')
  assert.equal(view.saved, 0.49)
  assert.equal(view.hidden.count, 1)
  // the two billed tools are split, and the summary names the model that wrote it
  assert.deepEqual(view.search.byTool, [
    { tool: 'web_search', calls: 1, cost: 0.005 },
    { tool: 'web_fetch', calls: 1, cost: 0.005 },
  ])
  assert.deepEqual(view.hidden.byModel, [{ id: 'deepseek-official/deepseek-flash', count: 1, cost: 0.28 }])
})

test('a holiday bills the whole day at the off-peak rate', () => {
  const definition = install({ holidays: ['2026-11-02'] })
  const { view } = viewOf(definition, [
    sample({ time: HOLIDAY, model: 'deepseek-v4-pro', usage: { inputTokens: 1000000 } }),
  ])
  assert.equal(view.cost.miss, 4.5)
})

test('a model without a tariff is reported instead of billed as zero', () => {
  const definition = install({})
  const { view } = viewOf(definition, [
    sample({ time: PEAK, provider: 'fish-ai', model: 'mystery-model', usage: { inputTokens: 1000, outputTokens: 1000 } }),
  ])
  assert.deepEqual(view.unpriced, ['fish-ai/mystery-model'])
  assert.equal(view.cost.total, 0)
})

test('a dated flash id falls back to the family rate and is flagged as an estimate', () => {
  const definition = install({})
  const { view } = viewOf(definition, [
    sample({ time: PEAK, provider: 'bailian', model: 'deepseek-v4.1-flash-1017', usage: { inputTokens: 1000, outputTokens: 0 } }),
  ])
  assert.deepEqual(view.unpriced, [])
  assert.deepEqual(view.estimated, ['bailian/deepseek-v4.1-flash-1017'])
  assert.equal(view.cost.miss, 0.002)
})

test('a flat tariff applies at every hour', () => {
  const definition = install({ models: { 'flat-model': { cacheHit: 0.1, cacheMiss: 4, output: 9 } } })
  const { view } = viewOf(definition, [
    sample({ time: PEAK, provider: 'vendor', model: 'flat-model', usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 } }),
  ])
  assert.deepEqual(view.unpriced, [])
  assert.equal(view.cost.miss, 4)
  assert.equal(view.cost.hit, 0.1)
  assert.equal(view.cost.out, 9)
})

test('an event that changes nothing keeps the state reference', () => {
  const definition = install({})
  const { state } = viewOf(definition, [
    sample({ time: PEAK, model: 'deepseek-flash', usage: { inputTokens: 1000 } }),
  ])
  const after = definition.apply(state, { type: 'turn/end', time: PEAK, data: { turn: 2, reason: 'done' } })
  assert.equal(after, state)
})

test('day buckets split at Beijing midnight and survive a retry', () => {
  const definition = install({ holidays: ['2026-11-02'], budget: { daily: 5, monthly: 100 } })

  const first = sample({ time: OFF_PEAK, model: 'deepseek-flash', stream: { inputTokens: 1000000, outputTokens: 100000, cacheReadTokens: 500000 } })
  let state = definition.init({ id: 'session-1' })
  state = definition.apply(state, first)
  state = definition.apply(state, { type: 'tool/call', time: PEAK, data: { turn: 1, step: 1, callId: 'a', name: 'web_search', arguments: {} } })

  const view = definition.wire.view(state)
  assert.equal(view.days['2026-10-31'], 1.41)
  assert.equal(view.days['2026-11-03'], 0.005)
  assert.equal(state.sessionId, 'session-1', 'the session header id is kept for the ledger')
  assert.equal(view.budget.day.limit, 5)
  assert.equal(view.budget.month.limit, 100)
  // the 1.41 landed in the previous month, so only the search shows this month
  assert.equal(view.budget.month.spent, 0.005)

  // the same turn/step reported again replaces the earlier sample
  const retry = sample({ time: OFF_PEAK, model: 'deepseek-flash', stream: { inputTokens: 500000, outputTokens: 50000 } })
  const replaced = definition.wire.view(definition.apply(state, retry))
  assert.equal(replaced.days['2026-10-31'], 0.5 + 0.2)
})

test('no budget config means no budget field', () => {
  const definition = install({})
  const { view } = viewOf(definition, [])
  assert.equal(view.budget, null)
})

test('the two-week trend follows the calendar and weeks start on Monday', () => {
  const definition = install({})
  const { view } = viewOf(definition, [])
  // Nothing has been spent yet, so there is no chart to draw.
  assert.equal(view.history, null)

  const sample1 = sample({ time: OFF_PEAK, model: 'deepseek-flash', stream: { inputTokens: 1000000, outputTokens: 100000 } })
  let state = definition.init({ id: 'session-1' })
  state = definition.apply(state, sample1)
  const history = definition.wire.view(state).history

  assert.equal(history.trend.length, 14)
  const dates = history.trend.map((entry) => entry.date)
  assert.deepEqual([...dates].sort(), dates, 'the chart runs oldest to newest')
  for (let index = 1; index < dates.length; index += 1) {
    const gap = Date.parse(`${dates[index]}T00:00:00Z`) - Date.parse(`${dates[index - 1]}T00:00:00Z`)
    assert.equal(gap, 86400000, 'one bar per day, no gaps')
  }
  assert.equal(new Date(`${history.week.start}T00:00:00Z`).getUTCDay(), 1, 'a week starts on Monday')
  assert.ok(history.week.spent >= 0)
  assert.equal(history.today, dates[dates.length - 1])
  assert.equal(state.sessionId, 'session-1')
})

test('the view reports which tariff priced it', () => {
  const definition = install({})
  const { view } = viewOf(definition, [])
  assert.equal(view.pricing.source, 'builtin')
  assert.equal(view.pricing.error, null)
})

test('a published table fills in models the built-in table does not know', () => {
  const published = normaliseModelMap({
    'vendor-y': { cacheHit: 0.01, cacheMiss: 1, output: 2 },
    junk: 'nope',
  })
  const pricing = resolvePricing({}, published)
  // a flat entry is written to both tariff windows
  assert.deepEqual(pricing.models['vendor-y'].offPeak, { cacheHit: 0.01, cacheMiss: 1, output: 2 })
  assert.deepEqual(pricing.models['vendor-y'].peak, { cacheHit: 0.01, cacheMiss: 1, output: 2 })
  // built-in entries survive the merge, unparseable ones are dropped
  assert.equal(pricing.models['deepseek-flash'].peak.cacheMiss, 2)
  assert.equal(pricing.models.junk, undefined)
})

test('configured prices win over both the built-in and the published table', () => {
  const published = normaliseModelMap({ 'vendor-x': { cacheHit: 0.1, cacheMiss: 5, output: 10 } })
  const pricing = resolvePricing(
    { models: { 'vendor-x': { cacheHit: 0.2, cacheMiss: 20, output: 40 } } },
    published,
  )
  assert.deepEqual(pricing.models['vendor-x'].peak, { cacheHit: 0.2, cacheMiss: 20, output: 40 })
})

test('auto pricing can be switched off', () => {
  assert.equal(resolvePricing({}).autoPricing, true)
  assert.equal(resolvePricing({ autoPricing: false }).autoPricing, false)
})