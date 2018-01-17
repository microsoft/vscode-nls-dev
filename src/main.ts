/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import File = require('vinyl');
import { KeyInfo, JavaScriptMessageBundle, processFile, resolveMessageBundle, createLocalizedMessages, bundle2keyValuePair, Map } from './lib';
import * as fs from 'fs';
import { through, readable } from 'event-stream';
import { ThroughStream } from 'through';
import * as Is from 'is';
import * as xml2js from 'xml2js';
import * as glob from 'glob';
import * as https from 'https';

var util = require('gulp-util');
var iconv  = require('iconv-lite');

function log(message: any, ...rest: any[]): void {
	util.log(util.colors.cyan('[i18n]'), message, ...rest);
}

interface FileWithSourceMap extends File {
	sourceMap: any;
}

interface SingleMetaDataFile {
	messages: string[];
	keys: KeyInfo[];
	filePath: string;
}

interface BundledMetaDataEntry {
	messages: string[];
	keys: KeyInfo[];
}

interface BundledMetaDataFile {
	type: string;
	name: string;
	rootPath: string;
	content: {
		[key: string]: BundledMetaDataEntry;
	}
}

const NLS_JSON = '.nls.json';
const NLS_METADATA_JSON = '.nls.metaData.json';
const I18N_JSON = '.i18n.json';

export function rewriteLocalizeCalls(): through.ThroughStream {
	return through(
		function (file: FileWithSourceMap) {
			if (!file.isBuffer()) {
				this.emit('error', `Failed to read file: ${file.relative}`);
			}
			let buffer: Buffer = file.contents as Buffer;
			let content = buffer.toString('utf8');
			let sourceMap = file.sourceMap;
			
			let result = processFile(content, sourceMap);
			let messagesFile: File;
			let metaDataFile: File;
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
					let filePath = file.path.substr(0, file.path.length - ext.length);
					messagesFile = new File({
						base: file.base,
						path: filePath + NLS_JSON,
						contents: new Buffer(JSON.stringify(result.bundle.messages, null, '\t'), 'utf8')
					});
					let metaDataContent: SingleMetaDataFile = Object.assign({}, result.bundle, { filePath: filePath.substr(file.base.length + 1)});
					metaDataFile = new File({
						base: file.base,
						path: filePath + NLS_METADATA_JSON,
						contents: new Buffer(JSON.stringify(metaDataContent, null, '\t'), 'utf8')						
					});
				}
			}
			this.emit('data', file);
			if (messagesFile) {
				this.emit('data', messagesFile);
			}
			if (metaDataFile) {
				this.emit('data', metaDataFile);
			}
		}
	);
}

export function bundleMetaDataFiles(name: string, rootPath: string): through.ThroughStream {
	let base: string = undefined;
	let result: BundledMetaDataFile = {
		type: "extensionBundle",
		name,
		rootPath,
		content: Object.create(null)
	};
	return through(function(file: File) {
		let basename = path.basename(file.relative);
		if (basename.length < NLS_METADATA_JSON.length || NLS_METADATA_JSON !== basename.substr(basename.length - NLS_METADATA_JSON.length)) {
			this.emit('data', file);
			return;
		}
		if (file.isBuffer()) {
			if (!base) {
				base = file.base;
			}
		} else {
			this.emit('error', `Failed to bundle file: ${file.relative}`);
		}
		if (!base) {
			base = file.base;
		}
		let buffer: Buffer = file.contents as Buffer;
		let json: SingleMetaDataFile = JSON.parse(buffer.toString('utf8'));
		result.content[json.filePath] = {
			messages: json.messages,
			keys: json.keys
		};
	}, function() {
		if (base) {
			this.emit('data', new File({
				base: base,
				path: path.join(base, 'nls.metadata.json'),
				contents: new Buffer(JSON.stringify(result, null, '\t'), 'utf8')
			}))
		}
		this.emit('end');
	});
}

/**
 * This map is used to map our 3 letter encoding in the
 * i18n folder to a file extension matching what is returned
 * from app.getOSLocale().
 */
