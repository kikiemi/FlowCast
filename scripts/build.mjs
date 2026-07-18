/**
 * FlowCast build.
 *
 * Outputs:
 *   dist/esm/**        - ESM modules (bundlers, Node ESM); worker source injected
 *   dist/FlowCast.js      - single-file classic script (global `FlowCast`)
 *   dist/FlowCast.min.js  - same bundle, comments stripped
 *   dist/**.d.ts       - type declarations
 *
 * The single files are self-contained: every module is compiled into one AMD
 * payload driven by the tiny loader below, and the audio worker is embedded
 * as a source string started via a Blob URL. This keeps the library working
 * from file:// pages and single-file uploads to static hosting.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const run = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const distDir = join(repoRoot, 'dist');
const esmOutDir = join(distDir, 'esm');
const tmpDir = join(distDir, '.tmp');
const localTscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const SHARED_TSC_FLAGS = [
    '--target', 'ES2022',
    '--lib', 'ES2022,DOM,DOM.Iterable',
    '--moduleResolution', 'node',
    '--strict', 'true',
    '--esModuleInterop', 'true',
    '--skipLibCheck', 'true',
    '--forceConsistentCasingInFileNames', 'true',
];

/**
 * Minimal AMD runtime for the tsc --outFile payload. define() registers a
 * module; require() instantiates on first use. The module record is cached
 * before the factory runs, matching CommonJS circular-import semantics.
 */
const AMD_LOADER = `var define, require;
(function () {
    'use strict';
    var registry = Object.create(null);
    var cache = Object.create(null);
    define = function (name, deps, factory) { registry[name] = { deps: deps, factory: factory }; };
    require = function (name) {
        if (cache[name]) return cache[name].exports;
        var record = registry[name];
        if (!record) throw new Error('FlowCast bundle: unknown module "' + name + '"');
        var module = { exports: {} };
        cache[name] = module;
        var args = record.deps.map(function (dep) {
            if (dep === 'require') return require;
            if (dep === 'exports') return module.exports;
            return require(dep);
        });
        var result = record.factory.apply(null, args);
        if (result !== undefined) module.exports = result;
        return module.exports;
    };
})();
`;

const BUNDLE_FOOTER = `
(function () {
    'use strict';
    var api = require('index');
    var globalObject = typeof globalThis !== 'undefined' ? globalThis : self;
    globalObject.FlowCast = api;
    globalObject.FlowCastReady = Promise.resolve(api);
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        try { document.dispatchEvent(new CustomEvent('flowcast:ready', { detail: api })); } catch (dispatchError) { void dispatchError; }
    }
})();
`;

async function resolveTscInvocation(extraArgs) {
    try {
        const info = await stat(localTscPath);
        if (info.isFile()) return { command: process.execPath, args: [localTscPath, ...extraArgs] };
    } catch {
        // fall through to a globally installed tsc
    }
    return { command: 'tsc', args: extraArgs };
}

async function runTsc(extraArgs, cwd = repoRoot) {
    const { command, args } = await resolveTscInvocation(extraArgs);
    await run(command, args, { cwd });
}

