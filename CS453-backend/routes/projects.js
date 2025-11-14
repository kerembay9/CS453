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

// Import helpers
const { PROJECTS_DIR, UPLOADS_DIR } = require("../helpers/config");
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
// Mount sub-routes
// -----------------------------
router.use("/todos", todoRoutes);
router.use("/survey", surveyRoutes);
router.use("/continue", continueRoutes);
router.use("/settings", settingsRoutes);

module.exports = router;
