import { AsyncLocalStorage } from "node:async_hooks";
import type http from "node:http";

import { logger } from "../logger.js";

type DeferredTask = () => Promise<void> | void;

interface DeferredTaskContext {
  readonly tasks: DeferredTask[];
  responseDone: boolean;
  flushScheduled: boolean;
  flushing: boolean;
}

const storage = new AsyncLocalStorage<DeferredTaskContext>();

export function runWithResponseDeferredTasks<T>(response: http.ServerResponse, callback: () => T): T {
  const context: DeferredTaskContext = {
    tasks: [],
    responseDone: false,
    flushScheduled: false,
    flushing: false
  };

  const markResponseDone = () => {
    context.responseDone = true;
    scheduleFlush(context);
  };

  response.once("finish", markResponseDone);
  response.once("close", markResponseDone);

  return storage.run(context, callback);
}

export function deferUntilResponseFinished(task: DeferredTask): boolean {
  const context = storage.getStore();
  if (!context) {
    return false;
  }

  context.tasks.push(task);
  if (context.responseDone) {
    scheduleFlush(context);
  }
  return true;
}

function scheduleFlush(context: DeferredTaskContext): void {
  if (!context.responseDone || context.flushScheduled) {
    return;
  }

  context.flushScheduled = true;
  setImmediate(() => {
    void flushTasks(context);
  });
}

async function flushTasks(context: DeferredTaskContext): Promise<void> {
  if (context.flushing) {
    return;
  }

  context.flushScheduled = false;
  context.flushing = true;
  try {
    while (context.tasks.length > 0) {
      const task = context.tasks.shift();
      if (!task) {
        continue;
      }

      try {
        await task();
      } catch (error) {
        logger.error("Deferred response task failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    context.flushing = false;
  }

  if (context.tasks.length > 0) {
    scheduleFlush(context);
  }
}
