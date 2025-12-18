const path = require("path");

// Configuration constants
const PROJECTS_DIR = path.join(__dirname, "../projects");
const UPLOADS_DIR = path.join(__dirname, "../uploads");
const CONTINUE_CONFIG_PATH = path.join(__dirname, "../continue/config.yaml");

// ElevenLabs configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_TRANSCRIPTION_MODEL =
  process.env.ELEVENLABS_TRANSCRIPTION_MODEL || "scribe_v1";

module.exports = {
  PROJECTS_DIR,
  UPLOADS_DIR,
  CONTINUE_CONFIG_PATH,
  ELEVENLABS_API_KEY,
  ELEVENLABS_TRANSCRIPTION_MODEL,
};

