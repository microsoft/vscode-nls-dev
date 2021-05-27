/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { through, ThroughStream } from 'event-stream';
import * as Is from 'is';
import * as path from 'path';
import { ThroughStream as _ThroughStream } from 'through';
import * as xml2js from 'xml2js';
import {
	bundle2keyValuePair, createLocalizedMessages, JavaScriptMessageBundle, KeyInfo, Map, processFile, resolveMessageBundle, removePathPrefix, BundledMetaDataHeader,
	BundledMetaDataFile, SingleMetaDataFile, BundledMetaDataEntry, MetaDataBundler
} from './lib';
import File = require('vinyl');
import * as fancyLog from 'fancy-log';
import * as ansiColors from 'ansi-colors';

function log(message: any, ...rest: any[]): void {
	fancyLog(ansiColors.cyan('[i18n]'), message, ...rest);
}

interface FileWithSourceMap extends File {
	sourceMap: any;
}

const NLS_JSON = '.nls.json';
const NLS_METADATA_JSON = '.nls.metadata.json';
const I18N_JSON = '.i18n.json';

export function rewriteLocalizeCalls(): ThroughStream {
	return through(
		function (this: ThroughStream, file: FileWithSourceMap) {
			if (!file.isBuffer()) {
				this.emit('error', `Failed to read file: ${file.relative}`);
				return;
			}
			const buffer: Buffer = file.contents as Buffer;
			const content = buffer.toString('utf8');
			const sourceMap = file.sourceMap;

			const result = processFile(content, undefined, sourceMap);
			let messagesFile: File | undefined;
			let metaDataFile: File | undefined;
			if (result.errors && result.errors.length > 0) {
				result.errors.forEach(error => console.error(`${file.relative}${error}`));
				this.emit('error', `Failed to rewrite file: ${file.path}`);
				return;
			} else {
				if (result.contents) {
					file.contents = new Buffer(result.contents, 'utf8');
				}
				if (result.sourceMap) {
					file.sourceMap = JSON.parse(result.sourceMap);
				}
				if (result.bundle) {
					let ext = path.extname(file.path);
					let filePath = file.path.substr(0, file.path.length - ext.length);
					messagesFile = new File({
						base: file.base,
						path: filePath + NLS_JSON,
						contents: new Buffer(JSON.stringify(result.bundle.messages, null, '\t'), 'utf8')
					});
					let metaDataContent: SingleMetaDataFile = Object.assign({}, result.bundle, { filePath: removePathPrefix(filePath, file.base) });
					metaDataFile = new File({
						base: file.base,
						path: filePath + NLS_METADATA_JSON,
						contents: new Buffer(JSON.stringify(metaDataContent, null, '\t'), 'utf8')
					});
				}
			}
			this.queue(file);
			if (messagesFile) {
				this.queue(messagesFile);
			}
			if (metaDataFile) {
				this.queue(metaDataFile);
			}
		}
	);
}

export function createMetaDataFiles(): ThroughStream {
	return through(
		function (this: ThroughStream, file: FileWithSourceMap) {
			if (!file.isBuffer()) {
				this.emit('error', `Failed to read file: ${file.relative}`);
				return;
			}

			let result = processFile(file.contents.toString('utf8'), undefined, undefined);
			if (result.errors && result.errors.length > 0) {
				result.errors.forEach(error => console.error(`${file.relative}${error}`));
				this.emit('error', `Failed to rewrite file: ${file.path}`);
				return;
			}

			// emit the input file as-is
			this.queue(file);

			// emit nls meta data if available
			if (result.bundle) {
				let ext = path.extname(file.path);
				let filePath = file.path.substr(0, file.path.length - ext.length);
				this.queue(new File({
					base: file.base,
					path: filePath + NLS_JSON,
					contents: new Buffer(JSON.stringify(result.bundle.messages, null, '\t'), 'utf8')
				}));
				let metaDataContent: SingleMetaDataFile = Object.assign({}, result.bundle, { filePath: removePathPrefix(filePath, file.base) });
				this.queue(new File({
					base: file.base,
					path: filePath + NLS_METADATA_JSON,
					contents: new Buffer(JSON.stringify(metaDataContent, null, '\t'), 'utf8')
				}));
			}
		}
	);
}

