/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert = require('assert');
import i18n = require('../main');

suite('XLF Parser Tests', () => {
	const sampleXlf = '<?xml version="1.0" encoding="utf-8"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="vs/base/common/keybinding" source-language="en" datatype="plaintext"><body><trans-unit id="key1"><source xml:lang="en">Key #1</source></trans-unit><trans-unit id="key2"><source xml:lang="en">Key #2 &amp;</source></trans-unit></body></file></xliff>';
	const sampleTranslatedXlf = '<?xml version="1.0" encoding="utf-8"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="vs/base/common/keybinding" source-language="en" target-language="ru" datatype="plaintext"><body><trans-unit id="key1"><source xml:lang="en">Key #1</source><target>Кнопка #1</target></trans-unit><trans-unit id="key2"><source xml:lang="en">Key #2 &amp;</source><target>Кнопка #2 &amp;</target></trans-unit></body></file></xliff>';
	const originalFilePath = 'vs/base/common/keybinding';
	const keys = ['key1', 'key2'];
	const messages = ['Key #1', 'Key #2 &'];
	const translatedMessages = { key1: 'Кнопка #1', key2: 'Кнопка #2 &' };

	test('Keys & messages to XLF conversion', () => {
		const xlf = new i18n.XLF('vscode-workbench');
		xlf.addFile(originalFilePath, keys, messages);
		const xlfString = xlf.toString();

		assert.strictEqual(xlfString.replace(/\s{2,}/g, ''), sampleXlf);
	});

	test('XLF to keys & messages conversion', () => {
		i18n.XLF.parse(sampleTranslatedXlf).then(function (resolvedFiles) {
			assert.deepStrictEqual(resolvedFiles[0].messages, translatedMessages);
			assert.strictEqual(resolvedFiles[0].originalFilePath, originalFilePath);
		});
	});

	test('Key with comments', () => {
		const xlf = new i18n.XLF('vscode-workbench');
		xlf.addFile(originalFilePath, [{ key: 'key1', comment: ['comment1']}], ['Key #1']);
		const xlfString = xlf.toString();
		const expected = '<?xml version="1.0" encoding="utf-8"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="vs/base/common/keybinding" source-language="en" datatype="plaintext"><body><trans-unit id="key1"><source xml:lang="en">Key #1</source><note>comment1</note></trans-unit></body></file></xliff>';
		assert.strictEqual(xlfString.replace(/\s{2,}/g, ''), expected);
	});

	test('Message with comments', () => {
		const xlf = new i18n.XLF('vscode-workbench');
		xlf.addFile(originalFilePath, ['key1'], [{ message: 'Key #1', comment: ['comment1']}]);
		const xlfString = xlf.toString();
		const expected = '<?xml version="1.0" encoding="utf-8"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file original="vs/base/common/keybinding" source-language="en" datatype="plaintext"><body><trans-unit id="key1"><source xml:lang="en">Key #1</source><note>comment1</note></trans-unit></body></file></xliff>';
		assert.strictEqual(xlfString.replace(/\s{2,}/g, ''), expected);
	});
});