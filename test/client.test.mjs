/**
 * Unit tests for the dsh-cost browser bundle.
 *
 * The bundle is a classic script, so the test stubs `window.__ModuleLoader__.load`
 * to capture the factory and then materializes it with the **real** `react` and
 * `react/jsx-runtime` modules. That means the tests run exactly the code the
 * browser runs: the pure price logic, the plugin's registration surface, and the
 * component's actual React render (through `react-test-renderer`).
 *
 * Run with: npm test   (requires `npm install` for the devDependencies)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as ReactNamespace from 'react';
import * as TestRendererNamespace from 'react-test-renderer';

const React = ReactNamespace.default ?? ReactNamespace;
const TestRenderer = TestRendererNamespace.default ?? TestRendererNamespace;

// #region Harness

/** Registrations captured from the one `__ModuleLoader__.load` call. */
let registration;

globalThis.window = {
	__ModuleLoader__: {
		load(value) {
			registration = value;
		},
	},
};

/** The two modules the bundle requires; both come from the real React package. */
const moduleTable = {
	react: React,
	'react/jsx-runtime': await import('react/jsx-runtime'),
};

/** This package's own manifest — the source of the names the module system keys on. */
const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

const pluginUrl = new URL('../client/client.js', import.meta.url);
await import(pluginUrl.href);

const plugin = registration.factory((specifier) => {
	if (!(specifier in moduleTable)) throw new Error(`unexpected require("${specifier}")`);
	return moduleTable[specifier];
});

const api = plugin.__test;

/**
 * Build the translator seat the slot framework supplies: flat `{name}` placeholders.
 *
 * Every miss is recorded, so a render can assert that no call site asked for a key
 * the dictionaries do not define (the failure mode is otherwise invisible: the UI
 * silently shows the raw key).
 * @param {Record<string, string>} dict - Locale dictionary.
 * @returns {((key: string, params?: Record<string, string|number>) => string) & { missing: string[] }} Translator.
 */
function makeT(dict) {
	const missing = [];
	const t = (key, params) => {
		if (!(key in dict)) missing.push(key);
		const template = dict[key] ?? key;
		return params === undefined
			? template
			: template.replace(/\{(\w+)\}/g, (match, name) =>
					params[name] === undefined ? match : String(params[name]),
				);
	};
	t.missing = missing;
	return t;
}

const tZh = makeT(api.zh);
const tEn = makeT(api.en);

/**
 * Every `console.error` React emitted during this run.
 *
 * The spy is installed before any test renders, because React de-duplicates most
 * warnings per message: a check that only watched its own render would pass
 * vacuously once an earlier test had already triggered the warning. The final test
 * asserts this is empty.
 */
const reactWarnings = [];
const originalConsoleError = console.error;
console.error = (...args) => {
	reactWarnings.push(args.map(String).join(' '));
};

/**
 * Stand-in for the framework's `useChat` selector Hook.
 *
 * The real seat is `useSyncExternalStoreWithSelector`; here the snapshot is a
 * plain mutable ref and the selector is memoized the same way the shim does, which
 * is what keeps the component's fresh-object selector from looping.
 * @param {() => object} readSnapshot - Reads the current fake Chat snapshot.
 * @returns {(selector: Function, equality?: Function) => unknown} Selector Hook.
 */
function makeUseChat(readSnapshot) {
	const cache = { value: undefined };
	return function useChat(selector, equality) {
		const next = selector(readSnapshot());
		if (cache.value === undefined || (equality !== undefined && !equality(cache.value, next))) {
			cache.value = next;
		}
		return cache.value;
	};
}

/**
 * Concatenate every text node under a `toJSON()` tree.
 * @param {unknown} node - Renderer JSON node.
 * @returns {string} Visible text.
 */
function textOf(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	return textOf(node.children);
}

/**
 * Render the cost line with real React.
 * @param {object} props - Slot props to render with.
 * @returns {{ renderer: object, text: string, json: object|null }} Renderer, its text, and its JSON tree.
 */
