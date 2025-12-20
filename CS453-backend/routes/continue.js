const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const fsp = require("fs/promises");
const { dbHelpers } = require("../db");
const { PROJECTS_DIR } = require("../helpers/config");
const { createGitCheckpoint, getGitDiff } = require("../helpers/gitHelpers");
const {
  detectQuotaError,
  executeCodeWithContinue,
} = require("../helpers/continueHelpers");
const { executionLockManager } = require("../helpers/executionLock");

const router = express.Router();
const execAsync = promisify(exec);

// Execute a single todo (code or command)
router.post("/execute-todo/:todoId", async (req, res) => {
  const todoId = req.params.todoId;
  let lockAcquired = false;
  let projectName = null;

  try {
    const todo = await dbHelpers.getTodoById(todoId);

    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    projectName = todo.project_name;
    const projectPath = path.join(PROJECTS_DIR, projectName);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    // Acquire execution lock to prevent concurrent executions
    if (!executionLockManager.acquireLock(projectName, `todo-${todoId}`)) {
      const lockInfo = executionLockManager.getLockInfo(projectName);
      return res.status(409).json({
        error: "Another execution is already in progress for this project",
        details: lockInfo
          ? `Execution ${lockInfo.executionId} started ${Math.floor(
              (Date.now() - lockInfo.acquiredAt) / 1000
            )} seconds ago`
          : "Unknown execution in progress",
      });
    }
    lockAcquired = true;

    // Smart git checkpoint strategy:
    // 1. Always create checkpoint before execution (for revert capability)
    // 2. Get diff from this execution's checkpoint to show only this execution's changes
    // 3. Each execution has its own checkpoint, so diffs don't mix
    let gitCommitHash = null;
    let executionHistoryId = null;
    
    try {
      // Always create checkpoint before execution (for revert capability)
      // Each execution gets its own checkpoint, preventing confusion
      console.log(`[EXECUTE-TODO] Creating checkpoint before execution...`);
      gitCommitHash = await createGitCheckpoint(projectPath);
      
      if (gitCommitHash) {
        // Store execution history
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          gitCommitHash
        );
      } else {
        // Still create execution history entry without commit hash
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          null
        );
      }
    } catch (checkpointError) {
      console.error(`[EXECUTE-TODO] Checkpoint error:`, checkpointError);
      // Still create execution history entry
      try {
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          null
        );
      } catch (histError) {
        // Ignore
      }
    }

    // If no code snippet is provided, use a single space
    const codeSnippet = (!todo.code_snippet || !todo.code_snippet.trim()) 
      ? " " 
      : todo.code_snippet.trim();

    // Execute the todo (code or command)
    const result = await executeCodeWithContinue(
      codeSnippet,
      todo,
      projectPath
    );

    // Store execution iteration
    if (executionHistoryId) {
      await dbHelpers.insertExecutionIteration(
        executionHistoryId,
        todoId,
        1,
        codeSnippet,
        result.error,
        result.stdout,
        result.stderr,
        null,
        null,
        result.success ? "success" : "failed"
      );
    }

    if (result.success) {
      // Get git diff to show what changed in this execution
      // Always diff from this execution's checkpoint to show only this execution's changes
      // This prevents confusion when multiple todos are executed
      let codeDiff = null;
      
      console.log(`[EXECUTE-TODO] Attempting to get diff. gitCommitHash: ${gitCommitHash}`);
      
      if (gitCommitHash) {
        try {
          codeDiff = await getGitDiff(projectPath, gitCommitHash);
          console.log(`[EXECUTE-TODO] Git diff retrieved from checkpoint ${gitCommitHash}: ${codeDiff ? codeDiff.length + " chars" : "no changes"}`);
          if (codeDiff) {
            console.log(`[EXECUTE-TODO] Diff preview (first 500 chars): ${codeDiff.substring(0, 500)}`);
          }
        } catch (diffError) {
          console.error(`[EXECUTE-TODO] Failed to get git diff:`, diffError.message);
          console.error(`[EXECUTE-TODO] Diff error stack:`, diffError.stack);
        }
      } else {
        console.log(`[EXECUTE-TODO] No gitCommitHash, trying unstaged changes...`);
        // Try to get unstaged changes as fallback
        try {
          codeDiff = await getGitDiff(projectPath, null);
          console.log(`[EXECUTE-TODO] Unstaged diff retrieved: ${codeDiff ? codeDiff.length + " chars" : "no changes"}`);
        } catch (fallbackError) {
          console.error(`[EXECUTE-TODO] Failed to get unstaged diff:`, fallbackError.message);
        }
      }

      // Always update todo with diff if available (even if code_snippet exists)
      // This shows the actual changes made by execution
      if (codeDiff && codeDiff.trim().length > 0) {
        try {
          // Store diff in code_snippet field (will be displayed as diff in frontend)
          await dbHelpers.updateTodo(todoId, { 
            code_snippet: codeDiff,
            status: "completed" 
          });
          console.log(`[EXECUTE-TODO] ✅ Updated todo ${todoId} with code diff (${codeDiff.length} chars)`);
        } catch (updateError) {
          console.error(`[EXECUTE-TODO] Failed to update todo with diff:`, updateError.message);
          console.error(`[EXECUTE-TODO] Update error stack:`, updateError.stack);
          // Fallback: just update status
          try {
            await dbHelpers.updateTodo(todoId, { status: "completed" });
          } catch (statusError) {
            // Ignore
          }
        }
      } else {
        console.log(`[EXECUTE-TODO] ⚠️ No diff available (codeDiff: ${codeDiff ? "empty" : "null"}), just updating status`);
        // No diff available, just update status
        try {
          await dbHelpers.updateTodo(todoId, { status: "completed" });
        } catch (statusError) {
          // Ignore
        }
      }

      return res.json({
        success: true,
        output: result.stdout,
        error: result.stderr || null,
        filePath: result.filePath || null,
        checkpointCreated: !!gitCommitHash,
        gitCommitHash: gitCommitHash,
        codeDiff: codeDiff, // Include diff in response
      });
    } else {
      // Handle quota errors
      let errorMessage = result.error || "Execution failed";
      let quotaInfo = null;

      if (result.errorCode === "QUOTA_ERROR") {
        errorMessage = result.error;
        quotaInfo = result.quotaInfo;
      } else {
        const quotaError = detectQuotaError(
          result.rawResponse || result.stderr || result.stdout
        );
        if (quotaError) {
          errorMessage = `${quotaError.message}. ${quotaError.details}`;
          quotaInfo = {
            retryTime: quotaError.retryTime,
            quotaLimit: quotaError.quotaLimit,
          };
        }
      }

      return res.status(500).json({
        success: false,
        error: errorMessage,
        errorCode: result.errorCode || (quotaInfo ? "QUOTA_ERROR" : null),
        errorSignal: result.errorSignal,
        stderr: result.stderr,
        stdout: result.stdout,
        checkpointCreated: !!gitCommitHash,
        gitCommitHash: gitCommitHash,
        quotaInfo: quotaInfo,
      });
    }
  } catch (error) {
    res.status(500).json({
      error: "Failed to execute todo",
      details: error.message,
      todoId: todoId,
    });
  } finally {
    // Always release the lock
    if (lockAcquired && projectName) {
      try {
        executionLockManager.releaseLock(projectName, `todo-${todoId}`);
      } catch (releaseError) {
        console.error("[EXECUTE-TODO] Error releasing lock:", releaseError);
      }
    }
  }
});

