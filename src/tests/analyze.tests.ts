/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as assert from 'assert';

import * as nlsDev from '../lib';

describe('Localize', () => {
	it('Analyze Simple Key', () => {
		let code: string[] = [
			"var nls = require('vscode-nls');",
			"var localize = nls.config({ locale: 'de-DE', cache: true })();",
			"localize('keyOne', '{0} {1}', 'Hello', 'World');",
			"//# sourceMappingURL=test.js.map"
		];
		let sourceMap: string = '{"version":3,"file":"test.js","sourceRoot":"","sources":["test.ts"],"names":[],"mappings":"AAAA,IAAY,GAAG,WAAM,YAAY,CAAC,CAAA;AAClC,IAAI,QAAQ,GAAG,GAAG,CAAC,MAAM,CAAC,EAAE,MAAM,EAAE,OAAO,EAAE,KAAK,EAAE,IAAI,EAAE,CAAC,EAAE,CAAC;AAC9D,QAAQ,CAAC,KAAK,EAAE,SAAS,EAAE,OAAO,EAAE,OAAO,CAAC,CAAC"}';
		let expected: string[] = [
			"var nls = require('vscode-nls');",
			"var localize = nls.config({ locale: 'de-DE', cache: true })(__filename);",
			"localize(0, null, 'Hello', 'World');",
			"//# sourceMappingURL=test.js.map"
		];
		let result = nlsDev.processFile(code.join('\r\n'), sourceMap);

		assert.strictEqual(result.contents, expected.join('\r\n'));
		assert.strictEqual(result.sourceMap, '{"version":3,"sources":["test.ts"],"names":[],"mappings":"AAAA,IAAY,GAAG,WAAM,YAAY,CAAC,CAAA;AAClC,IAAI,QAAQ,GAAG,GAAG,CAAC,MAAM,CAAC,EAAE,MAAM,EAAE,OAAO,EAAE,KAAK,EAAE,IAAI,EAAE,CAAC,YAAE,CAAC;AAC9D,QAAQ,CAAC,aAAyB,EAAE,OAAO,CAAC,CAAC","sourceRoot":""}');
		assert.deepStrictEqual(result.bundle, {
			messages: [
				'{0} {1}'
			],
			keys: [
				'keyOne'
			]
		});
	});
	it('Analyze Complex Key', () => {
		let code: string[] = [
			"var nls = require('vscode-nls');",
			"var localize = nls.config({ locale: 'de-DE', cache: true })();",
			"localize({",
			"    key: 'keyOne',",
			"    comment: ['comment'],",
			"}, '{0} {1}', 'Hello', 'World');",
			"//# sourceMappingURL=test.js.map"
		];
		let sourceMap: string = '{"version":3,"file":"test.js","sourceRoot":"","sources":["test.ts"],"names":[],"mappings":"AAAA,IAAY,GAAG,WAAM,YAAY,CAAC,CAAA;AAClC,IAAI,QAAQ,GAAG,GAAG,CAAC,MAAM,CAAC,EAAE,MAAM,EAAE,OAAO,EAAE,KAAK,EAAE,IAAI,EAAE,CAAC,EAAE,CAAC;AAC9D,QAAQ,CAAC;IACR,GAAG,EAAE,KAAK;IACV,QAAQ,EAAE,CAAC,SAAS,CAAC;CACrB,EAAE,SAAS,EAAE,OAAO,EAAE,OAAO,CAAC,CAAC"}';
		let expected: string[] = [
			"var nls = require('vscode-nls');",
			"var localize = nls.config({ locale: 'de-DE', cache: true })(__filename);",
			"localize(0, null, 'Hello', 'World');",
			"//# sourceMappingURL=test.js.map"
		];
		let result = nlsDev.processFile(code.join('\r\n'), sourceMap);
		assert.strictEqual(result.contents, expected.join('\r\n'));
		assert.strictEqual(result.sourceMap, '{"version":3,"sources":["test.ts"],"names":[],"mappings":"AAAA,IAAY,GAAG,WAAM,YAAY,CAAC,CAAA;AAClC,IAAI,QAAQ,GAAG,GAAG,CAAC,MAAM,CAAC,EAAE,MAAM,EAAE,OAAO,EAAE,KAAK,EAAE,IAAI,EAAE,CAAC,YAAE,CAAC;AAC9D,QAAQ,CAAC,CAGR,EAAE,IAAS,EAAE,OAAO,EAAE,OAAO,CAAC,CAAC","sourceRoot":""}');
		assert.deepStrictEqual(result.bundle, {
			messages: [
				'{0} {1}'
			],
			keys: [
				{
					key: 'keyOne',
					comment: ['comment']
				}
			]
		});
	});
	it('loadMessageBundle', () => {
		let code: string[] = [
			"var nls = require('vscode-nls');",
			"var localize = nls.loadMessageBundle();",
			"localize('keyOne', '{0} {1}', 'Hello', 'World');"
		];
		let result = nlsDev.processFile(code.join('\n'));
		let expected: string[] = [
			"var nls = require('vscode-nls');",
			"var localize = nls.loadMessageBundle(__filename);",
			"localize(0, null, 'Hello', 'World');"
		];
		assert.strictEqual(result.contents, expected.join('\n'));
	})
});