export function bundleMetaDataFiles(id: string, outDir: string): ThroughStream {
	let base: string | undefined = undefined;
	const bundler = new MetaDataBundler(id, outDir);
	return through(function (this: ThroughStream, file: File) {
		const basename = path.basename(file.relative);
		if (basename.length < NLS_METADATA_JSON.length || NLS_METADATA_JSON !== basename.substr(basename.length - NLS_METADATA_JSON.length)) {
			this.queue(file);
			return;
		}
		if (file.isBuffer()) {
			if (!base) {
				base = file.base;
			}
		} else {
			this.emit('error', `Failed to bundle file: ${file.relative}`);
			return;
		}
		if (!base) {
			base = file.base;
		}
		const buffer: Buffer = file.contents as Buffer;
		const json: SingleMetaDataFile = JSON.parse(buffer.toString('utf8'));
		bundler.add(json);
	}, function () {
		if (base) {
			const [header, content] = bundler.bundle();
			this.queue(new File({
				base: base,
				path: path.join(base, 'nls.metadata.header.json'),
				contents: new Buffer(JSON.stringify(header), 'utf8')
			}));
			this.queue(new File({
				base: base,
				path: path.join(base, 'nls.metadata.json'),
				contents: new Buffer(JSON.stringify(content), 'utf8')
			}));
		}
		this.queue(null);
	});
}

export interface Language {
	id: string; // language id, e.g. zh-tw, de
	folderName?: string; // language specific folder name, e.g. cht, deu  (optional, if not set, the id is used)
}

export function createAdditionalLanguageFiles(languages: Language[], i18nBaseDir: string, baseDir?: string, logProblems: boolean = true): ThroughStream {
	return through(function (this: ThroughStream, file: File) {
		// Queue the original file again.
		this.queue(file);

		const basename = path.basename(file.relative);
		const isPackageFile = basename === 'package.nls.json';
		const isAffected = isPackageFile || basename.match(/nls.metadata.json$/) !== null;
		if (!isAffected) {
			return;
		}
		const filename = isPackageFile
			? file.relative.substr(0, file.relative.length - '.nls.json'.length)
			: file.relative.substr(0, file.relative.length - NLS_METADATA_JSON.length);
		let json;
		if (file.isBuffer()) {
			const buffer: Buffer = file.contents as Buffer;
			json = JSON.parse(buffer.toString('utf8'));
			const resolvedBundle = resolveMessageBundle(json);
			languages.forEach((language) => {
				const folderName = language.folderName || language.id;
				const result = createLocalizedMessages(filename, resolvedBundle, folderName, i18nBaseDir, baseDir);
				if (result.problems && result.problems.length > 0 && logProblems) {
					result.problems.forEach(problem => log(problem));
				}
				if (result.messages) {
					this.queue(new File({
						base: file.base,
						path: path.join(file.base, filename) + '.nls.' + language.id + '.json',
						contents: new Buffer(JSON.stringify(result.messages, null, '\t').replace(/\r\n/g, '\n'), 'utf8')
					}));
				}
			});
		} else {
			this.emit('error', `Failed to read component file: ${file.relative}`);
			return;
		}
	});
}

interface ExtensionLanguageBundle {
	[key: string]: string[];
}

export function bundleLanguageFiles(): ThroughStream {
	interface MapValue {
		base: string;
		content: ExtensionLanguageBundle;
	}
	const bundles: Map<MapValue> = Object.create(null);
	function getModuleKey(relativeFile: string): string {
		return relativeFile.match(/(.*)\.nls\.(?:.*\.)?json/)![1].replace(/\\/g, '/');
	}

	return through(function (this: ThroughStream, file: File) {
		const basename = path.basename(file.path);
		const matches = basename.match(/.nls\.(?:(.*)\.)?json/);
		if (!matches || !file.isBuffer()) {
			// Not an nls file.
			this.queue(file);
			return;
		}
		const language = matches[1] ? matches[1] : 'en';
		let bundle = bundles[language];
		if (!bundle) {
			bundle = {
				base: file.base,
				content: Object.create(null)
			};
			bundles[language] = bundle;
		}
		bundle.content[getModuleKey(file.relative)] = JSON.parse((file.contents as Buffer).toString('utf8'));
	}, function () {
		for (const language in bundles) {
			const bundle = bundles[language];
			const languageId = language === 'en' ? '' : `${language}.`;
			const file = new File({
				base: bundle.base,
				path: path.join(bundle.base, `nls.bundle.${languageId}json`),
				contents: new Buffer(JSON.stringify(bundle.content), 'utf8')
			});
			this.queue(file);
		}
		this.queue(null);
	});
}

