/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import { relative } from 'path';
import { processFile, removePathPrefix } from './lib';
import * as path from 'path';

/**
 * A [webpack loader](https://webpack.js.org/api/loaders/) that rewrite nls-calls.
 */
module.exports = function (this: any, content: any, map: any, meta: any) {
	console.assert(this.query && typeof this.query.base === 'string', 'Expected {base: string} option');

	const callback = this.async();
	const relativePath = relative(this.query.base, this.resourcePath);
	const result = processFile(content, relativePath, map);

	if (result.errors && result.errors.length > 0) {
		// error
		callback(new Error(result.errors.join()));
		return;
	}

	if (result.bundle) {
		const ext = path.extname(relativePath);
		const base = relativePath.substr(0, relativePath.length - ext.length);
		const metaDataContent = { ...result.bundle, filePath: removePathPrefix(base, this.query.base) };

		// this.emitFile(`${base}.nls.json`, JSON.stringify(result.bundle.messages, null, '\t'), 'utf8');
		this.emitFile(`${base}.nls.metadata.json`, JSON.stringify(metaDataContent, null, '\t'), 'utf8');
	}

	if (!result.contents) {
		// nothing
		callback(null, content, map, meta);
	} else {
		// result
		callback(null, result.contents, result.sourceMap, meta);
	}
};
