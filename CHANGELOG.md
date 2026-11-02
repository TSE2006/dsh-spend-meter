# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-02

### Added

- **Effective unit rates**: each cost line now shows the rate it was charged at
  (`1.2M × ¥2.00/M`), so the money can be checked with one multiplication. A
  session that ran across peak and off-peak hours shows the weighted average.
- **Per-tool and per-model breakdown**: "Web search" is split by the tool that
  paid for it (`web_search` / `web_fetch`) and "Auto-compaction" by the model
  that wrote each summary.
- **Ledger export**: "Copy Markdown" and "Copy CSV" put the whole ledger
  (lines, tokens, balance, budget, models, turns) on the clipboard.
- **Cold-start smoke check**: `npm run smoke` loads both halves in a fresh
  process and verifies the shipped files, the price table and locale files, a
  bare-kernel `apply`, the one dock registration, rendering before any
  projection arrives, and that every `t('…')` key exists in both dictionaries.
  CI runs it on every push.

## [1.1.0] - 2026-11-02

Everything below landed after the first published release.

### Added

- **Budgets and alerts**: `config.budget.daily` / `config.budget.monthly` /
  `config.budget.warnRatio`. The ledger popover shows today and this month
  against their limits, turns yellow at the warning ratio and red once a limit
  is exceeded; the pill above the composer follows the same colour.
- **Persisted cross-session ledger**: daily totals are bucketed in Beijing time
  per session (`days` in the projection) and merged into
  `spend-meter-ledger.json`, so the day/month/trend figures survive restarts
  and include every session the Host has seen.
- **Budget banner**: when a budget is used up, a single dismissible banner
  appears next to the pill. Dismissing it keeps that day (or month) quiet; the
  state lives in `localStorage` and is pruned after 90 days.
- **Daily price refresh**: `pricing.json` is downloaded once a day (jsDelivr,
  then raw.githubusercontent.com), cached next to the profile for 24 hours and
  used to price models the built-in table does not know. A failed download
  keeps the previous table and says why in the popover.
- **Model-family pricing**: dated ids such as `deepseek-v4.1-flash-1017` are
  priced through their family and flagged as an estimate instead of being
  counted as ¥0.
- **Flat tariff**: a price table may now be written as
  `{ "cacheHit": .., "cacheMiss": .., "output": .. }` when a model has no peak
  / off-peak split.
- **Two-week chart**: the popover charts the last 14 days of spend (today
  highlighted, per-bar tooltip) plus a "this week" total that starts on Monday.
- **Turns left from budgets**: "≈ N more turns" now reports whichever of the
  wallet, today's budget or this month's budget runs out first, and names it.
- **Tests and CI**: `npm test` runs `node:test` over both halves (25 cases) and
  GitHub Actions runs it on Ubuntu and Windows with Node 22 and 24.
- **English README** with a language switcher, and a dedicated "what each line
  counts" section in both languages.

### Fixed

- The ledger path no longer depends on `DSH_PROFILE_DIR`: the desktop Host does
  not set it, so the ledger silently never reached disk before.
- The bookkeeping note ("counting since …") disappears once the start date
  falls into a previous month.
- The price table is reachable when `raw.githubusercontent.com` does not
  resolve, by falling back to the jsDelivr mirror.

## [1.0.0] - 2026-10-31

### Added

- A permanent pill under the composer showing this conversation's spend and the
  account balance, opening a ledger with per-item cost, cache savings, balance,
  remaining turns, per-model split, per-turn cost and links to the DeepSeek
  platform.
- Host half (`spendMeter` session projection) that folds the session event log
  so the numbers survive restarts, and a Client half rendered through the
  `conversation.composer.dock` slot.