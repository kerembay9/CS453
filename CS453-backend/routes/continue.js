const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const fsp = require("fs/promises");
const { dbHelpers } = require("../db");
const { PROJECTS_DIR } = require("../helpers/config");
const { createGitCheckpoint } = require("../helpers/gitHelpers");
const {
  detectQuotaError,
  executeCodeWithContinue,
} = require("../helpers/continueHelpers");

const router = express.Router();
const execAsync = promisify(exec);

// Execute a single todo (code or command)
router.post("/execute-todo/:todoId", async (req, res) => {
  const todoId = req.params.todoId;

  console.log(`[EXECUTE-TODO] Starting execution for todoId: ${todoId}`);

  try {
    const todo = await dbHelpers.getTodoById(todoId);

    if (!todo) {
      console.error(`[EXECUTE-TODO] Todo not found: ${todoId}`);
      return res.status(404).json({ error: "Todo not found" });
    }

    console.log(
      `[EXECUTE-TODO] Todo found: ${todo.title}, project: ${todo.project_name}`
    );
    console.log(`[EXECUTE-TODO] Has code snippet: ${!!todo.code_snippet}`);
    console.log(
      `[EXECUTE-TODO] Code snippet length: ${todo.code_snippet?.length || 0}`
    );

    if (!todo.code_snippet) {
      console.error(`[EXECUTE-TODO] No code snippet for todo: ${todoId}`);
      return res
        .status(400)
        .json({ error: "No code snippet or command to execute" });
    }

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);
    console.log(`[EXECUTE-TODO] Project path: ${projectPath}`);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      console.error(
        `[EXECUTE-TODO] Project directory not found: ${projectPath}`
      );
      return res.status(404).json({ error: "Project directory not found" });
    }
    console.log(`[EXECUTE-TODO] Project directory exists: ${projectPath}`);

    // Create git checkpoint before execution
    let gitCommitHash = null;
    let executionHistoryId = null;
    try {
      console.log(`[EXECUTE-TODO] Creating git checkpoint...`);
      gitCommitHash = await createGitCheckpoint(projectPath);
      if (gitCommitHash) {
        console.log(`[EXECUTE-TODO] Checkpoint created: ${gitCommitHash}`);
        // Store execution history
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          gitCommitHash
        );
        console.log(
          `[EXECUTE-TODO] Execution history stored with ID: ${executionHistoryId}`
        );
      } else {
        console.warn(
          `[EXECUTE-TODO] No checkpoint created (not a git repo or no changes)`
        );
        // Still create execution history entry without commit hash
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          null
        );
      }
    } catch (checkpointError) {
      console.error(
        `[EXECUTE-TODO] Failed to create checkpoint:`,
        checkpointError
      );
      // Still create execution history entry
      try {
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          null
        );
      } catch (histError) {
        console.error(
          `[EXECUTE-TODO] Failed to create execution history:`,
          histError
        );
      }
    }

    // Execute the todo (code or command)
    console.log(`[EXECUTE-TODO] Executing todo...`);
    const result = await executeCodeWithContinue(
      todo.code_snippet.trim(),
      todo,
      projectPath
    );

    console.log(`[EXECUTE-TODO] Result received:`);
    console.log(`[EXECUTE-TODO] - success: ${result.success}`);
    console.log(`[EXECUTE-TODO] - filePath: ${result.filePath || "(null)"}`);
    console.log(`[EXECUTE-TODO] - has stdout: ${!!result.stdout}`);
    console.log(`[EXECUTE-TODO] - has stderr: ${!!result.stderr}`);
    console.log(`[EXECUTE-TODO] - error: ${result.error || "(null)"}`);

    // Store execution iteration
    if (executionHistoryId) {
      await dbHelpers.insertExecutionIteration(
        executionHistoryId,
        todoId,
        1,
        todo.code_snippet.trim(),
        result.error,
        result.stdout,
        result.stderr,
        null,
        null,
        result.success ? "success" : "failed"
      );
    }

    if (result.success) {
      // Update todo status to completed on successful execution
      try {
        await dbHelpers.updateTodo(todoId, { status: "completed" });
        console.log(
          `[EXECUTE-TODO] Updated todo ${todoId} status to completed`
        );
      } catch (statusError) {
        console.warn(
          `[EXECUTE-TODO] Failed to update todo status:`,
          statusError.message
        );
      }

      return res.json({
        success: true,
        output: result.stdout,
        error: result.stderr || null,
        filePath: result.filePath || null,
        checkpointCreated: !!gitCommitHash,
        gitCommitHash: gitCommitHash,
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
    console.error(`[EXECUTE-TODO] Top-level error for todoId ${todoId}:`);
    console.error(`[EXECUTE-TODO] Error message: ${error.message}`);
    res.status(500).json({
      error: "Failed to execute todo",
      details: error.message,
      todoId: todoId,
    });
  }
});

// Execute code for all todos in a project
router.post("/execute-all-todos/:projectName", async (req, res) => {
  try {
    const { projectName } = req.params;

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
