const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

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

      const checkProcess = spawn("bash", ["-c", checkCommand], {
        stdio: "pipe",
      });

      checkProcess.on("exit", async (code) => {
        if (code === 0) {
          resolve(true);
        } else if (code === 1) {
          this.createScreenSession()
            .then(() => resolve(false))
            .catch(reject);
        } else {
          this.createScreenSession()
            .then(() => resolve(false))
            .catch(reject);
        }
      });

      checkProcess.on("error", (error) => {
        this.createScreenSession()
          .then(() => resolve(false))
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
      // Ensure project directory exists
      if (!fs.existsSync(this.projectPath)) {
        reject(
          new Error(`Project directory does not exist: ${this.projectPath}`)
        );
        return;
      }

      // Create session by cd'ing to project path first, then running cn
      const escapedProjectPath = this.projectPath.replace(/"/g, '\\"');
      const scriptCommand = `cd "${escapedProjectPath}" && cn --config "${this.configPath.replace(
        /"/g,
        '\\"'
      )}" --auto`;

      const command = [
        "screen",
        "-dmS",
        this.sessionName,
        "bash",
        "-c",
        scriptCommand,
      ];

      const process = spawn(command[0], command.slice(1), {
        stdio: "pipe",
      });

      process.on("exit", async (code) => {
        if (code === 0) {
          setTimeout(() => {
            resolve();
          }, 2000);
        } else {
          reject(new Error(`Failed to create screen session (code ${code})`));
        }
      });

      process.on("error", reject);
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
      // First, ensure session exists (will be created in project directory if needed)
      await this.ensureScreenSession();

      // Get baseline buffer state
      const baselineContent = await this.getScreenBuffer();
      const baselineLength = baselineContent.length;

      // Get script paths
      const scriptsDir = path.join(__dirname, "..", "scripts");
      const sendMessageScript = path.join(scriptsDir, "sendScreenMessage.js");
      const sendEnterScript = path.join(scriptsDir, "sendScreenEnter.js");

      // Now send the actual message (without cd command)
      // Pass todo ID or message to script
      const todoId =
        typeof messageOrTodoId === "number"
          ? messageOrTodoId.toString()
          : messageOrTodoId;
      const sendMessageProcess = spawn(
        "node",
        [sendMessageScript, this.sessionName, todoId],
        {
          stdio: "pipe",
        }
      );

      let sendStderr = "";
      sendMessageProcess.stderr.on("data", (data) => {
        sendStderr += data.toString();
      });

      sendMessageProcess.on("exit", async (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `Failed to send message (code ${code}): ${
                sendStderr || "Unknown error"
              }`
            )
          );
          return;
        }

        // Wait 500ms before sending Enter
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Send Enter using separate script
        const sendEnterProcess = spawn(
          "node",
          [sendEnterScript, this.sessionName],
          {
            stdio: "pipe",
          }
        );

        let enterStderr = "";
        sendEnterProcess.stderr.on("data", (data) => {
          enterStderr += data.toString();
        });

        sendEnterProcess.on("exit", async (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `Failed to send Enter (code ${code}): ${
                  enterStderr || "Unknown error"
                }`
              )
            );
            return;
          }

          // Wait for processing
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Get baseline after sending
          const afterSendContent = await this.getScreenBuffer();
          let lastContentLength = afterSendContent.length;

          // Poll for completion
          const startTime = Date.now();
          const pollInterval = 1000;
          let stableCount = 0;
          const requiredStableChecks = 2;

          const pollForCompletion = async () => {
            try {
              const currentContent = await this.getScreenBuffer();
              const currentLength = currentContent.length;
              const elapsed = Math.floor((Date.now() - startTime) / 1000);

              if (currentLength > lastContentLength) {
                lastContentLength = currentLength;
                stableCount = 0;
              } else {
                stableCount++;
              }

              if (stableCount >= requiredStableChecks) {
                // Extract new content
                let response = "";
                if (currentLength > baselineLength) {
                  const newContent = currentContent.slice(baselineLength);
                  response = this.cleanUIElements(newContent);
                } else {
                  response = this.cleanUIElements(currentContent);
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
                const finalContent = await this.getScreenBuffer();
                let finalResponse = "";
                if (finalContent.length > baselineLength) {
                  const newContent = finalContent.slice(baselineLength);
                  finalResponse = this.cleanUIElements(newContent);
                } else {
                  finalResponse = this.cleanUIElements(finalContent);
                }

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

        sendEnterProcess.on("error", reject);
      });

      sendMessageProcess.on("error", reject);
    });
  }
}

module.exports = { ScreenContinueConnection };
