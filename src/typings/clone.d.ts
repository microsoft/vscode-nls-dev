/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
 declare function fn<T>(obj: T, circular?:boolean, depth?: number): T;
 
 declare module 'clone' {
	export = fn;
}