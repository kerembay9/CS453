const express = require("express");
const path = require("path");
const { dbHelpers } = require("../db");
const { PROJECTS_DIR } = require("../helpers/config");
const { buildCodebaseContext } = require("../helpers/codebaseContext");
const { executeContinueCLI } = require("../helpers/continueHelpers");
const { executionLockManager } = require("../helpers/executionLock");

const router = express.Router();

// Generate todos from audio transcription
router.post("/generate-todos/:audioFileId", async (req, res) => {
  const { audioFileId } = req.params;
  let lockAcquired = false;
  let projectName = null;

  try {
    // Get audio file record
    const audioFile = await dbHelpers.getAudioFileById(audioFileId);
    if (!audioFile) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    // Debug: Log audio file and transcription details
    console.log(`[GENERATE-TODOS] Audio file retrieved:`, {
      audioFileId,
      hasTranscription: !!audioFile.transcription_text,
      transcriptionLength: audioFile.transcription_text?.length || 0,
      transcriptionPreview: audioFile.transcription_text?.substring(0, 200) || "NO TRANSCRIPTION",
      projectName: audioFile.project_name
    });

    if (!audioFile.transcription_text) {
      return res
        .status(400)
        .json({ error: "No transcription available for this audio file" });
    }

    projectName = audioFile.project_name;

    // Acquire execution lock to prevent concurrent executions
    if (!executionLockManager.acquireLock(projectName, `generate-todos-${audioFileId}`)) {
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

    // Build codebase context
    const projectPath = path.join(PROJECTS_DIR, projectName);
    const codebaseContext = await buildCodebaseContext(projectPath);

    // Debug: Log codebase context details
    console.log(`[GENERATE-TODOS] Building prompt with:`, {
      transcriptionLength: audioFile.transcription_text?.length || 0,
      codebaseContextFiles: codebaseContext.fileTree?.length || 0,
      keyFilesCount: codebaseContext.keyFiles?.length || 0,
      projectName: codebaseContext.projectName
    });

    // Create prompt for Continue.dev
    // Note: This is a one-way communication with an agentic AI - generate todos directly without asking follow-up questions
    const prompt = `IMPORTANT: This is a one-way communication. You are an agentic AI that generates tasks directly without asking follow-up questions. Generate the todos based on the following information:

Based on this voice transcription from a developer and the current codebase state, generate actionable development todos:

TRANSCRIPTION:
${audioFile.transcription_text}

CODEBASE CONTEXT:
Project: ${codebaseContext.projectName}
Files: ${JSON.stringify(codebaseContext.fileTree, null, 2)}
Key Files Content: ${JSON.stringify(codebaseContext.keyFiles, null, 2)}

Generate 3-10 specific, actionable todos that:
1. Address issues/bugs mentioned in the transcription
2. Implement features requested in the transcription
3. Consider the current codebase structure
4. Are technically feasible based on existing code

Format each todo as JSON:
{
  "title": "Brief action item",
  "description": "Detailed implementation notes",
  "code_snippet": "Optional code snippet if applicable",
  "complexity": "low|medium|high"
}

Return only a JSON array of todos.`;

    // Debug: Log prompt details
    console.log(`[GENERATE-TODOS] Prompt created:`, {
      promptLength: prompt.length,
      transcriptionIncluded: prompt.includes(audioFile.transcription_text || ""),
      transcriptionStartIndex: prompt.indexOf("TRANSCRIPTION:"),
      transcriptionEndIndex: prompt.indexOf("CODEBASE CONTEXT:"),
      transcriptionPreview: prompt.substring(
        prompt.indexOf("TRANSCRIPTION:") + "TRANSCRIPTION:".length,
        prompt.indexOf("CODEBASE CONTEXT:")
      ).substring(0, 200)
    });

    // Execute Continue.dev CLI command directly
    console.log(`[GENERATE-TODOS] Executing Continue.dev CLI...`);

    let stdout;
    try {
      // Get timeout from database settings, default to 5 minutes (300000ms)
      let timeout = 300000;
      try {
        const timeoutSetting = await dbHelpers.getSetting("continue_timeout");
        if (timeoutSetting && timeoutSetting.value) {
          timeout = parseInt(timeoutSetting.value, 10) || 300000;
        }
      } catch (error) {
        console.warn("Failed to get continue_timeout setting, using default:", error);
      }

      // Execute CLI directly with prompt
      const result = await executeContinueCLI(prompt, projectPath, timeout);
      stdout = result.stdout || "";

      // Check for authentication errors (more specific checks to avoid false positives)
      if (
        stdout.includes("x-api-key") ||
        stdout.includes("authentication_error") ||
        stdout.includes("invalid api key") ||
        stdout.includes("invalid_api_key") ||
        stdout.includes("api key is invalid") ||
        stdout.includes("authentication failed")
      ) {
        return res.status(401).json({
          error:
            "Continue.dev API authentication failed. Please check your API key in settings.",
        });
      }
    } catch (error) {
      const errorOutput = error.stderr || error.stdout || error.message || "";
      console.error(`[GENERATE-TODOS] Continue.dev error:`, errorOutput);

      // Check for quota/rate limit errors
      if (error.code === "QUOTA_ERROR") {
        return res.status(429).json({
          error: "API rate limit/quota exceeded. Please try again later.",
          details: error.message,
        });
      }

      // Check for authentication errors (more specific checks to avoid false positives)
      if (
        error.code === "AUTH_ERROR" ||
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid api key") ||
        errorOutput.includes("invalid_api_key") ||
        errorOutput.includes("api key is invalid") ||
        errorOutput.includes("authentication failed")
      ) {
        return res.status(401).json({
          error:
            "Continue.dev API authentication failed. Please check your API key in settings.",
        });
      }

      return res.status(500).json({
        error: "Failed to generate todos. Continue.dev CLI error.",
        details: errorOutput.substring(0, 500),
      });
    }

    // Check stdout for authentication errors (more specific checks to avoid false positives)
    if (
      stdout.includes("x-api-key") ||
      stdout.includes("authentication_error") ||
      stdout.includes("invalid api key") ||
      stdout.includes("invalid_api_key") ||
      stdout.includes("api key is invalid") ||
      stdout.includes("authentication failed")
    ) {
      return res.status(401).json({
        error:
          "Continue.dev API authentication failed. Please check your API key in settings.",
      });
    }

    // Try to extract JSON array from response
    // The CLI may output streaming text before the final JSON, so we need to find the last complete JSON array
    let todos = [];
    try {
      // Strategy: Find the last complete JSON array by searching backwards from the end
      // This handles cases where there's streaming output before the final JSON
      
      // Find the last closing bracket
      const lastClosingBracket = stdout.lastIndexOf(']');
      if (lastClosingBracket === -1) {
        throw new Error("No JSON array found in response");
      }
      
      // Work backwards to find the matching opening bracket
      let bracketCount = 0;
      let startIndex = -1;
      for (let i = lastClosingBracket; i >= 0; i--) {
        if (stdout[i] === ']') bracketCount++;
        if (stdout[i] === '[') {
          bracketCount--;
          if (bracketCount === 0) {
            startIndex = i;
            break;
          }
        }
      }
      
      if (startIndex === -1) {
        throw new Error("Could not find matching opening bracket for JSON array");
      }
      
      // Extract and parse the JSON array
      const jsonCandidate = stdout.substring(startIndex, lastClosingBracket + 1);
      try {
        todos = JSON.parse(jsonCandidate);
        if (!Array.isArray(todos)) {
          throw new Error("Parsed JSON is not an array");
        }
      } catch (parseError) {
        // If parsing fails, try alternative methods
        console.warn(`[GENERATE-TODOS] Failed to parse extracted JSON, trying alternatives:`, parseError.message);
        
        // Try finding all JSON arrays and use the last valid one
        const jsonArrayMatches = stdout.match(/\[[\s\S]*?\]/g);
        if (jsonArrayMatches && jsonArrayMatches.length > 0) {
          // Try parsing from the end backwards
          for (let i = jsonArrayMatches.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(jsonArrayMatches[i]);
              if (Array.isArray(parsed) && parsed.length > 0) {
                todos = parsed;
                break;
              }
            } catch (e) {
              // Continue to next match
            }
          }
        }
        
        // If still no valid array, try finding individual JSON objects
        if (todos.length === 0) {
          const jsonObjectMatches = stdout.match(/\{[\s\S]*?\}/g);
          if (jsonObjectMatches) {
            const parsedObjects = [];
            for (const match of jsonObjectMatches) {
              try {
                const parsed = JSON.parse(match);
                if (parsed && typeof parsed === 'object' && parsed.title) {
                  parsedObjects.push(parsed);
                }
              } catch (e) {
                // Skip invalid JSON objects
              }
            }
            if (parsedObjects.length > 0) {
              todos = parsedObjects;
            }
          }
        }
        
        // Last resort: try parsing entire stdout
        if (todos.length === 0) {
          try {
            const parsed = JSON.parse(stdout.trim());
            todos = Array.isArray(parsed) ? parsed : [parsed];
          } catch (e) {
            throw new Error(`Could not extract valid JSON from response: ${parseError.message}`);
          }
        }
      }

      // Ensure todos is an array
      if (!Array.isArray(todos)) {
        todos = [todos];
      }
    } catch (parseError) {
      console.error(`[GENERATE-TODOS] JSON parse error:`, parseError.message);
      console.error(`[GENERATE-TODOS] Raw stdout length:`, stdout.length);
      console.error(`[GENERATE-TODOS] Raw stdout (last 2000 chars):`, stdout.substring(Math.max(0, stdout.length - 2000)));
      return res.status(500).json({
        error: "Failed to parse todos from Continue.dev response",
        details: parseError.message,
        stdoutPreview: stdout.substring(Math.max(0, stdout.length - 1000)),
      });
    }

    // Validate and insert todos into database
    const insertedTodos = [];
    for (const todo of todos) {
      if (!todo.title) {
        console.warn(`[GENERATE-TODOS] Skipping todo without title:`, todo);
        continue;
      }

      try {
        const todoId = await dbHelpers.insertTodo(
          audioFileId,
          audioFile.project_name,
          todo.title,
          todo.description || null,
          todo.code_snippet || null,
          todo.complexity || "medium"
        );

        const insertedTodo = await dbHelpers.getTodoById(todoId);
        insertedTodos.push(insertedTodo);
      } catch (insertError) {
        console.error(`[GENERATE-TODOS] Failed to insert todo:`, insertError);
        // Continue with other todos
      }
    }

    console.log(
      `[GENERATE-TODOS] Generated ${insertedTodos.length} todos from ${todos.length} parsed todos`
    );

    res.json({
      success: true,
      todos: insertedTodos,
      count: insertedTodos.length,
    });
  } catch (error) {
    console.error("Generate todos error:", error);
    res.status(500).json({ error: "Failed to generate todos" });
  } finally {
    // Always release the lock
    if (lockAcquired && projectName) {
      try {
        executionLockManager.releaseLock(projectName, `generate-todos-${audioFileId}`);
      } catch (releaseError) {
        console.error("[GENERATE-TODOS] Error releasing lock:", releaseError);
      }
    }
  }
});