function renderTail(props) {
	let renderer;
	TestRenderer.act(() => {
		renderer = TestRenderer.create(React.createElement(api.CostTurnTail, props));
	});
	return { renderer, text: textOf(renderer.toJSON()), json: renderer.toJSON() };
}

/**
 * Find the first node in a `toJSON()` tree matching a predicate.
 * @param {unknown} node - Renderer JSON node.
 * @param {(node: object) => boolean} predicate - Match predicate.
 * @returns {object|undefined} The first match.
 */
function findNode(node, predicate) {
	if (node === null || node === undefined || typeof node !== 'object') return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findNode(child, predicate);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (predicate(node)) return node;
	return findNode(node.children, predicate);
}

/** A flash-routed, off-peak turn payload with the given token buckets. */
function tailData(overrides = {}) {
	return {
		turn: 1,
		time: at('2026-09-10T12:00:00Z'),
		tokenUsage: {
			uncachedInputTokens: 100,
			cacheReadTokens: 100,
			outputTokens: 200,
			totalTokens: 400,
			routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
		},
		...overrides,
	};
}

/** A fake Chat snapshot exposing the given turn-tail payloads. */
function snapshotOf(tails) {
	return { nodes: { values: () => tails.map((data) => ({ kind: 'turn-tail', data })) } };
}

// #endregion

// #region Bundle contract

test('bundle registers under the package name, which is the module system key', () => {
	// Cross-boundary contract: `@deepseek-ai/dsh-client-modules` looks the factory up
	// by the boot manifest entry id, and that id is the Loader row's module specifier
	// — the npm package name. Registering anything else (`dsh-cost`, say) throws
	// "loaded without registering <id>" and rejects the whole application batch.
	assert.equal(registration.id, pkg.name);
	assert.equal(plugin.name, 'dsh-cost');
	assert.deepEqual(plugin.inject, ['slots', 'locale']);
	assert.equal(typeof plugin.apply, 'function');
});

test('package.json declares the client half where dsh-client-modules looks for it', () => {
	assert.equal(pkg.dsh.client.platform, 'web');
	assert.equal(typeof pkg.exports['./client'], 'string');
	assert.ok(pkg.exports['./client'].endsWith('client.js'));
	// The declared path must be the file this test just materialized.
	assert.equal(
		fileURLToPath(new URL(`../${pkg.exports['./client']}`, import.meta.url)),
		fileURLToPath(pluginUrl),
	);
});

test('the bundle id and the cordis bundle patch agree on the package name', () => {
	// cordis.patch.yml is what makes the row exist; its `name` is the specifier the
	// Loader imports, so it has to equal the package name the bundle registers.
	const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8');
	const declared = /^\s*name:\s*'([^']+)'/m.exec(patch);
	assert.ok(declared, 'cordis.patch.yml must declare a quoted row name');
	assert.equal(declared[1], pkg.name);
});

test('apply registers dictionaries and the turn-tail entry', () => {
	const effects = [];
	const registered = [];
	const injected = [];
	const ctx = {
		effect: (fn, label) => {
			const dispose = fn();
			effects.push({ label, dispose });
			return dispose;
		},
		locale: {
			register: (ns, dicts) => {
				registered.push({ ns, dicts });
				return () => {};
			},
			bind: (ns) => (key) => `${ns}:${key}`,
		},
		slots: {
			inject: (key, callback) => {
				injected.push(key);
				callback();
			},
			register: (options, component) => {
				registered.push({ options, component });
				return () => {};
			},
		},
	};

	plugin.apply(ctx);

	const dicts = registered.find((entry) => entry.dicts);
	assert.equal(dicts.ns, 'dsh-cost');
	assert.deepEqual(Object.keys(dicts.dicts).sort(), ['en', 'zh']);

	assert.deepEqual(injected, ['conversation.chat.turnTail']);
	const entry = registered.find((item) => item.options);
	assert.equal(entry.options.name, 'conversation.chat.turnTail');
	assert.equal(entry.options.id, 'dsh-cost');
	assert.equal(entry.options.locale, 'dsh-cost');
	assert.equal(typeof entry.options.order, 'number');
	// A thunk, so the label follows the active locale without re-registering.
	assert.equal(typeof entry.options.label, 'function');
	assert.equal(entry.options.label(), 'dsh-cost:cost.title');
	assert.equal(typeof entry.component, 'function');
	assert.equal(effects.length, 1);
});

