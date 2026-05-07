import * as vscode from 'vscode';
import execa = require('execa');
import logger from '../logger';
import { UploadHookContext, UploadHookPhase } from '../core/transferTask';

const COMMAND_VARIABLES = {
  localPath: 'localFsPath',
  remotePath: 'remoteFsPath',
  workspace: 'workspace',
  serviceName: 'serviceName',
  trigger: 'uploadTrigger',
} as const;

function applyCommandVariables(command: string, context: UploadHookContext): string {
  return Object.keys(COMMAND_VARIABLES).reduce((result, key) => {
    const contextKey = COMMAND_VARIABLES[key as keyof typeof COMMAND_VARIABLES];
    const value = context[contextKey];
    if (value === undefined || value === null) {
      return result;
    }

    return result.split('${' + key + '}').join(String(value));
  }, command);
}

async function findTaskByName(name: string): Promise<vscode.Task | undefined> {
  const tasks = await vscode.tasks.fetchTasks();
  return tasks.find(task => task.name === name);
}

async function executeTaskByName(task: vscode.Task): Promise<number> {
  const execution = await vscode.tasks.executeTask(task);

  return new Promise<number>(resolve => {
    let processEnded = false;
    const onTaskProcessEnd = vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution !== execution) {
        return;
      }

      processEnded = true;
      disposeListeners();
      resolve(typeof event.exitCode === 'number' ? event.exitCode : 0);
    });

    const onTaskEnd = vscode.tasks.onDidEndTask(event => {
      if (event.execution !== execution) {
        return;
      }

      if (!processEnded) {
        disposeListeners();
        resolve(0);
      }
    });

    function disposeListeners() {
      onTaskProcessEnd.dispose();
      onTaskEnd.dispose();
    }
  });
}

function createErrorMessage(
  phase: UploadHookPhase,
  command: string,
  code: number,
  output: string,
  context: UploadHookContext,
  isTask: boolean
): string {
  const mode = isTask ? 'task' : 'command';
  const filePath = context.localFsPath;
  const outputMessage = output ? '\n' + output.trim() : '';

  return [
    'Upload ' + phase + ' hook ' + mode + ' failed.',
    mode + ': ' + command,
    'exitCode: ' + code,
    'file: ' + filePath,
  ].join(' ') + outputMessage;
}

async function runHook(
  phase: UploadHookPhase,
  rawCommand: string,
  context: UploadHookContext
): Promise<void> {
  const commandOrTask = applyCommandVariables(rawCommand, context).trim();
  if (!commandOrTask) {
    return;
  }

  const task = await findTaskByName(commandOrTask);
  if (task) {
    logger.info('[upload-hook][' + phase + '] run task: ' + commandOrTask);
    const exitCode = await executeTaskByName(task);
    if (exitCode !== 0) {
      throw new Error(
        createErrorMessage(phase, commandOrTask, exitCode, '', context, true) +
          '\nSee the task terminal for details.'
      );
    }
    return;
  }

  logger.info('[upload-hook][' + phase + '] run command: ' + commandOrTask);
  const result = await execa.command(commandOrTask, {
    cwd: context.workspace || process.cwd(),
    shell: true,
    reject: false,
    windowsHide: true,
  });

  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      createErrorMessage(phase, commandOrTask, result.exitCode, output, context, false)
    );
  }
}

export async function runUploadHooks(
  phase: UploadHookPhase,
  tasks: string[],
  context: UploadHookContext
): Promise<void> {
  for (const task of tasks) {
    await runHook(phase, task, context);
  }
}
