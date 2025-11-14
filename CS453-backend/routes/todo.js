const express = require("express");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { dbHelpers } = require("../db");
const {
  PROJECTS_DIR,
  CONTINUE_CONFIG_PATH,
} = require("../helpers/config");
const { buildCodebaseContext } = require("../helpers/codebaseContext");

const router = express.Router();
const execAsync = promisify(exec);

// Generate todos from audio transcription
router.post("/generate-todos/:audioFileId", async (req, res) => {
  try {
    const { audioFileId } = req.params;

    // Get audio file record
    const audioFile = await dbHelpers.getAudioFileById(audioFileId);
    if (!audioFile) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    if (!audioFile.transcription_text) {
      return res
        .status(400)
        .json({ error: "No transcription available for this audio file" });
    }

    // Build codebase context
    const projectPath = path.join(PROJECTS_DIR, audioFile.project_name);
    const codebaseContext = await buildCodebaseContext(projectPath);

    // Create prompt for Continue.dev
    const prompt = `Based on this voice transcription from a developer and the current codebase state, generate actionable development todos:

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

    // Execute Continue.dev CLI command
    // Use local config.yaml file
    const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${prompt.replace(
      /"/g,
      '\\"'
    )}" --auto`;

    console.log(`[GENERATE-TODOS] Executing Continue.dev CLI...`);
    console.log(`[GENERATE-TODOS] Command: ${continueCommand.substring(0, 200)}...`);

    let stdout;
    try {
      const result = await execAsync(continueCommand, {
        timeout: 120000, // 2 minutes timeout
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        cwd: projectPath,
        env: {
          ...process.env,
        },
      });
      stdout = result.stdout;
    } catch (execError) {
      const errorOutput =
        execError.stdout || execError.stderr || execError.message || "";
      console.error(`[GENERATE-TODOS] Continue.dev error:`, errorOutput);

      // Check for authentication errors
      if (
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid")
      ) {
        return res.status(401).json({
          error: "Continue.dev API authentication failed. Please check your API key in settings.",
        });
      }

      return res.status(500).json({
        error: "Failed to generate todos. Continue.dev CLI error.",
        details: errorOutput.substring(0, 500),
      });
    }

    // Check stdout for authentication errors
    if (
      stdout.includes("x-api-key") ||
      stdout.includes("authentication_error") ||
      stdout.includes("invalid")
    ) {
      return res.status(401).json({
        error: "Continue.dev API authentication failed. Please check your API key in settings.",
      });
    }

    // Try to extract JSON array from response
    let todos = [];
    try {
      // Try to find JSON array in the response
      const jsonArrayMatch = stdout.match(/\[[\s\S]*\]/);
      if (jsonArrayMatch) {
        todos = JSON.parse(jsonArrayMatch[0]);
      } else {
        // Try to find multiple JSON objects
        const jsonObjectMatches = stdout.match(/\{[\s\S]*?\}/g);
        if (jsonObjectMatches) {
          todos = jsonObjectMatches.map((match) => JSON.parse(match));
        } else {
          // Try to parse entire stdout as JSON
          todos = JSON.parse(stdout);
        }
      }

      // Ensure todos is an array
      if (!Array.isArray(todos)) {
        todos = [todos];
      }
    } catch (parseError) {
      console.error(`[GENERATE-TODOS] JSON parse error:`, parseError.message);
      console.error(`[GENERATE-TODOS] Raw stdout:`, stdout.substring(0, 1000));
      return res.status(500).json({
        error: "Failed to parse todos from Continue.dev response",
        details: stdout.substring(0, 500),
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

