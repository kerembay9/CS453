// routes.js
const express = require("express");
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const axios = require("axios");
const NodeFormData = require("form-data");
const { dbHelpers } = require("../db");

const router = express.Router();
const execAsync = promisify(exec);

// -----------------------------
// Config
// -----------------------------
const PROJECTS_DIR = path.join(__dirname, "../projects"); // ✅ ensure defined
const UPLOADS_DIR = path.join(__dirname, "../uploads");
const CONTINUE_CONFIG_PATH = path.join(__dirname, "../config.yaml"); // Local Continue.dev config

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "http://localhost:5678/webhook-test/ec52a91a-54e0-47a2-afa3-f191c87c7043"; // ✅ normal webhook (not -test)

// Ensure base dirs exist
async function ensureDirs() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}
ensureDirs().catch(console.error);

// -----------------------------
// Multer (temp storage)
// -----------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// -----------------------------
// Helpers
// -----------------------------
function sanitizeName(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
}
async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(src, dest);
}

// Helper function to build codebase context
async function buildCodebaseContext(projectPath) {
  try {
    const context = {
      projectName: path.basename(projectPath),
      fileTree: [],
      keyFiles: {},
    };

    // Read directory tree
    async function readDir(dirPath, relativePath = "") {
      const items = await fsp.readdir(dirPath, { withFileTypes: true });

      for (const item of items) {
        const itemPath = path.join(dirPath, item.name);
        const relativeItemPath = path.join(relativePath, item.name);

        // Skip common directories to ignore
        if (
          item.isDirectory() &&
          (item.name === "node_modules" ||
            item.name === ".git" ||
            item.name === "dist" ||
            item.name === "build" ||
            item.name === ".next" ||
            item.name === "coverage")
        ) {
          continue;
        }

        if (item.isDirectory()) {
          context.fileTree.push({
            type: "directory",
            name: item.name,
            path: relativeItemPath,
          });
          await readDir(itemPath, relativeItemPath);
        } else {
          context.fileTree.push({
            type: "file",
            name: item.name,
            path: relativeItemPath,
            size: (await fsp.stat(itemPath)).size,
          });
        }
      }
    }

    await readDir(projectPath);

    // Identify and read key files
    const keyFilePatterns = [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "README.md",
      "index.js",
      "index.ts",
      "main.js",
      "app.js",
      "server.js",
      "config.js",
      "webpack.config.js",
      "next.config.js",
      "tailwind.config.js",
      "tsconfig.json",
      "jsconfig.json",
      ".env",
      ".env.example",
    ];

    for (const file of context.fileTree) {
      if (
        file.type === "file" &&
        (keyFilePatterns.includes(file.name) ||
          file.name.endsWith(".js") ||
          file.name.endsWith(".ts") ||
          file.name.endsWith(".jsx") ||
          file.name.endsWith(".tsx"))
      ) {
        // Limit file size to avoid huge files
        if (file.size < 100000) {
          // 100KB limit
          try {
            const content = await fsp.readFile(
              path.join(projectPath, file.path),
              "utf8"
            );
            context.keyFiles[file.path] = content.substring(0, 5000); // Limit content to 5KB per file
          } catch (err) {
            console.warn(`Could not read file ${file.path}:`, err.message);
          }
        }
      }
    }

    return context;
  } catch (error) {
    console.error("Error building codebase context:", error);
    return {
      projectName: path.basename(projectPath),
      fileTree: [],
      keyFiles: {},
      error: error.message,
    };
  }
}

// -----------------------------
// Clone repository
// -----------------------------
router.post("/clone-repo", express.json(), async (req, res) => {
  try {
    const { repoUrl, repoName } = req.body || {};
    if (!repoUrl || !repoName) {
      return res.status(400).json({ error: "Missing repoUrl or repoName" });
    }
    await ensureDirs();
    const repoPath = path.join(PROJECTS_DIR, repoName);
    if (fs.existsSync(repoPath)) {
      return res.status(400).json({ error: "Repository already exists" });
    }
    await execAsync(`git clone ${repoUrl} "${repoPath}"`);
    res.json({ success: true, message: "Repository cloned successfully" });
  } catch (error) {
    console.error("clone-repo error:", error);
    res.status(500).json({ error: "Failed to clone repository" });
  }
});

// -----------------------------
// List projects
// -----------------------------
router.get("/", async (_req, res) => {
  try {
    await ensureDirs();
    const all = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = all.filter((d) => d.isDirectory()).map((d) => d.name);
    res.json({ projects });
  } catch (err) {
    console.error("list projects error:", err);
    res.json({ projects: [] });
  }
});

