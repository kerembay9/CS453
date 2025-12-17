// routes.js
const express = require("express");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const multer = require("multer");
const axios = require("axios");
const NodeFormData = require("form-data");
const { dbHelpers } = require("../db");

// Import helpers
const {
  PROJECTS_DIR,
  UPLOADS_DIR,
  ELEVENLABS_API_KEY,
  ELEVENLABS_TRANSCRIPTION_MODEL,
} = require("../helpers/config");
const { sanitizeName, moveFile, ensureDirs } = require("../helpers/utils");

// Import sub-routes
const todoRoutes = require("./todo");
const surveyRoutes = require("./survey");
const continueRoutes = require("./continue");
const settingsRoutes = require("./settings");

const router = express.Router();
const execAsync = promisify(exec);

// Ensure base dirs exist
ensureDirs().catch(console.error);

// Validation functions
function isValidGitUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    return false;
  }
  // Allow http, https, git, and ssh URLs
  const gitUrlPattern = /^(https?:\/\/|git@|git:\/\/)[\w\.-]+(?:\/[\w\.-]+)*\/?[\w\.-]+(?:\.git)?$/;
  return gitUrlPattern.test(url.trim());
}

function sanitizeFileName(filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Invalid filename");
  }
  
  // Remove path separators and dangerous characters
  // Keep only alphanumeric, dots, hyphens, underscores, and common file extensions
  const sanitized = filename
    .replace(/[\/\\]/g, "") // Remove path separators
    .replace(/[^a-zA-Z0-9._-]/g, "_") // Replace unsafe chars with underscore
    .replace(/^\.+/, "") // Remove leading dots (hidden files)
    .slice(0, 255); // Limit length (max filesystem filename length)
  
  if (!sanitized || sanitized.length === 0) {
    throw new Error("Filename sanitization resulted in empty string");
  }
  
  return sanitized;
}

function ensureFileWithinProjectDir(projectPath, filename) {
  // Sanitize filename
  const sanitizedFilename = sanitizeFileName(filename);
  
  // Resolve to absolute path
  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedFilePath = path.resolve(projectPath, sanitizedFilename);
  
  // Ensure file path is within project directory (prevent directory traversal)
  if (!resolvedFilePath.startsWith(resolvedProjectPath)) {
    throw new Error("Path traversal detected in filename");
  }
  
  return { sanitizedFilename, resolvedFilePath };
}

function ensurePathWithinProjectsDir(projectName) {
  // Sanitize the project name
  const sanitized = sanitizeName(projectName);
  if (!sanitized || sanitized.length === 0) {
    throw new Error("Invalid project name");
  }
  
  // Resolve to absolute path and ensure it's within PROJECTS_DIR
  const resolvedPath = path.resolve(PROJECTS_DIR, sanitized);
  const projectsDirResolved = path.resolve(PROJECTS_DIR);
  
  // Check for path traversal
  if (!resolvedPath.startsWith(projectsDirResolved)) {
    throw new Error("Path traversal detected");
  }
  
  return { sanitized, resolvedPath };
}

// Safe git clone using spawn (no shell injection)
function safeGitClone(repoUrl, targetPath) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn("git", ["clone", repoUrl, targetPath], {
      cwd: PROJECTS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    gitProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    gitProcess.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`git clone failed with code ${code}: ${stderr || stdout}`));
      }
    });

    gitProcess.on("error", (error) => {
      reject(new Error(`Failed to spawn git process: ${error.message}`));
    });
  });
}

// -----------------------------
// Multer (temp storage) - Dynamic based on settings
// -----------------------------
const getUploadMiddleware = async () => {
  try {
    const fileUploadLimitSetting = await dbHelpers.getSetting("file_upload_limit_mb");
    const fileUploadLimitMB = fileUploadLimitSetting?.value 
      ? parseInt(fileUploadLimitSetting.value) 
      : 100; // Default to 100MB if not set
    
    const limitMB = Math.max(1, Math.min(fileUploadLimitMB, 1000)); // Clamp between 1-1000MB
    const fileSizeLimit = limitMB * 1024 * 1024; // Convert to bytes
    
    return multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => cb(null, file.originalname),
      }),
      limits: { fileSize: fileSizeLimit },
    });
  } catch (error) {
    console.error("Error getting upload limit from settings, using default 100MB:", error);
    // Fallback to default 100MB
    return multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => cb(null, file.originalname),
      }),
      limits: { fileSize: 100 * 1024 * 1024 }, // 100MB default
    });
  }
};

