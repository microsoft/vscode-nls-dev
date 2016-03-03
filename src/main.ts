/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import { ThroughStream } from 'through';
import { through } from 'event-stream';
import File = require('vinyl');

import { KeyInfo, MessageBundle, processFile } from './lib';

export { KeyInfo, MessageBundle, processFile };

interface FileWithSourceMap extends File {
	sourceMap: any;
}

export function rewriteLocalizeCalls(): ThroughStream {
	return through(
		function (file: FileWithSourceMap) {
			if (!file.isBuffer()) {
				this.emit('error', `Failed to read file: ${file.relative}`);
			}
			let content = file.contents.toString('utf8');
			let sourceMap = file.sourceMap;
			
			let result = processFile(content, sourceMap);
			let bundleFile: File;
			if (result.errors && result.errors.length > 0) {
				result.errors.forEach(error => console.error(`${file.relative}${error}`));
				this.emit('error', `Failed to rewite file: ${file.relative}`);
			} else {
				if (result.contents) {
					file.contents = new Buffer(result.contents, 'utf8');
				}
				if (result.sourceMap) {
					file.sourceMap = JSON.parse(result.sourceMap);
				}
				if (result.bundle) {
					let ext = path.extname(file.path);
					bundleFile = new File({
						base: file.base,
						path: file.path.substr(0, file.path.length - ext.length) + '.nls.json',
						contents: new Buffer(JSON.stringify(result.bundle, null, 4), 'utf8')
					});
				}
			}
			this.emit('data', file);
			if (bundleFile) {
				this.emit('data', bundleFile);
			}
		},
		function () {
		}
	);
}