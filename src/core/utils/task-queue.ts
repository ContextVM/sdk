import { sleep } from './utils.js';

/**
 * A simple, concurrency-limited task queue.
 * Ensures that no more than `concurrency` tasks are running at the same time.
 */
export class TaskQueue {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];
  private isShutdown = false;

  /**
   * Creates a new TaskQueue with the specified concurrency limit.
   * @param concurrency - Maximum number of concurrent tasks (default: 5)
   */
  constructor(private concurrency: number = 5) {}

  /**
   * Adds a task to the queue. It will start immediately if the concurrency limit hasn't been reached.
   * @param task - A function that returns a Promise
   */
  add(task: () => Promise<void>): void {
    if (this.isShutdown) {
      return;
    }
    this.queue.push(task);
    this.processNext();
  }

  /**
   * Gets the current queue size (number of pending tasks).
   * @returns The number of pending tasks
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Gets the number of currently running tasks.
   * @returns The number of running tasks
   */
  getRunningCount(): number {
    return this.running;
  }

  /**
   * Shuts down the queue, waiting for running tasks to complete with a timeout.
   * @param timeoutMs - Maximum time to wait for running tasks (default: 5000ms)
   * @returns Promise that resolves when shutdown is complete
   */
  async shutdown(timeoutMs: number = 5000): Promise<void> {
    this.isShutdown = true;
    const pendingCount = this.queue.length;
    if (pendingCount > 0) {
      this.queue = [];
    }

    const startTime = Date.now();
    while (this.running > 0 && Date.now() - startTime < timeoutMs) {
      await sleep(100);
    }

    if (this.running > 0) {
      console.warn(
        `TaskQueue shutdown timed out with ${this.running} tasks still running`,
      );
    }
  }

  /**
   * Processes the next task in the queue if concurrency limit allows.
   */
  private processNext(): void {
    if (this.running >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.running++;

    task().finally(() => {
      this.running--;
      this.processNext();
    });
  }
}
