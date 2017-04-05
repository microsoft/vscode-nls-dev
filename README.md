# vscode-nls-dev
The tools automates the extraction of strings to be externalized from TS and JS code. It therefore helps localizing VSCode extensions and 
language servers written in TS and JS. It also contains helper methods to convert unlocalized JSON to XLIFF format for translations, and back to localized JSON files, with ability to push and pull localizations from Transifex platform.

[![Build Status](https://travis-ci.org/Microsoft/vscode-nls-dev.svg?branch=master)](https://travis-ci.org/Microsoft/vscode-nls-dev)
[![NPM Version](https://img.shields.io/npm/v/vscode-nls-dev.svg)](https://npmjs.org/package/vscode-nls-dev)
[![NPM Downloads](https://img.shields.io/npm/dm/vscode-nls-dev.svg)](https://npmjs.org/package/vscode-nls-dev)

* 2.0.0: based on TypeScript 2.0. Since TS changed the shape of the d.ts files for 2.0.x a major version number got introduce to not
  break existing clients using TypeScript 1.8.x.

### JSON->XLIFF->JSON
To perform unlocalized JSON to XLIFF conversion it is required to call `prepareXlfFiles(projectName, extensionName)` piping your extension/language server directory to it, where `projectName` is the Transifex project name (if such exists) and `extensionName` is the name of your extension/language server. Thereby, XLF files will have a path of `projectName/extensionName.xlf`.

To convert translated XLIFF to localized JSON files `prepareJsonFiles()` should be called, piping `.xlf` files to it. It will parse translated XLIFF to JSON files, reconstructed under original file paths.

### Transifex Push and Pull
Updating Transifex with latest unlocalized strings is done via `pushXlfFiles('www.transifex.com', apiName, apiToken)` and `pullXlfFiles('www.transifex.com', apiName, apiToken, resources)` for pulling localizations respectively. When pulling, you have to provide `resources` array with object literals that have `name` and `project` properties. `name` corresponds to the resource name in Transifex and `project` is a project name of your Transifex project where this resource is stored.

## LICENSE
[MIT](LICENSE)