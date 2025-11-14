const fsp = require("fs/promises");
const path = require("path");
const { PROJECTS_DIR, UPLOADS_DIR } = require("./config");

// Utility functions

function sanitizeName(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
}

async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(src, dest);
}

// Ensure base directories exist
async function ensureDirs() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
}

module.exports = {
  sanitizeName,
  moveFile,
  ensureDirs,
};

