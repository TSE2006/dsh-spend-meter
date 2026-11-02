# Spend Meter (spend-meter)

[简体中文](README.md) | **English**

A permanent line under the composer — `¥3.89 this chat · balance ¥19.07` — that opens the ledger for the current conversation when clicked.

![The pill under the composer](docs/preview.png)

Click it and this is the bill:

<img src="docs/panel.png" width="380" alt="Ledger panel: cost breakdown, cache savings, balance, per-model split, per-turn cost">

The styling deliberately follows two pieces of DSH's own UI: the pill copies `StatsPills` (the same bare-text buttons as `3 turns 228 steps · 232 tok/s` and `20.9M tok · 96% cached`), and the popover copies `stat-dialog` (the background, radius, shadow, rules and right-aligned tabular numbers of the "Token usage" card). Every design token comes from the runtime `--dsw-*` / `--dsh-*` variables, so light and dark themes follow automatically.

## Install

Requires DSH 0.2.1-rc.5 or newer on desktop (the plugin registers as a bundle in the profile).

1. Put the whole directory anywhere, for example `%USERPROFILE%\.dsh\plugins\spend-meter`.
2. Ask the agent in DSH to run `plugin_manager`'s `install_bundle` with `target` set to the **absolute path** of that directory; the plugin manager lists it as "Spend Meter".
3. When `¥0.00 this chat · balance ¥0.00` appears under the composer, it is installed.

The package name is fixed to `@local/spend-meter` (the local-package convention); nothing is published to npm.

## What it shows

| Where | Contents |
| --- | --- |
| The pill | Cost of this conversation, platform balance (yellow below ¥5, red below ¥1); the ¥ icon turns yellow during peak hours and stays grey off-peak |
| Ledger · time | Whether it is peak right now, and how long until the next half-price / peak window |
| Ledger · cost | Uncached input, cached input, output, web search, auto-compaction summaries — each with its amount and token count |
| Ledger · cache | Money saved by cache hits, and what the same tokens would have cost without a cache |
| Ledger · balance | Top-up balance + bonus balance, and roughly how many more turns it can pay for at the current pace |
| Ledger · budget | Today / this month spent vs. limit (only with `budget` configured), yellow at 80%, red with a notice once exceeded; the figure above the composer turns the same colour, and its tooltip carries today's percentage |
| Budget banner | Once a budget is used up a banner appears next to the pill; close it with × and the same day (or month) stays quiet |
| Ledger · recent | A 14-day bar chart of daily spend (today highlighted, hover a bar for its amount) and the "this week" total (weeks start on Monday, summed across sessions) |
| Ledger · prices | "Prices: updated <date>" when the table came from the daily download; a failed download says why; the built-in table takes no line of its own |
| Ledger · models | Cost split per model (shown only when a session used more than one) |
| Ledger · turns | The cost of each of the last 8 turns, expandable to the whole conversation |
| Ledger · links | Jump to the DeepSeek platform's usage / top-up pages |

## Where the numbers come from

**Cost**: the Host half registers a session projection named `spendMeter` that only folds the session event log, so it survives restarts and session switches:

- `usage` on `assistant/message` / `assistant/attempt` → bucketed by `(turn, step)`; a retry subtracts the previous sample before adding the new one, so nothing is charged twice.
- `usage` on `compaction/summary` → reported separately as the hidden cost of auto-compaction.
- `web_search` / `web_fetch` in `tool/call` → priced per call (¥0.005 by default, charged from 2026-11-01).
- Prices are picked by **each event's own timestamp**: peak is Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time, everything else is half price.

**Balance**: the Client half calls the `account` Remote directly (`ctx.remote.account.getBalance(...)`, the same path as Settings → Account), refreshing every 15 seconds, and immediately when the window becomes visible or the ledger is opened.

The projection view still carries a `wallet` field as a fallback while the Remote has not answered. It cannot be the only source: a projection only recomputes and broadcasts when a **session event** replaces its state reference, while wallet polling produces neither an event nor a state change — after a cold start the page would sit on the `loading` snapshot captured in the baseline forever.

That call is **not declared in `inject`**; it is resolved at runtime through `ctx.get`. Cordis has no optional injection, so hard-injecting a service that is not mounted yet leaves the entry `pending`, and the desktop web boot treats "any entry not active" as a fatal error.