export function debug(prefix: string = ''): ThroughStream {
	return through(function (this: ThroughStream, file: File) {
		console.log(`${prefix}In pipe ${file.path}`);
		this.queue(file);
	});
}

/**
 * A stream the creates additional key/value pair files for structured nls files.
 *
 * @param commentSeparator - if provided comments will be joined into one string using
 *  the commentSeparator value. If omitted comments will be includes as a string array.
 */
export function createKeyValuePairFile(commentSeparator: string | undefined = undefined): ThroughStream {
	return through(function (this: ThroughStream, file: File) {
		const basename = path.basename(file.relative);
		if (basename.length < NLS_METADATA_JSON.length || NLS_METADATA_JSON !== basename.substr(basename.length - NLS_METADATA_JSON.length)) {
			this.queue(file);
			return;
		}
		let kvpFile: File | undefined;
		const filename = file.relative.substr(0, file.relative.length - NLS_METADATA_JSON.length);
		if (file.isBuffer()) {
			const buffer: Buffer = file.contents as Buffer;
			const json = JSON.parse(buffer.toString('utf8'));
			if (JavaScriptMessageBundle.is(json)) {
				const resolvedBundle = json as JavaScriptMessageBundle;
				if (resolvedBundle.messages.length !== resolvedBundle.keys.length) {
					this.queue(file);
					return;
				}
				const kvpObject = bundle2keyValuePair(resolvedBundle, commentSeparator);
				kvpFile = new File({
					base: file.base,
					path: path.join(file.base, filename) + I18N_JSON,
					contents: new Buffer(JSON.stringify(kvpObject, null, '\t'), 'utf8')
				});
			} else {
				this.emit('error', `Not a valid JavaScript message bundle: ${file.relative}`);
				return;
			}
		} else {
			this.emit('error', `Failed to read JavaScript message bundle file: ${file.relative}`);
			return;
		}
		this.queue(file);
		if (kvpFile) {
			this.queue(kvpFile);
		}
	});
}

interface Item {
	id: string;
	message: string;
	comment?: string;
}

interface PackageJsonMessageFormat {
	message: string;
	comment: string[];
}

interface PackageJsonFormat {
	[key: string]: string | PackageJsonMessageFormat;
}

module PackageJsonFormat {
	export function is(value: any): value is PackageJsonFormat {
		if (Is.undef(value) || !Is.object(value)) {
			return false;
		}
		return Object.keys(value).every(key => {
			let element = value[key];
			return Is.string(element) || (Is.object(element) && Is.defined(element.message) && Is.defined(element.comment));
		});
	}
}

type MessageInfo = string | PackageJsonMessageFormat;

namespace MessageInfo {
	export function message(value: MessageInfo): string {
		return typeof value === 'string' ? value : value.message;
	}
	export function comment(value: MessageInfo): string[] | undefined {
		return typeof value === 'string' ? undefined : value.comment;
	}
}

export class Line {
	private buffer: string[] = [];

	constructor(indent: number = 0) {
		if (indent > 0) {
			this.buffer.push(new Array(indent + 1).join(' '));
		}
	}

	public append(value: string): Line {
		this.buffer.push(value);
		return this;
	}

	public toString(): string {
		return this.buffer.join('');
	}
}

export interface Resource {
	name: string;
	project: string;
}

export interface ParsedXLF {
	messages: Map<string>;
	originalFilePath: string;
	language: string;
}

export class XLF {
	private buffer: string[];
	private files: Map<Item[]>;

