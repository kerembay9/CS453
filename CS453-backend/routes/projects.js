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
    )}" --auto`;

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

// Validate code snippet - toggle valid boolean
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

    // Toggle the valid field: if null/false, set to true; if true, set to false
    const newValidValue = !todo.valid;

    await dbHelpers.updateTodo(todoId, { valid: newValidValue });

    res.json({
      success: true,
      valid: newValidValue,
    });
  } catch (error) {
    console.error("Validate code error:", error);
    res.status(500).json({ error: "Failed to validate code" });
  }
});

// Check correctness - toggle correct boolean
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

    // Toggle the correct field: if null/false, set to true; if true, set to false
    const newCorrectValue = !todo.correct;

    await dbHelpers.updateTodo(todoId, { correct: newCorrectValue });

    res.json({
      success: true,
      correct: newCorrectValue,
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

// Helper function to detect and format quota/rate limit errors
function detectQuotaError(errorOutput) {
  if (!errorOutput) return null;

  try {
    // Try to parse as JSON (might be nested)
    let parsed;
    try {
      parsed = JSON.parse(errorOutput);
    } catch {
      // Try to extract JSON from the output
      const jsonMatch = errorOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return null;
      }
    }

    // Check if it's a quota error
    let errorObj = null;

    // Check various possible structures
    if (parsed.status === "error" && parsed.message) {
      try {
        const messageData = JSON.parse(parsed.message);
        if (Array.isArray(messageData) && messageData[0]?.error) {
          errorObj = messageData[0].error;
        } else if (messageData.error) {
          errorObj = messageData.error;
        }
      } catch {
        // If message isn't JSON, check if parsed itself has error
        if (parsed.error) {
          errorObj = parsed.error;
        }
      }
    } else if (parsed.error) {
      errorObj = parsed.error;
    }

    if (!errorObj) return null;

    // Check for quota/rate limit indicators
    const isQuotaError =
      errorObj.code === 429 ||
      errorObj.status === "RESOURCE_EXHAUSTED" ||
      (errorObj.message &&
        (errorObj.message.includes("quota") ||
          errorObj.message.includes("Quota exceeded") ||
          errorObj.message.includes("rate limit") ||
          errorObj.message.includes("Rate limit")));

    if (!isQuotaError) return null;

    // Extract useful information
    let retryTime = null;
    let quotaLimit = null;
    let quotaMetric = null;

    // Extract retry time
    if (errorObj.details) {
      const retryInfo = errorObj.details.find(
        (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
      );
      if (retryInfo?.retryDelay) {
        retryTime = retryInfo.retryDelay;
      }

      // Extract quota information
      const quotaFailure = errorObj.details.find(
        (d) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
      );
      if (quotaFailure?.violations?.[0]) {
        quotaMetric = quotaFailure.violations[0].quotaMetric;
        quotaLimit = quotaFailure.violations[0].quotaValue;
      }
    }

    // Format user-friendly message
    let message = "LLM API quota limit reached";

    if (errorObj.message) {
      // Extract the main message from the error
      const mainMessage = errorObj.message.split("\n")[0];
      if (mainMessage.includes("quota") || mainMessage.includes("Quota")) {
        message = mainMessage;
      }
    }

    const details = [];
    if (quotaLimit) {
      details.push(`Daily limit: ${quotaLimit} requests`);
    }
    if (retryTime) {
      // Parse retry time (format: "20s" or "20.660733015s")
      const retryMatch = retryTime.match(/(\d+(?:\.\d+)?)s?/);
      if (retryMatch) {
        const seconds = Math.ceil(Number.parseFloat(retryMatch[1]));
        details.push(`Please retry in approximately ${seconds} seconds`);
      } else {
        details.push(`Please retry later`);
      }
    } else {
      details.push("Please try again later");
    }

    return {
      isQuotaError: true,
      message: message,
      details: details.join(". "),
      retryTime: retryTime,
      quotaLimit: quotaLimit,
      rawError: errorObj,
    };
  } catch (err) {
    // If parsing fails, check for common quota error strings
    if (
      errorOutput.includes("quota") ||
      errorOutput.includes("Quota exceeded") ||
      errorOutput.includes("429") ||
      errorOutput.includes("RESOURCE_EXHAUSTED")
    ) {
      return {
        isQuotaError: true,
        message: "LLM API quota limit reached",
        details: "Please try again later",
        retryTime: null,
        quotaLimit: null,
        rawError: null,
      };
    }
    return null;
  }
}

// Helper function to execute code using Continue.dev CLI
async function executeCodeWithContinue(
  codeSnippet,
  todo,
  projectPath,
  isShellCmd
) {
  // Build execution prompt for Continue.dev
  // Match the simple format that works in test.js - direct instruction without JSON format requests
  const executionPrompt = isShellCmd
    ? `${todo.title}
${todo.description}

${codeSnippet}`
    : `${todo.title}
${todo.description}

Code Snippet:
${codeSnippet}`;

  const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${executionPrompt}" --allow Write`;

  console.log(`[EXECUTE-CONTINUE] Continue command: ${continueCommand}`);
  // Determine timeout based on command type
  let timeout = 60000; // Default 60 seconds for Continue.dev
  if (isShellCmd) {
    if (
      codeSnippet.includes("npx") ||
      codeSnippet.includes("npm install") ||
      codeSnippet.includes("yarn")
    ) {
      timeout = 300000; // 5 minutes for package installation
    } else if (
      codeSnippet.includes("npm") ||
      codeSnippet.includes("yarn") ||
      codeSnippet.includes("pnpm")
    ) {
      timeout = 120000; // 2 minutes for other npm commands
    }
  }

  console.log(`[EXECUTE-CONTINUE] ==========================================`);
  console.log(`[EXECUTE-CONTINUE] Executing via Continue.dev CLI...`);
  console.log(`[EXECUTE-CONTINUE] Is shell command: ${isShellCmd}`);
  console.log(`[EXECUTE-CONTINUE] Project path: ${projectPath}`);
  console.log(`[EXECUTE-CONTINUE] Todo title: ${todo.title}`);
  console.log(
    `[EXECUTE-CONTINUE] Code snippet preview: ${codeSnippet.substring(
      0,
      100
    )}...`
  );
  console.log(
    `[EXECUTE-CONTINUE] Full command: ${continueCommand.substring(0, 200)}...`
  );
  console.log(`[EXECUTE-CONTINUE] Command timeout: ${timeout}ms`);

  try {
    console.log(`[EXECUTE-CONTINUE] Starting execAsync...`);
    const { stdout, stderr } = await execAsync(continueCommand, {
      timeout: timeout,
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      cwd: projectPath,
      env: {
        ...process.env,
        CI: "true",
        npm_config_yes: "true",
      },
    });

    console.log(`[EXECUTE-CONTINUE] Command executed successfully`);
    console.log(
      `[EXECUTE-CONTINUE] Stdout length: ${stdout?.length || 0} characters`
    );
    console.log(
      `[EXECUTE-CONTINUE] Stderr length: ${stderr?.length || 0} characters`
    );
    console.log(
      `[EXECUTE-CONTINUE] Stdout preview: ${
        stdout?.substring(0, 500) || "(empty)"
      }`
    );
    if (stderr) {
      console.log(`[EXECUTE-CONTINUE] Stderr: ${stderr.substring(0, 500)}`);
    }

    // Try to parse Continue.dev response as JSON
    let result;
    try {
      // Extract JSON from response
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        console.log(`[EXECUTE-CONTINUE] Found JSON in response, parsing...`);
        result = JSON.parse(jsonMatch[0]);
        console.log(
          `[EXECUTE-CONTINUE] Parsed result:`,
          JSON.stringify(result, null, 2)
        );
        console.log(`[EXECUTE-CONTINUE] Result success: ${result.success}`);
        console.log(
          `[EXECUTE-CONTINUE] Result filePath: ${result.filePath || "(null)"}`
        );
      } else {
        console.log(
          `[EXECUTE-CONTINUE] No JSON found in stdout, treating as plain text`
        );
        // If no JSON found, treat entire output as stdout
        result = {
          success: true,
          stdout: stdout,
          stderr: stderr || null,
          error: null,
          output: stdout,
        };
      }
    } catch (parseError) {
      console.error(`[EXECUTE-CONTINUE] JSON parse error:`, parseError.message);
      console.error(`[EXECUTE-CONTINUE] Parse error stack:`, parseError.stack);
      // If parsing fails, treat as success with raw output
      result = {
        success: true,
        stdout: stdout,
        stderr: stderr || null,
        error: null,
        output: stdout,
      };
    }

    const returnValue = {
      success: result.success !== false,
      stdout: result.stdout || result.output || stdout,
      stderr: result.stderr || stderr || null,
      error: result.error || null,
      errorCode: null,
      errorSignal: null,
      filePath: result.filePath || null, // Path to saved file (for code snippets)
      rawResponse: stdout,
    };

    console.log(`[EXECUTE-CONTINUE] Returning:`, {
      success: returnValue.success,
      hasStdout: !!returnValue.stdout,
      hasStderr: !!returnValue.stderr,
      filePath: returnValue.filePath,
      error: returnValue.error,
    });
    console.log(
      `[EXECUTE-CONTINUE] ==========================================`
    );

    return returnValue;
  } catch (execError) {
    console.error(
      `[EXECUTE-CONTINUE] ==========================================`
    );
    console.error(`[EXECUTE-CONTINUE] Command execution failed!`);
    console.error(`[EXECUTE-CONTINUE] Error code: ${execError.code}`);
    console.error(`[EXECUTE-CONTINUE] Error signal: ${execError.signal}`);
    console.error(`[EXECUTE-CONTINUE] Error message: ${execError.message}`);

    // Check for authentication errors
    const errorOutput =
      execError.stdout || execError.stderr || execError.message || "";

    console.error(
      `[EXECUTE-CONTINUE] Error stdout length: ${execError.stdout?.length || 0}`
    );
    console.error(
      `[EXECUTE-CONTINUE] Error stderr length: ${execError.stderr?.length || 0}`
    );
    console.error(
      `[EXECUTE-CONTINUE] Error stdout: ${
        execError.stdout?.substring(0, 1000) || "(empty)"
      }`
    );
    console.error(
      `[EXECUTE-CONTINUE] Error stderr: ${
        execError.stderr?.substring(0, 1000) || "(empty)"
      }`
    );

    // Check for quota/rate limit errors first
    const quotaError = detectQuotaError(errorOutput);
    if (quotaError) {
      console.error(`[EXECUTE-CONTINUE] Quota/rate limit error detected`);
      return {
        success: false,
        stdout: null,
        stderr: errorOutput,
        error: `${quotaError.message}. ${quotaError.details}`,
        errorCode: "QUOTA_ERROR",
        errorSignal: null,
        rawResponse: errorOutput,
        quotaInfo: {
          retryTime: quotaError.retryTime,
          quotaLimit: quotaError.quotaLimit,
        },
      };
    }

    if (
      errorOutput.includes("x-api-key") ||
      errorOutput.includes("authentication_error") ||
      errorOutput.includes("invalid")
    ) {
      console.error(`[EXECUTE-CONTINUE] Authentication error detected`);
      return {
        success: false,
        stdout: null,
        stderr: errorOutput,
        error: "Continue.dev API authentication failed",
        errorCode: "AUTH_ERROR",
        errorSignal: null,
        rawResponse: errorOutput,
      };
    }

    // Try to parse error output as JSON
    let errorResult;
    try {
      const jsonMatch = errorOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        console.log(
          `[EXECUTE-CONTINUE] Found JSON in error output, parsing...`
        );
        errorResult = JSON.parse(jsonMatch[0]);
        console.log(
          `[EXECUTE-CONTINUE] Parsed error result:`,
          JSON.stringify(errorResult, null, 2)
        );
      }
    } catch (parseErr) {
      console.error(
        `[EXECUTE-CONTINUE] Failed to parse error JSON:`,
        parseErr.message
      );
    }

    const returnValue = {
      success: false,
      stdout: execError.stdout || errorResult?.stdout || null,
      stderr: execError.stderr || errorResult?.stderr || errorOutput,
      error: errorResult?.error || execError.message || "Execution failed",
      errorCode: execError.code || null,
      errorSignal: execError.signal || null,
      rawResponse: errorOutput,
    };

    console.error(`[EXECUTE-CONTINUE] Returning error:`, {
      success: returnValue.success,
      error: returnValue.error,
      errorCode: returnValue.errorCode,
    });
    console.error(
      `[EXECUTE-CONTINUE] ==========================================`
    );

    return returnValue;
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
    )}" --auto`;
    console.log(`[ERROR-FIX] Continue command: ${continueCommand}`);
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

      // Check for quota/rate limit errors
      const quotaError = detectQuotaError(errorOutput);
      if (quotaError) {
        console.error(
          `[ERROR-FIX] Quota/rate limit error on iteration ${iterationNumber}`
        );
        // Return null to indicate no fix suggestion available (can't use LLM)
        return null;
      }

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

  // Get max iterations from settings or query parameter, default to 3
  let maxIterations = req.query.maxIterations
    ? parseInt(req.query.maxIterations)
    : null;

  if (!maxIterations) {
    try {
      const retrySetting = await dbHelpers.getSetting("max_retries");
      maxIterations = retrySetting ? parseInt(retrySetting.value) : 3;
    } catch (error) {
      console.error("Error getting max_retries setting:", error);
      maxIterations = 3; // Fallback to default
    }
  }
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

    // Detect if it's a shell command
    console.log(`[EXECUTE-CODE] Detecting command type...`);
    console.log(
      `[EXECUTE-CODE] Code snippet preview: ${todo.code_snippet.substring(
        0,
        100
      )}...`
    );

    const isShellCmd = isShellCommand(todo.code_snippet);
    console.log(`[EXECUTE-CODE] Is shell command: ${isShellCmd}`);

    // Prepare initial code snippet
    let currentCodeSnippet = todo.code_snippet.trim();

    // Iterative execution with error fixing
    const iterations = [];
    let finalResult = null;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      console.log(
        `[EXECUTE-CODE] === Iteration ${iteration}/${maxIterations} ===`
      );
      console.log(
        `[EXECUTE-CODE] Code snippet: ${currentCodeSnippet.substring(
          0,
          100
        )}...`
      );

      // Execute using Continue.dev CLI
      console.log(`[EXECUTE-CODE] Calling executeCodeWithContinue...`);
      const result = await executeCodeWithContinue(
        currentCodeSnippet,
        todo,
        projectPath,
        isShellCmd
      );

      console.log(
        `[EXECUTE-CODE] Result received from executeCodeWithContinue:`
      );
      console.log(`[EXECUTE-CODE] - success: ${result.success}`);
      console.log(`[EXECUTE-CODE] - filePath: ${result.filePath || "(null)"}`);
      console.log(`[EXECUTE-CODE] - has stdout: ${!!result.stdout}`);
      console.log(`[EXECUTE-CODE] - has stderr: ${!!result.stderr}`);
      console.log(`[EXECUTE-CODE] - error: ${result.error || "(null)"}`);

      // Verify file exists if filePath is provided
      if (result.filePath) {
        const fullFilePath = path.join(projectPath, result.filePath);
        console.log(`[EXECUTE-CODE] Verifying file exists: ${fullFilePath}`);
        console.log(`[EXECUTE-CODE] Project path: ${projectPath}`);
        console.log(`[EXECUTE-CODE] Relative filePath: ${result.filePath}`);

        try {
          const fileExists = fs.existsSync(fullFilePath);
          console.log(
            `[EXECUTE-CODE] File exists at expected path: ${fileExists}`
          );

          if (fileExists) {
            const stats = await fsp.stat(fullFilePath);
            console.log(`[EXECUTE-CODE] File size: ${stats.size} bytes`);
            const fileContent = await fsp.readFile(fullFilePath, "utf8");
            console.log(
              `[EXECUTE-CODE] File content preview: ${fileContent.substring(
                0,
                200
              )}...`
            );
          } else {
            console.warn(
              `[EXECUTE-CODE] WARNING: File path reported but file does not exist!`
            );

            // Check if directory exists
            const fileDir = path.dirname(fullFilePath);
            console.log(`[EXECUTE-CODE] Checking directory: ${fileDir}`);
            const dirExists = fs.existsSync(fileDir);
            console.log(`[EXECUTE-CODE] Directory exists: ${dirExists}`);

            if (dirExists) {
              try {
                const dirContents = await fsp.readdir(fileDir);
                console.log(
                  `[EXECUTE-CODE] Directory contents: ${dirContents.join(", ")}`
                );
              } catch (dirError) {
                console.error(
                  `[EXECUTE-CODE] Error reading directory:`,
                  dirError.message
                );
              }
            }

            // Search for Counter.tsx in common locations
            console.log(
              `[EXECUTE-CODE] Searching for Counter.tsx in project...`
            );
            const searchPaths = [
              path.join(projectPath, "new-test-repo", "app", "components"),
              path.join(projectPath, "new-test-repo", "components"),
              path.join(projectPath, "app", "components"),
              path.join(projectPath, "components"),
              path.join(projectPath, "src", "components"),
              projectPath, // Root of project
            ];

            for (const searchPath of searchPaths) {
              try {
                if (fs.existsSync(searchPath)) {
                  const files = await fsp.readdir(searchPath, {
                    recursive: false,
                  });
                  const counterFiles = files.filter(
                    (f) => f.includes("Counter") || f.includes("counter")
                  );
                  if (counterFiles.length > 0) {
                    console.log(
                      `[EXECUTE-CODE] Found Counter-related files in ${searchPath}: ${counterFiles.join(
                        ", "
                      )}`
                    );
                  }
                }
              } catch (searchError) {
                // Ignore errors, just continue searching
              }
            }

            // Also check if file might be in a different location relative to where Continue.dev ran
            const fileName = path.basename(result.filePath);
            console.log(`[EXECUTE-CODE] File name to search for: ${fileName}`);
          }
        } catch (verifyError) {
          console.error(
            `[EXECUTE-CODE] Error verifying file:`,
            verifyError.message
          );
          console.error(`[EXECUTE-CODE] Error stack:`, verifyError.stack);
        }
      } else if (!isShellCmd) {
        console.warn(
          `[EXECUTE-CODE] WARNING: Code snippet executed but no filePath returned!`
        );
        console.warn(
          `[EXECUTE-CODE] This might indicate Continue.dev did not save the file.`
        );
      }

      // Store iteration log
      const iterationLog = {
        iterationNumber: iteration,
        command: currentCodeSnippet,
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
        if (result.filePath) {
          console.log(`[EXECUTE-CODE] Code saved to file: ${result.filePath}`);
        } else if (!isShellCmd) {
          console.warn(
            `[EXECUTE-CODE] No filePath returned for code snippet execution`
          );
        }
        if (executionHistoryId) {
          await dbHelpers.insertExecutionIteration(
            executionHistoryId,
            todoId,
            iteration,
            currentCodeSnippet,
            null,
            result.stdout,
            result.stderr,
            null,
            null,
            "success"
          );
        }
        iterations.push(iterationLog);

        // Update todo status to completed on successful execution
        try {
          await dbHelpers.updateTodo(todoId, { status: "completed" });
          console.log(
            `[EXECUTE-CODE] Updated todo ${todoId} status to completed`
          );
        } catch (statusError) {
          console.warn(
            `[EXECUTE-CODE] Failed to update todo status:`,
            statusError.message
          );
          // Don't fail the execution if status update fails
        }

        return res.json({
          success: true,
          output: result.stdout,
          error: result.stderr || null,
          filePath: result.filePath || null, // Path to saved file (for code snippets)
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
          currentCodeSnippet,
          projectPath,
          iteration
        );

        iterationLog.llmSuggestion = llmSuggestion
          ? JSON.stringify(llmSuggestion)
          : null;

        if (llmSuggestion && llmSuggestion.fix) {
          console.log(`[EXECUTE-CODE] LLM suggested fix: ${llmSuggestion.fix}`);
          console.log(`[EXECUTE-CODE] LLM analysis: ${llmSuggestion.analysis}`);

          // Apply the fix - update the code snippet for next iteration
          currentCodeSnippet = llmSuggestion.fix.trim();
          iterationLog.appliedFix = currentCodeSnippet;
          console.log(
            `[EXECUTE-CODE] Applied fix: ${currentCodeSnippet.substring(
              0,
              100
            )}...`
          );
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
            currentCodeSnippet,
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

          // Check if the error is a quota error for better formatting
          let errorMessage =
            result.error || "Execution failed after all iterations";
          let quotaInfo = null;

          // Check if result already has quota error info
          if (result.errorCode === "QUOTA_ERROR") {
            // Error message already formatted by detectQuotaError
            errorMessage = result.error;
            quotaInfo = result.quotaInfo;
          } else {
            // Check raw response for quota errors
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
            iterations: iterations,
            totalIterations: iteration,
            quotaInfo: quotaInfo,
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
        const isShellCmd = isShellCommand(todo.code_snippet);

        // Execute using Continue.dev CLI
        const result = await executeCodeWithContinue(
          todo.code_snippet,
          todo,
          projectPath,
          isShellCmd
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

// -----------------------------
// Revert Execution Endpoints
// -----------------------------

// Revert a single todo execution
router.post("/revert-execution/:todoId", async (req, res) => {
  console.log(`[REVERT] Starting revert for todoId: ${req.params.todoId}`);
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      console.error(`[REVERT] Todo not found: ${todoId}`);
      return res.status(404).json({ error: "Todo not found" });
    }

    console.log(
      `[REVERT] Todo found: ${todo.title}, project: ${todo.project_name}`
    );

    const projectPath = path.join(PROJECTS_DIR, todo.project_name);
    console.log(`[REVERT] Project path: ${projectPath}`);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      console.error(`[REVERT] Project directory not found: ${projectPath}`);
      return res.status(404).json({ error: "Project directory not found" });
    }

    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      console.error(`[REVERT] Not a git repository: ${gitDir}`);
      return res.status(400).json({
        error: "Project is not a git repository. Cannot revert changes.",
      });
    }

    console.log(`[REVERT] Git repository found`);

    // Get the latest execution history for this todo
    const executionHistory = await dbHelpers.getLatestExecutionHistoryByTodoId(
      todoId
    );
    console.log(
      `[REVERT] Execution history:`,
      executionHistory
        ? {
            id: executionHistory.id,
            git_commit_hash: executionHistory.git_commit_hash,
            executed_at: executionHistory.executed_at,
          }
        : null
    );

    if (!executionHistory || !executionHistory.git_commit_hash) {
      console.error(`[REVERT] No checkpoint found for todo ${todoId}`);
      return res.status(404).json({
        error: "No execution checkpoint found for this todo. Cannot revert.",
      });
    }

    const commitHash = executionHistory.git_commit_hash;
    console.log(`[REVERT] Reverting to commit: ${commitHash}`);

    try {
      // Verify commit exists
      try {
        const { stdout: commitExists } = await execAsync(
          `git cat-file -e ${commitHash}`,
          { cwd: projectPath }
        );
        console.log(`[REVERT] Commit verified: ${commitHash}`);
      } catch (verifyError) {
        console.error(`[REVERT] Commit does not exist: ${commitHash}`);
        return res.status(404).json({
          error: `Checkpoint commit ${commitHash} not found in repository`,
        });
      }

      // Check current status
      try {
        const { stdout: statusStdout } = await execAsync(
          "git status --porcelain",
          {
            cwd: projectPath,
          }
        );
        console.log(
          `[REVERT] Current git status: ${statusStdout || "(clean)"}`
        );
      } catch (statusError) {
        console.warn(`[REVERT] Could not get git status:`, statusError.message);
      }

      // Reset to the checkpoint commit
      console.log(`[REVERT] Executing: git reset --hard ${commitHash}`);
      await execAsync(`git reset --hard ${commitHash}`, {
        cwd: projectPath,
      });
      console.log(`[REVERT] Git reset successful`);

      // Clean up any untracked files created during execution
      try {
        console.log(`[REVERT] Cleaning untracked files...`);
        const { stdout: cleanStdout } = await execAsync("git clean -fd", {
          cwd: projectPath,
        });
        if (cleanStdout) {
          console.log(`[REVERT] Cleaned files: ${cleanStdout}`);
        }
      } catch (cleanError) {
        console.warn(
          "[REVERT] Failed to clean untracked files:",
          cleanError.message
        );
      }

      // Verify we're at the correct commit
      try {
        const { stdout: currentHash } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const currentHashTrimmed = currentHash.trim();
        console.log(`[REVERT] Current HEAD: ${currentHashTrimmed}`);
        if (currentHashTrimmed !== commitHash) {
          console.warn(
            `[REVERT] WARNING: HEAD mismatch! Expected ${commitHash}, got ${currentHashTrimmed}`
          );
        }
      } catch (headError) {
        console.warn(`[REVERT] Could not verify HEAD:`, headError.message);
      }

      // Mark execution history as reverted
      try {
        await dbHelpers.updateExecutionHistory(executionHistory.id, {
          reverted: true,
        });
        console.log(
          `[REVERT] Marked execution history ${executionHistory.id} as reverted`
        );
      } catch (updateError) {
        console.warn(
          "[REVERT] Failed to mark execution history as reverted:",
          updateError.message
        );
        // Don't fail the revert if this update fails
      }

      res.json({
        success: true,
        message: "Successfully reverted to checkpoint",
        checkpointHash: executionHistory.git_commit_hash,
        executedAt: executionHistory.executed_at,
      });
    } catch (gitError) {
      console.error("[REVERT] Git revert error:", gitError);
      console.error("[REVERT] Error stdout:", gitError.stdout);
      console.error("[REVERT] Error stderr:", gitError.stderr);
      res.status(500).json({
        error: "Failed to revert changes",
        details: gitError.message,
        stdout: gitError.stdout,
        stderr: gitError.stderr,
      });
    }
  } catch (error) {
    console.error("[REVERT] Revert execution error:", error);
    console.error("[REVERT] Error stack:", error.stack);
    res
      .status(500)
      .json({ error: "Failed to revert execution", details: error.message });
  }
});

// Revert all executions for a project (revert to latest checkpoint)
router.post("/revert-all-executions/:projectName", async (req, res) => {
  console.log(
    `[REVERT-ALL] Starting revert for project: ${req.params.projectName}`
  );
  try {
    const { projectName } = req.params;

    const projectPath = path.join(PROJECTS_DIR, projectName);
    console.log(`[REVERT-ALL] Project path: ${projectPath}`);

    // Ensure project directory exists
    if (!fs.existsSync(projectPath)) {
      console.error(`[REVERT-ALL] Project directory not found: ${projectPath}`);
      return res.status(404).json({ error: "Project directory not found" });
    }

    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      console.error(`[REVERT-ALL] Not a git repository: ${gitDir}`);
      return res.status(400).json({
        error: "Project is not a git repository. Cannot revert changes.",
      });
    }

    console.log(`[REVERT-ALL] Git repository found`);

    // Get the latest execution history for the project
    const executionHistoryList = await dbHelpers.getExecutionHistoryByProject(
      projectName
    );
    console.log(
      `[REVERT-ALL] Found ${
        executionHistoryList?.length || 0
      } execution history entries`
    );

    if (!executionHistoryList || executionHistoryList.length === 0) {
      console.error(`[REVERT-ALL] No execution checkpoints found`);
      return res.status(404).json({
        error: "No execution checkpoints found. Cannot revert.",
      });
    }

    // Get the most recent checkpoint (first in the list since it's ordered DESC)
    const latestCheckpoint = executionHistoryList[0];
    console.log(`[REVERT-ALL] Latest checkpoint:`, {
      id: latestCheckpoint.id,
      git_commit_hash: latestCheckpoint.git_commit_hash,
      executed_at: latestCheckpoint.executed_at,
    });

    if (!latestCheckpoint.git_commit_hash) {
      console.error(`[REVERT-ALL] No valid checkpoint hash`);
      return res.status(404).json({
        error: "No valid checkpoint found. Cannot revert.",
      });
    }

    const commitHash = latestCheckpoint.git_commit_hash;
    console.log(`[REVERT-ALL] Reverting to commit: ${commitHash}`);

    try {
      // Verify commit exists
      try {
        await execAsync(`git cat-file -e ${commitHash}`, { cwd: projectPath });
        console.log(`[REVERT-ALL] Commit verified: ${commitHash}`);
      } catch (verifyError) {
        console.error(`[REVERT-ALL] Commit does not exist: ${commitHash}`);
        return res.status(404).json({
          error: `Checkpoint commit ${commitHash} not found in repository`,
        });
      }

      // Check current status
      try {
        const { stdout: statusStdout } = await execAsync(
          "git status --porcelain",
          {
            cwd: projectPath,
          }
        );
        console.log(
          `[REVERT-ALL] Current git status: ${statusStdout || "(clean)"}`
        );
      } catch (statusError) {
        console.warn(
          `[REVERT-ALL] Could not get git status:`,
          statusError.message
        );
      }

      // Reset to the latest checkpoint commit
      console.log(`[REVERT-ALL] Executing: git reset --hard ${commitHash}`);
      await execAsync(`git reset --hard ${commitHash}`, {
        cwd: projectPath,
      });
      console.log(`[REVERT-ALL] Git reset successful`);

      // Clean up any untracked files created during execution
      try {
        console.log(`[REVERT-ALL] Cleaning untracked files...`);
        const { stdout: cleanStdout } = await execAsync("git clean -fd", {
          cwd: projectPath,
        });
        if (cleanStdout) {
          console.log(`[REVERT-ALL] Cleaned files: ${cleanStdout}`);
        }
      } catch (cleanError) {
        console.warn(
          "[REVERT-ALL] Failed to clean untracked files:",
          cleanError.message
        );
      }

      // Verify we're at the correct commit
      try {
        const { stdout: currentHash } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const currentHashTrimmed = currentHash.trim();
        console.log(`[REVERT-ALL] Current HEAD: ${currentHashTrimmed}`);
        if (currentHashTrimmed !== commitHash) {
          console.warn(
            `[REVERT-ALL] WARNING: HEAD mismatch! Expected ${commitHash}, got ${currentHashTrimmed}`
          );
        }
      } catch (headError) {
        console.warn(`[REVERT-ALL] Could not verify HEAD:`, headError.message);
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
      console.error("[REVERT-ALL] Error stdout:", gitError.stdout);
      console.error("[REVERT-ALL] Error stderr:", gitError.stderr);
      res.status(500).json({
        error: "Failed to revert changes",
        details: gitError.message,
        stdout: gitError.stdout,
        stderr: gitError.stderr,
      });
    }
  } catch (error) {
    console.error("[REVERT-ALL] Revert all executions error:", error);
    console.error("[REVERT-ALL] Error stack:", error.stack);
    res.status(500).json({
      error: "Failed to revert all executions",
      details: error.message,
    });
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
      isGitRepo &&
      executionHistory &&
      executionHistory.git_commit_hash &&
      !executionHistory.reverted;

    res.json({
      canRevert: !!canRevert,
      isGitRepo: isGitRepo,
      hasCheckpoint: !!executionHistory,
      isReverted: !!executionHistory?.reverted,
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

// -----------------------------
// Settings Routes
// -----------------------------

// Get all settings
router.get("/settings", async (req, res) => {
  try {
    const settings = await dbHelpers.getAllSettings();
    // Convert array to object for easier frontend consumption
    const settingsObj = {};
    settings.forEach((setting) => {
      settingsObj[setting.key] = {
        value: setting.value,
        description: setting.description,
        updated_at: setting.updated_at,
      };
    });
    res.json(settingsObj);
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ error: "Failed to get settings" });
  }
});

// Get a single setting
router.get("/settings/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const setting = await dbHelpers.getSetting(key);
    if (!setting) {
      return res.status(404).json({ error: "Setting not found" });
    }
    res.json({
      key: setting.key,
      value: setting.value,
      description: setting.description,
    });
  } catch (error) {
    console.error("Get setting error:", error);
    res.status(500).json({ error: "Failed to get setting" });
  }
});

// Update settings
router.put("/settings", async (req, res) => {
  try {
    const settings = req.body;
    await dbHelpers.updateSettings(settings);

    // If continue_api_key is updated, update config.yaml
    if (settings.continue_api_key !== undefined) {
      try {
        const configPath = path.join(__dirname, "../config.yaml");
        if (fs.existsSync(configPath)) {
          let configContent = fs.readFileSync(configPath, "utf8");
          // Simple regex replacement for API key in YAML
          // Match the apiKey line and replace its value
          configContent = configContent.replace(
            /(apiKey:\s*)"[^"]*"/,
            `$1"${settings.continue_api_key}"`
          );
          fs.writeFileSync(configPath, configContent, "utf8");
          console.log("Updated config.yaml with new API key");
        }
      } catch (configError) {
        console.error("Error updating config.yaml:", configError);
        // Don't fail the request if config update fails
      }
    }

    res.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    console.error("Update settings error:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

module.exports = router;
