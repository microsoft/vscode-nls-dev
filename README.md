# vscode-nls-dev
The tools automates the extraction of strings to be externalized from TS and JS code. It therefore helps localizing VSCode extensions and 
language servers written in TS and JS. It also contains helper methods to convert to be translated JSON files to XLIFF format and back, with ability to update and pull localizations from Transifex.

[![Build Status](https://travis-ci.org/Microsoft/vscode-nls-dev.svg?branch=master)](https://travis-ci.org/Microsoft/vscode-nls-dev)
[![NPM Version](https://img.shields.io/npm/v/vscode-nls-dev.svg)](https://npmjs.org/package/vscode-nls-dev)
[![NPM Downloads](https://img.shields.io/npm/dm/vscode-nls-dev.svg)](https://npmjs.org/package/vscode-nls-dev)

* 2.0.0: based on TypeScript 2.0. Since TS changed the shape of the d.ts files for 2.0.x a major version number got introduce to not
  break existing clients using TypeScript 1.8.x.

### JSON->XLIFF->JSON
To perform unlocalized JSON to XLIFF conversion it is required to call `prepareXlfFiles(projectName, extensionName)` piping your extension/language server directory to it, where `projectName` is the Transifex project name (if such exists) and `extensionName` is the name of your extension/language server. Thereby, XLF files will have a path of `projectName/extensionName.xlf`.

To convert translated XLIFF to localized JSON files `prepareJsonFiles()` should be called, piping `.xlf` files to it. It will parse translated XLIFF to JSON files, reconstructed under original file paths. 

### Transifex Push and Pull
Updating Transifex with latest unlocalized strings is done via `pushXlfFiles('www.transifex.com', apiName, apiToken)` and `pullXlfFiles(projectName, 'www.transifex.com', apiName, apiToken)`. for pulling localizations respectively. 

## LICENSE
[MIT](LICENSE)