async function cleanDistDirectory() {
    await rm(distDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
}

/** Compile one entry (and its import graph) to a single AMD file. */
async function compileAmdBundle(entry, outFile, removeComments) {
    await runTsc([
        join(repoRoot, entry),
        '--module', 'amd',
        '--outFile', outFile,
        '--removeComments', removeComments ? 'true' : 'false',
        ...SHARED_TSC_FLAGS,
    ]);
    return readFile(outFile, 'utf8');
}

function composeWorkerScript(workerAmd) {
    return `${AMD_LOADER}${workerAmd}\nrequire('audio/custom-audio-worker');\n`;
}

function composeMainBundle(banner, workerScript, mainAmd) {
    const workerInjection = `var __FLOWCAST_AUDIO_WORKER_SOURCE__ = ${JSON.stringify(workerScript)};\n`;
    return `${banner}${workerInjection}${AMD_LOADER}${mainAmd}${BUNDLE_FOOTER}`;
}

async function buildSingleFileBundles() {
    const workerAmd = await compileAmdBundle('src/audio/custom-audio-worker.ts', join(tmpDir, 'worker.amd.js'), true);
    const workerScript = composeWorkerScript(workerAmd);

    const banner = '/*! FlowCast - browser media converter. Single-file build. */\n';
    const mainAmd = await compileAmdBundle('src/index.ts', join(tmpDir, 'main.amd.js'), false);
    const mainAmdMin = await compileAmdBundle('src/index.ts', join(tmpDir, 'main.min.amd.js'), true);

    await writeFile(join(distDir, 'FlowCast.js'), composeMainBundle(banner, workerScript, mainAmd), 'utf8');
    await writeFile(join(distDir, 'FlowCast.min.js'), composeMainBundle(banner, workerScript, mainAmdMin), 'utf8');
    return workerScript;
}

async function buildEsmJavaScript() {
    await runTsc([
        '--project', join(repoRoot, 'tsconfig.json'),
        '--outDir', esmOutDir,
        '--declaration', 'false',
        '--sourceMap', 'false',
        '--module', 'ES2022',
    ]);
}

async function listJavaScriptFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await listJavaScriptFiles(fullPath));
        else if (entry.isFile() && fullPath.endsWith('.js')) files.push(fullPath);
    }
    return files;
}

async function resolveOutputSpecifier(filePath, specifier) {
    if (!specifier.startsWith('.')) return specifier;
    const basePath = resolve(dirname(filePath), specifier);
    try {
        if ((await stat(`${basePath}.js`)).isFile()) return `${specifier}.js`;
    } catch {
        // not a file specifier
    }
    try {
        if ((await stat(basePath)).isDirectory() && (await stat(join(basePath, 'index.js'))).isFile()) {
            return `${specifier}/index.js`;
        }
    } catch {
        // not a directory specifier
    }
    return specifier;
}

/** Append .js to extensionless relative imports so browsers and Node resolve them. */
async function fixEsmSpecifiers() {
    const files = await listJavaScriptFiles(esmOutDir);
    const staticPattern = /(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g;
    for (const filePath of files) {
        let source = await readFile(filePath, 'utf8');
        const replacements = new Map();
        for (const match of source.matchAll(staticPattern)) {
            const specifier = match[2];
            if (!replacements.has(specifier)) replacements.set(specifier, await resolveOutputSpecifier(filePath, specifier));
        }
        for (const [before, after] of replacements) {
            if (before === after) continue;
            source = source.replaceAll(`'${before}'`, `'${after}'`).replaceAll(`"${before}"`, `"${after}"`);
        }
        await writeFile(filePath, source, 'utf8');
    }
}

/** Bake the worker source string into the ESM tree as well. */
async function injectWorkerSourceIntoEsm(workerScript) {
    const inlinePath = join(esmOutDir, 'audio', 'audio-worker-inline-source.js');
    const source = await readFile(inlinePath, 'utf8');
    const pattern = /typeof __FLOWCAST_AUDIO_WORKER_SOURCE__ === 'string'\s*\?\s*__FLOWCAST_AUDIO_WORKER_SOURCE__\s*:\s*''/;
    if (!pattern.test(source)) {
        throw new Error(`Worker source injection point not found in ${inlinePath}`);
    }
    await writeFile(inlinePath, source.replace(pattern, JSON.stringify(workerScript)), 'utf8');
}

async function buildTypes() {
    await runTsc([
        '--project', join(repoRoot, 'tsconfig.json'),
        '--outDir', distDir,
        '--declaration', 'true',
        '--emitDeclarationOnly', 'true',
    ]);
}

async function main() {
    await cleanDistDirectory();
    const workerScript = await buildSingleFileBundles();
    await buildEsmJavaScript();
    await fixEsmSpecifiers();
    await injectWorkerSourceIntoEsm(workerScript);
    await buildTypes();
    await rm(tmpDir, { recursive: true, force: true });
    console.log('build: dist/FlowCast.js, dist/FlowCast.min.js, dist/esm/, dist/**.d.ts');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
