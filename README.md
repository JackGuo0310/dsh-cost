# dsh-cost

[![npm](https://img.shields.io/npm/v/@jackguo0310/dsh-cost)](https://www.npmjs.com/package/@jackguo0310/dsh-cost)
[![CI](https://github.com/JackGuo0310/dsh-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/JackGuo0310/dsh-cost/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@jackguo0310/dsh-cost)](LICENSE)

Per-turn and per-session API cost estimation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web sessions.

为 DeepSeek Harness 的 Web 会话提供费用统计：每轮回答结束后显示**本轮 API 花费**，并累计**整个 Session 的花费**，点一下展开明细。

```
你 ─────────────────────────────────────────────
AI ─────────────────────────────────────────────
   本轮 ¥0.0321 · 累计 ¥1.8432 · 缓存 92%        ← dsh-cost
   🗄 用量 2.2M tok   ⏱ 用时 2分23秒              ← DSH 自带
```

> Note: the unscoped npm name `dsh-cost` belongs to an unrelated plugin by another
> author. This project publishes as **`@jackguo0310/dsh-cost`**.

---

## Features

- **本轮费用** — every completed turn shows its own cost.
- **Session 累计费用** — the running total for the conversation, with an
  `已计价 n/m 轮` coverage count so the number is never silently partial.
- **明细面板** — click the pill for the full breakdown: model, billing window, and
  each token bucket as `tokens × unit price = amount`.
- **缓存命中率** — how much of the prompt was served from cache.
- **DeepSeek 分时段计价** — peak / off-peak rates, with weekends handled
  automatically.
- **只读** — it only reads DSH's token-usage projection. It never writes to your
  session, never sends a request, and never touches the model API.
- **可扩展价目表** — pricing is a data-driven registry, so another provider is one
  `registerPriceBook()` call rather than a fork.

---

## Requirements

| | |
| --- | --- |
| DeepSeek Harness | `0.1.6-alpha.2` — the version this release was built and tested against |
| Node.js | `>=18` (developed and tested on `24.x`) |
| pnpm | required by `dsh plugin`, which is a pnpm passthrough |

Other DSH versions are not claimed as compatible. The plugin uses DSH's
`conversation.chat.turnTail` client slot, the `slots` / `locale` client services, and
the Chat turn-usage projection — those are the surfaces to re-check when DSH moves.

---

## Installation

```bash
dsh plugin --profile web add @jackguo0310/dsh-cost
dsh web
```

That is the whole install. `dsh plugin` installs the package into
`$DSH_HOME/profiles/web` and registers it as a profile bundle automatically — you do
**not** need to edit the profile's `package.json` or `cordis.patch.yml` by hand.

Already running `dsh web`? Restart it once after installing, then refresh the page.

### Install straight from GitHub

No npm account or registry involved — useful while a release is not published yet:

```bash
dsh plugin --profile web add github:JackGuo0310/dsh-cost
dsh web
```

The package builds nothing on install (the client half is a prebuilt bundle), so
pnpm runs no `prepare` script and asks for no build approval.

### Update

```bash
dsh plugin --profile web update @jackguo0310/dsh-cost
```

The dependency is keyed by package name either way, so the same command updates a
GitHub install too.

### Uninstall

```bash
dsh plugin --profile web remove @jackguo0310/dsh-cost
```

Removal also drops the bundle from the profile's `dsh.profile.bundles`, so the
plugin leaves no trace in the profile.

---

## What it shows

The cost pill sits under each reply, directly above DSH's own token/time pills.

- `本轮 ¥x` — this turn's cost. A `≈` prefix means the figure is an estimate: the
  model is not in the price list, or the turn was served by more than one model.
- `累计 ¥y` — the running total for the session.
- `缓存 z%` — share of prompt tokens served from cache.

Click it for the breakdown: turn total, model, billing window (peak / off-peak),
each bucket's `tokens × rate`, the session total, `已计价 n/m 轮`, and the price
list version.

A turn is shown as `未计价` rather than guessed when no registered price list owns
the provider.

---

## Pricing

Mirrored from DeepSeek's official [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
page (**2026-09-10**), in CNY per million tokens:

| Billing item | deepseek-flash off-peak | deepseek-flash peak | deepseek-v4-pro off-peak | deepseek-v4-pro peak |
| --- | --- | --- | --- | --- |
| Input, cache hit | 0.02 | 0.04 | 0.15 | 0.30 |
| Input, cache miss | 1 | 2 | 4.5 | 9.0 |
| Output | 4 | 8 | 13.5 | 27.0 |
| Cache write | free | free | free | free |

**Peak** is Beijing time, Monday to Friday (excluding Chinese statutory holidays),
09:00–12:00 and 14:00–18:00. Everything else — including all weekend and holiday
hours — is off-peak, at half the peak rate.

A turn costs `tokens ÷ 1,000,000 × rate`, summed over the four buckets. DeepSeek
does not bill disk-cache writes, so that rate is 0.

### Changing prices or adding holidays

Both live in [`client/client.js`](client/client.js), in the `DEEPSEEK_BOOK` data
structure. Chinese statutory holidays cannot be derived from a clock, so they are a
list; the **2026 mainland-China dates** ship as the default. Each January, replace
them with the new State Council notice:

```js
setDeepSeekHolidays(["2027-01-01", "2027-02-05"]); // Beijing time, YYYY-MM-DD
```

A missing holiday entry can only over-estimate a weekday, never under-estimate it.
Weekends are detected automatically.

### Adding another provider

Nothing in the cost math is DeepSeek-specific: it only reads a price book's
`match` / `models` / `bucketAt` / `currency`. Register a new one:

```js
registerPriceBook({
  id: "my-provider",
  label: "My Provider",
  currency: "USD",
  updated: "2026-09-01",
  source: "https://example.com/pricing",
  match: (route) => route.provider === "my-provider",
  bucketAt: () => "standard",           // one flat bucket, or any function of the request time
  fallbackModelId: "my-small",
  models: [
    {
      id: "my-small",
      label: "My Small",
      names: ["my-small", "my-small-2026"],
      rates: {
        standard: { cacheHit: 0.05, cacheMiss: 0.5, cacheWrite: 0.6, output: 1.5 },
      },
    },
  ],
});
```

---

## Development

```bash
git clone https://github.com/JackGuo0310/dsh-cost.git
cd dsh-cost
npm install

dsh plugin --profile web add .
dsh web
```

`npm run check` syntax-checks the bundle and the host half; `npm test` runs the
suite. Both run automatically before `npm publish` via `prepublishOnly`.

The browser half is a **prebuilt bundle that is also readable source**:
[`client/client.js`](client/client.js) registers one factory with
`window.__ModuleLoader__.load({ id, factory })`, and inside the factory only `react`
and `react/jsx-runtime` are required — both supplied by DSH's client module system.
There is no build step and no runtime dependency. (`react` and
`react-test-renderer` are devDependencies used by the tests only.)

Tests cover the price logic, the peak/off-peak boundary, the registration surface,
and real React rendering of the pill and the breakdown panel, with guards that no
render emits a React warning and no call site asks for a missing locale key.

---

## Limitations

- **An estimate, not an invoice.** DeepSeek's own billing is authoritative. Cache hit
  ratios, billing-window boundaries, and statutory holidays can differ slightly.
- **The billing window is decided from the turn's completion time.** A turn spanning
  a peak/off-peak boundary lands entirely on one side.
- **A turn that switched models** (a retry) cannot be split per model after the fact;
  it is priced with the first model and marked `≈`.
- **The session total covers the loaded turns.** Turns paged out of the loaded window
  are not in the total; the panel's `已计价 n/m 轮` shows the coverage.
- **The shipped holiday list covers 2026 mainland-China statutory holidays only** —
  update it yearly, and for your region.
- Failed or interrupted turns with no usage data are counted but not charged.

---

## License

MIT — see [LICENSE](LICENSE).
