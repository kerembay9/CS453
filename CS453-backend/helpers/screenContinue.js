const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");

const execAsync = promisify(exec);

/**
 * Screen-based communication with Continue.dev CLI
 * Uses a single shared screen session named "opsidian-continue".
 * The session is created when executing a todo, in the todo's project directory.
 * The session starts by cd'ing to the project path, then running the cn command.
 */
class ScreenContinueConnection {
  static SESSION_NAME = "opsidian-continue";

  constructor(configPath, projectPath) {
    this.configPath = configPath;
    this.projectPath = projectPath;
    this.sessionName = ScreenContinueConnection.SESSION_NAME;
  }

  /**
   * Create or check if screen session exists
   */
  async ensureScreenSession() {
    return new Promise((resolve, reject) => {
      const escapedSessionName = this.sessionName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );
      const checkCommand = `screen -list | grep -q "${escapedSessionName}"`;

      console.log(`[SCREEN-CONTINUE] Checking for screen session: ${this.sessionName}`);
      const checkProcess = spawn("bash", ["-c", checkCommand], {
        stdio: "pipe",
      });

      let checkStderr = "";
      checkProcess.stderr.on("data", (data) => {
        checkStderr += data.toString();
      });

      checkProcess.on("exit", async (code) => {
        console.log(`[SCREEN-CONTINUE] Screen session check exited with code: ${code}`);
        if (code === 0) {
          console.log(`[SCREEN-CONTINUE] Screen session exists`);
          resolve(true);
        } else if (code === 1) {
          console.log(`[SCREEN-CONTINUE] Screen session not found, creating new session...`);
          this.createScreenSession()
            .then(() => {
              console.log(`[SCREEN-CONTINUE] Screen session created successfully`);
              resolve(false);
            })
            .catch((error) => {
              console.error(`[SCREEN-CONTINUE] Failed to create screen session:`, error);
              reject(error);
            });
        } else {
          console.error(`[SCREEN-CONTINUE] Unexpected check exit code: ${code}, stderr: ${checkStderr}`);
          this.createScreenSession()
            .then(() => {
              console.log(`[SCREEN-CONTINUE] Screen session created after unexpected code`);
              resolve(false);
            })
            .catch((error) => {
              console.error(`[SCREEN-CONTINUE] Failed to create screen session:`, error);
              reject(error);
            });
        }
      });

      checkProcess.on("error", (error) => {
        console.error(`[SCREEN-CONTINUE] Error checking screen session:`, error);
        this.createScreenSession()
          .then(() => {
            console.log(`[SCREEN-CONTINUE] Screen session created after check error`);
            resolve(false);
          })
          .catch(reject);
      });
    });
  }

  /**
   * Create a screen session with cn running
   * This creates the session in the project directory (cd to project path first, then run cn)
   */
  async createScreenSession() {
    return new Promise((resolve, reject) => {
      console.log(`[SCREEN-CONTINUE] createScreenSession called for:`, {
        sessionName: this.sessionName,
        projectPath: this.projectPath,
        configPath: this.configPath,
      });

      // Ensure project directory exists
      if (!fs.existsSync(this.projectPath)) {
        const error = new Error(`Project directory does not exist: ${this.projectPath}`);
        console.error(`[SCREEN-CONTINUE] ${error.message}`);
        reject(error);
        return;
      }

      // Check if cn command exists
      execAsync("which cn")
        .then(() => {
          console.log(`[SCREEN-CONTINUE] 'cn' command found`);
        })
        .catch(() => {
          console.warn(`[SCREEN-CONTINUE] 'cn' command not found in PATH`);
        });

      // Create session by cd'ing to project path first, then running cn
      const escapedProjectPath = this.projectPath.replace(/"/g, '\\"');
      const escapedConfigPath = this.configPath ? this.configPath.replace(/"/g, '\\"') : "";
      const scriptCommand = `cd "${escapedProjectPath}" && cn --config "${escapedConfigPath}" --auto`;

      console.log(`[SCREEN-CONTINUE] Creating screen session with command:`, {
        command: "screen",
        args: ["-dmS", this.sessionName, "bash", "-c", scriptCommand],
        fullCommand: `screen -dmS ${this.sessionName} bash -c "${scriptCommand}"`,
      });

      const command = [
        "screen",
        "-dmS",
        this.sessionName,
        "bash",
        "-c",
        scriptCommand,
      ];

      let processStdout = "";
      let processStderr = "";

      const process = spawn(command[0], command.slice(1), {
        stdio: "pipe",
      });

      process.stdout.on("data", (data) => {
        processStdout += data.toString();
        console.log(`[SCREEN-CONTINUE] createScreenSession stdout:`, data.toString().substring(0, 200));
      });

      process.stderr.on("data", (data) => {
        processStderr += data.toString();
        console.error(`[SCREEN-CONTINUE] createScreenSession stderr:`, data.toString().substring(0, 200));
      });

      process.on("exit", async (code, signal) => {
        console.log(`[SCREEN-CONTINUE] createScreenSession process exited:`, {
          code,
          signal,
          stdout: processStdout.substring(0, 500),
          stderr: processStderr.substring(0, 500),
        });

        if (code === 0) {
          console.log(`[SCREEN-CONTINUE] Screen session spawn command succeeded, waiting 2s then verifying...`);
          setTimeout(async () => {
            // Verify session was actually created
            try {
              const escapedSessionName = this.sessionName.replace(/'/g, "'\\''");
              const verifyResult = await execAsync(`screen -list | grep "${escapedSessionName}"`);
              console.log(`[SCREEN-CONTINUE] Screen session verified:`, verifyResult.stdout.substring(0, 200));
              resolve();
            } catch (verifyError) {
              console.error(`[SCREEN-CONTINUE] Screen session verification failed after creation:`, {
                error: verifyError.message,
                code: verifyError.code,
              });
              reject(new Error(`Screen session was not created successfully: ${verifyError.message}`));
            }
          }, 2000);
        } else {
          const error = new Error(`Failed to create screen session (code ${code}): ${processStderr || "Unknown error"}`);
          console.error(`[SCREEN-CONTINUE] ${error.message}`);
          reject(error);
        }
      });

      process.on("error", (error) => {
        console.error(`[SCREEN-CONTINUE] createScreenSession spawn error:`, error);
        reject(error);
      });
    });
  }

  /**
   * Get the current screen buffer content
   */
  async getScreenBuffer() {
    return new Promise((resolve) => {
      const tempFile = `/tmp/screen-buffer-${
        this.sessionName
      }-${Date.now()}.txt`;
      const escapedSessionName = this.sessionName.replace(/'/g, "'\\''");
      const command = `screen -S '${escapedSessionName}' -X hardcopy '${tempFile}'`;

      const process = spawn("bash", ["-c", command], {
        stdio: "pipe",
      });

      process.on("exit", (code) => {
        if (code === 0) {
          try {
            if (fs.existsSync(tempFile)) {
              const content = fs.readFileSync(tempFile, "utf8");
              fs.unlinkSync(tempFile);
              resolve(content);
            } else {
              resolve("");
            }
          } catch (error) {
            resolve("");
          }
        } else {
          resolve("");
        }
      });

      process.on("error", () => {
        resolve("");
      });
    });
  }

  /**
   * Clean UI elements from content
   */
  cleanUIElements(content) {
    let cleaned = content
      .replace(/╭[─╮]*╮/g, "")
      .replace(/╰[─╯]*╯/g, "")
      .replace(/│[^│\n]*│/g, "")
      .replace(/[╭╮╰╯│─]/g, "")
      .replace(/[●▋◉]/g, "")
      .replace(/[⡾⡻⡧⢿⡯⠻⠫⠛⠵⠯⡿⣿⣾⣽⣻⢿⡿⣟⣯⣷⠿⠟⠻⠫⠛⠵⠯]/g, "")
      .replace(/\( \d+s • esc to interrupt \)/g, "")
      .replace(/Ask anything.*?shell mode/gi, "")
      .replace(/Continue CLI v[\d.]+/g, "")
      .replace(/───────────────────/g, "");

    const lines = cleaned.split("\n");
    const meaningfulLines = lines.filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.match(/^[●▋◉\s]*$/) &&
        !trimmed.match(/^\(.*interrupt.*\)$/) &&
        !trimmed.match(/^Continue CLI/) &&
        !trimmed.match(/^Ask anything/)
      );
    });

    cleaned = meaningfulLines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return cleaned;
  }

  /**
   * Send a command/message to the screen session and wait for execution to complete
   * Returns { success: boolean, stdout?: string, stderr?: string, error?: string }
   * @param {string|number} messageOrTodoId - Either a message string or a todo ID
   */
  async sendMessageAndWait(messageOrTodoId, timeout = 600000) {
    return new Promise(async (resolve, reject) => {
      console.log(`[SCREEN-CONTINUE] sendMessageAndWait called with:`, {
        messageOrTodoId: typeof messageOrTodoId === "string" ? messageOrTodoId.substring(0, 100) : messageOrTodoId,
        timeout,
        sessionName: this.sessionName,
        projectPath: this.projectPath,
      });

      // First, ensure session exists (will be created in project directory if needed)
      console.log(`[SCREEN-CONTINUE] Ensuring screen session exists...`);
      try {
        await this.ensureScreenSession();
        console.log(`[SCREEN-CONTINUE] Screen session ensured`);
        
        // Verify session is actually accessible
        try {
          const escapedSessionName = this.sessionName.replace(/'/g, "'\\''");
          const checkResult = await execAsync(`screen -list | grep "${escapedSessionName}"`);
          console.log(`[SCREEN-CONTINUE] Screen session verification:`, {
            found: true,
            output: checkResult.stdout.substring(0, 200),
          });
        } catch (checkError) {
          console.error(`[SCREEN-CONTINUE] Screen session verification failed:`, {
            error: checkError.message,
            code: checkError.code,
          });
        }
      } catch (error) {
        console.error(`[SCREEN-CONTINUE] Error ensuring screen session:`, error);
        reject(error);
        return;
      }

      // Get baseline buffer state
      console.log(`[SCREEN-CONTINUE] Getting baseline buffer state...`);
      const baselineContent = await this.getScreenBuffer();
      const baselineLength = baselineContent.length;
      console.log(`[SCREEN-CONTINUE] Baseline buffer length: ${baselineLength} chars`);

      // Get script paths
      const scriptsDir = path.join(__dirname, "..", "scripts");
      const sendMessageScript = path.join(scriptsDir, "sendScreenMessage.js");
      const sendEnterScript = path.join(scriptsDir, "sendScreenEnter.js");
      console.log(`[SCREEN-CONTINUE] Script paths:`, {
        scriptsDir,
        sendMessageScript,
        sendEnterScript,
        sendMessageScriptExists: fs.existsSync(sendMessageScript),
        sendEnterScriptExists: fs.existsSync(sendEnterScript),
      });

      // Now send the actual message (without cd command)
      // Pass todo ID or message to script
      const todoId =
        typeof messageOrTodoId === "number"
          ? messageOrTodoId.toString()
          : messageOrTodoId;
      
      console.log(`[SCREEN-CONTINUE] Spawning sendMessageProcess with:`, {
        command: "node",
        args: [sendMessageScript, this.sessionName, todoId ? `${todoId.substring(0, 50)}...` : todoId],
        sessionName: this.sessionName,
        todoIdLength: typeof todoId === "string" ? todoId.length : "N/A",
      });

      const sendMessageProcess = spawn(
        "node",
        [sendMessageScript, this.sessionName, todoId],
        {
          stdio: "pipe",
        }
      );

      let sendStdout = "";
      let sendStderr = "";
      
      sendMessageProcess.stdout.on("data", (data) => {
        const dataStr = data.toString();
        sendStdout += dataStr;
        console.log(`[SCREEN-CONTINUE] sendMessageProcess stdout:`, dataStr.substring(0, 200));
      });

      sendMessageProcess.stderr.on("data", (data) => {
        const dataStr = data.toString();
        sendStderr += dataStr;
        console.error(`[SCREEN-CONTINUE] sendMessageProcess stderr:`, dataStr.substring(0, 200));
      });

      sendMessageProcess.on("exit", async (code, signal) => {
        console.log(`[SCREEN-CONTINUE] sendMessageProcess exited:`, {
          code,
          signal,
          stdoutLength: sendStdout.length,
          stderrLength: sendStderr.length,
          stdout: sendStdout.substring(0, 500),
          stderr: sendStderr.substring(0, 500),
        });

        if (code !== 0) {
          const errorMsg = `Failed to send message (code ${code}): ${
            sendStderr || "Unknown error"
          }`;
          console.error(`[SCREEN-CONTINUE] ${errorMsg}`);
          reject(new Error(errorMsg));
          return;
        }

        // Wait 500ms before sending Enter
        console.log(`[SCREEN-CONTINUE] Waiting 500ms before sending Enter...`);
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send Enter using separate script
        console.log(`[SCREEN-CONTINUE] Spawning sendEnterProcess with:`, {
          command: "node",
          args: [sendEnterScript, this.sessionName],
          sessionName: this.sessionName,
        });

        const sendEnterProcess = spawn(
          "node",
          [sendEnterScript, this.sessionName],
          {
            stdio: "pipe",
          }
        );

        let enterStdout = "";
        let enterStderr = "";
        
        sendEnterProcess.stdout.on("data", (data) => {
          const dataStr = data.toString();
          enterStdout += dataStr;
          console.log(`[SCREEN-CONTINUE] sendEnterProcess stdout:`, dataStr.substring(0, 200));
        });

        sendEnterProcess.stderr.on("data", (data) => {
          const dataStr = data.toString();
          enterStderr += dataStr;
          console.error(`[SCREEN-CONTINUE] sendEnterProcess stderr:`, dataStr.substring(0, 200));
        });

        sendEnterProcess.on("exit", async (code, signal) => {
          console.log(`[SCREEN-CONTINUE] sendEnterProcess exited:`, {
            code,
            signal,
            stdoutLength: enterStdout.length,
            stderrLength: enterStderr.length,
            stdout: enterStdout.substring(0, 500),
            stderr: enterStderr.substring(0, 500),
          });

          if (code !== 0) {
            const errorMsg = `Failed to send Enter (code ${code}): ${
              enterStderr || "Unknown error"
            }`;
            console.error(`[SCREEN-CONTINUE] ${errorMsg}`);
            reject(new Error(errorMsg));
            return;
          }

          // Wait for processing
          console.log(`[SCREEN-CONTINUE] Waiting 1000ms for processing...`);
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Get baseline after sending
          console.log(`[SCREEN-CONTINUE] Getting buffer after sending...`);
          const afterSendContent = await this.getScreenBuffer();
          let lastContentLength = afterSendContent.length;
          console.log(`[SCREEN-CONTINUE] After-send buffer length: ${lastContentLength} chars (baseline: ${baselineLength})`);

          // Poll for completion
          const startTime = Date.now();
          const pollInterval = 1000;
          let stableCount = 0;
          const requiredStableChecks = 2;
          let pollCount = 0;

          console.log(`[SCREEN-CONTINUE] Starting to poll for completion (timeout: ${timeout}ms, interval: ${pollInterval}ms)`);

          const pollForCompletion = async () => {
            try {
              pollCount++;
              const currentContent = await this.getScreenBuffer();
              const currentLength = currentContent.length;
              const elapsed = Math.floor((Date.now() - startTime) / 1000);
              
              if (pollCount % 5 === 0 || currentLength !== lastContentLength) {
                console.log(`[SCREEN-CONTINUE] Poll #${pollCount} (${elapsed}s elapsed):`, {
                  currentLength,
                  lastContentLength,
                  baselineLength,
                  stableCount,
                  requiredStableChecks,
                  lengthDiff: currentLength - lastContentLength,
                });
              }

              if (currentLength > lastContentLength) {
                lastContentLength = currentLength;
                stableCount = 0;
              } else {
                stableCount++;
              }

              if (stableCount >= requiredStableChecks) {
                console.log(`[SCREEN-CONTINUE] Content stabilized after ${pollCount} polls (${elapsed}s)`);
                
                // Extract new content
                let response = "";
                if (currentLength > baselineLength) {
                  const newContent = currentContent.slice(baselineLength);
                  response = this.cleanUIElements(newContent);
                  console.log(`[SCREEN-CONTINUE] Extracted ${response.length} chars of new content (from ${newContent.length} raw)`);
                } else {
                  response = this.cleanUIElements(currentContent);
                  console.log(`[SCREEN-CONTINUE] Using full content (${response.length} chars)`);
                }

                // Check for errors
                const cleanedContent = currentContent
                  .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
                  .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
                  .toLowerCase();

                const hasError =
                  cleanedContent.includes("error") ||
                  cleanedContent.includes("failed") ||
                  cleanedContent.includes("exception") ||
                  cleanedContent.includes("traceback") ||
                  cleanedContent.includes("command not found") ||
                  cleanedContent.includes("permission denied") ||
                  cleanedContent.match(/exit code: [1-9]\d*/) ||
                  cleanedContent.match(/exit status \d+/);

                console.log(`[SCREEN-CONTINUE] Completion check:`, {
                  hasError,
                  responseLength: response.length,
                  rawResponseLength: currentContent.length,
                });

                resolve({
                  success: !hasError,
                  stdout: response,
                  stderr: hasError ? response : null,
                  error: hasError ? "Error detected in execution output" : null,
                  rawResponse: currentContent,
                });
                return;
              }

              if (Date.now() - startTime > timeout) {
                console.warn(`[SCREEN-CONTINUE] Timeout reached after ${elapsed}s`);
                const finalContent = await this.getScreenBuffer();
                let finalResponse = "";
                if (finalContent.length > baselineLength) {
                  const newContent = finalContent.slice(baselineLength);
                  finalResponse = this.cleanUIElements(newContent);
                } else {
                  finalResponse = this.cleanUIElements(finalContent);
                }

                console.log(`[SCREEN-CONTINUE] Returning timeout result:`, {
                  responseLength: finalResponse.length,
                  rawResponseLength: finalContent.length,
                });

                resolve({
                  success: false,
                  stdout: finalResponse,
                  stderr: finalResponse,
                  error: "Timeout: execution did not complete",
                  rawResponse: finalContent,
                });
                return;
              }

              setTimeout(pollForCompletion, pollInterval);
            } catch (error) {
              reject(error);
            }
          };

          pollForCompletion();
        });

        sendEnterProcess.on("error", (error) => {
          console.error(`[SCREEN-CONTINUE] sendEnterProcess error:`, error);
          reject(error);
        });
      });

      sendMessageProcess.on("error", (error) => {
        console.error(`[SCREEN-CONTINUE] sendMessageProcess error:`, error);
        reject(error);
      });
    });
  }
}

module.exports = { ScreenContinueConnection };
