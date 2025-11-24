/**
 * Execution Lock Manager
 * Prevents concurrent executions to avoid interference with shared screen session
 */

class ExecutionLockManager {
  constructor() {
    this.locks = new Map(); // Map of projectName -> lock info
  }

  /**
   * Acquire a lock for a project
   * @param {string} projectName - Project name
   * @param {string} executionId - Unique execution identifier (e.g., todoId)
   * @returns {boolean} - true if lock acquired, false if already locked
   */
  acquireLock(projectName, executionId) {
    const key = projectName || "global";
    
    if (this.locks.has(key)) {
      const existingLock = this.locks.get(key);
      console.log(
        `[EXECUTION-LOCK] Lock already held for ${key} by execution ${existingLock.executionId}`
      );
      return false;
    }

    this.locks.set(key, {
      executionId,
      acquiredAt: Date.now(),
      projectName,
    });

    console.log(
      `[EXECUTION-LOCK] Lock acquired for ${key} by execution ${executionId}`
    );
    return true;
  }

  /**
   * Release a lock for a project
   * @param {string} projectName - Project name
   * @param {string} executionId - Execution identifier (must match to release)
   * @returns {boolean} - true if lock released, false if lock doesn't exist or doesn't match
   */
  releaseLock(projectName, executionId) {
    const key = projectName || "global";
    
    if (!this.locks.has(key)) {
      console.warn(
        `[EXECUTION-LOCK] Attempted to release non-existent lock for ${key}`
      );
      return false;
    }

    const lock = this.locks.get(key);
    if (lock.executionId !== executionId) {
      console.warn(
        `[EXECUTION-LOCK] Lock release attempted with wrong executionId. Expected: ${lock.executionId}, Got: ${executionId}`
      );
      return false;
    }

    this.locks.delete(key);
    console.log(
      `[EXECUTION-LOCK] Lock released for ${key} by execution ${executionId}`
    );
    return true;
  }

  /**
   * Check if a project is currently locked
   * @param {string} projectName - Project name
   * @returns {boolean} - true if locked, false otherwise
   */
  isLocked(projectName) {
    const key = projectName || "global";
    return this.locks.has(key);
  }

  /**
   * Get lock information for a project
   * @param {string} projectName - Project name
   * @returns {object|null} - Lock info or null if not locked
   */
  getLockInfo(projectName) {
    const key = projectName || "global";
    return this.locks.get(key) || null;
  }

  /**
   * Force release all locks (use with caution, e.g., on server shutdown)
   */
  releaseAllLocks() {
    const count = this.locks.size;
    this.locks.clear();
    console.log(`[EXECUTION-LOCK] Force released ${count} lock(s)`);
  }

  /**
   * Clean up stale locks (locks older than maxAge)
   * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanupStaleLocks(maxAge = 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, lock] of this.locks.entries()) {
      if (now - lock.acquiredAt > maxAge) {
        console.warn(
          `[EXECUTION-LOCK] Cleaning up stale lock for ${key} (age: ${Math.floor((now - lock.acquiredAt) / 1000)}s)`
        );
        this.locks.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[EXECUTION-LOCK] Cleaned up ${cleaned} stale lock(s)`);
    }

    return cleaned;
  }
}

// Singleton instance
const executionLockManager = new ExecutionLockManager();

// Clean up stale locks every 30 minutes
setInterval(() => {
  executionLockManager.cleanupStaleLocks();
}, 30 * 60 * 1000);

module.exports = { executionLockManager };

