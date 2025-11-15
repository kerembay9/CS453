#!/usr/bin/env node

/**
 * Script to send Enter key to a screen session
 * Usage: node sendScreenEnter.js <sessionName>
 */

const { spawn } = require("child_process");

const sessionName = process.argv[2];

if (!sessionName) {
  console.error("Usage: node sendScreenEnter.js <sessionName>");
  process.exit(1);
}

const escapedSessionName = sessionName.replace(/'/g, "'\\''");

// Send Enter using screen -X stuff
const sendEnterCommand = `screen -S '${escapedSessionName}' -X stuff $'\\015'`;

const sendEnterProcess = spawn("bash", ["-c", sendEnterCommand], {
  stdio: "pipe",
});

let stderr = "";
sendEnterProcess.stderr.on("data", (data) => {
  stderr += data.toString();
});

sendEnterProcess.on("exit", (code) => {
  if (code !== 0) {
    console.error(`Failed to send Enter (code ${code}): ${stderr || "Unknown error"}`);
    process.exit(code);
  }
  // Success - no output needed
  process.exit(0);
});

sendEnterProcess.on("error", (error) => {
  console.error(`Failed to spawn process: ${error.message}`);
  process.exit(1);
});

