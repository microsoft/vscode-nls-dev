#!/usr/bin/env node
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

import * as yargs from 'yargs';
import * as glob from 'glob';

import { processFile } from './lib';

const argv = yargs
	.usage('Usage: vscl [options] files')
	.option('outDir', {
		alias: 'o',
		describe: 'The output directory. If not specified the files are overwritten in place.',
		string: true,
		demand: false
	})
	.option('rootDir', {
		alias: 'r',
		describe: 'The root directory of the sources. Only honored when outDir is set.',
		string: true,
		demand: false
	})
	.option('keepFilenames', {
		describe: 'Inline filenames when making localization calls. Only honored when rootDir is set.',
		boolean: true,
		demand: false
	}).parseSync();

let hasError: boolean = false;
const outDir = argv.outDir ? path.resolve(argv.outDir) : null;
const rootDir = argv.rootDir ? path.resolve(argv.rootDir) : null;
const keepFilenames = Boolean(argv.keepFilenames);

argv._.forEach(element => {
	if (typeof element === 'number') {
		return;
	}
	glob(element, (err, matches) => {
		if (err) {
			console.error(err.message);
			hasError = true;
			return;
		}
		matches.forEach(file => {
			const resolvedFile = path.resolve(file);
			const contents: string = fs.readFileSync(resolvedFile, 'utf8');

			let sourceMapFile: string | null = null;
			let resolvedSourceMapFile: string | null = null;
			let sourceMapContent: string | undefined = undefined;

			const sourceMapMatches = contents.match(/\/\/#\s+sourceMappingURL=(.*)(?:\r?\n|\n|$)/);
			if (sourceMapMatches && sourceMapMatches.length === 2) {
				let sourceMapUrl = url.parse(sourceMapMatches[1]);
				// For now we only support relative paths
				if (sourceMapUrl.protocol || sourceMapUrl.host) {
					console.error(`${file}: protocol or host based source map URLs are not supported.`);
					hasError = true;
				}
				const pathname = sourceMapUrl.pathname;
				if (pathname) {
					if (path.isAbsolute(pathname)) {
						resolvedSourceMapFile = pathname;
					} else {
						sourceMapFile = pathname;
						resolvedSourceMapFile = path.join(path.dirname(file), sourceMapFile);
					}
				}
				if (resolvedSourceMapFile && fs.existsSync(resolvedSourceMapFile)) {
					sourceMapContent = fs.readFileSync(resolvedSourceMapFile, 'utf8');
				}
			}

			const relativeFilename = keepFilenames && rootDir ? path.relative(rootDir, resolvedFile) : undefined;
			const result = processFile(contents, relativeFilename, sourceMapContent);

			if (result.errors && result.errors.length > 0) {
				result.errors.forEach(error => console.error(`${file}${error}`));
				hasError = true;
			} else {
				let outFile = resolvedFile;
				let sourceMapOutFile = resolvedSourceMapFile;
				if (outDir) {
					if (rootDir && resolvedFile.substring(0, rootDir.length) === rootDir) {
						outFile = path.join(outDir, resolvedFile.substring(rootDir.length));
					} else {
						outFile = path.join(outDir, file);
					}
					if (sourceMapFile) {
						sourceMapOutFile = path.join(outDir, sourceMapFile);
					}
				}
				if (result.contents) {
					const dirname = path.dirname(outFile);
					if (!fs.existsSync(dirname)) {
						fs.mkdirSync(path.dirname(outFile));
					}
					fs.writeFileSync(outFile, result.contents, { encoding: 'utf8' });
				}
				if (sourceMapOutFile && result.sourceMap) {
					fs.writeFileSync(sourceMapOutFile, result.sourceMap, { encoding: 'utf8' });
				}
				if (result.bundle) {
					const extension = path.extname(outFile);
					const bundledFile = outFile.substr(0, outFile.length - extension.length) + '.nls.json';
					fs.writeFileSync(bundledFile, JSON.stringify(result.bundle, null, 4), { encoding: 'utf8' });
				}
			}
		});
	});
});
if (hasError) {
	process.exit(1);
}