// -----------------------------
// Clone repository
// -----------------------------
router.post("/clone-repo", express.json(), async (req, res) => {
  try {
    const { repoUrl, repoName } = req.body || {};
    
    // Validate inputs
    if (!repoUrl || !repoName) {
      return res.status(400).json({ error: "Missing repoUrl or repoName" });
    }

    // Validate git URL format
    if (!isValidGitUrl(repoUrl)) {
      return res.status(400).json({ 
        error: "Invalid git URL format. Must be http, https, git, or ssh URL" 
      });
    }

    // Sanitize and validate project name, ensure path safety
    let sanitized, repoPath;
    try {
      const pathInfo = ensurePathWithinProjectsDir(repoName);
      sanitized = pathInfo.sanitized;
      repoPath = pathInfo.resolvedPath;
    } catch (pathError) {
      return res.status(400).json({ error: pathError.message });
    }

    await ensureDirs();

    // Check if repository already exists
    if (fs.existsSync(repoPath)) {
      return res.status(400).json({ error: "Repository already exists" });
    }

    // Use safe git clone (no shell injection)
    await safeGitClone(repoUrl.trim(), repoPath);
    
    res.json({ 
      success: true, 
      message: "Repository cloned successfully",
      projectName: sanitized 
    });
  } catch (error) {
    console.error("clone-repo error:", error);
    res.status(500).json({ 
      error: "Failed to clone repository",
      details: error.message 
    });
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
  try {
    const { projectName } = req.body || {};
    if (!projectName) {
      return res.status(400).json({ error: "Missing projectName" });
    }

    // Sanitize and validate project name, ensure path safety
    let projectPath;
    try {
      const pathInfo = ensurePathWithinProjectsDir(projectName);
      projectPath = pathInfo.resolvedPath;
    } catch (pathError) {
      return res.status(400).json({ error: pathError.message });
    }

    // Check if project exists
    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Use fs.rm instead of shell command (no command injection)
    await fsp.rm(projectPath, { recursive: true, force: true });
    
    res.json({ success: true, message: "Project deleted successfully" });
  } catch (error) {
    console.error("delete error:", error);
    res.status(500).json({ 
      error: "Failed to delete project",
      details: error.message 
    });
  }
});

// -----------------------------
// Upload audio → transcribe with ElevenLabs API directly
// If mounted at app.use("/api", router), path is /api/upload-audio
// -----------------------------
router.post("/upload-audio", async (req, res, next) => {
  try {
    const upload = await getUploadMiddleware();
    upload.single("audio")(req, res, next);
  } catch (error) {
    next(error);
  }
}, async (req, res) => {
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

  // Validate and sanitize project name, ensure path safety
  let projectName, projectPath;
  try {
    const pathInfo = ensurePathWithinProjectsDir(projectNameRaw);
    projectName = pathInfo.sanitized;
    projectPath = pathInfo.resolvedPath;
  } catch (pathError) {
    if (file?.path) {
      try {
        await fsp.unlink(file.path);
      } catch {}
    }
    return res.status(400).json({ error: pathError.message });
  }

  // Validate that project exists (don't create projects implicitly)
  if (!fs.existsSync(projectPath)) {
    if (file?.path) {
      try {
        await fsp.unlink(file.path);
      } catch {}
    }
    return res.status(404).json({ error: "Project does not exist. Please create it first." });
  }

  // Sanitize filename and ensure it stays within project directory
  let sanitizedFilename, finalPath;
  try {
    const fileInfo = ensureFileWithinProjectDir(projectPath, file.originalname);
    sanitizedFilename = fileInfo.sanitizedFilename;
    finalPath = fileInfo.resolvedFilePath;
  } catch (fileError) {
    if (file?.path) {
      try {
        await fsp.unlink(file.path);
      } catch {}
    }
    return res.status(400).json({ error: fileError.message });
  }

  try {
    await moveFile(file.path, finalPath);

    // Create database record for the audio file (use sanitized filename)
    const audioFileId = await dbHelpers.insertAudioFile(
      projectName,
      sanitizedFilename,
      finalPath
    );

    if (!ELEVENLABS_API_KEY) {
      await dbHelpers.updateTranscription(audioFileId, null, "failed");
      return res.status(500).json({
        error: "ELEVENLABS_API_KEY not configured",
        message: "Please set ELEVENLABS_API_KEY environment variable",
      });
    }

    // Build form-data for ElevenLabs speech-to-text API
    const form = new NodeFormData();
    form.append(
      "file",
      fs.createReadStream(finalPath),
      {
        filename: sanitizedFilename,
      }
    );
    form.append("model_id", ELEVENLABS_TRANSCRIPTION_MODEL || "scribe_v1");

    console.log("Sending audio to ElevenLabs:", {
      audioFile: sanitizedFilename,
      projectName: projectName,
      audioFileId: audioFileId,
      model: ELEVENLABS_TRANSCRIPTION_MODEL || "scribe_v1",
    });

    const elevenResponse = await axios.post(
      "https://api.elevenlabs.io/v1/speech-to-text",
      form,
      {
        headers: {
          ...form.getHeaders(),
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const elevenData = elevenResponse.data;
    console.log("ElevenLabs response:", elevenData);

    let transcriptionText = null;
    let finalStatus = "processing";

    if (typeof elevenData === "string" && elevenData.trim()) {
      transcriptionText = elevenData.trim();
      finalStatus = "completed";
    } else if (elevenData && typeof elevenData === "object") {
      transcriptionText =
        elevenData.text ||
        elevenData.transcription ||
        elevenData.result;
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
        `Transcription completed for audio file ${audioFileId}:`,
        {
          status: finalStatus,
          hasTranscription: !!transcriptionText,
        }
      );
    } else {
      await dbHelpers.updateTranscription(audioFileId, null, "failed");
      finalStatus = "failed";
    }

    return res.json({
      success: finalStatus === "completed",
      message: transcriptionText
        ? "Audio uploaded and transcription completed"
        : "Audio uploaded but transcription failed",
      audioFileId: audioFileId,
      transcription: transcriptionText,
      status: finalStatus,
      providerResponse: elevenData,
    });
  } catch (err) {
    console.error("Upload/transcription error:", err?.response?.data || err);
    const status = err?.response?.status || 502;
    const details = err?.response?.data || String(err);
    return res.status(status).json({
      error: "Failed to transcribe audio via ElevenLabs",
      status,
      details,
    });
  }
});

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
// Check and Fix Syntax/Build Errors
// -----------------------------
router.post("/check-syntax/:projectName", async (req, res) => {
  try {
    const { projectName } = req.params;
    const projectPath = path.join(PROJECTS_DIR, projectName);

    // Check if project exists
    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Build prompt to check and fix syntax errors
    const prompt = `CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. This is a ONE-WAY communication. You are an agentic AI that MUST execute tasks directly.
2. DO NOT ask questions. DO NOT ask for confirmation. DO NOT ask "Would you like me to..." or similar.
3. Execute the task immediately without any user interaction.

TASK TO EXECUTE:
Check the codebase for syntax errors and build errors, then fix any errors you find.

1. First, identify the project type (TypeScript/JavaScript, Python, etc.) by checking for package.json, tsconfig.json, requirements.txt, etc.
2. Run appropriate syntax/build checks:
   - For TypeScript projects: Run "tsc --noEmit" to check for TypeScript errors
   - For JavaScript projects: Run "node --check" on modified files or use ESLint if available
   - For Python projects: Run "python3 -m py_compile" on modified files or use a linter
   - For other languages: Use appropriate syntax checking tools
3. If any errors are found, analyze them and fix them automatically
4. Re-run the checks to verify all errors are fixed
5. Continue checking and fixing until there are no syntax errors remaining

Remember: Execute immediately. No questions. No confirmations. Fix all syntax errors you find.`;

    console.log(`[CHECK-SYNTAX] Checking syntax for project: ${projectName}`);
    console.log(`[CHECK-SYNTAX] Project path: ${projectPath}`);

    // Import executeContinueCLI dynamically to avoid circular dependencies
    const { executeContinueCLI } = require("../helpers/continueHelpers");

    // Execute the CLI command
    const result = await executeContinueCLI(prompt, projectPath, 600000); // 10 minute timeout

    if (result.success) {
      return res.json({
        success: true,
        message: "Syntax check completed successfully",
        output: result.stdout,
        errors: null,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: "Syntax check failed or errors were found",
        output: result.stdout || result.stderr,
        errors: result.error || "Unknown error",
      });
    }
  } catch (error) {
    console.error(`[CHECK-SYNTAX] Error:`, error);
    return res.status(500).json({
      success: false,
      message: "Failed to check syntax",
      error: error.message || "Unknown error",
    });
  }
});

// -----------------------------
// Mount sub-routes
// -----------------------------
router.use("/todos", todoRoutes);
router.use("/survey", surveyRoutes);
router.use("/continue", continueRoutes);
router.use("/settings", settingsRoutes);

module.exports = router;