// #endregion

// #region Billing clock
//
// Beijing wall-clock times below are exact UTC offsets, because Asia/Shanghai is
// UTC+8 with no DST. 2026-09-10 is a Thursday; 2026-09-12 is a Saturday.

test('peak windows are Beijing 09:00-12:00 and 14:00-18:00 on weekdays', () => {
	assert.equal(api.deepseekBucketAt(at('2026-09-10T01:00:00Z')), 'peak', 'Beijing 09:00 is inclusive');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T03:59:00Z')), 'peak');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T04:00:00Z')), 'offPeak', 'Beijing 12:00 is exclusive');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T06:00:00Z')), 'peak', 'Beijing 14:00 is inclusive');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T09:59:00Z')), 'peak');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T10:00:00Z')), 'offPeak', 'Beijing 18:00 is exclusive');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T12:00:00Z')), 'offPeak', 'Beijing 20:00');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T00:00:00Z')), 'offPeak', 'Beijing 08:00');
});

test('weekends are always off-peak', () => {
	assert.equal(api.deepseekBucketAt(at('2026-09-12T02:00:00Z')), 'offPeak', 'Saturday 10:00');
	assert.equal(api.deepseekBucketAt(at('2026-09-13T06:00:00Z')), 'offPeak', 'Sunday 14:00');
});

test('the shipped 2026 holidays are off-peak by default', () => {
	assert.equal(api.deepseekBucketAt(at('2026-10-01T02:00:00Z')), 'offPeak', 'National Day, Thursday 10:00');
	assert.equal(api.deepseekBucketAt(at('2026-02-18T02:00:00Z')), 'offPeak', 'Spring Festival weekday');
	assert.equal(api.deepseekBucketAt(at('2026-09-10T02:00:00Z')), 'peak', 'plain Thursday stays peak');
});

test('the holiday set can be replaced', () => {
	api.setDeepSeekHolidays(['2026-09-10']);
	try {
		assert.equal(api.deepseekBucketAt(at('2026-09-10T02:00:00Z')), 'offPeak');
		assert.equal(api.deepseekBucketAt(at('2026-10-01T02:00:00Z')), 'peak', 'replacing drops the shipped entries');
	} finally {
		api.setDeepSeekHolidays(api.DEEPSEEK_HOLIDAYS_2026);
	}
	assert.equal(api.deepseekBucketAt(at('2026-10-01T02:00:00Z')), 'offPeak', 'shipped list restored');
});

/**
 * Parse one UTC instant.
 *
 * Asia/Shanghai is UTC+8 with no DST, so Beijing wall-clock times are exact UTC
 * offsets. 2026-09-10 is a Thursday; 2026-09-12 is a Saturday.
 * @param {string} iso - UTC ISO instant.
 * @returns {number} Epoch ms.
 */
const at = (iso) => Date.parse(iso);

// #endregion

// #region Cost math

/** A flash-routed turn at one instant. */
function turn(usage, model = 'deepseek-flash', iso = '2026-09-10T12:00:00Z') {
	return {
		turn: 1,
		time: at(iso),
		tokenUsage: { routes: [{ provider: 'deepseek-official', model }], ...usage },
	};
}