const iso639_3_to_2: Map<string> = {
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

export const coreLanguages: string[] = ['chs', 'cht', 'jpn', 'kor', 'deu', 'fra', 'esn', 'rus', 'ita'];

export function createAdditionalLanguageFiles(languages: string[], i18nBaseDir: string, baseDir?: string): through.ThroughStream {
	return through(function(file: File) {
		let basename = path.basename(file.relative);
		if (basename.length < NLS_METADATA_JSON.length || NLS_METADATA_JSON !== basename.substr(basename.length - NLS_METADATA_JSON.length)) {
			this.emit('data', file);
			return;
		}
		let filename = file.relative.substr(0, file.relative.length - NLS_METADATA_JSON.length);
		let json;
		if (file.isBuffer()) {
			let buffer: Buffer = file.contents as Buffer;
			json = JSON.parse(buffer.toString('utf8'));
			let resolvedBundle = resolveMessageBundle(json);
			languages.forEach((language) => {
				let result = createLocalizedMessages(filename, resolvedBundle, language, i18nBaseDir, baseDir);
				if (result.problems && result.problems.length > 0) {
					result.problems.forEach(problem => log(problem));
				}
				if (result.messages) {
					this.emit('data', new File({
						base: file.base,
						path: path.join(file.base, filename) + '.nls.' + iso639_3_to_2[language] + '.json',
						contents: new Buffer(JSON.stringify(result.messages, null, '\t').replace(/\r\n/g, '\n'), 'utf8')
					}));
				}
 			});
		} else {
			this.emit('error', `Failed to read component file: ${file.relative}`)
		}
		this.emit('data', file);
	});
}

/**
 * A stream the creates additional key/value pair files for structured nls files.
 * 
 * @param commentSeparator - if provided comments will be joined into one string using 
 *  the commentSeparator value. If omitted comments will be includes as a string array.
 */
export function createKeyValuePairFile(commentSeparator: string = undefined): through.ThroughStream {
	return through(function(file: File) {
		let basename = path.basename(file.relative);
		if (basename.length < NLS_METADATA_JSON.length || NLS_METADATA_JSON !== basename.substr(basename.length - NLS_METADATA_JSON.length)) {
			this.emit('data', file);
			return;
		}
		let json;
		let kvpFile;
		let filename = file.relative.substr(0, file.relative.length - NLS_METADATA_JSON.length);
		if (file.isBuffer()) {
			let buffer: Buffer = file.contents as Buffer;
			json = JSON.parse(buffer.toString('utf8'));
			if (JavaScriptMessageBundle.is(json)) {
				let resolvedBundle = json as JavaScriptMessageBundle;
				if (resolvedBundle.messages.length !== resolvedBundle.keys.length) {
					this.emit('data', file);
					return;
				}
				let kvpObject = bundle2keyValuePair(resolvedBundle, commentSeparator);
				kvpFile = new File({
					base: file.base,
					path: path.join(file.base, filename) + I18N_JSON,
					contents: new Buffer(JSON.stringify(kvpObject, null, '\t'), 'utf8')
				});
			} else {
				this.emit('error', `Not a valid JavaScript message bundle: ${file.relative}`)
			}
		} else {
			this.emit('error', `Failed to read JavaScript message bundle file: ${file.relative}`)
		}
		this.emit('data', file);
		if (kvpFile) {
			this.emit('data', kvpFile);
		}
	});
}

/**
 * The following code is used to perform JSON->XLF->JSON conversion as well as to update and pull resources from Transifex.
 */
interface Item {
	id: string;
	message: string;
	comment: string;
}

interface LocalizeInfo {
	key: string;
	comment: string[];
}

module LocalizeInfo {
	export function is(value: any): value is LocalizeInfo {
		let candidate = value as LocalizeInfo;
		return Is.defined(candidate) && Is.string(candidate.key) && (Is.undef(candidate.comment) || (Is.array(candidate.comment) && candidate.comment.every(element => Is.string(element))));
	}
}

interface ValueFormat {
	message: string;
	comment: string[];
}

interface PackageJsonFormat {
	[key: string]: string | ValueFormat;
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
interface ModuleJsonFormat {
	messages: string[];
	keys: (string | LocalizeInfo)[];
}

module ModuleJsonFormat {
	export function is(value: any): value is ModuleJsonFormat {
		let candidate = value as ModuleJsonFormat;
		return Is.defined(candidate)
			&& Is.array(candidate.messages) && candidate.messages.every(message => Is.string(message))
			&& Is.array(candidate.keys) && candidate.keys.every(key => Is.string(key) || LocalizeInfo.is(key));
	}
}

export class Line {
	private buffer: string[] = [];

	constructor(private indent: number = 0) {
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

		for (let file in this.files) {
			this.appendNewLine(`<file original="${file}" source-language="en" datatype="plaintext"><body>`, 2);
			for (let item of this.files[file]) {
				this.addStringItem(item);
			}
	   		this.appendNewLine('</body></file>', 2);
		}

		this.appendFooter();
		return this.buffer.join('\r\n');
	}

	public addFile(original: string, keys: any[], messages: string[]) {
		this.files[original] = [];
		let existingKeys = [];

		for (let key of keys) {
			// Ignore duplicate keys because Transifex does not populate those with translated values.
			if (existingKeys.indexOf(key) !== -1) {
				continue;
			}
			existingKeys.push(key);

			let message: string = encodeEntities(messages[keys.indexOf(key)]);
			let comment: string = undefined;

			// Check if the message contains description (if so, it becomes an object type in JSON)
			if (Is.string(key)) {
				this.files[original].push({ id: key, message: message, comment: comment });
			} else {
				if (key['comment'] && key['comment'].length > 0) {
					comment = key['comment'].map(comment => encodeEntities(comment)).join('\r\n');
				}

				this.files[original].push({ id: key['key'], message: message, comment: comment });
			}
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
		let line = new Line(indent);
		line.append(content);
		this.buffer.push(line.toString());
	}

	static parse = function(xlfString: string) : Promise<ParsedXLF[]> {
		return new Promise((resolve, reject) => {
			let parser = new xml2js.Parser();

			let files: { messages: Map<string>, originalFilePath: string, language: string }[] = [];

			parser.parseString(xlfString, function(err, result) {
				if (err) {
					reject(`Failed to parse XLIFF string. ${err}`);
				}

				const fileNodes: any[] = result['xliff']['file'];
				if (!fileNodes) {
					reject('XLIFF file does not contain "xliff" or "file" node(s) required for parsing.');
				}

				fileNodes.forEach((file) => {
					const originalFilePath = file.$.original;
					if (!originalFilePath) {
						reject('XLIFF file node does not contain original attribute to determine the original location of the resource file.');
					}
					const language = file.$['target-language'].toLowerCase();
					if (!language) {
						reject('XLIFF file node does not contain target-language attribute to determine translated language.');
					}

					let messages: Map<string> = {};
					const transUnits = file.body[0]['trans-unit'];

					transUnits.forEach(unit => {
						const key = unit.$.id;
						if (!unit.target) {
							return; // No translation available
						}

						const val = unit.target.toString();
						if (key && val) {
							messages[key] = decodeEntities(val);
						} else {
							reject('XLIFF file does not contain full localization data. ID or target translation for one of the trans-unit nodes is not present.');
						}
					});

					files.push({ messages: messages, originalFilePath: originalFilePath, language: language });
				});

				resolve(files);
			});
		});
	};
}

/**
 * This map is used to map the language of a Transifex Xlf file
 * to the folder representation in VS Code i18n folder.
 */
const iso639_2_to_3: Map<string> = {
	'zh-cn': 'chs',
	'zh-tw': 'cht',
	'zh-hans': 'chs',
	'zh-hant': 'cht',
	'cs-cz': 'csy',
	'de': 'deu',
	'en': 'enu',
	'es': 'esn',
	'fr': 'fra',
	'hu': 'hun',
	'it': 'ita',
	'ja': 'jpn',
	'ko': 'kor',
	'nl': 'nld',
	'pl': 'plk',
	'pt-br': 'ptb',
	'pt': 'ptg',
	'ru': 'rus',
	'sv-se': 'sve',
	'tr': 'trk'
};

export function prepareXlfFiles(projectName: string, extensionName: string): ThroughStream {
	return through(
		function (file: File) {
			if (!file.isBuffer()) {
				log('Error', `Failed to read component file: ${file.relative}`);
			}

			const extension = path.extname(file.path);
			if (extension === '.json') {
				const json = JSON.parse((<Buffer>file.contents).toString('utf8'));

				if (PackageJsonFormat.is(json) || ModuleJsonFormat.is(json)) {
					importModuleOrPackageJson(file, json, projectName, this, extensionName);
				} else {
					log('Error', 'JSON format cannot be deduced.');
				}
			}
		}
	);
}

var extensions: Map<{ xlf: XLF, processed: number }> = Object.create(null);
function importModuleOrPackageJson(file: File, json: ModuleJsonFormat | PackageJsonFormat, projectName: string, stream: ThroughStream, extensionName: string): void {
	if (ModuleJsonFormat.is(json) && json['keys'].length !== json['messages'].length) {
		throw new Error(`There is a mismatch between keys and messages in ${file.relative}`);
	}

	// Prepare the source path for <original/> attribute in XLF & extract messages from JSON
	const formattedSourcePath = file.relative.replace(/\\/g, '/');
	const messages = Object.keys(json).map((key) => json[key].toString());

	// Stores the amount of localization files to be transformed to XLF before the emission
	let localizationFilesCount = glob.sync('**/*.nls.json').length;
	let originalFilePath = `${formattedSourcePath.substr(0, formattedSourcePath.length - '.nls.json'.length)}`;

	let extension = extensions[extensionName] ?
		extensions[extensionName] : extensions[extensionName] = { xlf: new XLF(projectName), processed: 0 };
	
	// .nls.json can come with empty array of keys and messages, check for it
	if (ModuleJsonFormat.is(json) && json.keys.length !== 0) {
		extension.xlf.addFile(originalFilePath, json.keys, json.messages);
	} else if (PackageJsonFormat.is(json) && Object.keys(json).length !== 0) {
		extension.xlf.addFile(originalFilePath, Object.keys(json), messages);
	}

	// Check if XLF is populated with file nodes to emit it
	if (++extensions[extensionName].processed === localizationFilesCount) {
		const newFilePath = path.join(projectName, extensionName + '.xlf');
		const xlfFile = new File({ path: newFilePath, contents: new Buffer(extension.xlf.toString(), 'utf-8')});
		stream.emit('data', xlfFile);
	}
}

export function pushXlfFiles(apiHostname: string, username: string, password: string): ThroughStream {
	let tryGetPromises = [];
	let updateCreatePromises = [];

	return through(function(file: File) {
		const project = path.dirname(file.relative);
		const fileName = path.basename(file.path);
		const slug = fileName.substr(0, fileName.length - '.xlf'.length);
		const credentials = `${username}:${password}`;

		// Check if resource already exists, if not, then create it.
		let promise = tryGetResource(project, slug, apiHostname, credentials);
		tryGetPromises.push(promise);
		promise.then(exists => {
			if (exists) {
				promise = updateResource(project, slug, file, apiHostname, credentials);
			} else {
				promise = createResource(project, slug, file, apiHostname, credentials);
			}
			updateCreatePromises.push(promise);
		});

	}, function() {
		// End the pipe only after all the communication with Transifex API happened
		Promise.all(tryGetPromises).then(() => {
			Promise.all(updateCreatePromises).then(() => {
				this.emit('end');
			}).catch((reason) => { throw new Error(reason); });
		}).catch((reason) => { throw new Error(reason); });
	});
}

function tryGetResource(project: string, slug: string, apiHostname: string, credentials: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const options = {
			hostname: apiHostname,
			path: `/api/2/project/${project}/resource/${slug}/?details`,
			auth: credentials,
			method: 'GET'
		};

		const request = https.request(options, (response) => {
			if (response.statusCode === 404) {
				resolve(false);
			} else if (response.statusCode === 200) {
				resolve(true);
			} else {
				reject(`Failed to query resource ${project}/${slug}. Response: ${response.statusCode} ${response.statusMessage}`);
			}
		});
		request.on('error', (err) => {
			reject(`Failed to get ${project}/${slug} on Transifex: ${err}`);
		});

		request.end();
	});
}

function createResource(project: string, slug: string, xlfFile: File, apiHostname: string, credentials: any): Promise<any> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify({
			'content': xlfFile.contents.toString(),
			'name': slug,
			'slug': slug,
			'i18n_type': 'XLIFF'
		});
		const options = {
			hostname: apiHostname,
			path: `/api/2/project/${project}/resources`,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(data)
			},
			auth: credentials,
			method: 'POST'
		};

		let request = https.request(options, (res) => {
			if (res.statusCode === 201) {
				log(`Resource ${project}/${slug} successfully created on Transifex.`);
			} else {
				reject(`Something went wrong in the request creating ${slug} in ${project}. ${res.statusCode}`);
			}
		});
		request.on('error', (err) => {
			reject(`Failed to create ${project}/${slug} on Transifex: ${err}`);
		});

		request.write(data);
		request.end();
	});
}

