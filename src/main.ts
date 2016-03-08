/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import { ThroughStream } from 'through';
import { through } from 'event-stream';
import File = require('vinyl');

import { KeyInfo, MessageBundle, processFile, resolveMessageBundle, createLocalizedMessages } from './lib';

interface FileWithSourceMap extends File {
	sourceMap: any;
}

const NLS_JSON = '.nls.json';

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
						path: file.path.substr(0, file.path.length - ext.length) + NLS_JSON,
						contents: new Buffer(JSON.stringify(result.bundle, null, '\t'), 'utf8')
					});
				}
			}
			this.emit('data', file);
			if (bundleFile) {
				this.emit('data', bundleFile);
			}
		}
	);
}

const iso639_3_to_2 = {
	'chs': 'zh-cn',
	'cht': 'zh-tw',
	'csy': 'cs-cz',
	'deu': 'de',
	'enu': 'en',
	'esn': 'es',
	'fra': 'fr',
	'hun': 'hu',
	'ita': 'it',
	'jpn': 'ja',
	'kor': 'ko',
	'nld': 'nl',
	'plk': 'pl',
	'ptb': 'pt-br',
	'ptg': 'pt',
	'rus': 'ru',
	'sve': 'sv-se',
	'trk': 'tr'
};

export function createAdditionalLanguageFiles(languages: string[], i18nBaseDir: string, component: string): ThroughStream {
	return through(function(file: File) {
		let basename = path.basename(file.path);
		if (basename.length < NLS_JSON.length || NLS_JSON !== basename.substr(basename.length - NLS_JSON.length)) {
			this.emit('data', file);
			return;
		}
		let filename = file.path.substr(0, file.path.length - NLS_JSON.length);
		let json;
		if (file.isBuffer()) {
			json = JSON.parse(file.contents.toString('utf8'));
			let resolvedBundle = resolveMessageBundle(json);
			languages.forEach((language) => {
				let messages = createLocalizedMessages(filename, resolvedBundle, language, i18nBaseDir, component);
				if (messages) {
					this.emit('data', new File({
						base: file.base,
						path: filename + '.nls.' + iso639_3_to_2[language] + '.json',
						contents: new Buffer(JSON.stringify(messages, null, '\t').replace(/\r\n/g, '\n'), 'utf8')
					}));
				}
 			});
		} else {
			this.emit('error', `Failed to read component file: ${file.relative}`)
		}
		this.emit('data', file);
	});
}