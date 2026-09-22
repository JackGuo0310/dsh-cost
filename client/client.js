/**
 * dsh-cost — browser half (prebuilt plugin bundle).
 *
 * WHY THIS FILE IS A "BUNDLE" AND NOT PLAIN SOURCE
 * ------------------------------------------------
 * DSH serves every client plugin half as a classic script at
 * `/plugins/<package-id>/client.js`. The script's only job is to register a
 * factory with the browser module system:
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * Nothing in the factory body runs until the module is first materialized, and
 * `require` resolves only the shell's seed words (`react`, `react/jsx-runtime`,
 * `react-dom`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
 * `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`,
 * `@deepseek-ai/cordis`) plus other plugins' registered halves. This plugin needs
 * only `react` and `react/jsx-runtime`, so the bundle has no build step and no
 * runtime dependencies: what you read here is what the browser runs.
 *
 * The sections below are deliberately ordered like modules — price books, billing
 * clock, cost math, snapshot selection, formatting, styles, copy, view, plugin
 * body — and `exports.__test` re-exports the pure logic so `node --test` can cover
 * it without a browser.
 */

window.__ModuleLoader__.load({
	// Must be the npm package name, not a nickname: `@deepseek-ai/dsh-client-modules`
	// keys its factory table by the boot manifest entry id, which is the Loader row's
	// module specifier — the package name. A bundle that registers anything else
	// fails `arrive()` with "loaded without registering <id>", which rejects the whole
	// application batch, not just this plugin.
	id: "@jackguo0310/dsh-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { jsx, jsxs, Fragment } = require("react/jsx-runtime");

		// #region 1. Price books
		/**
		 * A price book describes one provider's public price list.
		 *
		 * Adding a provider later means adding one more book to `PRICE_BOOKS` (or
		 * calling `registerPriceBook` from the host half / another plugin). Nothing
		 * else in this file hard-codes DeepSeek: the generic cost math below only
		 * reads the book's `match`, `models`, `bucketAt`, and `currency`.
		 *
		 * @typedef {object} PriceRates
		 * @property {number} cacheMiss  Currency units per 1M uncached ("cache miss") input tokens.
		 * @property {number} cacheHit   Currency units per 1M cached ("cache hit") input tokens.
		 * @property {number} cacheWrite Currency units per 1M cache-write input tokens; 0 when the provider does not bill cache writes separately.
		 * @property {number} output     Currency units per 1M output tokens.
		 *
		 * @typedef {object} PriceModel
		 * @property {string} id            Canonical model id used in the UI and in price lookups.
		 * @property {string} label         Human-readable name.
		 * @property {string[]} names       Every id/alias this model answers to (lower-case).
		 * @property {Record<string, PriceRates>} rates Rates per billing bucket key.
		 * @property {string} [note]        Optional note rendered in the detail panel.
		 *
		 * @typedef {object} PriceBook
		 * @property {string} id            Stable book id.
		 * @property {string} label         Human-readable provider name.
		 * @property {string} currency      ISO-ish currency code used for the symbol and copy.
		 * @property {string} updated       Date of the price list this book mirrors (YYYY-MM-DD).
		 * @property {string} source        URL of the mirrored public price list.
		 * @property {(route: { provider: string, model: string }) => boolean} match
		 *   Whether this book owns a provider/model route.
		 * @property {(at: number) => string} bucketAt
		 *   Billing bucket key for one request time (Unix epoch ms).
		 * @property {PriceModel[]} models  Price entries, best match first.
		 * @property {string} fallbackModelId Model priced when an id is unknown.
		 */

		/** Beijing-time peak windows (start hour inclusive, end hour exclusive) on working days. */
		const DEEPSEEK_PEAK_WINDOWS = [
			[9, 12],
			[14, 18],
		];

		/**
		 * Chinese statutory holidays are not derivable from a clock, so they are
		 * simply listed. DeepSeek bills a holiday as off-peak; a missing entry only
		 * ever over-estimates a weekday cost, never under-estimates it. Add
		 * `YYYY-MM-DD` keys for whichever years you care about.
		 *
		 * @example setDeepSeekHolidays(['2027-01-01', '2027-02-05'])
		 */
		const DEEPSEEK_HOLIDAYS = new Set([]);

		/**
		 * Replace the holiday set used for off-peak detection.
		 * @param {Iterable<string>} dates - `YYYY-MM-DD` keys in Beijing time.
		 */
		function setDeepSeekHolidays(dates) {
			DEEPSEEK_HOLIDAYS.clear();
			for (const date of dates) DEEPSEEK_HOLIDAYS.add(String(date));
		}

		/** Lazily built Beijing calendar formatter (Intl construction is not free). */
		let beijingFormatter = null;

		/**
		 * Read one instant as Beijing wall-clock parts.
		 * @param {number} epochMs - Unix epoch milliseconds.
		 * @returns {{ hour: number, minute: number, weekday: string, dateKey: string, weekend: boolean }}
		 */
		function beijingParts(epochMs) {
			if (beijingFormatter === null) {
				beijingFormatter = new Intl.DateTimeFormat("en-US", {
					timeZone: "Asia/Shanghai",
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
					weekday: "short",
				});
			}
			const parts = {};
			for (const part of beijingFormatter.formatToParts(new Date(epochMs))) {
				parts[part.type] = part.value;
			}
			const weekday = parts.weekday ?? "";
			return {
				// Some engines render midnight as "24" with hour12:false.
				hour: Number(parts.hour ?? 0) % 24,
				minute: Number(parts.minute ?? 0),
				weekday,
				dateKey: `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`,
				weekend: weekday === "Sat" || weekday === "Sun",
			};
		}

		/**
		 * DeepSeek billing bucket for one request time.
		 *
		 * Peak = Beijing time, Monday to Friday, 09:00-12:00 and 14:00-18:00,
		 * excluding Chinese statutory holidays. Everything else is off-peak (half
		 * price). See {@link DEEPSEEK_HOLIDAYS} for the one thing a clock cannot know.
		 * @param {number} epochMs - Request time (Unix epoch ms).
		 * @returns {'peak'|'offPeak'} Billing bucket key.
		 */
		function deepseekBucketAt(epochMs) {
			const at = beijingParts(epochMs);
			if (at.weekend || DEEPSEEK_HOLIDAYS.has(at.dateKey)) return "offPeak";
			const hour = at.hour + at.minute / 60;
			for (const [from, to] of DEEPSEEK_PEAK_WINDOWS) {
				if (hour >= from && hour < to) return "peak";
			}
			return "offPeak";
		}

		/**
		 * DeepSeek price book, mirrored from the official 模型 & 价格 page.
		 * Cache writes are not billed separately (the disk cache has no write fee),
		 * so `cacheWrite` is 0 — that is why DeepSeek never reports a cache-write
		 * token bucket at all.
		 */
		const DEEPSEEK_BOOK = {
			id: "deepseek",
			label: "DeepSeek",
			currency: "CNY",
			updated: "2026-09-10",
			source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
			match: (route) =>
				/deepseek/i.test(route.provider ?? "") || /^deepseek[-.]/i.test(route.model ?? ""),
			bucketAt: deepseekBucketAt,
			models: [
				{
					id: "deepseek-flash",
					label: "DeepSeek Flash",
					names: [
						"deepseek-flash",
						"deepseek-v4.1-flash",
						"deepseek-v4-flash",
						"deepseek-v4-flash-vision-exp",
					],
					rates: {
						peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
						offPeak: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 },
					},
				},
				{
					id: "deepseek-v4-pro",
					label: "DeepSeek V4 Pro",
					names: ["deepseek-v4-pro", "deepseek-v4-pro-0813"],
					rates: {
						peak: { cacheHit: 0.3, cacheMiss: 9, cacheWrite: 0, output: 27 },
						offPeak: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 0, output: 13.5 },
					},
				},
				{
					id: "deepseek-chat",
					label: "DeepSeek Chat (legacy)",
					names: ["deepseek-chat", "deepseek-reasoner"],
					rates: {
						peak: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 0, output: 8 },
						offPeak: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 0, output: 4 },
					},
					note: "legacy id — priced at DeepSeek Flash rates",
				},
			],
			fallbackModelId: "deepseek-flash",
		};

		/** Live registry of price books, in match order. */
		const PRICE_BOOKS = [DEEPSEEK_BOOK];

		/**
		 * Bumped whenever the registry changes, so cached per-turn readings computed
		 * under an older price list are discarded instead of silently reused.
		 */
		let priceRevision = 0;

		/**
		 * Add or replace one price book.
		 *
		 * This is the extension point for other providers: pass a book shaped like
		 * {@link DEEPSEEK_BOOK}. A book whose `id` is already registered replaces it,
		 * so a plugin can override shipped prices without forking this file.
		 * @param {PriceBook} book - Price book to register.
		 * @returns {() => void} Disposer restoring the previous registry entry.
		 */
		function registerPriceBook(book) {
			priceRevision += 1;
			const index = PRICE_BOOKS.findIndex((candidate) => candidate.id === book.id);
			if (index === -1) {
				PRICE_BOOKS.push(book);
				return () => {
					priceRevision += 1;
					const at = PRICE_BOOKS.indexOf(book);
					if (at !== -1) PRICE_BOOKS.splice(at, 1);
				};
			}
			const previous = PRICE_BOOKS[index];
			PRICE_BOOKS[index] = book;
			return () => {
				priceRevision += 1;
				PRICE_BOOKS[index] = previous;
			};
		}

		/**
		 * Find the book that owns one route.
		 * @param {{ provider: string, model: string }} route - Provider/model identity.
		 * @returns {PriceBook|undefined} Owning book.
		 */
		function findPriceBook(route) {
			for (const book of PRICE_BOOKS) {
				try {
					if (book.match(route)) return book;
				} catch {
					// A third-party book must not be able to break the whole panel.
				}
			}
			return undefined;
		}

		/**
		 * Lower-case a model id and drop any `vendor/` prefix.
		 * @param {unknown} model - Raw model id.
		 * @returns {string} Normalized id.
		 */
		function normalizeModelId(model) {
			if (typeof model !== "string") return "";
			const trimmed = model.trim().toLowerCase();
			const slash = trimmed.lastIndexOf("/");
			return slash === -1 ? trimmed : trimmed.slice(slash + 1);
		}

		/**
		 * Resolve a model id against a book.
		 * @param {PriceBook} book - Owning price book.
		 * @param {string} model - Raw model id from the route.
		 * @returns {{ model: PriceModel, matched: boolean }} Price entry plus whether the id was exact/prefix-matched.
		 */
		function resolvePricedModel(book, model) {
			const id = normalizeModelId(model);
			for (const entry of book.models) {
				if (entry.names.includes(id)) return { model: entry, matched: true };
			}
			for (const entry of book.models) {
				if (entry.names.some((name) => id.startsWith(name))) return { model: entry, matched: true };
			}
			const fallback =
				book.models.find((entry) => entry.id === book.fallbackModelId) ?? book.models[0];
			return { model: fallback, matched: false };
		}

		// #endregion

		// #region 2. Usage normalization and cost math
		/** Bucket keys in the order the detail panel lists them. */
		const COST_LINE_KEYS = ["cacheMiss", "cacheHit", "cacheWrite", "output"];

		/** Locale keys for each cost line, kept beside the bucket order they label. */
		const COST_LINE_LABELS = {
			cacheMiss: "cost.line.cacheMiss",
			cacheHit: "cost.line.cacheHit",
			cacheWrite: "cost.line.cacheWrite",
			output: "cost.line.output",
		};

		/**
		 * Coerce one provider-reported token count.
		 * @param {unknown} value - Raw count.
		 * @returns {number} A non-negative finite integer, or 0.
		 */
		function tokenCount(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
		}

		/**
		 * Normalize the DSH turn-usage projection into billing buckets.
		 *
		 * DSH's `TurnTokenUsage` already splits prompt tokens the way DeepSeek bills
		 * them: `uncachedInputTokens` is the cache-miss portion and `cacheReadTokens`
		 * the cache-hit portion (absent when a provider cannot report the split).
		 * @param {object} usage - A `TurnTokenUsage`-shaped value.
		 * @returns {{ cacheMiss: number, cacheHit: number, cacheWrite: number, output: number, reasoning: number, hasCacheHit: boolean, hasCacheWrite: boolean }} Billing buckets.
		 */
		function normalizeUsage(usage) {
			const raw = usage !== null && typeof usage === "object" ? usage : {};
			return {
				cacheMiss: tokenCount(raw.uncachedInputTokens),
				cacheHit: tokenCount(raw.cacheReadTokens),
				cacheWrite: tokenCount(raw.cacheWriteTokens),
				output: tokenCount(raw.outputTokens),
				reasoning: tokenCount(raw.reasoningTokens),
				hasCacheHit: typeof raw.cacheReadTokens === "number",
				hasCacheWrite: typeof raw.cacheWriteTokens === "number",
			};
		}

		/**
		 * Collect the provider/model routes that contributed usage to one turn.
		 *
		 * The usage projection carries `routes` only when every billed attempt was
		 * attributed; otherwise the closing assistant message's provider metadata is
		 * the best identity available.
		 * @param {object} tailData - A `TurnTailChatData` value.
		 * @returns {{ provider: string, model: string }[]} Routes in recorded order.
		 */
		function turnRoutes(tailData) {
			const usage = tailData === null || tailData === undefined ? undefined : tailData.tokenUsage;
			const routes = usage === null || usage === undefined ? undefined : usage.routes;
			if (Array.isArray(routes) && routes.length > 0) {
				return routes.map((route) => ({
					provider: typeof route.provider === "string" ? route.provider : "",
					model: typeof route.model === "string" ? route.model : "",
				}));
			}
			const finalNode = tailData?.closing?.finalNode;
			const meta = finalNode?.providerMetadata;
			if (meta !== undefined && typeof meta.model === "string") {
				return [{ provider: meta.provider ?? "", model: meta.model }];
			}
			const config = finalNode?.requestConfig;
			if (config !== undefined && typeof config.model === "string") {
				return [{ provider: config.provider ?? "", model: config.model }];
			}
			return [];
		}

		/**
		 * Price one turn's token buckets.
		 *
		 * Cost math is book-agnostic: `tokens / 1e6 * rate` per bucket, summed. A turn
		 * whose attempts span more than one price book/model is priced with the first
		 * route and flagged `estimated`, because the aggregate buckets cannot be split
		 * per route after the fact.
		 * @param {object} tailData - A `TurnTailChatData` value.
		 * @param {{ provider: string, model: string }[]} [routes] - Pre-resolved routes.
		 * @returns {object|null} Cost reading, or null when the turn carries no usage.
		 */
		function computeTurnCost(tailData, routes) {
			const usage = tailData === null || tailData === undefined ? undefined : tailData.tokenUsage;
			if (usage === null || usage === undefined) return null;

			const buckets = normalizeUsage(usage);
			const resolvedRoutes = Array.isArray(routes) ? routes : turnRoutes(tailData);
			const route = resolvedRoutes[0] ?? { provider: "", model: "" };
			const book = findPriceBook(route);
			const at = typeof tailData.time === "number" ? tailData.time : Date.now();

			if (book === undefined) {
				return {
					priced: false,
					reason: "no-price-book",
					route,
					routes: resolvedRoutes,
					at,
					buckets,
					currency: "CNY",
					total: 0,
					lines: [],
					estimated: true,
				};
			}

			const bucketKey = book.bucketAt(at);
			const { model, matched } = resolvePricedModel(book, route.model);
			const rates = model.rates[bucketKey] ?? model.rates.offPeak ?? model.rates.peak;

			const lines = COST_LINE_KEYS.map((key) => {
				const tokens = buckets[key];
				const rate = typeof rates[key] === "number" ? rates[key] : 0;
				return { key, tokens, rate, cost: (tokens / 1e6) * rate };
			});

			const total = lines.reduce((sum, line) => sum + line.cost, 0);
			const billedInput = buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite;

			return {
				priced: true,
				book: book.id,
				bookLabel: book.label,
				bookUpdated: book.updated,
				bookSource: book.source,
				currency: book.currency,
				model: model.id,
				modelLabel: model.label,
				modelNote: model.note,
				modelMatched: matched,
				bucket: bucketKey,
				at,
				buckets,
				lines,
				total,
				cacheHitRate: billedInput > 0 ? buckets.cacheHit / billedInput : null,
				// A multi-route turn or an unknown model id makes the figure approximate.
				estimated: !matched || resolvedRoutes.length > 1,
				routes: resolvedRoutes,
			};
		}

		/**
		 * Per-turn cost memo.
		 *
		 * A Chat snapshot republishes on every streaming delta, and the session total
		 * re-walks every loaded turn each time. `TurnTailChatData` objects are
		 * immutable per snapshot rebuild, so identity is a safe cache key; the
		 * registry revision invalidates everything the moment a price book changes.
		 * @type {WeakMap<object, { revision: number, cost: object|null }>}
		 */
		const turnCostCache = new WeakMap();

		/**
		 * Priced reading for one turn, memoized by payload identity.
		 * @param {object} tailData - A `TurnTailChatData` value.
		 * @returns {object|null} Cost reading, or null when the turn carries no usage.
		 */
		function pricedTurn(tailData) {
			const cached = turnCostCache.get(tailData);
			if (cached !== undefined && cached.revision === priceRevision) return cached.cost;
			const cost = computeTurnCost(tailData);
			turnCostCache.set(tailData, { revision: priceRevision, cost });
			return cost;
		}

		/**
		 * Fold every loaded turn of one session into the two numbers the UI shows.
		 *
		 * The total covers the turns currently materialized in the Chat snapshot —
		 * i.e. the loaded window — which is what "this conversation" means on screen.
		 * @param {object} snapshot - Chat snapshot (`useChat` argument).
		 * @param {number} turnNumber - Turn whose own cost is reported.
		 * @returns {{ turnCost: object|null, turnHasUsage: boolean, sessionTotal: number, totalTurns: number, pricedTurns: number, unpricedTurns: number, signature: string }} Summary.
		 */
		function selectCostSummary(snapshot, turnNumber) {
			const nodes = snapshot?.nodes;
			const values = typeof nodes?.values === "function" ? nodes.values() : [];

			let sessionTotal = 0;
			let totalTurns = 0;
			let pricedTurns = 0;
			let unpricedTurns = 0;
			let turnCost = null;
			let turnHasUsage = false;

			for (const node of values) {
				if (node === null || node === undefined || node.kind !== "turn-tail") continue;
				const data = node.data;
				if (data === null || data === undefined || typeof data.turn !== "number") continue;
				totalTurns += 1;

				const cost = pricedTurn(data);
				if (cost !== null && cost.priced) {
					pricedTurns += 1;
					sessionTotal += cost.total;
				} else {
					unpricedTurns += 1;
				}

				if (data.turn === turnNumber) {
					turnCost = cost;
					turnHasUsage = cost !== null;
				}
			}

			return {
				turnCost,
				turnHasUsage,
				sessionTotal,
				totalTurns,
				pricedTurns,
				unpricedTurns,
				signature: costSummarySignature({
					turnCost,
					turnHasUsage,
					sessionTotal,
					totalTurns,
					pricedTurns,
					unpricedTurns,
				}),
			};
		}

		/**
		 * Build the cheap change key `useChat` compares on.
		 * @param {object} summary - Summary fields.
		 * @returns {string} Stable string that changes exactly when the display would.
		 */
		function costSummarySignature(summary) {
			const cost = summary.turnCost;
			const lines = cost === null ? "" : cost.lines.map((line) => line.tokens).join(",");
			return [
				summary.totalTurns,
				summary.pricedTurns,
				summary.unpricedTurns,
				Math.round(summary.sessionTotal * 1e6),
				summary.turnHasUsage ? 1 : 0,
				cost === null
					? ""
					: `${Math.round(cost.total * 1e6)}|${cost.bucket ?? ""}|${cost.model ?? ""}|${
							cost.estimated ? 1 : 0
						}|${lines}`,
			].join("/");
		}

		/**
		 * `useChat` equality: the summary is a fresh object per snapshot pass, so the
		 * store must compare the rendered signature instead of object identity.
		 * @param {object} a - Previous summary.
		 * @param {object} b - Next summary.
		 * @returns {boolean} Whether the two summaries render identically.
		 */
		function equalCostSummary(a, b) {
			if (a === b) return true;
			if (a === null || a === undefined || b === null || b === undefined) return false;
			return a.signature === b.signature;
		}

		// #endregion

		// #region 3. Formatting
		/**
		 * Currency symbol for a supported book currency.
		 * @param {string} currency - Currency code.
		 * @returns {string} Symbol, or the code plus a space for unknown codes.
		 */
		function currencySymbol(currency) {
			if (currency === "CNY") return "¥";
			if (currency === "USD") return "$";
			return typeof currency === "string" && currency.length > 0 ? `${currency} ` : "";
		}

		/** Drop trailing zeros from a fixed-point string. */
		function trimZeros(text) {
			return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
		}

		/**
		 * Format a money amount with enough precision to stay meaningful at
		 * fractions of a cent (single turns are often well below ¥0.01).
		 * @param {number} value - Amount in the book's currency.
		 * @param {string} currency - Currency code.
		 * @returns {string} Display text.
		 */
		function formatMoney(value, currency) {
			const symbol = currencySymbol(currency);
			const amount = Number.isFinite(value) ? value : 0;
			const abs = Math.abs(amount);
			if (abs === 0) return `${symbol}0`;
			if (abs >= 1) return `${symbol}${amount.toFixed(3)}`;
			if (abs >= 0.01) return `${symbol}${trimZeros(amount.toFixed(4))}`;
			return `${symbol}${trimZeros(amount.toFixed(7))}`;
		}

		/**
		 * Format a per-1M-token rate.
		 * @param {number} value - Rate in the book's currency per 1M tokens.
		 * @param {string} currency - Currency code.
		 * @returns {string} Display text.
		 */
		function formatRate(value, currency) {
			const symbol = currencySymbol(currency);
			const rate = Number.isFinite(value) ? value : 0;
			const text = rate >= 1 ? trimZeros(rate.toFixed(2)) : trimZeros(rate.toFixed(3));
			return `${symbol}${text}/M`;
		}

		/**
		 * Compact token count (`1.2k`, `3.4M`).
		 * @param {number} value - Token count.
		 * @returns {string} Display text.
		 */
		function formatTokens(value) {
			const tokens = Number.isFinite(value) ? value : 0;
			if (tokens < 1000) return String(Math.round(tokens));
			if (tokens < 1e6) return `${trimZeros((tokens / 1e3).toFixed(1))}k`;
			return `${trimZeros((tokens / 1e6).toFixed(2))}M`;
		}

		/** Percentage text for a 0..1 ratio, or null when unavailable. */
		function formatPercent(ratio) {
			if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
			const percent = ratio * 100;
			return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
		}

		// #endregion

		// #region 4. Styles
		/** Injected once per page; every colour comes from a DSH token with a sane fallback. */
		const CSS = `
.dsh-cost-root{display:inline-flex;flex-direction:column;gap:6px;max-width:100%}
.dsh-cost-pill{display:inline-flex;align-items:center;gap:8px;padding:2px 8px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8b8b);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;cursor:pointer;font-variant-numeric:tabular-nums}
.dsh-cost-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-cost-pill:focus-visible{outline:2px solid var(--dsw-alias-border-focus,#4c8dff);outline-offset:1px}
.dsh-cost-amount{color:var(--dsw-alias-label-secondary,#4d4d4d);font-weight:500}
.dsh-cost-sep{opacity:.5}
.dsh-cost-tag{padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-base,rgba(127,127,127,.14));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)}
.dsh-cost-panel{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));border-radius:10px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#4d4d4d);font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums}
.dsh-cost-panel dt{color:var(--dsw-alias-label-tertiary,#8b8b8b)}
.dsh-cost-panel dd{margin:0}
.dsh-cost-num{text-align:right;white-space:nowrap}
.dsh-cost-totalRow{border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.22));padding-top:6px;margin-top:2px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.dsh-cost-foot{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:1.5}
.dsh-cost-foot a{color:inherit}
`;

		/** Install the stylesheet once, guarded like the shipped client bundles. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const id = "dsh-cost/plugin.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cost";
			tag.dataset.pluginCss = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// #endregion

		// #region 5. Copy
		/** Locale namespace owned by this plugin. */
		const NS = "dsh-cost";

		const zh = {
			"cost.turn": "本轮",
			"cost.session": "累计",
			"cost.cache": "缓存 {percent}",
			"cost.unpriced": "未计价",
			"cost.open": "查看费用明细",
			"cost.close": "收起费用明细",
			"cost.title": "费用明细",
			"cost.model": "模型",
			"cost.window": "计费时段",
			"cost.window.peak": "高峰",
			"cost.window.offPeak": "空闲",
			"cost.line.cacheMiss": "未缓存输入",
			"cost.line.cacheHit": "缓存命中输入",
			"cost.line.cacheWrite": "缓存写入",
			"cost.line.output": "输出",
			"cost.tokensAndRate": "{tokens} tok × {rate}",
			"cost.turnTotal": "本轮合计",
			"cost.sessionTotal": "本会话累计",
			"cost.turns": "已计价 {priced}/{total} 轮",
			"cost.noUsage": "本轮暂无用量数据",
			"cost.modelFallback": "按 {model} 价格估算",
			"cost.priceList": "价格表 {date}",
			"cost.disclaimer": "按 DeepSeek 官方价目表估算，最终以账单为准。",
		};

		const en = {
			"cost.turn": "This turn",
			"cost.session": "Total",
			"cost.cache": "cache {percent}",
			"cost.unpriced": "not priced",
			"cost.open": "Show cost breakdown",
			"cost.close": "Hide cost breakdown",
			"cost.title": "Cost breakdown",
			"cost.model": "Model",
			"cost.window": "Billing window",
			"cost.window.peak": "Peak",
			"cost.window.offPeak": "Off-peak",
			"cost.line.cacheMiss": "Uncached input",
			"cost.line.cacheHit": "Cached input",
			"cost.line.cacheWrite": "Cache write",
			"cost.line.output": "Output",
			"cost.tokensAndRate": "{tokens} tok × {rate}",
			"cost.turnTotal": "Turn total",
			"cost.sessionTotal": "Conversation total",
			"cost.turns": "{priced}/{total} turns priced",
			"cost.noUsage": "No usage recorded for this turn",
			"cost.modelFallback": "estimated at {model} rates",
			"cost.priceList": "Price list {date}",
			"cost.disclaimer": "Estimated from DeepSeek's public price list; your invoice is authoritative.",
		};

		// #endregion

		// #region 6. View
		/**
		 * One completed turn's cost line, rendered in the Chat turn-tail slot right
		 * above the shipped token/time pills.
		 * @param {object} props - Slot props: owner (`turn`), standard (`useChat`), locale (`t`).
		 * @returns {object|null} The pill plus an optional inline breakdown, or null when there is nothing to show.
		 */
		function CostTurnTail(props) {
			// The guard lives in a hook-free wrapper: the slot either always carries
			// `useChat` or never does, but keeping the early return out of the body
			// means the hook order below can never be conditional.
			if (typeof props.useChat !== "function") return null;
			return jsx(CostTurnTailBody, props);
		}

		/**
		 * Body of the cost line, with the Chat selector Hook and the disclosure state.
		 * @param {object} props - Slot props: owner (`turn`), standard (`useChat`), locale (`t`).
		 * @returns {object|null} The pill plus an optional inline breakdown, or null when there is nothing to show.
		 */
		function CostTurnTailBody(props) {
			const { turn, useChat, t } = props;

			const [open, setOpen] = React.useState(false);
			const turnNumber = typeof turn?.turn === "number" ? turn.turn : -1;
			const summary = useChat(
				(snapshot) => selectCostSummary(snapshot, turnNumber),
				equalCostSummary,
			);

			const cost = summary.turnCost;
			// A completed turn with no usage still gets a line — it says so instead of
			// vanishing, so a failed or interrupted turn is not mistaken for a missing
			// one. Only a snapshot carrying no turn data at all renders nothing.
			if (cost === null && summary.totalTurns === 0) return null;

			const currency = cost?.currency ?? "CNY";
			const turnText =
				cost === null
					? null
					: cost.priced
						? `${cost.estimated ? "≈" : ""}${formatMoney(cost.total, currency)}`
						: t("cost.unpriced");
			const sessionText = formatMoney(summary.sessionTotal, currency);
			const cacheText = formatPercent(cost?.cacheHitRate ?? null);
			const hasSession = summary.pricedTurns > 0;

			// Without usage the "本轮" label folds into the message itself, so the
			// line reads "本轮暂无用量数据" instead of a bare amount slot.
			const turnPart =
				cost === null
					? jsx("span", { className: "dsh-cost-amount", children: t("cost.noUsage") })
					: jsxs("span", {
							children: [
								jsx("span", { children: t("cost.turn") }),
								jsx("span", { className: "dsh-cost-amount", children: turnText }),
							],
						});
			const sepPart = hasSession
				? jsx("span", { className: "dsh-cost-sep", "aria-hidden": true, children: "·" })
				: null;
			const sessionPart = hasSession
				? jsxs("span", {
						children: [
							jsx("span", { children: t("cost.session") }),
							jsx("span", { className: "dsh-cost-amount", children: sessionText }),
						],
					})
				: null;
			const cachePart =
				cacheText === null
					? null
					: jsx("span", {
							className: "dsh-cost-tag",
							children: t("cost.cache", { percent: cacheText }),
						});

			const pill = jsx("button", {
				type: "button",
				className: "dsh-cost-pill",
				"aria-expanded": open,
				"aria-label": open ? t("cost.close") : t("cost.open"),
				title: open ? t("cost.close") : t("cost.open"),
				onClick: () => setOpen((value) => !value),
				children: jsxs(Fragment, {
					children: [turnPart, sepPart, sessionPart, cachePart],
				}),
			});

			if (!open) {
				return jsx("div", { className: "dsh-cost-root", "data-dsh-cost": turnNumber, children: pill });
			}

			return jsx("div", {
				className: "dsh-cost-root",
				"data-dsh-cost": turnNumber,
				children: jsxs(Fragment, {
					children: [pill, renderPanel(cost, summary, t)],
				}),
			});
		}

		/**
		 * Build the inline breakdown panel.
		 * @param {object|null} cost - Current turn's cost reading.
		 * @param {object} summary - Session summary.
		 * @param {Function} t - Locale seat.
		 * @returns {object} Panel element.
		 */
		function renderPanel(cost, summary, t) {
			const currency = cost?.currency ?? "CNY";
			/**
			 * One three-column grid row: a label, its value, and an optional third
			 * cell. The Fragment carries the list key — passed as the jsx runtime's
			 * third argument, never as a prop — and adds no DOM node, so the `dt`/`dd`
			 * stay direct children of the `dl` grid.
			 */
			const row = (key, label, value, third, className) =>
				jsxs(
					Fragment,
					{
						children: [
							jsx("dt", className === undefined ? { children: label } : { className, children: label }),
							jsx("dd", {
								className: className === undefined ? "dsh-cost-num" : `dsh-cost-num ${className}`,
								children: value,
							}),
							third === undefined
								? jsx("dd", {})
								: jsx("dd", { className, children: third }),
						],
					},
					key,
				);
			const rows = [];

			rows.push(
				row(
					"turn",
					t("cost.turnTotal"),
					cost === null
						? t("cost.noUsage")
						: cost.priced
							? `${cost.estimated ? "≈" : ""}${formatMoney(cost.total, currency)}`
							: t("cost.unpriced"),
				),
			);

			if (cost !== null && cost.priced) {
				const modelText = cost.modelNote
					? `${cost.modelLabel}（${cost.modelNote}）`
					: cost.modelLabel;
				rows.push(
					row(
						"model",
						t("cost.model"),
						cost.modelMatched ? modelText : t("cost.modelFallback", { model: cost.modelLabel }),
					),
				);
				rows.push(
					row(
						"window",
						t("cost.window"),
						cost.bucket === "peak" ? t("cost.window.peak") : t("cost.window.offPeak"),
					),
				);

				for (const line of cost.lines) {
					if (line.tokens === 0 && line.cost === 0) continue;
					rows.push(
						row(
							`line-${line.key}`,
							t(COST_LINE_LABELS[line.key]),
							t("cost.tokensAndRate", {
								tokens: formatTokens(line.tokens),
								rate: formatRate(line.rate, currency),
							}),
							formatMoney(line.cost, currency),
						),
					);
				}
			}

			rows.push(
				row(
					"session",
					t("cost.sessionTotal"),
					formatMoney(summary.sessionTotal, currency),
					t("cost.turns", { priced: summary.pricedTurns, total: summary.totalTurns }),
					"dsh-cost-totalRow",
				),
			);

			if (cost !== null && cost.priced) {
				const foot = [t("cost.priceList", { date: cost.bookUpdated })];
				if (cost.bookSource) foot.push(cost.bookSource);
				foot.push(t("cost.disclaimer"));
				rows.push(
					jsx("div", { className: "dsh-cost-foot", children: foot.join(" · ") }, "foot"),
				);
			}

			return jsx("dl", {
				className: "dsh-cost-panel",
				role: "group",
				"aria-label": t("cost.title"),
				"data-dsh-cost-panel": true,
				children: rows,
			});
		}

		// #endregion

		// #region 7. Plugin body
		/** Stable Cordis plugin name. */
		const name = "dsh-cost";

		/** Client services this half needs: the slot registry and the locale registry. */
		const inject = ["slots", "locale"];

		/**
		 * Mount the browser half.
		 * @param {object} ctx - Client Cordis context.
		 */
		function apply(ctx) {
			ensureStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-cost: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.chat.turnTail", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.turnTail",
						id: "dsh-cost",
						// After the shipped plan/deliverables tails, so the cost line sits
						// closest to the token/time pills it complements.
						order: 100,
						// A thunk, re-read on every projection, so the label follows the
						// active locale without re-registering.
						label: () => t("cost.title"),
						locale: NS,
					},
					CostTurnTail,
				),
			);
		}

		// #endregion

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;

		/**
		 * Pure logic, exported for `node --test` and for other plugins that want to
		 * reuse the price registry (for example a host-side billing exporter).
		 */
		exports.__test = {
			DEEPSEEK_BOOK,
			DEEPSEEK_PEAK_WINDOWS,
			PRICE_BOOKS,
			COST_LINE_LABELS,
			registerPriceBook,
			findPriceBook,
			normalizeModelId,
			resolvePricedModel,
			deepseekBucketAt,
			beijingParts,
			setDeepSeekHolidays,
			normalizeUsage,
			turnRoutes,
			computeTurnCost,
			pricedTurn,
			selectCostSummary,
			equalCostSummary,
			costSummarySignature,
			formatMoney,
			formatRate,
			formatTokens,
			formatPercent,
			currencySymbol,
			CostTurnTail,
			CostTurnTailBody,
			zh,
			en,
		};

		return module.exports;
	},
});
