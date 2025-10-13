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
    const continueCommand = `cn -p "${prompt.replace(
      /"/g,
      '\\"'
    )}" --codebase "${projectPath}"`;

    console.log("Executing Continue.dev command:", continueCommand);
    const { stdout, stderr } = await execAsync(continueCommand, {
      timeout: 30000, // 30 second timeout
      maxBuffer: 1024 * 1024, // 1MB buffer
    });

    if (stderr) {
      console.warn("Continue.dev stderr:", stderr);
    }

    // Parse response
    let todos;
    try {
      // Extract JSON from response (might have extra text)
      const jsonMatch = stdout.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        todos = JSON.parse(jsonMatch[0]);
      } else {
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
    const continueCommand = `cn -p "${prompt.replace(
      /"/g,
      '\\"'
    )}" --codebase "${projectPath}"`;

    const { stdout } = await execAsync(continueCommand, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

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
    const continueCommand = `continue --headless --prompt "${prompt.replace(
      /"/g,
      '\\"'
    )}" --codebase "${projectPath}"`;

    const { stdout } = await execAsync(continueCommand, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

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

module.exports = router;