/**
 * The following link provides information about how Transifex handles updates of a resource file:
 * https://dev.befoolish.co/tx-docs/public/projects/updating-content#what-happens-when-you-update-files
 */
function updateResource(project: string, slug: string, xlfFile: File, apiHostname: string, credentials: string) : Promise<any> {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify({ content: xlfFile.contents.toString() });
		const options = {
			hostname: apiHostname,
			path: `/api/2/project/${project}/resource/${slug}/content`,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(data)
			},
			auth: credentials,
			method: 'PUT'
		};

		let request = https.request(options, (res) => {
			if (res.statusCode === 200) {
				res.setEncoding('utf8');

				let responseBuffer: string = '';
				res.on('data', function (chunk) {
					responseBuffer += chunk;
				});
				res.on('end', () => {
					const response = JSON.parse(responseBuffer);
					log(`Resource ${project}/${slug} successfully updated on Transifex. Strings added: ${response.strings_added}, updated: ${response.strings_added}, deleted: ${response.strings_added}`);
					resolve();
				});
			} else {
				reject(`Something went wrong in the request updating ${slug} in ${project}. ${res.statusCode}`);
			}
		});
		request.on('error', (err) => {
			reject(`Failed to update ${project}/${slug} on Transifex: ${err}`);
		});

		request.write(data);
		request.end();
	});
}

