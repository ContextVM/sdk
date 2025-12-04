/**
 * A simple, concurrency-limited task queue.
 * Ensures that no more than `concurrency` tasks are running at the same time.
 */
export class TaskQueue {
  private running = 0;
  private queue: Array<() => Promise<void>> = [];

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
