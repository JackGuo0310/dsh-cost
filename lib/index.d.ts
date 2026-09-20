/**
 * dsh-cost — host half type surface.
 *
 * The runtime host half is an empty Cordis plugin; it exists so the package is a
 * Loader row and its `./client` bundle gets served to the browser.
 */

import type { Context } from '@deepseek-ai/cordis';

/** Stable Cordis plugin name. */
export declare const name: string;

/** Required host services (none). */
export declare const inject: string[];

/**
 * Mount the host half.
 * @param ctx - Cordis host context.
 */
export declare function apply(ctx: Context): void;