export function pullXlfFiles(apiHostname: string, username: string, password: string, languages: string[], resources: Resource[]): NodeJS.ReadableStream {
	if (!resources) {
		throw new Error('Transifex projects and resources must be defined to be able to pull translations from Transifex.');
	}

	const credentials = `${username}:${password}`;
	let expectedTranslationsCount = languages.length * resources.length;
	let translationsRetrieved = 0, called = false;

	return readable(function(count, callback) {
		// Mark end of stream when all resources were retrieved
		if (translationsRetrieved === expectedTranslationsCount) {
			return this.emit('end');
		}

		if (!called) {
			called = true;
			const stream = this;

			languages.map(function(language) {
				resources.map(function(resource) {
					retrieveResource(language, resource, apiHostname, credentials).then((file: File) => {
						stream.emit('data', file);
						translationsRetrieved++;
					}).catch(error => { throw new Error(error); });
				});
			});
		}

		callback();
	});
}

function retrieveResource(language: string, resource: Resource, apiHostname, credentials): Promise<File> {
	return new Promise<File>((resolve, reject) => {
		const slug = resource.name.replace(/\//g, '_');
		const project = resource.project;
		const iso639 = language.toLowerCase();
		const options = {
			hostname: apiHostname,
			path: `/api/2/project/${project}/resource/${slug}/translation/${iso639}?file&mode=onlyreviewed`,
			auth: credentials,
			method: 'GET'
		};

		let request = https.request(options, (res) => {
				let xlfBuffer: Buffer[] = [];
				res.on('data', (chunk) => xlfBuffer.push(<Buffer>chunk));
				res.on('end', () => {
					if (res.statusCode === 200) {
						resolve(new File({ contents: Buffer.concat(xlfBuffer), path: `${project}/${iso639_2_to_3[language]}/${slug}.xlf` }));
					}
					reject(`${slug} in ${project} returned no data. Response code: ${res.statusCode}.`);
				});
		});
		request.on('error', (err) => {
			reject(`Failed to query resource ${slug} with the following error: ${err}`);
		});
		request.end();
	});
}

export function prepareJsonFiles(): ThroughStream {
	let parsePromises: Promise<ParsedXLF[]>[] = [];

	return through(function(xlf: File) {
		let stream = this;
		let parsePromise = XLF.parse(xlf.contents.toString());
		parsePromises.push(parsePromise);

		parsePromise.then(
			function(resolvedFiles) {
				resolvedFiles.forEach(file => {
					let messages = file.messages, translatedFile;
					translatedFile = createI18nFile(iso639_2_to_3[file.language], file.originalFilePath, messages);
					stream.emit('data', translatedFile);
				});
			},
			function(rejectReason) {
				throw new Error(`XLF parsing error: ${rejectReason}`);
			}
		);
	}, function() {
		Promise.all(parsePromises)
			.then(() => { this.emit('end'); })
			.catch(reason => { throw new Error(reason); })
	});
}

function createI18nFile(base: string, originalFilePath: string, messages: Map<string>): File {
	let content = [
		'/*---------------------------------------------------------------------------------------------',
		' *  Copyright (c) Microsoft Corporation. All rights reserved.',
		' *  Licensed under the MIT License. See License.txt in the project root for license information.',
		' *--------------------------------------------------------------------------------------------*/',
		'// Do not edit this file. It is machine generated.'
	].join('\n') + '\n' + JSON.stringify(messages, null, '\t').replace(/\r\n/g, '\n');

	return new File({
		path: path.join(base, originalFilePath + '.i18n.json'),
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

function decodeEntities(value:string): string {
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}