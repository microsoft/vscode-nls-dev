/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { MappingItem as BaseMappingItem, RawSourceMap, SourceMapConsumer, SourceMapGenerator } from 'source-map';
import * as ts from 'typescript';
import clone = require('clone');
import * as crypto from 'crypto';

export interface Map<V> {
	[key: string]: V;
}

class SingleFileServiceHost implements ts.LanguageServiceHost {

	private file: ts.IScriptSnapshot;
	private lib: ts.IScriptSnapshot;

	constructor(private options: ts.CompilerOptions, private filename: string, contents: string) {
		this.file = ts.ScriptSnapshot.fromString(contents);
		this.lib = ts.ScriptSnapshot.fromString('');
	}

	getCompilationSettings = () => this.options;
	getScriptFileNames = () => [this.filename];
	getScriptVersion = () => '1';
	getScriptSnapshot = (name: string) => name === this.filename ? this.file : this.lib;
	getCurrentDirectory = () => '';
	getDefaultLibFileName = () => 'lib.d.ts';
}


interface Span {
	start: ts.LineAndCharacter;
	end: ts.LineAndCharacter;
}

interface Patch {
	span: Span;
	content: string;
}

export interface LocalizeInfo {
	key: string;
	comment: string[];
}

export namespace LocalizeInfo {
	export function is(value: any): value is LocalizeInfo {
		const candidate = value as LocalizeInfo;
		return candidate !== undefined && candidate.key !== undefined && candidate.comment !== undefined;
	}
}

export type KeyInfo = string | LocalizeInfo;

export namespace KeyInfo {
	export function key(value: KeyInfo): string {
		return isString(value) ? value : value.key;
	}
	export function comment(value: KeyInfo): string[] | undefined {
		return isString(value) ? undefined : value.comment;
	}
}

export interface JavaScriptMessageBundle {
	messages: string[];
	keys: KeyInfo[];
}

export namespace JavaScriptMessageBundle {
	export function is(value: any): value is JavaScriptMessageBundle {
		let candidate = value as JavaScriptMessageBundle;
		return candidate && candidate.messages !== undefined && candidate.keys !== undefined;
	}
}

export interface ResolvedJavaScriptMessageBundle {
	messages: string[];
	keys: string[];
	map: Map<string>;
}

export namespace ResolvedJavaScriptMessageBundle {
	export function is(value: any): value is ResolvedJavaScriptMessageBundle {
		const candidate = value as ResolvedJavaScriptMessageBundle;
		return candidate && candidate.keys !== undefined && candidate.messages !== undefined && candidate.map !== undefined;
	}
	export function asTranslatedMessages(bundle: ResolvedJavaScriptMessageBundle, translatedMessages: Map<string> | undefined, problems: string[]): string[] {
		const result: string[] = [];
		bundle.keys.forEach(key => {
			let translated = translatedMessages ? translatedMessages[key] : undefined;
			if (translated === undefined) {
				if (translatedMessages) {
					problems.push(`No localized message found for key ${key}`);
				}
				translated = bundle.map[key];
			}
			result.push(translated);
		});
		return result;
	}
}

export interface PackageJsonMessageBundle {
	[key: string]: string;
}

export namespace PackageJsonMessageBundle {
	export function asTranslatedMessages(bundle: PackageJsonMessageBundle, translatedMessages: Map<string> | undefined, problems: string[]): Map<string> {
		const result: Map<string> = Object.create(null);
		Object.keys(bundle).forEach((key) => {
			let message = translatedMessages ? translatedMessages[key] : undefined;
			if (message === undefined) {
				if (translatedMessages) {
					problems.push(`No localized message found for key ${key}`);
				}
				message = bundle[key];
			}
			result[key] = message;
		});
		return result;
	}
}

interface AnalysisResult {
	patches: Patch[];
	errors: string[];
	bundle: JavaScriptMessageBundle;
}

interface MappingItem extends BaseMappingItem {
	delete?: boolean;
	columnDelta?: number;
	lineDelta?: number;
}

interface Line {
	content: string | null;
	ending: string;
	mappings: MappingItem[] | null;
}

const toString = Object.prototype.toString;

