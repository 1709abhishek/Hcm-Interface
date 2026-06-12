import { Injectable } from '@nestjs/common';

/**
 * Minimal promise-based mutex.
 * Better-sqlite3 uses a single synchronous connection; TypeORM wraps it in async,
 * which means concurrent `dataSource.transaction()` calls will collide on BEGIN.
 * Serialising through this mutex restores the "single-writer" guarantee the TRD relies on.
 */
@Injectable()
export class DbMutex {
  private queue: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = this.queue.then(() => fn()).finally(() => release());
    this.queue = next;
    return result;
  }
}