// Get todos by audio file
router.get("/:audioFileId", async (req, res) => {
  try {
    const { audioFileId } = req.params;
    const todos = await dbHelpers.getTodosByAudioFile(audioFileId);
    res.json({ todos });
  } catch (error) {
    console.error("Get todos error:", error);
    res.status(500).json({ error: "Failed to get todos" });
  }
});

// Get all todos for a project
router.get("/project/:projectName", async (req, res) => {
  try {
    const { projectName } = req.params;
    const todos = await dbHelpers.getTodosByProject(projectName);
    res.json({ todos });
  } catch (error) {
    console.error("Get project todos error:", error);
    res.status(500).json({ error: "Failed to get project todos" });
  }
});

// Create todo manually
router.post("/", express.json(), async (req, res) => {
  try {
    const {
      audioFileId,
      projectName,
      title,
      description,
      codeSnippet,
      complexity,
    } = req.body;

    if (!title || !projectName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const todoId = await dbHelpers.insertTodo(
      audioFileId || null,
      projectName,
      title,
      description || null,
      codeSnippet || null,
      complexity || "medium"
    );

    const todo = await dbHelpers.getTodoById(todoId);
    res.json({ success: true, todo });
  } catch (error) {
    console.error("Create todo error:", error);
    res.status(500).json({ error: "Failed to create todo" });
  }
});

// Update todo
router.put("/:id", express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const changes = await dbHelpers.updateTodo(id, updates);

    if (changes === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }

    const todo = await dbHelpers.getTodoById(id);
    res.json({ success: true, todo });
  } catch (error) {
    console.error("Update todo error:", error);
    res.status(500).json({ error: "Failed to update todo" });
  }
});

// Delete todo
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const changes = await dbHelpers.deleteTodo(id);

    if (changes === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }

    res.json({ success: true, message: "Todo deleted" });
  } catch (error) {
    console.error("Delete todo error:", error);
    res.status(500).json({ error: "Failed to delete todo" });
  }
});

module.exports = router;
