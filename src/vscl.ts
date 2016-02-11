//#!/usr/bin/env node
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

import { processFile } from './main';


let argv = yargs
	.usage('Usage: vscl [options] files')
	.option('outDir', {
		alias: 'o',
		describe: 'The output directory. If not specified the files are overwriten in place.',
		demand: false
	})
	.option('rootDir', {
		alias: 'r',
		describe: 'The root directory of the sources. Only honored when outDir is set.',
		demand: false
	})
	.argv;

let hasError: boolean = false;
let outDir = argv.outDir ? path.resolve(argv.outDir) : null;
let rootDir = argv.rootDir ? path.resolve(argv.rootDir) : null;

argv._.forEach(element => {
	glob(element, (err, matches) => {
		if (err) {
			console.error(err.message);
			hasError = true;
			return;
		}
		matches.forEach(file => {
			let resolvedFile = path.resolve(file);
			let contents: string = fs.readFileSync(resolvedFile, 'utf8');
			
			let sourceMapFile: string = null;
			let resolvedSourceMapFile: string = null;
			let sourceMapContent: string = undefined;
			
			let sourceMapMatches = contents.match(/\/\/#\s+sourceMappingURL=(.*)(?:\r?\n|\n|$)/);
			if (sourceMapMatches && sourceMapMatches.length === 2) {
				let sourceMapUrl = url.parse(sourceMapMatches[1]);
				// For now we only support relative pathes
				if (sourceMapUrl.protocol || sourceMapUrl.host) {
					console.error(`${file}: protocol or host based source map URLs are not supported.`);
					hasError = true;
				}
				let pathname = sourceMapUrl.pathname;
				if (path.isAbsolute(pathname)) {
					resolvedSourceMapFile = pathname;
				} else {
					sourceMapFile = pathname;
					resolvedSourceMapFile = path.join(path.dirname(file), sourceMapFile);
				}
				if (fs.existsSync(resolvedSourceMapFile)) {
					sourceMapContent = fs.readFileSync(resolvedSourceMapFile, 'utf8');
				}
			}
			let result = processFile(contents, sourceMapContent);
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
				let dirname = path.dirname(outFile);
				if (!fs.existsSync(dirname)) {
					fs.mkdirSync(path.dirname(outFile));
				}
				fs.writeFileSync(outFile, result.contents, { encoding: 'utf8' });
				if (sourceMapOutFile) {
					fs.writeFileSync(sourceMapOutFile, result.sourceMap, { encoding: 'utf8' });
				}
				let extension = path.extname(outFile);
				let bundlefile = outFile.substr(0, outFile.length - extension.length) + '.nls.json';
				fs.writeFileSync(bundlefile, JSON.stringify(result.bundle, null, 4), { encoding: 'utf8' });
			}
		});
	});
});
if (hasError) {
	process.exit(1);
}