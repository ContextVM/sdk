import { expect, test } from 'bun:test';
import { TaskQueue } from './task-queue.js';

test('bounds waiting work while preserving concurrency and recovering capacity', async () => {
  const queue = new TaskQueue(1);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  queue.add(() => blocked);
  for (let i = 0; i < 100; i++) {
    queue.add(async () => {
      calls++;
    });
  }
  queue.add(async () => {
    calls += 1000;
  });
  expect(calls).toBe(0);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(100);
  queue.add(async () => {
    calls++;
  });
  await queue.shutdown();
  expect(calls).toBe(101);
  queue.add(async () => {
    calls += 1000;
  });
  expect(calls).toBe(101);
});
