/**
 * dsh-cost — host half.
 *
 * The feature is browser-only: every contribution (the per-turn cost line and the
 * price registry) lives in the client half at `./client`. This module exists so
 * the package is a loadable Loader row, which is what makes the client bundle
 * discoverable: `@deepseek-ai/dsh-client-modules` only serves `/plugins/<id>/client.js`
 * for packages that appear as active Loader entries and declare `dsh.client`.
 *
 * Add host-side work here only when it genuinely needs the Node side, for example
 * reading a price table from disk or exposing a `host.call` handler. Keep the
 * browser half free of Node imports.
 */

/** Stable Cordis plugin name; must match the row `name` used in cordis.patch.yml. */
export const name = 'dsh-cost';

/** No host services are required. */
export const inject = [];

/**
 * Mount the host half.
 *
 * Intentionally empty: the plugin contributes nothing on the Node side yet.
 * @param _ctx - Cordis host context (unused).
 */
export function apply(_ctx) {}