**Budget**: the projection state carries a `days` map bucketed by Beijing date; every event adds only its **cost delta** to that event's own day (a retry that replaces an attempt subtracts, so nothing is double counted). The Host half then sums those buckets across sessions into today / this month:

- Persisted file: `%USERPROFILE%\.dsh\spend-meter-ledger.json` (last 70 days kept), so restarts continue where the last run stopped. When `DSH_PROFILE_DIR` is set the file lives there instead, and `SPEND_METER_LEDGER` overrides the path outright.
- Merge order: on-disk ledger → sessions seen by this process (`sessionProjections.onChanged` pushes absolute maps) → the current session's own `days` (applied last, so the newest event is never missing).
- Without `budget` configured the field is absent and the popover shows no budget section.
- The "recent" bars and the week total read the same ledger over the last 14 day buckets; a week starts on Monday in Beijing time. The section is hidden while the ledger is still all zeros (fresh install).

## Robustness

The Client half never throws into Cordis (otherwise the whole app would refuse to start):

- every step of `apply` (dictionaries, styles, mounting) is wrapped in `guard()`, and a failure only lands in `problems`;
- `buildPanel()` is try/catch as a whole and degrades the pill to `—`, while `PanelBoundary` catches the popover;
- styles are always CSS classes, never a string handed to `style` (React requires an object there; a string throws during render and the slot runtime silently drops the whole cell).

Anything the plugin diagnoses about itself is shown in the "Plugin problem" block at the bottom of the popover.

## Pricing (built-in defaults, overridable through `config` in the patch)

| Model | Cache hit | Cache miss | Output |
| --- | --- | --- | --- |
| deepseek-flash (including the v4-flash aliases) | ¥0.04 / ¥0.02 | ¥2 / ¥1 | ¥8 / ¥4 |
| deepseek-v4-pro | ¥0.30 / ¥0.15 | ¥9 / ¥4.5 | ¥27 / ¥13.5 |

Units: CNY per million tokens, formatted as "peak / off-peak". Lookup is three steps: an exact model name, then the same name with a date or version tail stripped (`-1017`, `-20250929`), and only then the model family — a `deepseek` name containing `flash` bills at the flash rate and one containing `pro` at the pro rate. When that third step is used the popover says "Estimated at the model-family rate: <model>". Everything else is collected into `unpriced` and excluded from the totals.

An entry in `config.models` accepts either the `peak` / `offPeak` shape above or a **flat** tariff that applies all day — handy for third-party channels that do not split the day:

```yaml
    models:
      deepseek-v4.1-flash-1017: { cacheHit: 0.02, cacheMiss: 1, output: 4 }   # flat, same peak and off-peak
```

### Daily price updates

A built-in table ages, so the Host half downloads `pricing.json` from this repository once a day:

- URL: `https://cdn.jsdelivr.net/gh/TSE2006/dsh-spend-meter@main/pricing.json` first (some networks cannot resolve `raw.githubusercontent.com`), then `https://raw.githubusercontent.com/TSE2006/dsh-spend-meter/main/pricing.json`; `SPEND_METER_PRICING_URL` points it at your own mirror (only that one URL is then used).
- Cache: `%USERPROFILE%\.dsh\spend-meter-pricing.json`, reused for 24 hours; a failed download keeps the previous table (or the built-in one) and only reports the reason in the popover.
- Precedence: `config.models` > downloaded/cached table > built-in table, merged model by model, so publishing a single new model is enough.
- Off switch: `config.autoPricing: false`.
- Maintenance: when DeepSeek ships a model, edit `pricing.json` at the repository root — users do not need a plugin upgrade.

## What the numbers count

Every line comes from the usage events DSH already records; no request goes to the platform's billing API.

| Line | Source | Note |
| --- | --- | --- |
| Uncached input | `usage.inputTokens` | Real logs satisfy `totalTokens = inputTokens + outputTokens + cacheReadTokens`, so this is the **uncached** share, never the whole prompt |
| Cached input | `usage.cacheReadTokens` | Billed at the hit rate; also produces "saved by the cache" = what those tokens would have cost at the miss rate |
| Output | `usage.outputTokens` | A reasoning model that folds thinking into output is billed here too; the usage object has no separate reasoning field to split out |
| Cache write | `usage.cacheWriteTokens` | Zero in every event measured (DeepSeek does not report cache creation separately); billed at the miss rate if a provider ever reports it |