// -----------------------------
// Delete project
// -----------------------------
router.delete("/", express.json(), async (req, res) => {
  const { projectName } = req.body || {};
  if (!projectName)
    return res.status(400).json({ error: "Missing projectName" });

  const projectPath = path.join(PROJECTS_DIR, projectName);
  if (!fs.existsSync(projectPath)) {
    return res.status(404).json({ error: "Project not found" });
  }
  try {
    await execAsync(`rm -rf "${projectPath}"`);
    res.json({ success: true });
  } catch (error) {
    console.error("delete error:", error);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// -----------------------------
// Upload audio → forward to n8n
// If mounted at app.use("/api", router), path is /api/upload-audio
// -----------------------------
router.post("/upload-audio", upload.single("audio"), async (req, res) => {
  const projectNameRaw = req.body?.projectName;
  const file = req.file;

  if (!file || !projectNameRaw) {
    if (file?.path) {
      try {
        await fsp.unlink(file.path);
      } catch {}
    }
    return res.status(400).json({ error: "Missing file or project name" });
  }

  const projectName = sanitizeName(projectNameRaw);
  const projectPath = path.join(PROJECTS_DIR, projectName);
  const finalPath = path.join(projectPath, file.originalname);

  try {
    await moveFile(file.path, finalPath);

    // Create database record for the audio file
    const audioFileId = await dbHelpers.insertAudioFile(
      projectName,
      file.originalname,
      finalPath
    );

    // Use axios instead of fetch for better FormData support
    const form = new NodeFormData();
    form.append("audio", fs.createReadStream(finalPath), {
      filename: path.basename(finalPath),
      contentType: "audio/mpeg", // change if not mp3
    });
    form.append("projectName", projectName);
    form.append("audioFileId", audioFileId.toString()); // Include ID for webhook callback

    console.log("FormData created with:", {
      audioFile: path.basename(finalPath),
      projectName: projectName,
      audioFileId: audioFileId,
      contentType: "audio/mpeg",
    });

    const webhookResponse = await axios.post(
      "http://localhost:5678/webhook-test/ec52a91a-54e0-47a2-afa3-f191c87c7043",
      form,
      {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const webhookData = webhookResponse.data;
    console.log("Webhook response:", webhookData);

    if (webhookResponse.status < 200 || webhookResponse.status >= 300) {
      // Update status to failed if webhook fails
      await dbHelpers.updateTranscription(audioFileId, null, "failed");
      return res.status(webhookResponse.status).json({
        error: "Webhook request failed",
        status: webhookResponse.status,
        statusText: webhookResponse.statusText,
        webhookResponse: webhookData,
      });
    }

    // Check if webhook returned transcription result immediately
    let transcriptionText = null;
    let finalStatus = "processing";

    if (typeof webhookData === "string" && webhookData.trim()) {
      // If webhook returns a string, treat it as transcription
      transcriptionText = webhookData.trim();
      finalStatus = "completed";
    } else if (webhookData && typeof webhookData === "object") {
      // If webhook returns an object, look for transcription field
      transcriptionText =
        webhookData.transcription || webhookData.text || webhookData.result;
      if (transcriptionText) {
        finalStatus = "completed";
      }
    }

    // Update database with transcription result if available
    if (transcriptionText) {
      await dbHelpers.updateTranscription(
        audioFileId,
        transcriptionText,
        finalStatus
      );
      console.log(
        `Transcription completed immediately for audio file ${audioFileId}:`,
        {
          status: finalStatus,
          hasTranscription: !!transcriptionText,
        }
      );
    }

    return res.json({
      success: true,
      message: transcriptionText
        ? "Audio uploaded and transcription completed"
        : "Audio uploaded and processing started",
      audioFileId: audioFileId,
      transcription: transcriptionText,
      status: finalStatus,
      webhookResponse: webhookData,
    });
  } catch (err) {
    console.error("Upload/forward error:", err?.response?.data || err);
    const status = err?.response?.status || 502;
    const details = err?.response?.data || String(err);
    return res.status(status).json({
      error: "Failed to forward audio to n8n",
      status,
      details,
    });
  }
});

// -----------------------------
// N8N Webhook Callback for Transcription Results
// -----------------------------
router.post(
  "/webhook/transcription-complete",
  express.json(),
  async (req, res) => {
    try {
      const { audioFileId, transcriptionText, status, error } = req.body;

      if (!audioFileId) {
        return res.status(400).json({ error: "Missing audioFileId" });
      }

      // Update the database record with transcription results
      const finalStatus =
        status || (transcriptionText ? "completed" : "failed");
      const finalTranscription =
        transcriptionText || (error ? `Error: ${error}` : null);

      const changes = await dbHelpers.updateTranscription(
        audioFileId,
        finalTranscription,
        finalStatus
      );

      if (changes === 0) {
        return res.status(404).json({ error: "Audio file not found" });
      }

      console.log(`Transcription completed for audio file ${audioFileId}:`, {
        status: finalStatus,
        hasTranscription: !!finalTranscription,
      });

      res.json({
        success: true,
        message: "Transcription result updated",
        audioFileId,
        status: finalStatus,
      });
    } catch (error) {
      console.error("Webhook callback error:", error);
      res.status(500).json({ error: "Failed to update transcription result" });
    }
  }
);

// -----------------------------
// Audio Files Management Endpoints
// -----------------------------

// Get all audio files for a project
router.get("/audio-files/:projectName", async (req, res) => {
  try {
    const { projectName } = req.params;
    const audioFiles = await dbHelpers.getAudioFilesByProject(projectName);
    res.json({ audioFiles });
  } catch (error) {
    console.error("Get audio files error:", error);
    res.status(500).json({ error: "Failed to get audio files" });
  }
});

// Get specific audio file by ID
router.get("/audio-file/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const audioFile = await dbHelpers.getAudioFileById(id);

    if (!audioFile) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    res.json({ audioFile });
  } catch (error) {
    console.error("Get audio file error:", error);
    res.status(500).json({ error: "Failed to get audio file" });
  }
});

// Delete audio file
router.delete("/audio-file/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Get file info before deleting from database
    const audioFile = await dbHelpers.getAudioFileById(id);
    if (!audioFile) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    // Delete from database
    const changes = await dbHelpers.deleteAudioFile(id);

    // Delete physical file
    try {
      if (fs.existsSync(audioFile.file_path)) {
        await fsp.unlink(audioFile.file_path);
      }
    } catch (fileError) {
      console.warn("Failed to delete physical file:", fileError);
    }

    res.json({
      success: true,
      message: "Audio file deleted",
      deletedId: id,
    });
  } catch (error) {
    console.error("Delete audio file error:", error);
    res.status(500).json({ error: "Failed to delete audio file" });
  }
});

// -----------------------------
// Todo Generation with Continue.dev
// -----------------------------

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
    )}"`;

    console.log("Executing Continue.dev command:", continueCommand);
    let stdout, stderr;
    try {
      const result = await execAsync(continueCommand, {
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024, // 1MB buffer
        cwd: projectPath, // Set working directory to project path
        env: {
          ...process.env, // Pass all environment variables including CONTINUE_API_KEY
        },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (execError) {
      // Check for Continue.dev API authentication errors
      const errorOutput =
        execError.stdout || execError.stderr || execError.message || "";
      const errorString = JSON.stringify(errorOutput);
      const errorText = String(errorOutput);

      // Try to parse JSON error messages
      let parsedError = null;
      try {
        // Try parsing the error output directly
        parsedError = JSON.parse(errorText);
      } catch {
        try {
          // Try parsing if it's nested in a message field
          const messageMatch = errorText.match(/"message"\s*:\s*"([^"]+)"/);
          if (messageMatch) {
            parsedError = JSON.parse(messageMatch[1]);
          }
        } catch {}
      }

      // Check for authentication errors in various formats
      const hasAuthError =
        errorString.includes("x-api-key") ||
        errorString.includes("authentication_error") ||
        errorString.includes("invalid x-api-key") ||
        errorText.includes("x-api-key") ||
        errorText.includes("authentication_error") ||
        errorText.includes("invalid") ||
        (parsedError &&
          (JSON.stringify(parsedError).includes("x-api-key") ||
            JSON.stringify(parsedError).includes("authentication_error") ||
            (parsedError.error &&
              parsedError.error.type === "authentication_error")));

      if (hasAuthError) {
        console.error("Continue.dev API authentication error:", errorOutput);
        return res.status(401).json({
          error: "Continue.dev API authentication failed",
          message:
            "Continue.dev CLI requires an API key to be configured. Please configure Continue.dev with your LLM provider API key (e.g., OpenAI, Anthropic). See https://docs.continue.dev for setup instructions.",
          details: errorOutput,
        });
      }

      // Re-throw other errors
      throw execError;
    }

    if (stderr) {
      console.warn("Continue.dev stderr:", stderr);
      // Check stderr for authentication errors too
      if (
        stderr.includes("x-api-key") ||
        stderr.includes("authentication_error") ||
        stderr.includes("invalid")
      ) {
        return res.status(401).json({
          error: "Continue.dev API authentication failed",
          message:
            "Continue.dev CLI requires an API key to be configured. Please configure Continue.dev with your LLM provider API key (e.g., OpenAI, Anthropic). See https://docs.continue.dev for setup instructions.",
          details: stderr,
        });
      }
    }

    // Parse response
    let todos;
    try {
      // Extract JSON from response (might have extra text)
      const jsonMatch = stdout.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        todos = JSON.parse(jsonMatch[0]);
      } else {
        // Check if stdout contains authentication error
        if (
          stdout.includes("x-api-key") ||
          stdout.includes("authentication_error") ||
          stdout.includes("invalid")
        ) {
          return res.status(401).json({
            error: "Continue.dev API authentication failed",
            message:
              "Continue.dev CLI requires an API key to be configured. Please configure Continue.dev with your LLM provider API key (e.g., OpenAI, Anthropic). See https://docs.continue.dev for setup instructions.",
            rawResponse: stdout,
          });
        }
        throw new Error("No JSON array found in response");
      }
    } catch (parseError) {
      console.error("Failed to parse Continue.dev response:", parseError);
      console.error("Raw response:", stdout);
      return res.status(500).json({
        error: "Failed to parse Continue.dev response",
        rawResponse: stdout,
      });
    }

    // Validate todos structure
    if (!Array.isArray(todos)) {
      return res
        .status(500)
        .json({ error: "Continue.dev did not return an array of todos" });
    }

    // Insert todos into database
    const insertedTodos = [];
    for (const todo of todos) {
      if (todo.title && todo.description) {
        const todoId = await dbHelpers.insertTodo(
          audioFileId,
          audioFile.project_name,
          todo.title,
          todo.description,
          todo.code_snippet || null,
          todo.complexity || "medium"
        );

        const insertedTodo = await dbHelpers.getTodoById(todoId);
        insertedTodos.push(insertedTodo);
      }
    }

    console.log(
      `Generated ${insertedTodos.length} todos for audio file ${audioFileId}`
    );

    res.json({
      success: true,
      message: `Generated ${insertedTodos.length} todos`,
      todos: insertedTodos,
    });
  } catch (error) {
    console.error("Generate todos error:", error);
    res.status(500).json({
      error: "Failed to generate todos",
      details: error.message,
    });
  }
});

