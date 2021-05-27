# vscode-nls-dev
The tools automates the extraction of strings to be externalized from TS and JS code. It therefore helps localizing VSCode extensions and
language servers written in TS and JS. It also contains helper methods to convert unlocalized JSON to XLIFF format for translations, and back to localized JSON files, with ability to push and pull localizations from Transifex platform.

[![Build Status](https://travis-ci.org/Microsoft/vscode-nls-dev.svg?branch=master)](https://travis-ci.org/Microsoft/vscode-nls-dev)
[![NPM Version](https://img.shields.io/npm/v/vscode-nls-dev.svg)](https://npmjs.org/package/vscode-nls-dev)
[![NPM Downloads](https://img.shields.io/npm/dm/vscode-nls-dev.svg)](https://npmjs.org/package/vscode-nls-dev)

### 4.0.0-next.1

* [Add support for comments in messages (e.g. package.nls.json)](https://github.com/microsoft/vscode-nls-dev/issues/32)
* Remove Transifex support
* General code cleanup. Move to TS 4.3.1 and more stricter type checking.

### 3.3.2

* Merged [allow es imports, update ts and use their helper methods](https://github.com/microsoft/vscode-nls-dev/pull/27)

### 3.0.0

* added support to bundle the strings into a single `nls.bundle(.${locale})?.json` file.
* added support for VS Code language packs.

### 2.1.0:

* Add support to push to and pull from Transifex.

### 2.0.0:

* based on TypeScript 2.0. Since TS changed the shape of the d.ts files for 2.0.x a major version number got introduce to not break existing clients using TypeScript 1.8.x.

### JSON->XLIFF->JSON
To perform unlocalized JSON to XLIFF conversion it is required to call `prepareXlfFiles(projectName, extensionName)` piping your extension/language server directory to it, where `projectName` is the Transifex project name (if such exists) and `extensionName` is the name of your extension/language server. Thereby, XLF files will have a path of `projectName/extensionName.xlf`.

To convert translated XLIFF to localized JSON files `prepareJsonFiles()` should be called, piping `.xlf` files to it. It will parse translated XLIFF to JSON files, reconstructed under original file paths.

### Transifex Push and Pull
Updating Transifex with latest unlocalized strings is done via `pushXlfFiles('www.transifex.com', apiName, apiToken)` and `pullXlfFiles('www.transifex.com', apiName, apiToken, languages, resources)` for pulling localizations respectively. When pulling, you have to provide `resources` array with object literals that have `name` and `project` properties. `name` corresponds to the resource name in Transifex and `project` is a project name of your Transifex project where this resource is stored. `languages` argument is an array of strings of culture names to be pulled from Transifex.


### Onboarding Extension to Transifex
Here is a sample code that adds localization using Transifex. You can copy and use it as a template for your own extension, changing the values to the ones described in the code comments.

```javascript
var nls = require('vscode-nls-dev');
const vscodeLanguages = [
	'zh-hans',
	'zh-hant',
	'ja',
	'ko',
	'de',
	'fr',
	'es',
	'ru',
	'it'
]; // languages an extension has to be translated to

const transifexApiHostname = 'www.transifex.com';
const transifexApiName = 'api';
const transifexApiToken = process.env.TRANSIFEX_API_TOKEN; // token to talk to Transifex (to obtain it see https://docs.transifex.com/api/introduction#authentication)
const transifexProjectName = 'vscode-extensions'; // your project name in Transifex
const transifexExtensionName = 'vscode-node-debug'; // your resource name in Transifex

gulp.task('transifex-push', function() {
	return gulp.src('**/*.nls.json')
		.pipe(nls.prepareXlfFiles(transifexProjectName, transifexExtensionName))
		.pipe(nls.pushXlfFiles(transifexApiHostname, transifexApiName, transifexApiToken));
});

gulp.task('transifex-pull', function() {
	return nls.pullXlfFiles(transifexApiHostname, transifexApiName, transifexApiToken, vscodeLanguages, [{ name: transifexExtensionName, project: transifexProjectName }])
		.pipe(gulp.dest(`../${transifexExtensionName}-localization`));
});

gulp.task('i18n-import', function() {
	return gulp.src(`../${transifexExtensionName}-localization/**/*.xlf`)
		.pipe(nls.prepareJsonFiles())
		.pipe(gulp.dest('./i18n'));
});
```

To push strings for translation to Transifex you call `gulp transifex-push`. To pull and perform the import of latest translations from Transifex to your extension, you need to call `transifex-pull` and `i18n-import` sequentially. This will pull XLF files from Transifex in first gulp task, and import them to i18n folder in JSON format.

## LICENSE
[MIT](License.txt)
