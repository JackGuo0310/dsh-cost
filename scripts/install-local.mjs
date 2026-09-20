#!/usr/bin/env node
/**
 * Install dsh-cost into a local DSH web profile.
 *
 * This plugin is not on npm yet, so the script does the two things an install
 * would do:
 *
 *   1. copy the package into `<profile>/node_modules/dsh-cost`, where the Loader's
 *      Node resolution finds it;
 *   2. append the Loader row to `<profile>/cordis.patch.yml`, which is what makes
 *      the package an active row (and therefore makes
 *      `@deepseek-ai/dsh-client-modules` serve its `/plugins/dsh-cost/client.js`).
 *
 * Usage:
 *   node scripts/install-local.mjs [--profile <dir>] [--no-patch] [--uninstall]
 *
 * The profile defaults to `$DSH_HOME/profiles/web`, then `~/.dsh/profiles/web`.
 *
 * A copy in `node_modules` is not tracked by the profile's lockfile, so a later
 * `pnpm install` there may remove it. For a durable local checkout, add
 * `"dsh-cost": "link:<this directory>"` to the profile's package.json instead and
 * re-run this script's patch step (`--no-copy` is implied by editing by hand).
 */

import { cp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root (the directory holding this script's parent). */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files and directories that make up the installed package. */
const PACKAGE_ENTRIES = ['package.json', 'lib', 'client', 'cordis.patch.yml', 'README.md', 'LICENSE'];

/** The Loader row this plugin needs, and the marker used to detect it. */
const PATCH_ENTRY = ['', '# dsh-cost — 对话费用插件（由 scripts/install-local.mjs 添加）', '- insert:', '    - id: dsh-cost', '      name: dsh-cost', ''].join('\n');

/**
 * Parse `--flag value` style arguments.
 * @param {string[]} argv - Process arguments after the script name.
 * @returns {{ profile?: string, patch: boolean, uninstall: boolean, help: boolean }} Parsed options.
 */
function parseArgs(argv) {
	const options = { patch: true, uninstall: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--profile') {
			options.profile = argv[index + 1];
			index += 1;
		} else if (arg === '--no-patch') {
			options.patch = false;
		} else if (arg === '--uninstall') {
			options.uninstall = true;
		} else if (arg === '--help' || arg === '-h') {
			options.help = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

/**
 * Resolve the DSH web profile directory.
 * @param {string|undefined} explicit - `--profile` value.
 * @returns {string} Absolute profile path.
 */
function resolveProfile(explicit) {
	if (explicit !== undefined) return resolve(explicit);
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'profiles', 'web');
}

/**
 * Whether the profile's patch file already inserts this plugin.
 * @param {string} text - Patch file contents.
 * @returns {boolean} Whether the row is already present.
 */
function alreadyPatched(text) {
	return /^\s*-?\s*name:\s*['"]?dsh-cost['"]?\s*$/m.test(text);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
	console.log(`dsh-cost installer

  node scripts/install-local.mjs [options]

  --profile <dir>   DSH web profile directory (default: $DSH_HOME/profiles/web, then ~/.dsh/profiles/web)
  --no-patch        copy the package but do not touch cordis.patch.yml
  --uninstall       remove the copied package from the profile
  -h, --help        show this message`);
	process.exit(0);
}

const profile = resolveProfile(options.profile);
const target = join(profile, 'node_modules', 'dsh-cost');

if (options.uninstall) {
	await rm(target, { recursive: true, force: true });
	console.log(`removed ${target}`);
	console.log('Remove the dsh-cost insert entry from the profile cordis.patch.yml by hand.');
	process.exit(0);
}

if (!existsSync(profile)) {
	console.error(`profile not found: ${profile}`);
	console.error('Pass --profile <dir> to point at the DSH web profile you run.');
	process.exit(1);
}

await mkdir(dirname(target), { recursive: true });
await rm(target, { recursive: true, force: true });
for (const entry of PACKAGE_ENTRIES) {
	const from = join(packageRoot, entry);
	if (!existsSync(from)) continue;
	await cp(from, join(target, entry), { recursive: true });
}
console.log(`installed ${target}`);

// Stamp the freshly copied bundle. `@deepseek-ai/dsh-client-hmr` watches this file
// and pushes a `rebuilt` frame, so an already-open page swaps in the new bundle
// without a manual reload (and without waiting for the profile patch to re-fire).
const installedBundle = join(target, 'client', 'client.js');
if (existsSync(installedBundle)) {
	const now = new Date();
	await utimes(installedBundle, now, now);
}

const patchFile = join(profile, 'cordis.patch.yml');
if (options.patch) {
	let text = existsSync(patchFile) ? await readFile(patchFile, 'utf8') : '';
	if (alreadyPatched(text)) {
		console.log(`row already present in ${patchFile}`);
	} else {
		if (text.length > 0 && !text.endsWith('\n')) text += '\n';
		await writeFile(patchFile, text + PATCH_ENTRY, 'utf8');
		console.log(`added the dsh-cost row to ${patchFile}`);
	}
} else {
	console.log(`skipped cordis.patch.yml; add this by hand:\n${PATCH_ENTRY.trimEnd()}`);
}

console.log(`
Next:
  1. Reload the DSH web page (a profile patch reloads live; if the row does not
     appear, restart \`dsh web\`).
  2. Send a message and look under the reply for "本轮 ¥… · 累计 ¥…".
  3. If nothing shows up, open the browser console and check for a
     "client-modules" or "slots" error mentioning dsh-cost.`);