// -----------------------------
// Todo CRUD Endpoints
// -----------------------------

// Get todos for specific audio file
router.get("/todos/:audioFileId", async (req, res) => {
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
router.get("/todos/project/:projectName", async (req, res) => {
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
router.post("/todos", express.json(), async (req, res) => {
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
router.put("/todos/:id", express.json(), async (req, res) => {
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
router.delete("/todos/:id", async (req, res) => {
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

// -----------------------------
// Code Validation Endpoints
// -----------------------------

// Validate code snippet
router.post("/validate-code/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    if (!todo.code_snippet) {
      return res.status(400).json({ error: "No code snippet to validate" });
    }

    // Create validation prompt
    const prompt = `Validate this code snippet for syntax errors and basic correctness:

CODE:
${todo.code_snippet}

PROJECT CONTEXT:
${todo.project_name}

Return only "VALID" if the code is syntactically correct and follows good practices, or "INVALID" with a brief explanation if there are issues.`;

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);
    const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${prompt.replace(
      /"/g,
      '\\"'
    )}"`;

    let stdout;
    try {
      const result = await execAsync(continueCommand, {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        cwd: projectPath, // Set working directory to project path
        env: {
          ...process.env, // Pass all environment variables including CONTINUE_API_KEY
        },
      });
      stdout = result.stdout;
    } catch (execError) {
      const errorOutput =
        execError.stdout || execError.stderr || execError.message || "";
      if (
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid")
      ) {
        return res.status(401).json({
          error: "Continue.dev API authentication failed",
          message:
            "Continue.dev CLI requires an API key to be configured. Please configure Continue.dev with your LLM provider API key.",
          details: errorOutput,
        });
      }
      throw execError;
    }

    const isValid = stdout.trim().toUpperCase().startsWith("VALID");

    await dbHelpers.updateTodo(todoId, { valid: isValid });

    res.json({
      success: true,
      valid: isValid,
      response: stdout.trim(),
    });
  } catch (error) {
    console.error("Validate code error:", error);
    res.status(500).json({ error: "Failed to validate code" });
  }
});

// Check correctness
router.post("/check-correctness/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    if (!todo.code_snippet) {
      return res.status(400).json({ error: "No code snippet to check" });
    }

    // Create correctness check prompt
    const prompt = `Check if this code snippet correctly implements the described functionality:

TODO TITLE: ${todo.title}
TODO DESCRIPTION: ${todo.description}

CODE:
${todo.code_snippet}

PROJECT CONTEXT:
${todo.project_name}

Return only "CORRECT" if the code correctly implements the described functionality, or "INCORRECT" with a brief explanation if there are logical issues.`;

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);
    const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${prompt.replace(
      /"/g,
      '\\"'
    )}"`;

    let stdout;
    try {
      const result = await execAsync(continueCommand, {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        cwd: projectPath, // Set working directory to project path
        env: {
          ...process.env, // Pass all environment variables including CONTINUE_API_KEY
        },
      });
      stdout = result.stdout;
    } catch (execError) {
      const errorOutput =
        execError.stdout || execError.stderr || execError.message || "";
      if (
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid")
      ) {
        return res.status(401).json({
          error: "Continue.dev API authentication failed",
          message:
            "Continue.dev CLI requires an API key to be configured. Please configure Continue.dev with your LLM provider API key.",
          details: errorOutput,
        });
      }
      throw execError;
    }

    const isCorrect = stdout.trim().toUpperCase().startsWith("CORRECT");

    await dbHelpers.updateTodo(todoId, { correct: isCorrect });

    res.json({
      success: true,
      correct: isCorrect,
      response: stdout.trim(),
    });
  } catch (error) {
    console.error("Check correctness error:", error);
    res.status(500).json({ error: "Failed to check correctness" });
  }
});

// -----------------------------
// Code Execution Endpoints
// -----------------------------

// Helper function to detect if code snippet is a shell command
function isShellCommand(codeSnippet) {
  const trimmed = codeSnippet.trim();

  // Remove any leading/trailing whitespace and normalize
  const normalized = trimmed.replace(/\s+/g, " ");

  // Check for common shell command patterns
  const shellPatterns = [
    /^(npm|npx|yarn|pnpm)\s/i, // Package managers (case insensitive)
    /^(git|cd|ls|mkdir|rm|cp|mv|chmod|chown|pwd|cat|grep|find)\s/i,
    /^\.\/\w+/, // Executable scripts
    /^(curl|wget|ssh|scp|rsync)\s/i,
    /^echo\s/i,
    /^export\s+\w+=/,
    /^#!\/(bin|usr)\/(sh|bash|zsh)/, // Shebang
  ];

  const isShell = shellPatterns.some((pattern) => pattern.test(normalized));

  // Additional check: if it doesn't look like code (no JS/Python keywords), treat as shell
  if (!isShell && trimmed.length > 0) {
    const hasCodeKeywords =
      /(function|const|let|var|def|class|import|from|require|module\.exports)/i.test(
        trimmed
      );
    const hasShellKeywords =
      /^(npm|npx|yarn|pnpm|git|cd|ls|mkdir|rm|cp|mv|echo|export)/i.test(
        trimmed
      );

    if (hasShellKeywords && !hasCodeKeywords) {
      return true;
    }
  }

  return isShell;
}

// Helper function to determine file extension from code snippet
function detectLanguage(codeSnippet) {
  // First check if it's a shell command
  if (isShellCommand(codeSnippet)) {
    return "sh";
  }

  // Simple heuristic-based detection
  // Check for Python-specific patterns first
  if (
    codeSnippet.includes("def ") ||
    (codeSnippet.includes("import ") && codeSnippet.includes("print(")) ||
    (codeSnippet.includes("from ") && codeSnippet.includes("import "))
  ) {
    // Additional check: Python typically doesn't have semicolons, braces, or require
    if (
      !codeSnippet.includes("require(") &&
      !codeSnippet.includes("module.exports") &&
      !codeSnippet.includes("{")
    ) {
      return "py";
    }
  }
  // Check for JavaScript/Node.js patterns
  if (
    codeSnippet.includes("require(") ||
    codeSnippet.includes("module.exports") ||
    codeSnippet.includes("export ") ||
    codeSnippet.includes("function ") ||
    codeSnippet.includes("const ") ||
    codeSnippet.includes("let ") ||
    codeSnippet.includes("var ")
  ) {
    return "js";
  }
  // Default to JavaScript for web projects
  return "js";
}

// Helper function to create git checkpoint
async function createGitCheckpoint(projectPath) {
  console.log(
    `[GIT-CHECKPOINT] Starting checkpoint creation for: ${projectPath}`
  );
  try {
    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      console.log(
        `[GIT-CHECKPOINT] Not a git repository: ${gitDir} does not exist`
      );
      return null; // Not a git repo, can't create checkpoint
    }
    console.log(`[GIT-CHECKPOINT] Git directory found: ${gitDir}`);

    // Stage all changes
    console.log(`[GIT-CHECKPOINT] Staging all changes...`);
    try {
      await execAsync("git add -A", { cwd: projectPath });
      console.log(`[GIT-CHECKPOINT] Changes staged successfully`);
    } catch (addError) {
      console.error(
        `[GIT-CHECKPOINT] Failed to stage changes:`,
        addError.message
      );
      throw addError;
    }

    // Check if there are any changes to commit
    try {
      const { stdout: statusStdout } = await execAsync(
        "git status --porcelain",
        { cwd: projectPath }
      );
      console.log(
        `[GIT-CHECKPOINT] Git status: ${statusStdout || "(no output)"}`
      );
      if (!statusStdout.trim()) {
        // No changes, get current HEAD
        console.log(
          `[GIT-CHECKPOINT] No changes to commit, getting current HEAD...`
        );
        const { stdout: headStdout } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const headHash = headStdout.trim();
        console.log(`[GIT-CHECKPOINT] Current HEAD: ${headHash}`);
        return headHash;
      }
    } catch (statusError) {
      console.log(
        `[GIT-CHECKPOINT] No commits yet, attempting initial commit...`
      );
      // No commits yet, create initial commit
      try {
        await execAsync('git commit -m "Checkpoint before todo execution"', {
          cwd: projectPath,
        });
        const { stdout: commitStdout } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const commitHash = commitStdout.trim();
        console.log(`[GIT-CHECKPOINT] Initial commit created: ${commitHash}`);
        return commitHash;
      } catch (commitError) {
        console.error(
          `[GIT-CHECKPOINT] Failed to create initial commit:`,
          commitError.message
        );
        // Can't commit (maybe no files or git not configured)
        return null;
      }
    }

    // Create a checkpoint commit
    console.log(`[GIT-CHECKPOINT] Creating checkpoint commit...`);
    try {
      await execAsync('git commit -m "Checkpoint before todo execution"', {
        cwd: projectPath,
      });
      const { stdout: commitStdout } = await execAsync("git rev-parse HEAD", {
        cwd: projectPath,
      });
      const commitHash = commitStdout.trim();
      console.log(`[GIT-CHECKPOINT] Checkpoint commit created: ${commitHash}`);
      return commitHash;
    } catch (commitError) {
      console.error(`[GIT-CHECKPOINT] Commit failed:`, commitError.message);
      // Commit failed, try to get current HEAD anyway
      try {
        const { stdout: headStdout } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const headHash = headStdout.trim();
        console.log(
          `[GIT-CHECKPOINT] Using current HEAD as fallback: ${headHash}`
        );
        return headHash;
      } catch (headError) {
        console.error(
          `[GIT-CHECKPOINT] Failed to get HEAD:`,
          headError.message
        );
        return null;
      }
    }
  } catch (error) {
    console.error(
      `[GIT-CHECKPOINT] Failed to create git checkpoint:`,
      error.message
    );
    console.error(`[GIT-CHECKPOINT] Error stack:`, error.stack);
    return null;
  }
}

// Helper function to execute a single command attempt
async function executeCommandAttempt(
  command,
  todo,
  projectPath,
  finalIsShellCmd,
  language,
  tempFilePath,
  tempFileName
) {
  // Determine timeout based on command type
  let timeout = 30000; // Default 30 seconds
  if (finalIsShellCmd) {
    // Shell commands might need more time, especially for npm/npx commands
    if (
      command.includes("npx") ||
      command.includes("npm install") ||
      command.includes("yarn")
    ) {
      timeout = 300000; // 5 minutes for package installation commands
    } else if (
      command.includes("npm") ||
      command.includes("yarn") ||
      command.includes("pnpm")
    ) {
      timeout = 120000; // 2 minutes for other npm commands
    }
  }

  // For npx create-next-app, we need to make it non-interactive
  let finalCommand = command;
  if (command.includes("create-next-app")) {
    // Check if directory is not empty (create-next-app won't work in non-empty dirs)
    const isCreatingInCurrentDir =
      command.includes(" .") || command.trim().endsWith(".");
    if (isCreatingInCurrentDir) {
      try {
        const files = await fsp.readdir(projectPath);
        const filteredFiles = files.filter(
          (f) => !f.startsWith(".") && f !== "node_modules" && f !== ".git"
        );

        if (filteredFiles.length > 0) {
          console.warn(
            `[EXECUTE-ATTEMPT] Directory contains files: ${filteredFiles.join(
              ", "
            )}`
          );
        }
      } catch (dirError) {
        console.warn(
          `[EXECUTE-ATTEMPT] Could not check directory contents:`,
          dirError.message
        );
      }
    }

    // create-next-app needs --yes or -y flag to skip prompts
    if (!command.includes("--yes") && !command.includes("-y")) {
      finalCommand = command.replace(
        /(create-next-app[^\s]*)\s+(\.)/,
        "$1 --yes $2"
      );

      if (finalCommand === command) {
        finalCommand = command.replace(/(create-next-app[^\s]*)/, "$1 --yes");
      }
    }
  }

  console.log(`[EXECUTE-ATTEMPT] Executing command: ${finalCommand}`);

  try {
    const { stdout, stderr } = await execAsync(finalCommand, {
      timeout: timeout,
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      cwd: projectPath,
      env: {
        ...process.env,
        CI: "true",
        npm_config_yes: "true",
      },
    });

    return {
      success: true,
      stdout: stdout,
      stderr: stderr || null,
      error: null,
      errorCode: null,
      errorSignal: null,
    };
  } catch (execError) {
    return {
      success: false,
      stdout: execError.stdout || null,
      stderr: execError.stderr || null,
      error: execError.message || "Execution failed",
      errorCode: execError.code || null,
      errorSignal: execError.signal || null,
    };
  }
}

// Helper function to get error fix suggestion from Continue.dev
async function getErrorFixSuggestion(
  todo,
  errorMessage,
  errorStdout,
  errorStderr,
  command,
  projectPath,
  iterationNumber
) {
  try {
    const errorContext = `
TODO TITLE: ${todo.title}
TODO DESCRIPTION: ${todo.description}
ORIGINAL CODE/COMMAND: ${todo.code_snippet}

EXECUTION ERROR (Attempt ${iterationNumber}):
Command: ${command}
Error: ${errorMessage}
${errorStdout ? `\nStdout:\n${errorStdout}` : ""}
${errorStderr ? `\nStderr:\n${errorStderr}` : ""}

PROJECT CONTEXT:
Project: ${todo.project_name}
Working Directory: ${projectPath}

Please analyze this error and provide a fix. The fix should be:
1. A corrected command or code snippet that addresses the error
2. An explanation of what went wrong
3. If the error is due to directory conflicts or missing prerequisites, suggest the appropriate fix

Return your response as JSON:
{
  "analysis": "Explanation of what went wrong",
  "fix": "The corrected command/code to fix the issue",
  "fixType": "command|code|manual",
  "reasoning": "Why this fix should work"
}`;

    const prompt = errorContext;
    const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${prompt.replace(
      /"/g,
      '\\"'
    )}"`;

    console.log(
      `[ERROR-FIX] Requesting fix suggestion from Continue.dev (iteration ${iterationNumber})...`
    );
    let stdout;
    try {
      const result = await execAsync(continueCommand, {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 10,
        cwd: projectPath,
        env: {
          ...process.env, // Pass all environment variables including CONTINUE_API_KEY
        },
      });
      stdout = result.stdout;
    } catch (execError) {
      const errorOutput =
        execError.stdout || execError.stderr || execError.message || "";
      if (
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid")
      ) {
        console.error(
          `[ERROR-FIX] Continue.dev API authentication error on iteration ${iterationNumber}`
        );
        // Return null to indicate no fix suggestion available
        return null;
      }
      // For other errors, return null as well
      console.error(
        `[ERROR-FIX] Continue.dev error on iteration ${iterationNumber}:`,
        execError.message
      );
      return null;
    }

    // Check stdout for authentication errors
    if (
      stdout.includes("x-api-key") ||
      stdout.includes("authentication_error") ||
      stdout.includes("invalid")
    ) {
      console.error(
        `[ERROR-FIX] Continue.dev API authentication error in response`
      );
      return null;
    }

    // Try to extract JSON from response
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const suggestion = JSON.parse(jsonMatch[0]);
        console.log(`[ERROR-FIX] Received fix suggestion from LLM`);
        return suggestion;
      } catch (parseError) {
        console.warn(`[ERROR-FIX] Failed to parse JSON, using raw response`);
        return {
          analysis: "Could not parse LLM response",
          fix: stdout.trim(),
          fixType: "command",
          reasoning: "Raw LLM response",
        };
      }
    } else {
      // Use raw response as fix
      return {
        analysis: "LLM response format unclear",
        fix: stdout.trim(),
        fixType: "command",
        reasoning: "Using raw LLM output",
      };
    }
  } catch (error) {
    console.error(`[ERROR-FIX] Failed to get fix suggestion:`, error.message);
    return null;
  }
}