// Execute code for all todos in a project
router.post("/execute-all-todos/:projectName", async (req, res) => {
  const { projectName } = req.params;
  let lockAcquired = false;

  try {
    const todos = await dbHelpers.getTodosByProject(projectName);
    const todosWithCode = todos.filter((todo) => todo.code_snippet);

    if (todosWithCode.length === 0) {
      return res
        .status(400)
        .json({ error: "No todos with code snippets found" });
    }

    const projectPath = path.join(PROJECTS_DIR, projectName);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    // Acquire execution lock to prevent concurrent executions
    if (!executionLockManager.acquireLock(projectName, `execute-all-${projectName}`)) {
      const lockInfo = executionLockManager.getLockInfo(projectName);
      return res.status(409).json({
        error: "Another execution is already in progress for this project",
        details: lockInfo
          ? `Execution ${lockInfo.executionId} started ${Math.floor(
              (Date.now() - lockInfo.acquiredAt) / 1000
            )} seconds ago`
          : "Unknown execution in progress",
      });
    }
    lockAcquired = true;

    // Create git checkpoint before executing all todos
    let gitCommitHash = null;
    try {
      gitCommitHash = await createGitCheckpoint(projectPath);
      if (gitCommitHash) {
        // Store execution history for all todos
        for (const todo of todosWithCode) {
          await dbHelpers.insertExecutionHistory(
            todo.id,
            projectName,
            gitCommitHash
          );
        }
      }
    } catch (checkpointError) {
      console.warn("Failed to create checkpoint:", checkpointError);
    }

    const results = [];

    for (const todo of todosWithCode) {
      try {
        const result = await executeCodeWithContinue(
          todo.code_snippet,
          todo,
          projectPath
        );

        results.push({
          todoId: todo.id,
          title: todo.title,
          success: result.success,
          output: result.stdout,
          error: result.stderr || result.error || null,
        });
      } catch (error) {
        results.push({
          todoId: todo.id,
          title: todo.title,
          success: false,
          error: error.message || "Failed to execute",
        });
      }
    }

    res.json({
      success: true,
      total: todosWithCode.length,
      results: results,
      checkpointCreated: !!gitCommitHash,
      gitCommitHash: gitCommitHash,
    });
  } catch (error) {
    console.error("Execute all todos error:", error);
    res.status(500).json({ error: "Failed to execute all todos" });
  } finally {
    // Always release the lock
    if (lockAcquired) {
      try {
        executionLockManager.releaseLock(projectName, `execute-all-${projectName}`);
      } catch (releaseError) {
        console.error("[EXECUTE-ALL-TODOS] Error releasing lock:", releaseError);
      }
    }
  }
});