	constructor(public project: string) {
		this.buffer = [];
		this.files = Object.create(null);
	}

	public toString(): string {
		this.appendHeader();

		for (const file in this.files) {
			this.appendNewLine(`<file original="${file}" source-language="en" datatype="plaintext"><body>`, 2);
			for (const item of this.files[file]) {
				this.addStringItem(item);
			}
			this.appendNewLine('</body></file>', 2);
		}

		this.appendFooter();
		return this.buffer.join('\r\n');
	}

	public addFile(original: string, keys: KeyInfo[], messages: MessageInfo[]) {
		if (keys.length === 0) {
			return;
		}
		if (keys.length !== messages.length) {
			throw new Error(`Un-matching keys(${keys.length}) and messages(${messages.length}).`);
		}

		this.files[original] = [];
		const existingKeys: Set<string> = new Set();

		for (let i = 0; i < keys.length; i++) {
			const keyInfo = keys[i];
			const key = KeyInfo.key(keyInfo);
			if (existingKeys.has(key)) {
				continue;
			}
			existingKeys.add(key);

			const messageInfo = messages[i];
			const message = encodeEntities(MessageInfo.message(messageInfo));
			const comment: string | undefined = function(comments: string[] | undefined) {
				if (comments === undefined) {
					return undefined;
				}
				return comments.map(comment => encodeEntities(comment)).join(`\r\n`);
			}(KeyInfo.comment(keyInfo) ?? MessageInfo.comment(messageInfo));

			this.files[original].push(comment !== undefined ? { id: key, message: message, comment: comment } : { id: key, message: message });
		}
	}

	private addStringItem(item: Item): void {
		if (!item.id || !item.message) {
			throw new Error('No item ID or value specified.');
		}

		this.appendNewLine(`<trans-unit id="${item.id}">`, 4);
		this.appendNewLine(`<source xml:lang="en">${item.message}</source>`, 6);

		if (item.comment) {
			this.appendNewLine(`<note>${item.comment}</note>`, 6);
		}

		this.appendNewLine('</trans-unit>', 4);
	}

	private appendHeader(): void {
		this.appendNewLine('<?xml version="1.0" encoding="utf-8"?>', 0);
		this.appendNewLine('<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">', 0);
	}

	private appendFooter(): void {
		this.appendNewLine('</xliff>', 0);
	}

	private appendNewLine(content: string, indent?: number): void {
		const line = new Line(indent);
		line.append(content);
		this.buffer.push(line.toString());
	}

	static parse(xlfString: string): Promise<ParsedXLF[]> {
		const getValue = function (this: void, target: any): string | undefined {
			if (typeof target === 'string') {
				return target;
			}
			if (typeof target._ === 'string') {
				return target._;
			}
			if (Array.isArray(target) && target.length === 1) {
				const item = target[0];
				if (typeof item === 'string') {
					return item;
				}
				if (typeof item._ === 'string') {
					return item._;
				}
				return target[0]._;
			}
			return undefined;
		};
		return new Promise((resolve, reject) => {
			const parser = new xml2js.Parser();
			const files: { messages: Map<string>, originalFilePath: string, language: string }[] = [];

			parser.parseString(xlfString, function (err: any, result: any) {
				if (err) {
					reject(new Error(`Failed to parse XLIFF string. ${err}`));
				}

				const fileNodes: any[] = result['xliff']['file'];
				if (!fileNodes) {
					reject(new Error('XLIFF file does not contain "xliff" or "file" node(s) required for parsing.'));
				}

				fileNodes.forEach((file) => {
					const originalFilePath = file.$.original;
					if (!originalFilePath) {
						reject(new Error('XLIFF file node does not contain original attribute to determine the original location of the resource file.'));
					}
					const language = file.$['target-language'].toLowerCase();
					if (!language) {
						reject(new Error('XLIFF file node does not contain target-language attribute to determine translated language.'));
					}

					const messages: Map<string> = {};
					const transUnits = file.body[0]['trans-unit'];
					if (transUnits) {
						transUnits.forEach((unit: any) => {
							const key = unit.$.id;
							if (!unit.target) {
								return; // No translation available
							}

							const val = getValue(unit.target);
							if (key && val) {
								messages[key] = decodeEntities(val);
							} else {
								reject(new Error('XLIFF file does not contain full localization data. ID or target translation for one of the trans-unit nodes is not present.'));
							}
						});

						files.push({ messages: messages, originalFilePath: originalFilePath, language: language });
					}
				});

				resolve(files);
			});
		});
	}
}

