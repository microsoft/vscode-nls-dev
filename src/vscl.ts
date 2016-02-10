#!/usr/bin/env node
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as yargs from 'yargs';
import * as glob from 'glob';
import * as fs from 'fs';

import { processFile } from './main';


let argv = yargs
	.usage('Usage: vscl [options] files')
	.argv;

let hasError: boolean = false;
argv._.forEach(element => {
	glob(element, (err, matches) => {
		if (err) {
			console.error(err.message);
			hasError = true;
			return;
		}
		matches.forEach(match => {
			let contents: string = fs.readFileSync(match, 'utf8');
			let result = processFile(contents);
			if (result.errors && result.errors.length > 0) {
				result.errors.forEach(error => console.error(`${match}${error}`));
				hasError = true;
			}
			console.log(result.contents);
		});
	});
});
if (hasError) {
	process.exit(1);
}