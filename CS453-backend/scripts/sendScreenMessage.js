#!/usr/bin/env node

/**
 * Script to send a message to a screen session
 * Usage: node sendScreenMessage.js <sessionName> <todoId>
 * If todoId is provided, it will fetch the todo from DB and generate the message
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { dbHelpers } = require("../db");

const sessionName = process.argv[2];
const todoIdOrMessage = process.argv[3];

if (!sessionName || !todoIdOrMessage) {
  console.error("Usage: node sendScreenMessage.js <sessionName> <todoId>");
  process.exit(1);
}

// Check if it's a todo ID (numeric) or a message string
const todoId = /^\d+$/.test(todoIdOrMessage)
  ? parseInt(todoIdOrMessage, 10)
  : null;

async function getMessage() {
  if (todoId) {
    // Fetch todo from database and generate message
    try {
      const todo = await dbHelpers.getTodoById(todoId);
      if (!todo) {
        console.error(`Todo with ID ${todoId} not found`);
        process.exit(1);
      }

      const codeSnippet = todo.code_snippet || "";
      const message = `CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. This is a ONE-WAY communication. You are an agentic AI that MUST execute tasks directly.
2. DO NOT ask questions. DO NOT ask for confirmation. DO NOT ask "Would you like me to..." or similar.
3. If you encounter any issues (Node.js version, missing dependencies, etc.), handle them automatically:
   - For Node.js version issues: Use the current Node.js version or install the required version automatically
   - For missing dependencies: Install them automatically
   - For configuration issues: Configure automatically using sensible defaults
4. Execute the task immediately without any user interaction.
5. AFTER completing the task, you MUST check for syntax errors in the codebase and fix any syntax errors you find:
   - For TypeScript/JavaScript projects: Run syntax checks (e.g., "tsc --noEmit" for TypeScript, "node --check" for JavaScript files, or use the project's linter)
   - For Python projects: Run "python3 -m py_compile" on modified files or use a linter
   - For other languages: Use appropriate syntax checking tools
   - If any syntax errors are found, fix them immediately
   - Continue checking and fixing until there are no syntax errors remaining

TASK TO EXECUTE:
${todo.title}
${todo.description}

${codeSnippet}

Remember: Execute immediately. No questions. No confirmations. After completing the task, check for syntax errors and fix them if any exist. Use --yes for commands where applicable.`;
      return message;
    } catch (error) {
      console.error(`Failed to fetch todo: ${error.message}`);
      process.exit(1);
    }
  } else {
    // Use the provided message as-is
    return todoIdOrMessage;
  }
}

getMessage().then((message) => {
  console.log("message is", message);
  sendMessage(message);
});

function sendMessage(message) {
  // Split message into 50-character chunks
  const chunkSize = 50;
  const chunks = [];
  for (let i = 0; i < message.length; i += chunkSize) {
    chunks.push(message.slice(i, i + chunkSize));
  }

  console.log(
    `Splitting message into ${chunks.length} chunks of ~${chunkSize} characters (including final empty chunk)`
  );

  let currentChunkIndex = 0;

  function sendNextChunk() {
    if (currentChunkIndex >= chunks.length) {
      console.log("All chunks sent successfully (including final empty chunk)");
      process.exit(0);
      return;
    }

    const chunk = chunks[currentChunkIndex];
    console.log(
      `Sending chunk ${currentChunkIndex + 1}/${
        chunks.length
      }: "${chunk.substring(0, 30)}..."`
    );

    // Use a temporary file for each chunk
    const tempFile = path.join(
      "/tmp",
      `screen-message-chunk-${Date.now()}-${currentChunkIndex}.txt`
    );

    try {
      // Write chunk to temp file
      fs.writeFileSync(tempFile, chunk, "utf8");

      const escapedSessionName = sessionName.replace(/'/g, "'\\''");

      // Use screen -X stuff with file input
      const sendMessageCommand = `screen -S '${escapedSessionName}' -X stuff "$(cat '${tempFile.replace(
        /'/g,
        "'\\''"
      )}')"`;

      const sendMessageProcess = spawn("bash", ["-c", sendMessageCommand], {
        stdio: "pipe",
      });

      let stderr = "";
      sendMessageProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      sendMessageProcess.on("exit", (code) => {
        // Clean up temp file
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }

        if (code !== 0) {
          console.error(
            `Failed to send chunk ${currentChunkIndex + 1} (code ${code}): ${
              stderr || "Unknown error"
            }`
          );
          process.exit(code);
          return;
        }

        // Move to next chunk after a small delay
        currentChunkIndex++;
        setTimeout(sendNextChunk, 100); // 100ms delay between chunks
      });

      sendMessageProcess.on("error", (error) => {
        // Clean up temp file
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch (e) {
          // Ignore cleanup errors
        }

        console.error(
          `Failed to spawn process for chunk ${currentChunkIndex + 1}: ${
            error.message
          }`
        );
        process.exit(1);
      });
    } catch (error) {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch (e) {
        // Ignore cleanup errors
      }

      console.error(
        `Failed to write chunk ${currentChunkIndex + 1}: ${error.message}`
      );
      process.exit(1);
    }
  }

  // Start sending chunks
  sendNextChunk();
}