export function createXlfFiles(projectName: string, extensionName: string): ThroughStream {
	let _xlf: XLF;
	let header: BundledMetaDataHeader | undefined;
	let data: BundledMetaDataFile | undefined;
	function getXlf() {
		if (!_xlf) {
			_xlf = new XLF(projectName);
		}
		return _xlf;
	}
	return through(function (this: ThroughStream, file: File) {
		if (!file.isBuffer()) {
			this.emit('error', `File ${file.path} is not a buffer`);
			return;
		}
		const buffer: Buffer = file.contents as Buffer;
		const basename = path.basename(file.path);
		if (basename === 'package.nls.json') {
			const json: PackageJsonFormat = JSON.parse(buffer.toString('utf8'));
			const keys = Object.keys(json);
			const messages = keys.map((key) => {
				const value = json[key];
				return value === undefined ? `Unknown message for key: ${key}` : value;
			});
			getXlf().addFile('package', keys, messages);
		} else if (basename === 'nls.metadata.json') {
			data = JSON.parse(buffer.toString('utf8'));
		} else if (basename === 'nls.metadata.header.json') {
			header = JSON.parse(buffer.toString('utf8'));
		} else {
			this.emit('error', new Error(`${file.path} is not a valid nls or meta data file`));
			return;
		}
	}, function (this: ThroughStream) {
		if (header && data) {
			const outDir = header.outDir;
			for (const module in data) {
				const fileContent: BundledMetaDataEntry = data[module];
				// in the XLF files we only use forward slashes.
				getXlf().addFile(`${outDir}/${module.replace(/\\/g, '/')}`, fileContent.keys, fileContent.messages);
			}
		}
		if (_xlf) {
			const xlfFile = new File({
				path: path.join(projectName, extensionName + '.xlf'),
				contents: new Buffer(_xlf.toString(), 'utf8')
			});
			this.queue(xlfFile);
		}
		this.queue(null);
	});
}

export function prepareJsonFiles(): ThroughStream {
	let parsePromises: Promise<ParsedXLF[]>[] = [];

	return through(function (this: ThroughStream, xlf: File) {
		let stream = this;
		let parsePromise = XLF.parse(xlf.contents!.toString());
		parsePromises.push(parsePromise);

		parsePromise.then(
			function (resolvedFiles) {
				resolvedFiles.forEach(file => {
					let messages = file.messages, translatedFile;
					translatedFile = createI18nFile(file.originalFilePath, messages);
					stream.queue(translatedFile);
				});
			}
		);
	}, function () {
		Promise.all(parsePromises)
			.then(() => { this.queue(null); })
			.catch(reason => { throw new Error(reason); });
	});
}

function createI18nFile(originalFilePath: string, messages: Map<string>): File {
	let content = [
		'/*---------------------------------------------------------------------------------------------',
		' *  Copyright (c) Microsoft Corporation. All rights reserved.',
		' *  Licensed under the MIT License. See License.txt in the project root for license information.',
		' *--------------------------------------------------------------------------------------------*/',
		'// Do not edit this file. It is machine generated.'
	].join('\n') + '\n' + JSON.stringify(messages, null, '\t').replace(/\r\n/g, '\n');

	return new File({
		path: path.join(originalFilePath + '.i18n.json'),
		contents: new Buffer(content, 'utf8')
	});
}

function encodeEntities(value: string): string {
	var result: string[] = [];
	for (var i = 0; i < value.length; i++) {
		var ch = value[i];
		switch (ch) {
			case '<':
				result.push('&lt;');
				break;
			case '>':
				result.push('&gt;');
				break;
			case '&':
				result.push('&amp;');
				break;
			default:
				result.push(ch);
		}
	}
	return result.join('');
}

function decodeEntities(value: string): string {
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
