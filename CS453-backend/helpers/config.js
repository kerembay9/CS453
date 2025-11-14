const path = require("path");

// Configuration constants
const PROJECTS_DIR = path.join(__dirname, "../projects");
const UPLOADS_DIR = path.join(__dirname, "../uploads");
const CONTINUE_CONFIG_PATH = path.join(__dirname, "../config.yaml");

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "http://localhost:5678/webhook-test/ec52a91a-54e0-47a2-afa3-f191c87c7043";

module.exports = {
  PROJECTS_DIR,
  UPLOADS_DIR,
  CONTINUE_CONFIG_PATH,
  N8N_WEBHOOK_URL,
};