// Execute code for a single todo with iterative error fixing
router.post("/execute-code/:todoId", async (req, res) => {
  const todoId = req.params.todoId;
  const maxIterations = req.query.maxIterations
    ? parseInt(req.query.maxIterations)
    : 3;
  console.log(
    `[EXECUTE-CODE] Starting execution for todoId: ${todoId} (max iterations: ${maxIterations})`
  );

  try {
    console.log(`[EXECUTE-CODE] Fetching todo with id: ${todoId}`);
    const todo = await dbHelpers.getTodoById(todoId);

    if (!todo) {
      console.error(`[EXECUTE-CODE] Todo not found: ${todoId}`);
      return res.status(404).json({ error: "Todo not found" });
    }

    console.log(
      `[EXECUTE-CODE] Todo found: ${todo.title}, project: ${todo.project_name}`
    );
    console.log(`[EXECUTE-CODE] Has code snippet: ${!!todo.code_snippet}`);
    console.log(
      `[EXECUTE-CODE] Code snippet length: ${todo.code_snippet?.length || 0}`
    );

    if (!todo.code_snippet) {
      console.error(`[EXECUTE-CODE] No code snippet for todo: ${todoId}`);
      return res.status(400).json({ error: "No code snippet to execute" });
    }

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);
    console.log(`[EXECUTE-CODE] Project path: ${projectPath}`);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      console.error(
        `[EXECUTE-CODE] Project directory not found: ${projectPath}`
      );
      return res.status(404).json({ error: "Project directory not found" });
    }
    console.log(`[EXECUTE-CODE] Project directory exists: ${projectPath}`);

    // Create git checkpoint before execution
    let gitCommitHash = null;
    let executionHistoryId = null;
    try {
      console.log(`[EXECUTE-CODE] Creating git checkpoint...`);
      gitCommitHash = await createGitCheckpoint(projectPath);
      if (gitCommitHash) {
        console.log(`[EXECUTE-CODE] Checkpoint created: ${gitCommitHash}`);
        // Store execution history - we'll use this ID for iterations
        executionHistoryId = await dbHelpers.insertExecutionHistory(
          todoId,
          todo.project_name,
          gitCommitHash
        );
        console.log(
          `[EXECUTE-CODE] Execution history stored with ID: ${executionHistoryId}`
        );
      } else {
        console.warn(
          `[EXECUTE-CODE] No checkpoint created (not a git repo or no changes)`
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
        `[EXECUTE-CODE] Failed to create checkpoint:`,
        checkpointError
      );
      console.error(
        `[EXECUTE-CODE] Checkpoint error stack:`,
        checkpointError.stack
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
          `[EXECUTE-CODE] Failed to create execution history:`,
          histError
        );
      }
    }

    // Detect language and determine execution command
    console.log(`[EXECUTE-CODE] Detecting language...`);
    console.log(
      `[EXECUTE-CODE] Code snippet preview: ${todo.code_snippet.substring(
        0,
        100
      )}...`
    );

    const isShellCmd = isShellCommand(todo.code_snippet);
    const language = detectLanguage(todo.code_snippet);
    const finalIsShellCmd = language === "sh" || isShellCmd;

    console.log(
      `[EXECUTE-CODE] Detected language: ${language}, isShellCommand: ${finalIsShellCmd}`
    );

    // Prepare initial command
    let currentCommand = finalIsShellCmd
      ? todo.code_snippet.trim()
      : todo.code_snippet;
    let tempFileName = null;
    let tempFilePath = null;

    // For non-shell commands, create temp file
    if (!finalIsShellCmd) {
      tempFileName = `todo_${todoId}_${Date.now()}.${language}`;
      tempFilePath = path.join(projectPath, tempFileName);
      await fsp.writeFile(tempFilePath, todo.code_snippet, "utf8");

      if (language === "js") {
        currentCommand = `node "${tempFileName}"`;
      } else if (language === "py") {
        currentCommand = `python3 "${tempFileName}"`;
      } else {
        currentCommand = `node "${tempFileName}"`;
      }
    }

    // Iterative execution with error fixing
    const iterations = [];
    let finalResult = null;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      console.log(
        `[EXECUTE-CODE] === Iteration ${iteration}/${maxIterations} ===`
      );
      console.log(`[EXECUTE-CODE] Command: ${currentCommand}`);

      // Execute the command
      const result = await executeCommandAttempt(
        currentCommand,
        todo,
        projectPath,
        finalIsShellCmd,
        language,
        tempFilePath,
        tempFileName
      );

      // Store iteration log
      const iterationLog = {
        iterationNumber: iteration,
        command: currentCommand,
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        errorCode: result.errorCode,
        errorSignal: result.errorSignal,
        llmSuggestion: null,
        appliedFix: null,
        status: result.success ? "success" : "failed",
      };

      if (result.success) {
        // Success! Store iteration and return
        console.log(
          `[EXECUTE-CODE] Execution succeeded on iteration ${iteration}`
        );
        if (executionHistoryId) {
          await dbHelpers.insertExecutionIteration(
            executionHistoryId,
            todoId,
            iteration,
            currentCommand,
            null,
            result.stdout,
            result.stderr,
            null,
            null,
            "success"
          );
        }
        iterations.push(iterationLog);

        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try {
            await fsp.unlink(tempFilePath);
          } catch (e) {}
        }

        return res.json({
          success: true,
          output: result.stdout,
          error: result.stderr || null,
          language: language,
          checkpointCreated: !!gitCommitHash,
          gitCommitHash: gitCommitHash,
          iterations: iterations,
          totalIterations: iteration,
        });
      } else {
        // Error occurred - get LLM fix suggestion
        console.log(
          `[EXECUTE-CODE] Execution failed on iteration ${iteration}, requesting fix...`
        );

        const llmSuggestion = await getErrorFixSuggestion(
          todo,
          result.error,
          result.stdout,
          result.stderr,
          currentCommand,
          projectPath,
          iteration
        );

        iterationLog.llmSuggestion = llmSuggestion
          ? JSON.stringify(llmSuggestion)
          : null;

        if (llmSuggestion && llmSuggestion.fix) {
          console.log(`[EXECUTE-CODE] LLM suggested fix: ${llmSuggestion.fix}`);
          console.log(`[EXECUTE-CODE] LLM analysis: ${llmSuggestion.analysis}`);

          // Apply the fix
          if (llmSuggestion.fixType === "command" && finalIsShellCmd) {
            // For shell commands, use the suggested fix as new command
            currentCommand = llmSuggestion.fix.trim();
            iterationLog.appliedFix = currentCommand;
            console.log(`[EXECUTE-CODE] Applied fix: ${currentCommand}`);
          } else if (llmSuggestion.fixType === "code" && !finalIsShellCmd) {
            // For code, update temp file
            if (tempFilePath) {
              await fsp.writeFile(tempFilePath, llmSuggestion.fix, "utf8");
              iterationLog.appliedFix = llmSuggestion.fix;
              console.log(`[EXECUTE-CODE] Updated code file with fix`);
            }
          } else {
            // Try to apply fix as command anyway
            currentCommand = llmSuggestion.fix.trim();
            iterationLog.appliedFix = currentCommand;
          }
        } else {
          console.warn(`[EXECUTE-CODE] No LLM fix suggestion available`);
          iterationLog.status = "failed_no_fix";
        }

        // Store iteration in database
        if (executionHistoryId) {
          await dbHelpers.insertExecutionIteration(
            executionHistoryId,
            todoId,
            iteration,
            currentCommand,
            result.error,
            result.stdout,
            result.stderr,
            iterationLog.llmSuggestion,
            iterationLog.appliedFix,
            iterationLog.status
          );
        }

        iterations.push(iterationLog);

        // If this is the last iteration, return error
        if (iteration === maxIterations) {
          console.log(`[EXECUTE-CODE] Max iterations reached, returning error`);

          // Clean up temp file
          if (tempFilePath && fs.existsSync(tempFilePath)) {
            try {
              await fsp.unlink(tempFilePath);
            } catch (e) {}
          }

          return res.status(500).json({
            success: false,
            error: result.error || "Execution failed after all iterations",
            errorCode: result.errorCode,
            errorSignal: result.errorSignal,
            stderr: result.stderr,
            stdout: result.stdout,
            checkpointCreated: !!gitCommitHash,
            gitCommitHash: gitCommitHash,
            iterations: iterations,
            totalIterations: iteration,
          });
        }
      }
    }
  } catch (error) {
    console.error(`[EXECUTE-CODE] Top-level error for todoId ${todoId}:`);
    console.error(`[EXECUTE-CODE] Error message: ${error.message}`);
    console.error(`[EXECUTE-CODE] Error stack:`, error.stack);
    res.status(500).json({
      error: "Failed to execute code",
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
      // Continue with execution even if checkpoint fails
    }

    const results = [];

    for (const todo of todosWithCode) {
      try {
        // Detect language and determine execution command
        const language = detectLanguage(todo.code_snippet);
        const tempFileName = `todo_${todo.id}_${Date.now()}.${language}`;
        const tempFilePath = path.join(projectPath, tempFileName);

        try {
          // Write code snippet to temporary file
          await fsp.writeFile(tempFilePath, todo.code_snippet, "utf8");

          // Determine execution command based on language
          let execCommand;
          if (language === "js") {
            execCommand = `node "${tempFileName}"`;
          } else if (language === "py") {
            execCommand = `python3 "${tempFileName}"`;
          } else {
            execCommand = `node "${tempFileName}"`;
          }

          // Execute the code
          const { stdout, stderr } = await execAsync(execCommand, {
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 10,
            cwd: projectPath,
          });

          // Clean up temporary file
          try {
            await fsp.unlink(tempFilePath);
          } catch (cleanupError) {
            console.warn("Failed to cleanup temp file:", cleanupError);
          }

          results.push({
            todoId: todo.id,
            title: todo.title,
            success: true,
            output: stdout,
            error: stderr || null,
            language: language,
          });
        } catch (execError) {
          // Clean up temporary file on error
          try {
            await fsp.unlink(tempFilePath);
          } catch (cleanupError) {
            console.warn("Failed to cleanup temp file:", cleanupError);
          }

          results.push({
            todoId: todo.id,
            title: todo.title,
            success: false,
            error: execError.message || "Execution failed",
            stderr: execError.stderr || null,
            stdout: execError.stdout || null,
          });
        }
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

// -----------------------------
// Revert Execution Endpoints
// -----------------------------

// Revert a single todo execution
router.post("/revert-execution/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return res.status(400).json({
        error: "Project is not a git repository. Cannot revert changes.",
      });
    }

    // Get the latest execution history for this todo
    const executionHistory = await dbHelpers.getLatestExecutionHistoryByTodoId(
      todoId
    );
    if (!executionHistory || !executionHistory.git_commit_hash) {
      return res.status(404).json({
        error: "No execution checkpoint found for this todo. Cannot revert.",
      });
    }

    try {
      // Reset to the checkpoint commit
      await execAsync(`git reset --hard ${executionHistory.git_commit_hash}`, {
        cwd: projectPath,
      });

      // Clean up any untracked files created during execution
      try {
        await execAsync("git clean -fd", { cwd: projectPath });
      } catch (cleanError) {
        console.warn("Failed to clean untracked files:", cleanError);
      }

      res.json({
        success: true,
        message: "Successfully reverted to checkpoint",
        checkpointHash: executionHistory.git_commit_hash,
        executedAt: executionHistory.executed_at,
      });
    } catch (gitError) {
      console.error("Git revert error:", gitError);
      res.status(500).json({
        error: "Failed to revert changes",
        details: gitError.message,
      });
    }
  } catch (error) {
    console.error("Revert execution error:", error);
    res.status(500).json({ error: "Failed to revert execution" });
  }
});

