// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { TypeScriptTask } from './TypeScriptTask';
import { TSLintTask } from './TSLintTask';
import { TextTask } from './TextTask';
import { RemoveTripleSlashReferenceTask } from './RemoveTripleSlashReferenceTask';
import { IExecutable, parallel, serial } from '@microsoft/gulp-core-build';

import {
  TscCmdTask,
  ITscCmdTaskConfig
} from './miniTasks/TscCmdTask';
import {
  TslintCmdTask,
  ITslintCmdTaskConfig
} from './miniTasks/TslintCmdTask';
import { ApiExtractorTask } from './miniTasks/ApiExtractorTask';

export * from './TypeScriptConfiguration';
export {
  TypeScriptTask,
  TscCmdTask,
  ITscCmdTaskConfig,
  TslintCmdTask,
  ITslintCmdTaskConfig
};

export const typescript: TypeScriptTask = new TypeScriptTask();
export const tslint: TSLintTask = new TSLintTask();
export const text: TextTask = new TextTask();
export const removeTripleSlash: RemoveTripleSlashReferenceTask = new RemoveTripleSlashReferenceTask();

export const tscCmd: TscCmdTask = new TscCmdTask();
export const tslintCmd: TslintCmdTask = new TslintCmdTask();
export const apiExtractor: ApiExtractorTask = new ApiExtractorTask();

// tslint:disable:export-name
export default parallel(tslint, serial(typescript, removeTripleSlash)) as IExecutable;
