/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import { processFile } from "./lib";
import { relative } from "path";

/**
 * A [webpack loader](https://webpack.js.org/api/loaders/) that rewrite nls-calls.
 */
module.exports = function (content, map, meta) {
	const callback = this.async();
	const relativePath = relative(this.resourcePath, this.context);
	const result = processFile(content, relativePath, map);
	if (result.errors && result.errors.length > 0) {
		// error
		callback(new Error(result.errors.join()));
	} else if (!result.contents) {
		// nothing
		callback(null, content, map, meta);
	} else {
		// result
		callback(null, result.contents, result.sourceMap, meta);
	}
}
