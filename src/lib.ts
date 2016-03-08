/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';

import * as ts from 'typescript';
import { RawSourceMap, SourceMapConsumer, SourceMapGenerator } from 'source-map';

import clone = require('clone');
import { ThroughStream } from 'through';
import { through } from 'event-stream';

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

export type KeyInfo = string | LocalizeInfo;

export interface JavaScriptMessageBundle {
	messages: string[];
	keys: KeyInfo[];
}

export namespace JavaScriptMessageBundle {
	export function is(value: any): value is JavaScriptMessageBundle {
		let candidate = value as JavaScriptMessageBundle;
		return candidate && isDefined(candidate.messages) && isDefined(candidate.keys);
	}
}

export interface ResolvedJavaScriptMessageBundle {
	messages: string[];
	keys: string[];
	map: Map<string>;
}

export namespace ResolvedJavaScriptMessageBundle {
	export function is(value: any): value is ResolvedJavaScriptMessageBundle {
		let candidate = value as ResolvedJavaScriptMessageBundle;
		return candidate && isDefined(candidate.keys) && isDefined(candidate.messages) && isDefined(candidate.map);
	}
	export function asTranslatedMessages(bundle: ResolvedJavaScriptMessageBundle, translatedMessages: Map<string>): string[] {
		let result: string[] = [];
		bundle.keys.forEach(key => {
			let translated = translatedMessages ? translatedMessages[key] : undefined;
			if (isUndefined(translated)) {
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
	export function asTranslatedMessages(bundle: PackageJsonMessageBundle, translatedMessages: Map<string>): Map<string> {
		let result: Map<string> = Object.create(null);
		Object.keys(bundle).forEach((key) => {
			let message = translatedMessages ? translatedMessages[key] : undefined;
			if (isUndefined(message)) {
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

interface MappingItem extends SourceMap.MappingItem {
	delete?: boolean;
	columnDelta?: number;
	lineDelta?: number;
}

interface Line {
	content: string;
	ending: string;
	mappings: MappingItem[];
}

const toString = Object.prototype.toString;

function isString(value: any): value is string {
	return toString.call(value) === '[object String]';
}

function isDefined(value: any): boolean {
	return typeof value !== 'undefined';
}

function isUndefined(value: any): boolean {
	return typeof value === 'undefined';
}

class TextModel {

	private lines: Line[];

	constructor(contents: string, private rawSourceMap?: RawSourceMap) {
		const regex = /\r\n|\r|\n/g;
		let index = 0;
		let match: RegExpExecArray;

		this.lines = [];

		while (match = regex.exec(contents)) {
			this.lines.push({ content: contents.substring(index, match.index), ending: match[0], mappings: null});
			index = regex.lastIndex;
		}

		if (contents.length > 0) {
			this.lines.push({ content: contents.substring(index, contents.length), ending: '', mappings: null });
		}
		if (rawSourceMap) {
			let sourceMapConsumer = new SourceMapConsumer(rawSourceMap);
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
		if (patches.length === 0){
			return;
		}

		patches = patches.sort((a, b) => {
			let lca = a.span.start;
			let lcb = b.span.start;
			return lca.line != lcb.line ? lca.line - lcb.line : lca.character - lcb.character;
		});

		let overlapping = false;
		if (patches.length > 1) {
			let previousSpan = patches[0].span;
			for (let i = 1; i < patches.length; i++) {
				let nextSpan = patches[i].span;

				if (previousSpan.end.line > nextSpan.start.line || (previousSpan.end.line === nextSpan.start.line && previousSpan.end.character >= nextSpan.start.character)) {
					overlapping = true;
					break;
				}
			}
		}
		if (overlapping) {
			throw new Error(`Overlapping text edits generated.`);
		}
		let lastPatch = patches[patches.length - 1];
		let lastLine = this.lines[this.lineCount - 1];

		if (lastPatch.span.end.line > this.lines.length || (lastPatch.span.end.line === this.lineCount && lastPatch.span.end.character > lastLine.content.length)) {
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
				startLine.content.substring(0, patch.span.start.character),
				patch.content,
				endLine.content.substring(patch.span.end.character)
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
					let mappingItem: MappingItem = null;
					while ((mappingItem = mappingCursor.index !== -1 ? startLine.mappings[mappingCursor.index] : null) != null
							&&  mappingItem.generatedColumn > patch.span.start.character) {
						if (mappingItem.generatedColumn < patch.span.end.character) {
							// The patch covers the source mapping. Delete it
							mappingItem.delete = true;
						}
						mappingCursor.index--;
					}
					// Record the delta on the first source marker after the patch.
					if (mappingCursor.index + 1 < startLine.mappings.length) {
						let mapping = startLine.mappings[mappingCursor.index + 1];
						mapping.columnDelta = (mapping.columnDelta || 0)  + delta;
					}
				} else {
					let startLineMappings =  startLine.mappings;
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
					let endLineMappins = endLine.mappings;
					if (endLineMappins) {
						let lineDelta = startLineNumber - endLineNumber;
						let index = 0;
						for (; index < endLineMappins.length; index++) {
							let mapping = endLineMappins[index];
							if (mapping.generatedColumn < patch.span.end.character) {
								mapping.delete = true;
							} else {
								break;
							}
						}
						if (index < endLineMappins.length) {
							let mapping = endLineMappins[index];
							mapping.lineDelta = lineDelta;
							mapping.columnDelta = (patch.span.start.character - patch.span.end.character) + patch.content.length;
						}
					}
				}
			}
		});
	}

	public generateSourceMap(): string {
		if (!this.rawSourceMap) {
			return undefined;
		}
		let sourceMapGenerator = new SourceMapGenerator({ sourceRoot: this.rawSourceMap.sourceRoot});
		let lineDelta = 0;
		this.lines.forEach(line => {
			let mappings = line.mappings;
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
		})
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

function analyze(contents: string, options: ts.CompilerOptions = {}): AnalysisResult {

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
			var stepResult = fn(node);

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
		return node.kind === ts.SyntaxKind.ImportDeclaration || node.kind === ts.SyntaxKind.ImportEqualsDeclaration;
	}

	function isRequireImport(node: ts.Node): boolean {
		if (node.kind !== ts.SyntaxKind.CallExpression) {
			return false;
		}
		const callExpression = node as ts.CallExpression;
		if (callExpression.expression.getText() !== 'require' || !callExpression.arguments || callExpression.arguments.length !== 1) {
			return false;
		}
		const argument = callExpression.arguments[0];
		return argument.kind === ts.SyntaxKind.StringLiteral && vscodeRegExp.test(argument.getText());
	}

	function findClosestNode(node: ts.Node, textSpan: ts.TextSpan): ts.Node {
		let textSpanEnd = textSpan.start + textSpan.length;
		function loop(node: ts.Node): ts.Node {
			let length = node.end - node.pos;
			if (node.pos === textSpan.start && length === textSpan.length) {
				return node;
			}
			if (node.pos <= textSpan.start && textSpanEnd <= node.end) {
				let candidadate = ts.forEachChild(node, loop);
				return candidadate || node;
			}
		}
		return loop(node);
	}

	function isIdentifier(node: ts.Node): node is ts.Identifier {
		return node && node.kind === ts.SyntaxKind.Identifier;
	}

	function isVariableDeclaration(node: ts.Node): node is ts.VariableDeclaration {
		return node && node.kind === ts.SyntaxKind.VariableDeclaration;
	}

	function isCallExpression(node: ts.Node): node is ts.CallExpression {
		return node && node.kind === ts.SyntaxKind.CallExpression;
	}

	function isPropertyAccessExpression(node: ts.Node): node is ts.PropertyAccessExpression {
		return node && node.kind === ts.SyntaxKind.PropertyAccessExpression;
	}
	
	function isStringLiteral(node: ts.Node): node is ts.StringLiteral {
		return node && node.kind === ts.SyntaxKind.StringLiteral;
	}
	
	function isObjectLiteral(node: ts.Node): node is ts.ObjectLiteralExpression {
		return node && node.kind === ts.SyntaxKind.ObjectLiteralExpression;
	}
	
	function isArrayLiteralExpression(node: ts.Node): node is ts.ArrayLiteralExpression {
		return node && node.kind === ts.SyntaxKind.ArrayLiteralExpression;
	}

	function isPropertyAssignment(node: ts.Node): node is ts.PropertyAssignment {
		return node && node.kind === ts.SyntaxKind.PropertyAssignment;
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
		var result: string[] = [];
		for (let i = 0; i < str.length; i++) {
			let ch = str.charAt(i);
			if (ch === '\\') {
				if (i + 1 < str.length) {
					let replace = unescapeMap[str.charAt(i + 1)];
					if (isDefined(replace)) {
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
	const sourceFile = service.getSourceFile(filename);

	const patches: Patch[] = [];
	const errors: string[] = [];
	const bundle: JavaScriptMessageBundle = { messages: [], keys: [] };

	// all imports
	const imports = collect(sourceFile, n => isRequireImport(n) ? CollectStepResult.YesAndRecurse : CollectStepResult.NoAndRecurse);

	const nlsReferences = imports.reduce<ts.Node[]>((memo, node) => {
		if (node.kind === ts.SyntaxKind.CallExpression) {
			let parent = node.parent;
			if (isVariableDeclaration(parent)) {
				let references = service.getReferencesAtPosition(filename, parent.name.pos + 1);
				references.forEach(reference => {
					if (!reference.isWriteAccess) {
						memo.push(findClosestNode(sourceFile, reference.textSpan));
					}
				});
			}
		}
		return memo;
	},[]);

	const loadCalls = nlsReferences.reduce<ts.CallExpression[]>((memo, node) => {
		let callExpression = node;
		while (callExpression && callExpression.kind != ts.SyntaxKind.CallExpression) {
			callExpression = callExpression.parent;
		}
		if (isCallExpression(callExpression)) {
			let expression = callExpression.expression;
			if (isPropertyAccessExpression(expression)) {
				if (expression.name.text === 'loadMessageBundle') {
					// We have a load call like nls.load();
					memo.push(callExpression);
				} else if (expression.name.text === 'config') {
					// We have a load call like nls.config({...})();
					let parent = callExpression.parent;
					if (isCallExpression(parent) && parent.expression === callExpression) {
						memo.push(parent);
					}
				}
			}
		}
		return memo;
	}, []);

	const localizeCalls = loadCalls.reduce<ts.CallExpression[]>((memo, loadCall) => {
		let parent = loadCall.parent;
		if (isCallExpression(parent)) {
			// We have something like nls.config({...})()('key', 'message');
			memo.push(parent);
		} else if (isVariableDeclaration(parent)) {
			// We have something like var localize = nls.config({...})();
			service.getReferencesAtPosition(filename, parent.name.pos + 1).forEach(reference => {
				if (!reference.isWriteAccess) {
					let node = findClosestNode(sourceFile, reference.textSpan);
					if (isIdentifier(node)) {
						let parent = node.parent;
						if (isCallExpression(parent) && parent.arguments.length >= 2) {
							memo.push(parent);
						} else {
							let position = ts.getLineAndCharacterOfPosition(sourceFile, node.pos);
							errors.push(`(${position.line + 1},${position.character + 1}): localize function (bound to ${node.text}) used in an unusal way.`);
						}
					}
				}
			});
		}
		return memo;
	}, []);

	loadCalls.reduce((memo, loadCall) => {
		if (loadCall.arguments.length === 0) {
			let args = loadCall.arguments;
			patches.push({
				span: { start: ts.getLineAndCharacterOfPosition(sourceFile, args.pos), end: ts.getLineAndCharacterOfPosition(sourceFile, args.end) },
				content: '__filename',
			});
		}
		return memo;
	}, patches);

	let messageIndex = 0;
	localizeCalls.reduce((memo, localizeCall) => {
		let firstArg = localizeCall.arguments[0];
		let secondArg = localizeCall.arguments[1];
		let key: string = null;
		let message: string = null;
		let comment: string[] = [];
		let text: string = null;
		if (isStringLiteral(firstArg)) {
			text = firstArg.getText();
			key = text.substr(1, text.length - 2);
		} else if (isObjectLiteral(firstArg)) {
			for (let i = 0; i < firstArg.properties.length; i++) {
				let property = firstArg.properties[i];
				if (isPropertyAssignment(property)) {
					let name = property.name.getText();
					if (name === 'key') {
						let initializer = property.initializer;
						if (isStringLiteral(initializer)) {
							text = initializer.getText();
							key = text.substr(1, text.length - 2);
						}
					} else if (name === 'comment') {
						let initializer = property.initializer;
						if (isArrayLiteralExpression(initializer)) {
							initializer.elements.forEach(element => {
								if (isStringLiteral(element)) {
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
			let position = ts.getLineAndCharacterOfPosition(sourceFile, firstArg.pos);
			errors.push(`(${position.line + 1},${position.character + 1}): first argument of a localize call must either be a string literal a object literal of type LocalizeInfo.`);
			return memo;
		}
		if (isStringLiteral(secondArg)) {
			let text = secondArg.getText();
			message = text.substr(1, text.length - 2);
		}
		if (!message) {
			let position = ts.getLineAndCharacterOfPosition(sourceFile, secondArg.pos);
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

export function processFile(contents: string, sourceMap?: string | RawSourceMap): { contents: string, sourceMap: string, bundle: JavaScriptMessageBundle, errors: string[] } {

	const analysisResult = analyze(contents);
	if (analysisResult.patches.length === 0) {
		return {
			contents: undefined,
			sourceMap: undefined,
			bundle: undefined,
			errors: analysisResult.errors
		};
	}
	let rawSourceMap: RawSourceMap = undefined;
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
	let result = content.replace(regexp, (match, m1, m2, m3, m4) => {
		// Only one of m1, m2, m3, m4 matches
		if (m3) {
			// A block comment. Replace with nothing
			return '';
		} else if (m4) {
			// A line comment. If it ends in \r?\n then keep it.
			let length = m4.length;
			if (length > 2 && m4[length - 1] === '\n') {
				return m4[length - 2] === '\r' ? '\r\n': '\n';
			} else {
				return '';
			}
		} else {
			// We match a string
			return match;
		}
	});
	return result;
};

export function resolveMessageBundle(bundle: JavaScriptMessageBundle): ResolvedJavaScriptMessageBundle;
export function resolveMessageBundle(bundle: PackageJsonMessageBundle): PackageJsonMessageBundle;
export function resolveMessageBundle(bundle: JavaScriptMessageBundle | PackageJsonMessageBundle): ResolvedJavaScriptMessageBundle | PackageJsonMessageBundle {
	if (JavaScriptMessageBundle.is(bundle)) {
		if (bundle.messages.length !== bundle.keys.length) {
			return null;
		}
		let keys: string[] = [];
		let map: Map<string> = Object.create(null);
		bundle.keys.forEach((key, index) => {
			let resolvedKey = isString(key) ? key : key.key;
			keys.push(resolvedKey);
			map[resolvedKey] = bundle.messages[index];
		});
		return { messages: bundle.messages, keys: keys, map };		
	} else {
		return bundle;
	}
}

export function createLocalizedMessages(filename: string, bundle: ResolvedJavaScriptMessageBundle | PackageJsonMessageBundle, language: string, i18nBaseDir: string, component?: string): string[] | Map<String> {
	let i18nFile = (component 
		? path.join(i18nBaseDir, language, component, filename)
		: path.join(i18nBaseDir, language, filename)) + '.i18n.json';
	let messages: Map<string>;
	
	if (fs.existsSync(i18nFile)) {
		let content = stripComments(fs.readFileSync(i18nFile, 'utf8'));
		messages = JSON.parse(content);
	}
	if (ResolvedJavaScriptMessageBundle.is(bundle)) {
		return ResolvedJavaScriptMessageBundle.asTranslatedMessages(bundle, messages);
	} else {
		return PackageJsonMessageBundle.asTranslatedMessages(bundle, messages);
	}
}