// Revert all executions for a project (revert to latest checkpoint)
router.post("/revert-all-executions/:projectName", async (req, res) => {
  try {
    const { projectName } = req.params;

    const projectPath = path.join(PROJECTS_DIR, projectName);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return res.status(400).json({
        error: "Project is not a git repository. Cannot revert changes.",
      });
    }

    // Get the latest execution history for the project
    const executionHistoryList = await dbHelpers.getExecutionHistoryByProject(
      projectName
    );
    if (!executionHistoryList || executionHistoryList.length === 0) {
      return res.status(404).json({
        error: "No execution checkpoints found. Cannot revert.",
      });
    }

    // Get the most recent checkpoint (first in the list since it's ordered DESC)
    const latestCheckpoint = executionHistoryList[0];
    if (!latestCheckpoint.git_commit_hash) {
      return res.status(404).json({
        error: "No valid checkpoint found. Cannot revert.",
      });
    }

    try {
      // Reset to the latest checkpoint commit
      await execAsync(`git reset --hard ${latestCheckpoint.git_commit_hash}`, {
        cwd: projectPath,
      });

      // Clean up any untracked files created during execution
      try {
        await execAsync("git clean -fd", { cwd: projectPath });
      } catch (cleanError) {
        console.warn("Failed to clean untracked files:", cleanError);
      }

      res.json({
        success: true,
        message: "Successfully reverted all executions to latest checkpoint",
        checkpointHash: latestCheckpoint.git_commit_hash,
        executedAt: latestCheckpoint.executed_at,
        totalReverted: executionHistoryList.length,
      });
    } catch (gitError) {
      console.error("Git revert error:", gitError);
      res.status(500).json({
        error: "Failed to revert changes",
        details: gitError.message,
      });
    }
  } catch (error) {
    console.error("Revert all executions error:", error);
    res.status(500).json({ error: "Failed to revert all executions" });
  }
});

// Check if a todo can be reverted (has checkpoint)
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
    const canRevert =
      isGitRepo && executionHistory && executionHistory.git_commit_hash;

    res.json({
      canRevert: !!canRevert,
      isGitRepo: isGitRepo,
      hasCheckpoint: !!executionHistory,
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

    // Parse JSON fields
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