test('cost is tokens/1e6 x rate, summed over the four DeepSeek buckets', () => {
	// Off-peak flash: miss ¥1, hit ¥0.02, output ¥4 per 1M.
	const offPeak = api.computeTurnCost(
		turn({
			uncachedInputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			outputTokens: 1_000_000,
			totalTokens: 3_000_000,
		}),
	);
	assert.equal(offPeak.priced, true);
	assert.equal(offPeak.bucket, 'offPeak');
	assert.equal(offPeak.model, 'deepseek-flash');
	assert.equal(offPeak.modelMatched, true);
	assert.equal(offPeak.estimated, false);
	assert.ok(Math.abs(offPeak.total - 5.02) < 1e-9, `expected 5.02, got ${offPeak.total}`);

	// Peak flash: miss ¥2, hit ¥0.04, output ¥8 per 1M.
	const peak = api.computeTurnCost(
		turn(
			{
				uncachedInputTokens: 1_000_000,
				cacheReadTokens: 1_000_000,
				outputTokens: 1_000_000,
				totalTokens: 3_000_000,
			},
			'deepseek-flash',
			'2026-09-10T02:00:00Z',
		),
	);
	assert.equal(peak.bucket, 'peak');
	assert.ok(Math.abs(peak.total - 10.04) < 1e-9, `expected 10.04, got ${peak.total}`);
});

test('deepseek-v4-pro uses its own price list', () => {
	const cost = api.computeTurnCost(
		turn(
			{
				uncachedInputTokens: 1_000_000,
				cacheReadTokens: 1_000_000,
				outputTokens: 1_000_000,
				totalTokens: 3_000_000,
			},
			'deepseek-v4-pro',
		),
	);
	assert.equal(cost.model, 'deepseek-v4-pro');
	// Off-peak pro: miss ¥4.5 + hit ¥0.15 + output ¥13.5 per 1M.
	assert.ok(Math.abs(cost.total - 18.15) < 1e-9, `expected 18.15, got ${cost.total}`);
});