function isString(value: any): value is string {
	return toString.call(value) === '[object String]';
}

class TextModel {

	private lines: Line[];

	constructor(contents: string, private rawSourceMap?: RawSourceMap) {
		const regex = /\r\n|\r|\n/g;
		let index = 0;
		let match: RegExpExecArray | null;

		this.lines = [];

		while (match = regex.exec(contents)) {
			this.lines.push({ content: contents.substring(index, match.index), ending: match[0], mappings: null });
			index = regex.lastIndex;
		}

		if (contents.length > 0) {
			this.lines.push({ content: contents.substring(index, contents.length), ending: '', mappings: null });
		}
		if (rawSourceMap) {
			const sourceMapConsumer = new SourceMapConsumer(rawSourceMap);
			sourceMapConsumer.eachMapping((mapping) => {
				// Note that the generatedLine index is one based;
				let line = this.lines[mapping.generatedLine - 1];
				if (line) {
					if (!line.mappings) {
						line.mappings = [];
					}
					line.mappings.push(mapping);
				}
			}, null, SourceMapConsumer.GENERATED_ORDER);
		}
	}

	public get lineCount(): number {
		return this.lines.length;
	}

	/**
	 * Applies patch(es) to the model.
	 * Multiple patches must be ordered.
	 * Does not support patches spanning multiple lines.
	 */
	public apply(patches: Patch[]): void {
		if (patches.length === 0) {
			return;
		}

		patches = patches.sort((a, b) => {
			const lca = a.span.start;
			const lcb = b.span.start;
			return lca.line !== lcb.line ? lca.line - lcb.line : lca.character - lcb.character;
		});

		let overlapping = false;
		if (patches.length > 1) {
			const previousSpan = patches[0].span;
			for (let i = 1; i < patches.length; i++) {
				const nextSpan = patches[i].span;

				if (previousSpan.end.line > nextSpan.start.line || (previousSpan.end.line === nextSpan.start.line && previousSpan.end.character >= nextSpan.start.character)) {
					overlapping = true;
					break;
				}
			}
		}
		if (overlapping) {
			throw new Error(`Overlapping text edits generated.`);
		}
		const lastPatch = patches[patches.length - 1];
		const lastLine = this.lines[this.lineCount - 1];

		if (lastPatch.span.end.line > this.lines.length || (lastPatch.span.end.line === this.lineCount && lastPatch.span.end.character > lastLine.content!.length)) {
			throw new Error(`Patches are outside of the buffer content.`);
		}

		let mappingCursor: {
			line: number;
			index: number;
		} = { line: -1, index: -1 };
		patches.reverse().forEach((patch) => {
			const startLineNumber = patch.span.start.line;
			const endLineNumber = patch.span.end.line;

			const startLine = this.lines[startLineNumber];
			const endLine = this.lines[endLineNumber];

			// Do the textual manipulations.
			startLine.content = [
				startLine.content!.substring(0, patch.span.start.character),
				patch.content,
				endLine.content!.substring(patch.span.end.character)
			].join('');
			for (let i = startLineNumber + 1; i <= endLineNumber; i++) {
				this.lines[i].content = null;
			}

			// Adopt source mapping if available
			if (this.rawSourceMap) {
				if (startLineNumber === endLineNumber) {
					if (!mappingCursor || mappingCursor.line !== startLineNumber) {
						mappingCursor.line = startLineNumber;
						mappingCursor.index = startLine.mappings ? startLine.mappings.length - 1 : -1;
					}
					let delta = patch.content.length - (patch.span.end.character - patch.span.start.character);
					let mappingItem: MappingItem | null = null;
					while ((mappingItem = mappingCursor.index !== -1 ? startLine.mappings![mappingCursor.index] : null) !== null
						&& mappingItem.generatedColumn > patch.span.start.character) {
						if (mappingItem.generatedColumn < patch.span.end.character) {
							// The patch covers the source mapping. Delete it
							mappingItem.delete = true;
						}
						mappingCursor.index--;
					}
					// Record the delta on the first source marker after the patch.
					if (mappingCursor.index + 1 < startLine.mappings!.length) {
						let mapping = startLine.mappings![mappingCursor.index + 1];
						mapping.columnDelta = (mapping.columnDelta || 0) + delta;
					}
				} else {
					let startLineMappings = startLine.mappings;
					if (startLineMappings) {
						for (let i = startLineMappings.length - 1; i >= 0 && startLineMappings[i].generatedColumn > patch.span.start.character; i--) {
							startLineMappings[i].delete = true;
						}
					}
					for (let i = startLineNumber + 1; i < endLineNumber; i++) {
						let line = this.lines[i];
						if (line.mappings) {
							line.mappings.forEach(mapping => mapping.delete = true);
						}
					}
					let endLineMappings = endLine.mappings;
					if (endLineMappings) {
						let lineDelta = startLineNumber - endLineNumber;
						let index = 0;
						for (; index < endLineMappings.length; index++) {
							let mapping = endLineMappings[index];
							if (mapping.generatedColumn < patch.span.end.character) {
								mapping.delete = true;
							} else {
								break;
							}
						}
						if (index < endLineMappings.length) {
							let mapping = endLineMappings[index];
							mapping.lineDelta = lineDelta;
							mapping.columnDelta = (patch.span.start.character - patch.span.end.character) + patch.content.length;
						}
					}
				}
			}
		});
	}