Only a **successful** `assistant/message` carries usage. A failed request (a 401, say) lands on `assistant/attempt` with all-zero usage and is therefore **not billed** — which matches a real invoice. When the same `turn/step` is reported twice, the later report replaces the earlier one, so a retry never double counts.

Web search is billed per call (default ¥0.005, free before `searchFreeUntil`), and the LLM spend of an auto-compaction summary is listed separately as "compaction".

## Configuration example

Add a `config` block to the `spend-meter` row in the profile's `cordis.patch.yml` (`%USERPROFILE%\.dsh\profiles\<profile>\`):

```yaml
- id: spend-meter
  config:
    holidays: ['2026-10-01', '2026-10-02']   # public holidays are priced off-peak all day
    searchPerCall: 0.005
    turnHistory: 120
    currency: CNY
    budget:
      daily: 20            # today's limit, same unit as currency; omit or 0 for no limit
      monthly: 200         # this month's limit
      warnRatio: 0.8       # turns yellow at this share, red with a notice past 100%
    autoPricing: true    # false keeps the built-in table and never downloads
    models:
      deepseek-flash:
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
```

> The plugin declares no `Config`, so `config` is not schema-validated; every field falls back to the table above.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Host half: the `spendMeter` projection (cost ledger + day buckets), the cross-session ledger, and the wallet fallback poll |
| `client.ui.js` | Client half source (pill, popover, CSS, dictionaries) |
| `client.js` | Deployment artifact, identical to `client.ui.js` |
| `locale/{en,zh}.json` | Title and description shown in the plugin manager |
| `icon.svg` | Plugin icon |
| `pricing.json` | The online price table, merged into the built-in one once a day |
| `cordis.patch.yml` | Bundle insert declaration |
| `README.md` / `README.en.md` | Chinese / English documentation |
| `docs/preview.png` | Screenshot of the pill |
| `docs/panel.png` | Screenshot of the ledger popover |
| `tests/projection.test.mjs` | Host half: folding tests for pricing, day buckets and the budget view |
| `tests/client.test.mjs` | Client half: loads the bundle the way the kernel does, renders the pill and the popover |
| `.github/workflows/test.yml` | Runs the suite on Node 22/24 × Linux/Windows |

After editing the source: `Copy-Item client.ui.js client.js -Force`. DSH's client-module HMR picks it up in about 3–4 seconds; no page refresh is needed.

## Tests

```bash
npm test      # = node --test "tests/*.test.mjs"
```

Node's built-in `node:test` and `node:assert` only — there are no development dependencies. The host half folds events through a fake projection definition; the client half loads `client.js` exactly as the kernel does (`__ModuleLoader__.load` plus `factory(require)`) and renders the pill and popover through a minimal React/Hook stand-in. Module body, dictionary keys, registration options, link handlers and budget colouring are therefore covered without a browser.

## Known limits

- **The price table is built in and topped up online**: the built-in table holds DeepSeek's official prices as fetched in 2026-10, and the Host half downloads `pricing.json` from this repository once a day to override the same models (a cached or built-in table is used offline). For a private tariff, write `config.models` in the profile patch — it wins over both. Models outside every table only count tokens, never money, and are flagged at the bottom of the popover.
- **Search billing** starts at 2026-11-01 00:00 Beijing time, per the official announcement; earlier `web_search` / `web_fetch` calls are counted as free.
- **The balance needs a platform account**: when DSH uses an API key and is not signed in to a DeepSeek platform account, the wallet cannot be read — the balance slot shows `—`, the popover explains why, and cost tracking is unaffected.
- **This conversation only**: for a cross-session total, use the platform usage page (linked at the bottom of the popover).
- **Budgets count from the day the plugin started bookkeeping**: the ledger only accumulates events this plugin saw, so spending from before installation is missing and the first "this month" figure reads low. The popover says "Counting since <date>" so you know; that line disappears once the date falls into a previous month.
- The "roughly N more turns" figure extrapolates from this session's average cost per turn, so it drifts in long conversations.
