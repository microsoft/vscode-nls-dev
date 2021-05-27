/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import * as webpack from 'webpack';
import { MetaDataBundler } from './lib';

export class NLSBundlePlugin {

	constructor(private id: string) { }

	apply(compiler: webpack.Compiler): void {
		compiler.hooks.emit.tap('NLSBundlePlugin', (compilation: any) => {
			const assets: any = {};
			const bundler = new MetaDataBundler(this.id, 'dist');

			for (const name of Object.keys(compilation.assets)) {
				if (!/nls\.metadata\.json$/.test(name)) {
					assets[name] = compilation.assets[name];
					continue;
				}

				const json = JSON.parse(compilation.assets[name].source().toString('utf8'));
				bundler.add(json);
			}

			// Skip empty NLS files
			if (bundler.size === 0) {
				return;
			}

			const [header, content] = bundler.bundle();
			const rawHeader = JSON.stringify(header);
			const rawContent = JSON.stringify(content);

			assets['nls.metadata.header.json'] = {
				source() { return rawHeader; },
				size() { return rawHeader.length; }
			};

			assets['nls.metadata.json'] = {
				source() { return rawContent; },
				size() { return rawContent.length; }
			};

			compilation.assets = assets;
		});
	}
}