test('cache writes are free on DeepSeek and legacy ids are priced', () => {
	const cost = api.computeTurnCost(
		turn({
			uncachedInputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 1_000_000,
			outputTokens: 0,
			totalTokens: 1_000_000,
		}),
	);
	assert.equal(cost.total, 0);

	const legacy = api.computeTurnCost(
		turn({ uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, 'deepseek-chat'),
	);
	assert.equal(legacy.model, 'deepseek-chat');
	assert.equal(legacy.modelMatched, true);
	assert.ok(Math.abs(legacy.total - 1) < 1e-9);
});

test('unknown model ids fall back to the book fallback and are marked estimated', () => {
	const cost = api.computeTurnCost(
		turn({ uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, 'deepseek-turbo'),
	);
	assert.equal(cost.priced, true);
	assert.equal(cost.model, 'deepseek-flash');
	assert.equal(cost.modelMatched, false);
	assert.equal(cost.estimated, true);
	assert.ok(Math.abs(cost.total - 1) < 1e-9);
});

test('model ids are matched through vendor prefixes and aliases', () => {
	assert.equal(api.normalizeModelId('DeepSeek/DeepSeek-V4-Pro'), 'deepseek-v4-pro');
	const cost = api.computeTurnCost(
		turn(
			{ uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
			'deepseek-ai/DeepSeek-V4-Flash',
		),
	);
	assert.equal(cost.model, 'deepseek-flash');
	assert.equal(cost.modelMatched, true);
});

test('a multi-route turn is priced with the first route and flagged estimated', () => {
	const data = {
		turn: 1,
		time: at('2026-09-10T12:00:00Z'),
		tokenUsage: {
			uncachedInputTokens: 1_000_000,
			outputTokens: 0,
			totalTokens: 1_000_000,
			routes: [
				{ provider: 'deepseek-official', model: 'deepseek-flash' },
				{ provider: 'deepseek-official', model: 'deepseek-v4-pro' },
			],
		},
	};
	const cost = api.computeTurnCost(data);
	assert.equal(cost.estimated, true);
	assert.ok(Math.abs(cost.total - 1) < 1e-9);
});

test('other providers report "not priced" instead of guessing', () => {
	const cost = api.computeTurnCost(
		turn({ uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }, 'gpt-5.5'),
	);
	// The provider field still says deepseek-official, so the book owns the route.
	assert.equal(cost.priced, true);

	const foreign = api.computeTurnCost({
		turn: 1,
		time: at('2026-09-10T12:00:00Z'),
		tokenUsage: {
			uncachedInputTokens: 1_000_000,
			outputTokens: 0,
			totalTokens: 1_000_000,
			routes: [{ provider: 'openai-codex', model: 'gpt-5.5' }],
		},
	});
	assert.equal(foreign.priced, false);
	assert.equal(foreign.reason, 'no-price-book');
	assert.equal(foreign.total, 0);
});

test('a new provider can be registered without touching the shipped book', () => {
	const dispose = api.registerPriceBook({
		id: 'test-provider',
		label: 'Test',
		currency: 'USD',
		updated: '2026-01-01',
		source: 'https://example.invalid',
		match: (route) => route.provider === 'test-provider',
		bucketAt: () => 'offPeak',
		fallbackModelId: 'test-small',
		models: [
			{
				id: 'test-small',
				label: 'Test Small',
				names: ['test-small'],
				rates: { offPeak: { cacheHit: 0, cacheMiss: 1, cacheWrite: 0, output: 2 } },
			},
		],
	});
	try {
		const cost = api.computeTurnCost({
			turn: 1,
			time: at('2026-09-10T12:00:00Z'),
			tokenUsage: {
				uncachedInputTokens: 1_000_000,
				outputTokens: 1_000_000,
				totalTokens: 2_000_000,
				routes: [{ provider: 'test-provider', model: 'test-small' }],
			},
		});
		assert.equal(cost.priced, true);
		assert.equal(cost.currency, 'USD');
		assert.equal(cost.book, 'test-provider');
		assert.ok(Math.abs(cost.total - 3) < 1e-9);
	} finally {
		dispose();
	}
	assert.equal(api.findPriceBook({ provider: 'test-provider', model: 'test-small' }), undefined);
});

test('routes fall back to the closing assistant provider metadata', () => {
	const data = {
		turn: 3,
		time: at('2026-09-10T12:00:00Z'),
		tokenUsage: { uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
		closing: {
			finalNode: {
				providerMetadata: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
			},
		},
	};
	const cost = api.computeTurnCost(data);
	assert.equal(cost.model, 'deepseek-v4-pro');
	assert.ok(Math.abs(cost.total - 4.5) < 1e-9);
});

test('usage buckets survive missing or malformed fields', () => {
	const buckets = api.normalizeUsage({ uncachedInputTokens: 10, cacheReadTokens: 'x', outputTokens: -5 });
	assert.deepEqual(buckets, {
		cacheMiss: 10,
		cacheHit: 0,
		cacheWrite: 0,
		output: 0,
		reasoning: 0,
		hasCacheHit: false,
		hasCacheWrite: false,
	});
});

// #endregion

// #region Snapshot selection

test('the summary reports the addressed turn and the running total', () => {
	const cheap = {
		turn: 1,
		time: at('2026-09-10T12:00:00Z'),
		tokenUsage: {
			uncachedInputTokens: 1_000_000,
			outputTokens: 0,
			totalTokens: 1_000_000,
			routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
		},
	};
	const dear = {
		turn: 2,
		time: at('2026-09-10T12:00:00Z'),
		tokenUsage: {
			uncachedInputTokens: 1_000_000,
			outputTokens: 0,
			totalTokens: 1_000_000,
			routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
		},
	};
	const unstable = { turn: 3, time: at('2026-09-10T12:00:00Z'), closing: null };

	const first = api.selectCostSummary(snapshotOf([cheap, dear, unstable]), 1);
	assert.equal(first.totalTurns, 3);
	assert.equal(first.pricedTurns, 2);
	assert.equal(first.unpricedTurns, 1);
	assert.equal(first.turnHasUsage, true);
	assert.ok(Math.abs(first.turnCost.total - 1) < 1e-9);
	assert.ok(Math.abs(first.sessionTotal - 5.5) < 1e-9);

	// The same numbers must produce the same signature, so `useChat` does not
	// re-render on every snapshot pass.
	const again = api.selectCostSummary(snapshotOf([cheap, dear, unstable]), 1);
	assert.equal(again.signature, first.signature);
	assert.equal(api.equalCostSummary(first, again), true);

	// A different turn (and therefore a different running total) must not.
	const third = api.selectCostSummary(snapshotOf([cheap, dear, unstable]), 2);
	assert.notEqual(third.signature, first.signature);
	assert.equal(api.equalCostSummary(first, third), false);
	assert.ok(Math.abs(third.turnCost.total - 4.5) < 1e-9);
});

test('turns without usage are counted but never charged', () => {
	const summary = api.selectCostSummary(snapshotOf([{ turn: 1 }, { turn: 2, tokenUsage: undefined }]), 1);
	assert.equal(summary.totalTurns, 2);
	assert.equal(summary.pricedTurns, 0);
	assert.equal(summary.unpricedTurns, 2);
	assert.equal(summary.sessionTotal, 0);
	assert.equal(summary.turnCost, null);
	assert.equal(summary.turnHasUsage, false);
});

test('a snapshot without a node store degrades to an empty summary', () => {
	const summary = api.selectCostSummary(undefined, 1);
	assert.equal(summary.totalTurns, 0);
	assert.equal(summary.sessionTotal, 0);
	assert.equal(summary.turnCost, null);
});

// #endregion

// #region Formatting

test('money formatting keeps sub-cent turns readable', () => {
	assert.equal(api.formatMoney(0, 'CNY'), '¥0');
	assert.equal(api.formatMoney(5.5, 'CNY'), '¥5.500');
	assert.equal(api.formatMoney(0.0998, 'CNY'), '¥0.0998');
	assert.equal(api.formatMoney(0.0000312, 'CNY'), '¥0.0000312');
	assert.equal(api.formatMoney(1.5, 'USD'), '$1.500');
});

test('rates and token counts stay compact', () => {
	assert.equal(api.formatRate(2, 'CNY'), '¥2/M');
	assert.equal(api.formatRate(0.04, 'CNY'), '¥0.04/M');
	assert.equal(api.formatRate(13.5, 'CNY'), '¥13.5/M');
	assert.equal(api.formatTokens(999), '999');
	assert.equal(api.formatTokens(1234), '1.2k');
	assert.equal(api.formatTokens(2_200_000), '2.2M');
	assert.equal(api.formatPercent(0.9231), '92%');
	assert.equal(api.formatPercent(null), null);
});

// #endregion

// #region Memoization

test('per-turn pricing is memoized by payload identity', () => {
	const data = tailData();
	const first = api.pricedTurn(data);
	const second = api.pricedTurn(data);
	// Same reading object, so the session total never re-derives an unchanged turn.
	assert.equal(first, second);
});

test('changing a price book invalidates memoized turn readings', () => {
	const data = tailData();
	const before = api.pricedTurn(data);
	assert.ok(Math.abs(before.total - 0.000902) < 1e-12, `got ${before.total}`);

	// Replace the DeepSeek book with doubled prices, as a user overriding rates would.
	const dispose = api.registerPriceBook({
		...api.DEEPSEEK_BOOK,
		models: api.DEEPSEEK_BOOK.models.map((model) => ({
			...model,
			rates: Object.fromEntries(
				Object.entries(model.rates).map(([bucket, rates]) => [
					bucket,
					Object.fromEntries(Object.entries(rates).map(([key, value]) => [key, value * 2])),
				]),
			),
		})),
	});
	try {
		const during = api.pricedTurn(data);
		assert.notEqual(during, before, 'cache must not survive a registry change');
		assert.ok(Math.abs(during.total - 0.001804) < 1e-12, `got ${during.total}`);
		const again = api.pricedTurn(data);
		assert.equal(again, during, 'the new reading is memoized in turn');
	} finally {
		dispose();
	}

	// Disposing restores the shipped book and invalidates again.
	const after = api.pricedTurn(data);
	assert.ok(Math.abs(after.total - 0.000902) < 1e-12, `got ${after.total}`);
});

// #endregion

// #region Render

test('the pill shows the turn cost, the conversation total, and the cache hit rate', () => {
	const data = tailData();
	const useChat = makeUseChat(() => snapshotOf([data]));
	const { text, json } = renderTail({ turn: { turn: 1 }, useChat, t: tZh });

	assert.equal(json.type, 'div');
	assert.equal(json.props['data-dsh-cost'], 1);
	assert.match(text, /本轮/);
	assert.match(text, /¥0\.000902/);
	assert.match(text, /累计/);
	assert.match(text, /缓存 50%/);

	const button = findNode(json, (node) => node.type === 'button');
	assert.equal(button.props['aria-expanded'], false);
	assert.equal(button.props['aria-label'], '查看费用明细');
	// Closed: the breakdown panel is not in the tree at all.
	assert.equal(findNode(json, (node) => node.props['data-dsh-cost-panel'] === true), undefined);
});

test('clicking the pill opens the full breakdown', () => {
	const data = tailData();
	const useChat = makeUseChat(() => snapshotOf([data]));
	const localT = makeT(api.zh);
	const { renderer } = renderTail({ turn: { turn: 1 }, useChat, t: localT });

	const button = findNode(renderer.toJSON(), (node) => node.type === 'button');
	TestRenderer.act(() => {
		button.props.onClick();
	});

	const json = renderer.toJSON();
	const text = textOf(json);
	assert.equal(findNode(json, (node) => node.type === 'button').props['aria-expanded'], true);

	const panel = findNode(json, (node) => node.props['data-dsh-cost-panel'] === true);
	assert.notEqual(panel, undefined);
	assert.equal(panel.props['aria-label'], '费用明细');

	for (const expected of [
		'本轮合计',
		'模型',
		'DeepSeek Flash',
		'计费时段',
		'空闲',
		'未缓存输入',
		'100 tok × ¥1/M',
		'缓存命中输入',
		'100 tok × ¥0.02/M',
		'输出',
		'200 tok × ¥4/M',
		'本会话累计',
		'已计价 1/1 轮',
		'价格表 2026-09-10',
		'api-docs.deepseek.com',
	]) {
		assert.ok(text.includes(expected), `breakdown should include ${JSON.stringify(expected)} — got ${text}`);
	}
	// Zero-cost buckets are omitted rather than listed as ¥0.
	assert.ok(!text.includes('缓存写入'), `cache writes are free and should be hidden — got ${text}`);
	// The whole point: no call site may ask for a key the dictionaries lack.
	assert.deepEqual(localT.missing, []);
});

test('the arithmetic in the breakdown adds up to the pill total', () => {
	const data = tailData();
	const useChat = makeUseChat(() => snapshotOf([data]));
	const cost = api.pricedTurn(data);
	const sum = cost.lines.reduce((total, line) => total + line.cost, 0);
	assert.ok(Math.abs(sum - cost.total) < 1e-12);
	assert.equal(api.formatMoney(sum, cost.currency), '¥0.000902');
});

test('the session total accumulates every loaded turn', () => {
	const first = tailData({ turn: 1 });
	const second = tailData({
		turn: 2,
		tokenUsage: {
			uncachedInputTokens: 1_000_000,
			outputTokens: 0,
			totalTokens: 1_000_000,
			routes: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
		},
	});
	const useChat = makeUseChat(() => snapshotOf([first, second]));

	const onFirstTurn = renderTail({ turn: { turn: 1 }, useChat, t: tZh });
	assert.match(onFirstTurn.text, /¥0\.000902/);
	// Above ¥1 the display keeps three decimals, so sub-mill-yuan detail is dropped.
	assert.match(onFirstTurn.text, /累计.*¥4\.501/s);

	const onSecondTurn = renderTail({ turn: { turn: 2 }, useChat, t: tZh });
	assert.match(onSecondTurn.text, /本轮.*¥4\.5/s);
	assert.match(onSecondTurn.text, /累计.*¥4\.501/s);
});

test('a turn with no usage says so instead of rendering nothing', () => {
	const useChat = makeUseChat(() => snapshotOf([{ turn: 1, time: at('2026-09-10T12:00:00Z') }]));
	const { text } = renderTail({ turn: { turn: 1 }, useChat, t: tZh });
	assert.match(text, /本轮暂无用量数据/);
	assert.doesNotMatch(text, /累计/);
	assert.doesNotMatch(text, /¥/);
});

test('a no-usage turn still shows the running session total', () => {
	const first = tailData({ turn: 1 });
	const second = { turn: 2, time: at('2026-09-10T12:00:00Z') };
	const useChat = makeUseChat(() => snapshotOf([first, second]));
	const { text } = renderTail({ turn: { turn: 2 }, useChat, t: tZh });
	assert.match(text, /本轮暂无用量数据/);
	assert.match(text, /累计.*¥0\.000902/s);
});

test('a slot without useChat renders nothing instead of throwing', () => {
	const { json } = renderTail({ turn: { turn: 1 }, t: tZh });
	assert.equal(json, null);
});

test('an unpriced provider shows "未计价" and no cumulative figure', () => {
	const data = tailData({
		turn: 1,
		tokenUsage: {
			uncachedInputTokens: 10,
			outputTokens: 10,
			totalTokens: 20,
			routes: [{ provider: 'openai-codex', model: 'gpt-5.5' }],
		},
	});
	const useChat = makeUseChat(() => snapshotOf([data]));
	const { text } = renderTail({ turn: { turn: 1 }, useChat, t: tZh });
	assert.match(text, /本轮.*未计价/s);
	assert.ok(!text.includes('累计'), `nothing priced, so no total — got ${text}`);
});

test('an estimated turn is marked with a tilde', () => {
	const data = tailData({ turn: 1 });
	data.tokenUsage.routes = [{ provider: 'deepseek-official', model: 'deepseek-turbo' }];
	const useChat = makeUseChat(() => snapshotOf([data]));
	const { text } = renderTail({ turn: { turn: 1 }, useChat, t: tZh });
	assert.match(text, /本轮.*≈¥0\.000902/s);
});

test('the English locale renders English copy', () => {
	const data = tailData();
	const useChat = makeUseChat(() => snapshotOf([data]));
	const localT = makeT(api.en);
	const { renderer, text } = renderTail({ turn: { turn: 1 }, useChat, t: localT });
	assert.match(text, /This turn/);
	assert.match(text, /Total/);
	assert.match(text, /cache 50%/);

	const button = findNode(renderer.toJSON(), (node) => node.type === 'button');
	TestRenderer.act(() => {
		button.props.onClick();
	});
	const openText = textOf(renderer.toJSON());
	assert.match(openText, /Cost breakdown|Turn total/);
	assert.deepEqual(localT.missing, []);
});

test('the dictionaries stay in sync', () => {
	assert.deepEqual(Object.keys(api.zh).sort(), Object.keys(api.en).sort());
});

test('every cost bucket the UI can list has a label in both dictionaries', () => {
	for (const key of Object.values(api.COST_LINE_LABELS)) {
		assert.ok(key in api.zh, `${key} missing from zh`);
		assert.ok(key in api.en, `${key} missing from en`);
	}
});

test('no React warning was emitted by any render in this file', () => {
	// Restored first, so a failure below reports through the real console.
	console.error = originalConsoleError;
	assert.deepEqual(reactWarnings, []);
});

// #endregion