// Revert a single todo execution
router.post("/revert-execution/:todoId", async (req, res) => {
  console.log(`[REVERT] Starting revert for todoId: ${req.params.todoId}`);
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);

    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return res.status(400).json({
        error: "Project is not a git repository. Cannot revert changes.",
      });
    }

    const executionHistory = await dbHelpers.getLatestExecutionHistoryByTodoId(
      todoId
    );

    if (!executionHistory || !executionHistory.git_commit_hash) {
      return res.status(404).json({
        error: "No execution checkpoint found for this todo. Cannot revert.",
      });
    }

    const commitHash = executionHistory.git_commit_hash;

    try {
      // Verify commit exists
      await execAsync(`git cat-file -e ${commitHash}`, { cwd: projectPath });

      // Reset to the checkpoint commit
      await execAsync(`git reset --hard ${commitHash}`, {
        cwd: projectPath,
      });

      // Clean up any untracked files
      try {
        await execAsync("git clean -fd", { cwd: projectPath });
      } catch (cleanError) {
        console.warn(
          "[REVERT] Failed to clean untracked files:",
          cleanError.message
        );
      }

      // Mark execution history as reverted
      try {
        await dbHelpers.updateExecutionHistory(executionHistory.id, {
          reverted: true,
        });
      } catch (updateError) {
        console.warn(
          "[REVERT] Failed to mark execution history as reverted:",
          updateError.message
        );
      }

      // Update todo status to pending
      try {
        await dbHelpers.updateTodo(todoId, { status: "pending" });
      } catch (statusError) {
        console.warn(
          "[REVERT] Failed to update todo status:",
          statusError.message
        );
      }

      res.json({
        success: true,
        message: "Successfully reverted to checkpoint",
        checkpointHash: executionHistory.git_commit_hash,
        executedAt: executionHistory.executed_at,
      });
    } catch (gitError) {
      console.error("[REVERT] Git revert error:", gitError);
      res.status(500).json({
        error: "Failed to revert changes",
        details: gitError.message,
      });
    }
  } catch (error) {
    console.error("[REVERT] Revert execution error:", error);
    res
      .status(500)
      .json({ error: "Failed to revert execution", details: error.message });
  }
});