	public generateSourceMap(): string | undefined {
		if (!this.rawSourceMap) {
			return undefined;
		}
		const sourceMapGenerator = new SourceMapGenerator({ sourceRoot: this.rawSourceMap.sourceRoot });
		let lineDelta = 0;
		this.lines.forEach(line => {
			const mappings = line.mappings;
			let columnDelta = 0;
			if (mappings) {
				mappings.forEach(mapping => {
					lineDelta = (mapping.lineDelta || 0) + lineDelta;
					columnDelta = (mapping.columnDelta || 0) + columnDelta;
					if (mapping.delete) {
						return;
					}
					sourceMapGenerator.addMapping({
						source: mapping.source,
						name: mapping.name,
						original: { line: mapping.originalLine, column: mapping.originalColumn },
						generated: { line: mapping.generatedLine + lineDelta, column: mapping.generatedColumn + columnDelta }
					});
				});
			}
		});
		return sourceMapGenerator.toString();
	}

	public toString(): string {
		let count = this.lineCount;
		let buffer: string[] = [];
		for (let i = 0; i < count; i++) {
			let line = this.lines[i];
			if (line.content) {
				buffer.push(line.content + line.ending);
			}
		}
		return buffer.join('');
	}
}

function analyze(contents: string, relativeFilename: string | undefined, options: ts.CompilerOptions = {}): AnalysisResult {

	const vscodeRegExp = /^\s*(["'])vscode-nls\1\s*$/;

	enum CollectStepResult {
		Yes,
		YesAndRecurse,
		No,
		NoAndRecurse
	}

	function collect(node: ts.Node, fn: (node: ts.Node) => CollectStepResult): ts.Node[] {
		const result: ts.Node[] = [];

		function loop(node: ts.Node) {
			const stepResult = fn(node);

			if (stepResult === CollectStepResult.Yes || stepResult === CollectStepResult.YesAndRecurse) {
				result.push(node);
			}

			if (stepResult === CollectStepResult.YesAndRecurse || stepResult === CollectStepResult.NoAndRecurse) {
				ts.forEachChild(node, loop);
			}
		}

		loop(node);
		return result;
	}

	function isImportNode(node: ts.Node): boolean {
		if (ts.isImportDeclaration(node)) {
			return ts.isStringLiteralLike(node.moduleSpecifier) && vscodeRegExp.test(node.moduleSpecifier.getText());
		}

		if (ts.isImportEqualsDeclaration(node)) {
			return ts.isExternalModuleReference(node.moduleReference)
			 && ts.isStringLiteralLike(node.moduleReference.expression)
			 && vscodeRegExp.test(node.moduleReference.expression.getText());
		}
		return false;
	}

	function isRequireImport(node: ts.Node): boolean {
		if (!ts.isCallExpression(node)) {
			return false;
		}

		if (node.expression.getText() !== 'require' || !node.arguments || node.arguments.length !== 1) {
			return false;
		}
		const argument = node.arguments[0];
		return ts.isStringLiteralLike(argument) && vscodeRegExp.test(argument.getText());
	}

	function findClosestNode(node: ts.Node, textSpan: ts.TextSpan): ts.Node | undefined {
		let textSpanEnd = textSpan.start + textSpan.length;
		function loop(node: ts.Node): ts.Node | undefined {
			const length = node.end - node.pos;
			if (node.pos === textSpan.start && length === textSpan.length) {
				return node;
			}
			if (node.pos <= textSpan.start && textSpanEnd <= node.end) {
				const candidate = ts.forEachChild(node, loop);
				return candidate || node;
			}
			return undefined;
		}
		return loop(node);
	}

	const unescapeMap: Map<string> = {
		'\'': '\'',
		'"': '"',
		'\\': '\\',
		'n': '\n',
		'r': '\r',
		't': '\t',
		'b': '\b',
		'f': '\f'
	};

	function unescapeString(str: string): string {
		const result: string[] = [];
		for (let i = 0; i < str.length; i++) {
			const ch = str.charAt(i);
			if (ch === '\\') {
				if (i + 1 < str.length) {
					let replace = unescapeMap[str.charAt(i + 1)];
					if (replace !== undefined) {
						result.push(replace);
						i++;
						continue;
					}
				}
			}
			result.push(ch);
		}
		return result.join('');
	}

	options = clone(options, false);
	options.noResolve = true;
	options.allowJs = true;

	const filename = 'file.js';
	const serviceHost = new SingleFileServiceHost(options, filename, contents);
	const service = ts.createLanguageService(serviceHost);
	const sourceFile = service.getProgram()!.getSourceFile(filename)!;

	const patches: Patch[] = [];
	const errors: string[] = [];
	const bundle: JavaScriptMessageBundle = { messages: [], keys: [] };

	// all imports
	const imports = collect(sourceFile, n => isRequireImport(n) || isImportNode(n) ? CollectStepResult.YesAndRecurse : CollectStepResult.NoAndRecurse);

	const nlsReferences = imports.reduce<ts.Node[]>((memo, node) => {
		let references: ts.ReferenceEntry[] | undefined;

		if (ts.isCallExpression(node)) {
			let parent = node.parent;
			if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === '__importStar') {
				parent = node.parent.parent;
			}
			if (ts.isVariableDeclaration(parent)) {
				references = service.getReferencesAtPosition(filename, parent.name.pos + 1);
			}
		} else if (ts.isImportDeclaration(node) && node.importClause && node.importClause.namedBindings) {
			if (ts.isNamespaceImport(node.importClause.namedBindings)) {
				references = service.getReferencesAtPosition(filename, node.importClause.namedBindings.pos);
			}
		} else if (ts.isImportEqualsDeclaration(node)) {
			references = service.getReferencesAtPosition(filename, node.name.pos);
		}

		if (references) {
			references.forEach(reference => {
				if (!reference.isWriteAccess) {
					const node = findClosestNode(sourceFile, reference.textSpan);
					if (node) {
						memo.push(node);
					}
				}
			});
		}

		return memo;
	}, []);

	const loadCalls = nlsReferences.reduce<ts.CallExpression[]>((memo, node) => {
		// We are looking for nls.loadMessageBundle || nls.config. In the AST
		// this is Indetifier -> PropertyAccess -> CallExpression.
		if (!ts.isIdentifier(node) || !ts.isPropertyAccessExpression(node.parent) || !ts.isCallExpression(node.parent.parent)) {
			return memo;
		}
		const callExpression = node.parent.parent;
		const expression = callExpression.expression;
		if (ts.isPropertyAccessExpression(expression)) {
			if (expression.name.text === 'loadMessageBundle') {
				// We have a load call like nls.loadMessageBundle();
				memo.push(callExpression);
			} else if (expression.name.text === 'config') {
				// We have a load call like nls.config({...})();
				let parent = callExpression.parent;
				if (ts.isCallExpression(parent) && parent.expression === callExpression) {
					memo.push(parent);
				}
			}
		}
		return memo;
	}, []);

	const localizeCalls = loadCalls.reduce<ts.CallExpression[]>((memo, loadCall) => {
		const parent = loadCall.parent;
		if (ts.isCallExpression(parent)) {
			// We have something like nls.config({...})()('key', 'message');
			memo.push(parent);
		} else if (ts.isVariableDeclaration(parent)) {
			// We have something like var localize = nls.config({...})();
			const references = service.getReferencesAtPosition(filename, parent.name.pos + 1);
			if (references) {
				references.forEach(reference => {
					if (!reference.isWriteAccess) {
						const node = findClosestNode(sourceFile, reference.textSpan);
						if (node) {
							if (ts.isIdentifier(node)) {
								let parent = node.parent;
								if (ts.isCallExpression(parent) && parent.arguments.length >= 2) {
									memo.push(parent);
								} else {
									let position = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
									errors.push(`(${position.line + 1},${position.character + 1}): localize function (bound to ${node.text}) used in an unusual way.`);
								}
							}
						}
					}
				});
			}
		}
		return memo;
	}, []);

	loadCalls.reduce((memo, loadCall) => {
		if (loadCall.arguments.length === 0) {
			const args = loadCall.arguments;
			patches.push({
				span: { start: ts.getLineAndCharacterOfPosition(sourceFile, args.pos), end: ts.getLineAndCharacterOfPosition(sourceFile, args.end) },
				content: relativeFilename ? `require('path').join(__dirname, '${relativeFilename.replace(/\\/g, '\\\\')}')` : '__filename',
			});
		}
		return memo;
	}, patches);

	let messageIndex = 0;
	localizeCalls.reduce((memo, localizeCall) => {
		const firstArg = localizeCall.arguments[0];
		const secondArg = localizeCall.arguments[1];
		let key: string | null = null;
		let message: string | null = null;
		let comment: string[] = [];
		let text: string | null = null;
		if (ts.isStringLiteralLike(firstArg)) {
			text = firstArg.getText();
			key = text.substr(1, text.length - 2);
		} else if (ts.isObjectLiteralExpression(firstArg)) {
			for (let i = 0; i < firstArg.properties.length; i++) {
				const property = firstArg.properties[i];
				if (ts.isPropertyAssignment(property)) {
					const name = property.name.getText();
					if (name === 'key') {
						const initializer = property.initializer;
						if (ts.isStringLiteralLike(initializer)) {
							text = initializer.getText();
							key = text.substr(1, text.length - 2);
						}
					} else if (name === 'comment') {
						const initializer = property.initializer;
						if (ts.isArrayLiteralExpression(initializer)) {
							initializer.elements.forEach(element => {
								if (ts.isStringLiteralLike(element)) {
									text = element.getText();
									comment.push(text.substr(1, text.length - 2));
								}
							});
						}
					}
				}
			}
		}
		if (!key) {
			const position = ts.getLineAndCharacterOfPosition(sourceFile, firstArg.pos);
			errors.push(`(${position.line + 1},${position.character + 1}): first argument of a localize call must either be a string literal or an object literal of type LocalizeInfo.`);
			return memo;
		}
		if (ts.isStringLiteralLike(secondArg)) {
			const text = secondArg.getText();
			message = text.substr(1, text.length - 2);
		}
		if (!message) {
			const position = ts.getLineAndCharacterOfPosition(sourceFile, secondArg.pos);
			errors.push(`(${position.line + 1},${position.character + 1}): second argument of a localize call must be a string literal.`);
			return memo;
		}
		message = unescapeString(message);
		memo.patches.push({
			span: { start: ts.getLineAndCharacterOfPosition(sourceFile, firstArg.pos + firstArg.getLeadingTriviaWidth()), end: ts.getLineAndCharacterOfPosition(sourceFile, firstArg.end) },
			content: messageIndex.toString()
		});
		memo.patches.push({
			span: { start: ts.getLineAndCharacterOfPosition(sourceFile, secondArg.pos + secondArg.getLeadingTriviaWidth()), end: ts.getLineAndCharacterOfPosition(sourceFile, secondArg.end) },
			content: 'null'
		});
		bundle.messages.push(message);
		if (comment.length > 0) {
			bundle.keys.push({
				key: key,
				comment: comment
			});
		} else {
			bundle.keys.push(key);
		}
		messageIndex++;
		return memo;
	}, { patches });

	return {
		patches,
		errors,
		bundle
	};
}

export function processFile(contents: string, relativeFileName: string | undefined, sourceMap?: string | RawSourceMap): { contents: string | undefined, sourceMap: string | undefined, bundle: JavaScriptMessageBundle | undefined, errors: string[] } {

	const analysisResult = analyze(contents, relativeFileName);
	if (analysisResult.patches.length === 0) {
		return {
			contents: undefined,
			sourceMap: undefined,
			bundle: undefined,
			errors: analysisResult.errors
		};
	}
	let rawSourceMap: RawSourceMap | undefined = undefined;
	if (isString(sourceMap)) {
		try {
			rawSourceMap = JSON.parse(sourceMap);
		} catch (e) {
		}
	} else if (sourceMap) {
		rawSourceMap = sourceMap;
	}

	const textModel = new TextModel(contents, rawSourceMap);
	textModel.apply(analysisResult.patches);

	return {
		contents: textModel.toString(),
		sourceMap: textModel.generateSourceMap(),
		bundle: analysisResult.bundle,
		errors: analysisResult.errors
	};
}

function stripComments(content: string): string {
	/**
	* First capturing group matches double quoted string
	* Second matches single quotes string
	* Third matches block comments
	* Fourth matches line comments
	*/
	var regexp: RegExp = /("(?:[^\\\"]*(?:\\.)?)*")|('(?:[^\\\']*(?:\\.)?)*')|(\/\*(?:\r?\n|.)*?\*\/)|(\/{2,}.*?(?:(?:\r?\n)|$))/g;
	let result = content.replace(regexp, (match, _m1, _m2, m3, m4) => {
		// Only one of m1, m2, m3, m4 matches
		if (m3) {
			// A block comment. Replace with nothing
			return '';
		} else if (m4) {
			// A line comment. If it ends in \r?\n then keep it.
			let length = m4.length;
			if (length > 2 && m4[length - 1] === '\n') {
				return m4[length - 2] === '\r' ? '\r\n' : '\n';
			} else {
				return '';
			}
		} else {
			// We match a string
			return match;
		}
	});
	return result;
}

export function resolveMessageBundle(bundle: JavaScriptMessageBundle): ResolvedJavaScriptMessageBundle;
export function resolveMessageBundle(bundle: PackageJsonMessageBundle): PackageJsonMessageBundle;
export function resolveMessageBundle(bundle: JavaScriptMessageBundle | PackageJsonMessageBundle): ResolvedJavaScriptMessageBundle | PackageJsonMessageBundle | null {
	if (JavaScriptMessageBundle.is(bundle)) {
		if (bundle.messages.length !== bundle.keys.length) {
			return null;
		}
		const keys: string[] = [];
		const map: Map<string> = Object.create(null);
		bundle.keys.forEach((key, index) => {
			const resolvedKey = isString(key) ? key : key.key;
			keys.push(resolvedKey);
			map[resolvedKey] = bundle.messages[index];
		});
		return { messages: bundle.messages, keys: keys, map };
	} else {
		return bundle;
	}
}

export interface LocalizedMessagesResult {
	messages: string[] | Map<String>;
	problems: string[];
}

export function createLocalizedMessages(filename: string, bundle: ResolvedJavaScriptMessageBundle | PackageJsonMessageBundle, languageFolderName: string, i18nBaseDir: string, baseDir?: string): LocalizedMessagesResult {
	const problems: string[] = [];
	const i18nFile = (baseDir
		? path.join(i18nBaseDir, languageFolderName, baseDir, filename)
		: path.join(i18nBaseDir, languageFolderName, filename)) + '.i18n.json';

	let messages: Map<string> | undefined;
	let bundleLength = ResolvedJavaScriptMessageBundle.is(bundle) ? bundle.keys.length : Object.keys(bundle).length;
	if (fs.existsSync(i18nFile)) {
		const content = stripComments(fs.readFileSync(i18nFile, 'utf8'));
		messages = JSON.parse(content) as Map<string>;
		if (Object.keys(messages).length === 0) {
			if (bundleLength > 0) {
				problems.push(`Message file ${i18nFile.substr(i18nBaseDir.length + 1)} is empty. Missing messages: ${bundleLength}`);
			}
			messages = undefined;
		}
	} else {
		if (bundleLength > 0) {
			problems.push(`Message file ${i18nFile.substr(i18nBaseDir.length + 1)} not found. Missing messages: ${bundleLength}`);
		}
	}

	let translatedMessages: string[] | Map<string>;

	if (ResolvedJavaScriptMessageBundle.is(bundle)) {
		translatedMessages = ResolvedJavaScriptMessageBundle.asTranslatedMessages(bundle, messages, problems);
	} else {
		translatedMessages = PackageJsonMessageBundle.asTranslatedMessages(bundle, messages, problems);
	}
	if (problems.length > 0) {
		problems.unshift(`Generating localized messages for '${languageFolderName}' resulted in the following problems:`, '');
		problems.push('', '');
	}
	return { messages: translatedMessages, problems };
}

export function bundle2keyValuePair(bundle: JavaScriptMessageBundle, commentSeparator: string | undefined = undefined): any {
	let result = Object.create(null);

	for (var i = 0; i < bundle.messages.length; ++i) {
		let key: string;
		let comments: string[] | undefined;
		let keyInfo = bundle.keys[i];

		if (LocalizeInfo.is(keyInfo)) {
			key = keyInfo.key;
			comments = keyInfo.comment;
		} else {
			key = keyInfo;
		}

		if (key in result) {
			throw new Error(`The following key is duplicated: "${key}". Please use unique keys.`);
		}

		result[key] = bundle.messages[i];

		if (comments) {
			if (commentSeparator) {
				result[`_${key}.comments`] = comments.join(commentSeparator);
			} else {
				result[`_${key}.comments`] = comments;
			}
		}
	}

	return result;
}

export function removePathPrefix(path: string, prefix: string): string {
	if (!prefix) {
		return path;
	}
	if (!path.startsWith(prefix)) {
		return path;
	}
	const ch = prefix.charAt(prefix.length - 1);

	if (ch === '/' || ch === '\\') {
		return path.substr(prefix.length);
	} else {
		return path.substr(prefix.length + 1);
	}
}


export interface SingleMetaDataFile {
	messages: string[];
	keys: KeyInfo[];
	filePath: string;
}

export interface BundledMetaDataEntry {
	messages: string[];
	keys: KeyInfo[];
}

export interface BundledMetaDataHeader {
	id: string;
	type: string;
	hash: string;
	outDir: string;
}

export interface BundledMetaDataFile {
	[key: string]: BundledMetaDataEntry;
}

export class MetaDataBundler {

	private content: BundledMetaDataFile = Object.create(null);

	get size(): number {
		return Object.keys(this.content).length;
	}

	constructor(private id: string, private outDir: string) { }

	add(file: SingleMetaDataFile) {
		this.content[file.filePath.replace(/\\/g, '/')] = { messages: file.messages, keys: file.keys };
	}

	bundle(): [BundledMetaDataHeader, BundledMetaDataFile] {
		// We use md5 since we only need a finger print.
		// The actual data is public and put into a file.
		// Since the hash is used as a file name in the file
		// system md5 shortens the name and therefore the path
		// especially under Windows (max path issue).
		const md5 = crypto.createHash('md5');
		const keys = Object.keys(this.content).sort();
		for (let key of keys) {
			md5.update(key);
			const entry: BundledMetaDataEntry = this.content[key];
			for (const keyInfo of entry.keys) {
				if (isString(keyInfo)) {
					md5.update(keyInfo);
				} else {
					md5.update(keyInfo.key);
				}
			}
			for (let message of entry.messages) {
				md5.update(message);
			}
		}
		const hash = md5.digest('hex');
		const header: BundledMetaDataHeader = {
			id: this.id,
			type: 'extensionBundle',
			hash,
			outDir: this.outDir
		};

		return [header, this.content];
	}
}