// Revert all executions for a project
router.post("/revert-all-executions/:projectName", async (req, res) => {
  try {
    const { projectName } = req.params;

    const projectPath = path.join(PROJECTS_DIR, projectName);

    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return res.status(400).json({
        error: "Project is not a git repository. Cannot revert changes.",
      });
    }

    const executionHistoryList = await dbHelpers.getExecutionHistoryByProject(
      projectName
    );

    if (!executionHistoryList || executionHistoryList.length === 0) {
      return res.status(404).json({
        error: "No execution checkpoints found. Cannot revert.",
      });
    }

    const latestCheckpoint = executionHistoryList[0];

    if (!latestCheckpoint.git_commit_hash) {
      return res.status(404).json({
        error: "No valid checkpoint found. Cannot revert.",
      });
    }

    const commitHash = latestCheckpoint.git_commit_hash;

    try {
      // Verify commit exists
      await execAsync(`git cat-file -e ${commitHash}`, { cwd: projectPath });

      // Reset to the latest checkpoint commit
      await execAsync(`git reset --hard ${commitHash}`, {
        cwd: projectPath,
      });

      // Clean up any untracked files
      try {
        await execAsync("git clean -fd", { cwd: projectPath });
      } catch (cleanError) {
        console.warn(
          "[REVERT-ALL] Failed to clean untracked files:",
          cleanError.message
        );
      }

      // Mark all execution histories as reverted
      const uniqueTodoIds = new Set(
        executionHistoryList.map((eh) => eh.todo_id)
      );

      for (const executionHistory of executionHistoryList) {
        try {
          await dbHelpers.updateExecutionHistory(executionHistory.id, {
            reverted: true,
          });
        } catch (updateError) {
          console.warn(
            `[REVERT-ALL] Failed to mark execution history ${executionHistory.id} as reverted:`,
            updateError.message
          );
        }
      }

      // Update all affected todos to pending status
      for (const todoId of uniqueTodoIds) {
        try {
          await dbHelpers.updateTodo(todoId, { status: "pending" });
        } catch (statusError) {
          console.warn(
            `[REVERT-ALL] Failed to update todo ${todoId} status:`,
            statusError.message
          );
        }
      }

      res.json({
        success: true,
        message: "Successfully reverted all executions to latest checkpoint",
        checkpointHash: latestCheckpoint.git_commit_hash,
        executedAt: latestCheckpoint.executed_at,
        totalReverted: executionHistoryList.length,
      });
    } catch (gitError) {
      console.error("[REVERT-ALL] Git revert error:", gitError);
      res.status(500).json({
        error: "Failed to revert changes",
        details: gitError.message,
      });
    }
  } catch (error) {
    console.error("[REVERT-ALL] Revert all executions error:", error);
    res.status(500).json({
      error: "Failed to revert all executions",
      details: error.message,
    });
  }
});

// Check if a todo can be reverted
router.get("/can-revert/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);
    const gitDir = path.join(projectPath, ".git");
    const isGitRepo = fs.existsSync(gitDir);

    const executionHistory = await dbHelpers.getLatestExecutionHistoryByTodoId(
      todoId
    );

    let executionSuccessful = false;
    if (executionHistory) {
      const iterations = await dbHelpers.getExecutionIterationsByTodoId(todoId);
      const executionHistoryIterations = iterations.filter(
        (iter) => iter.execution_history_id === executionHistory.id
      );
      executionSuccessful = executionHistoryIterations.some(
        (iter) => iter.status === "success"
      );
    }

    const canRevert =
      isGitRepo &&
      executionHistory &&
      executionHistory.git_commit_hash &&
      !executionHistory.reverted &&
      executionSuccessful;

    res.json({
      canRevert: !!canRevert,
      isGitRepo: isGitRepo,
      hasCheckpoint: !!executionHistory,
      isReverted: !!executionHistory?.reverted,
      executionSuccessful: executionSuccessful,
      checkpointHash: executionHistory?.git_commit_hash || null,
      executedAt: executionHistory?.executed_at || null,
    });
  } catch (error) {
    console.error("Check can revert error:", error);
    res.status(500).json({ error: "Failed to check revert status" });
  }
});

// Get execution iterations for a todo
router.get("/execution-iterations/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const iterations = await dbHelpers.getExecutionIterationsByTodoId(todoId);

    const parsedIterations = iterations.map((iter) => ({
      ...iter,
      llmSuggestion: iter.llm_suggestion
        ? JSON.parse(iter.llm_suggestion)
        : null,
    }));

    res.json({
      success: true,
      iterations: parsedIterations,
      total: parsedIterations.length,
    });
  } catch (error) {
    console.error("Get execution iterations error:", error);
    res.status(500).json({ error: "Failed to get execution iterations" });
  }
});

module.exports = router;
