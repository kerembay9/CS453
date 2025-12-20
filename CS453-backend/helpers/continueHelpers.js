const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { CONTINUE_CONFIG_PATH } = require("./config");
const { dbHelpers } = require("../db");

const execAsync = promisify(exec);

// Helper function to detect and format quota/rate limit errors
function detectQuotaError(errorOutput) {
  if (!errorOutput) return null;

  try {
    // Try to parse as JSON (might be nested)
    let parsed;
    try {
      parsed = JSON.parse(errorOutput);
    } catch {
      // Try to extract JSON from the output
      const jsonMatch = errorOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return null;
      }
    }

    // Check if it's a quota error
    let errorObj = null;

    // Check various possible structures
    if (parsed.status === "error" && parsed.message) {
      try {
        const messageData = JSON.parse(parsed.message);
        if (Array.isArray(messageData) && messageData[0]?.error) {
          errorObj = messageData[0].error;
        } else if (messageData.error) {
          errorObj = messageData.error;
        }
      } catch {
        // If message isn't JSON, check if parsed itself has error
        if (parsed.error) {
          errorObj = parsed.error;
        }
      }
    } else if (parsed.error) {
      errorObj = parsed.error;
    }

    if (!errorObj) return null;

    // Check for quota/rate limit indicators
    const isQuotaError =
      errorObj.code === 429 ||
      errorObj.status === 429 ||
      errorObj.status === "RESOURCE_EXHAUSTED" ||
      errorObj.statusCode === 429 ||
      (errorObj.message &&
        (errorObj.message.includes("quota") ||
          errorObj.message.includes("Quota exceeded") ||
          errorObj.message.includes("rate limit") ||
          errorObj.message.includes("Rate limit") ||
          errorObj.message.includes("429")));

    if (!isQuotaError) return null;

    // Extract useful information
    let retryTime = null;
    let quotaLimit = null;
    let quotaMetric = null;

    // Extract retry time
    if (errorObj.details) {
      const retryInfo = errorObj.details.find(
        (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
      );
      if (retryInfo?.retryDelay) {
        retryTime = retryInfo.retryDelay;
      }

      // Extract quota information
      const quotaFailure = errorObj.details.find(
        (d) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
      );
      if (quotaFailure?.violations?.[0]) {
        quotaMetric = quotaFailure.violations[0].quotaMetric;
        quotaLimit = quotaFailure.violations[0].quotaValue;
      }
    }

    // Format user-friendly message
    let message = "LLM API quota limit reached";

    if (errorObj.message) {
      // Extract the main message from the error
      const mainMessage = errorObj.message.split("\n")[0];
      if (mainMessage.includes("quota") || mainMessage.includes("Quota")) {
        message = mainMessage;
      }
    }

    const details = [];
    if (quotaLimit) {
      details.push(`Daily limit: ${quotaLimit} requests`);
    }
    if (retryTime) {
      // Parse retry time (format: "20s" or "20.660733015s")
      const retryMatch = retryTime.match(/(\d+(?:\.\d+)?)s?/);
      if (retryMatch) {
        const seconds = Math.ceil(Number.parseFloat(retryMatch[1]));
        details.push(`Please retry in approximately ${seconds} seconds`);
      } else {
        details.push(`Please retry later`);
      }
    } else {
      details.push("Please try again later");
    }

    return {
      isQuotaError: true,
      message: message,
      details: details.join(". "),
      retryTime: retryTime,
      quotaLimit: quotaLimit,
      rawError: errorObj,
    };
  } catch (err) {
    // If parsing fails, check for common quota error strings
    // Also check for "Status: 429" pattern which appears in API responses
    if (
      errorOutput.includes("quota") ||
      errorOutput.includes("Quota exceeded") ||
      errorOutput.includes("429") ||
      errorOutput.includes("Status: 429") ||
      errorOutput.includes("RESOURCE_EXHAUSTED") ||
      /Status:\s*429/.test(errorOutput)
    ) {
      return {
        isQuotaError: true,
        message: "LLM API quota limit reached",
        details: "Please try again later",
        retryTime: null,
        quotaLimit: null,
        rawError: null,
      };
    }
    return null;
  }
}

/**
 * Execute Continue CLI directly using the new simple I/O mode
 * This replaces the screen session approach with a direct CLI call
 */
async function executeContinueCLI(prompt, projectPath, timeout = 300000) {
  return new Promise((resolve, reject) => {
    // Path to the Continue CLI
    // From CS453-backend/helpers to CS453-backend/continue
    const continueCliPath = path.join(
      __dirname,
      "..",
      "continue"
    );

    // Build absolute path to config file (in the continue directory)
    const configFilePath = path.join(continueCliPath, "config.yaml");

    // Build the command as a shell string
    // Strategy: Pass prompt via stdin to avoid shell escaping issues
    // The CLI supports reading from stdin, which is much safer for long prompts with special characters
    const escapedCliPath = continueCliPath
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$");
    const escapedConfigPath = configFilePath
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$");

    // Build shell command
    // Strategy: Change to project directory, then run npm start from CLI directory
    // The CLI uses process.cwd() which will be where Node.js process runs from
    const escapedProjectPath = projectPath
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$");

    // Change to project directory, then run node directly with absolute paths
    // This ensures the config path is always absolute and works regardless of working directory
    // We use node directly instead of npm start to have full control over the config path
    const indexPath = path.join(continueCliPath, "index.js");
    
    // Build command arguments
    // Strategy: For very long prompts, write to temp file and reference it
    // For shorter prompts, use positional argument
    // IMPORTANT: Use --print flag for non-interactive output
    const nodeArgs = [
      indexPath,
      "--config",
      configFilePath,
      "--auto", // Enable auto mode to allow all file modifications without permission prompts
      "--print", // Print response and exit (non-interactive mode) - REQUIRED for getting output
      "--silent", // Strip tags and excess whitespace from output
    ];
    
    let promptFile = null;
    let cleanupPromptFile = null;
    
    // If prompt is very long (>10000 chars), use temp file to avoid command-line limits
    if (prompt && prompt.trim()) {
      if (prompt.length > 10000) {
        // Write prompt to temp file
        try {
          promptFile = path.join(os.tmpdir(), `continue-prompt-${Date.now()}-${Math.random().toString(36).substring(7)}.txt`);
          fs.writeFileSync(promptFile, prompt, 'utf8');
          console.log(`[CLI] Prompt written to temp file: ${promptFile} (${prompt.length} chars)`);
          
          // Add file path as argument (Continue CLI might read from file)
          // Or add prompt content directly if CLI doesn't support file input
          nodeArgs.push(prompt);
          
          // Cleanup function
          cleanupPromptFile = () => {
            try {
              if (fs.existsSync(promptFile)) {
                fs.unlinkSync(promptFile);
                console.log(`[CLI] Cleaned up temp prompt file: ${promptFile}`);
              }
            } catch (err) {
              console.warn(`[CLI] Failed to cleanup temp file: ${err.message}`);
            }
          };
        } catch (err) {
          console.error(`[CLI] Failed to write prompt to temp file:`, err);
          // Fallback to positional argument
          nodeArgs.push(prompt);
        }
      } else {
        // Short prompt, use positional argument directly
        console.log(`[CLI] Adding prompt as positional argument (${prompt.length} chars)`);
        nodeArgs.push(prompt);
      }
      
      console.log(`[CLI] Prompt details:`, {
        promptLength: prompt.length,
        promptPreview: prompt.substring(0, 300),
        transcriptionInPrompt: prompt.includes("TRANSCRIPTION:") || false,
        transcriptionStartIndex: prompt.indexOf("TRANSCRIPTION:"),
        hasTranscriptionContent: prompt.indexOf("TRANSCRIPTION:") !== -1 && 
                                 prompt.indexOf("CODEBASE CONTEXT:") !== -1 &&
                                 prompt.substring(prompt.indexOf("TRANSCRIPTION:") + "TRANSCRIPTION:".length, 
                                                 prompt.indexOf("CODEBASE CONTEXT:")).trim().length > 0
      });
    }

    // Spawn process directly with node, avoiding shell command string
    // This ensures proper argument handling without shell escaping issues
    const shellProcess = spawn("node", nodeArgs, {
      cwd: projectPath, // Start in project directory
      env: {
        ...process.env,
        // Ensure PWD is set to project path
        PWD: projectPath,
        // Pass project path to CLI so it can change directory if needed
        CONTINUE_PROJECT_PATH: projectPath,
        // Enable debug logging for directory changes
        CONTINUE_DEBUG_DIR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
    });

    let stdout = "";
    let stderr = "";
    let timeoutId = null;
    let processCompleted = false; // Track if process actually completed
    let timeoutOccurred = false; // Track if timeout occurred

    // Log command details for debugging
    const commandStr = `node ${nodeArgs.join(" ")}`;
    console.log(
      `[CLI] Spawning process with command: ${commandStr.substring(0, 200)}...`
    );
    console.log(`[CLI] Project path: ${projectPath}`);
    console.log(`[CLI] Config path: ${configFilePath}`);
    console.log(`[CLI] Prompt length: ${prompt ? prompt.length : 0}`);
    console.log(`[CLI] Command argument count: ${nodeArgs.length}`);
    console.log(`[CLI] Last argument (prompt) length: ${nodeArgs[nodeArgs.length - 1]?.length || 0}`);
    console.log(`[CLI] Full command (first 500 chars): ${commandStr.substring(0, 500)}`);
    if (prompt) {
      console.log(`[CLI] Full prompt:\n${prompt}`);
      // Debug: Verify transcription is in the prompt
      const transcriptionSection = prompt.substring(
        prompt.indexOf("TRANSCRIPTION:") + "TRANSCRIPTION:".length,
        prompt.indexOf("CODEBASE CONTEXT:")
      );
      console.log(`[CLI] Transcription section length: ${transcriptionSection.trim().length}`);
      console.log(`[CLI] Transcription section preview: ${transcriptionSection.trim().substring(0, 200)}`);
    } else {
      console.log(`[CLI] No prompt provided`);
    }

    // Close stdin - prompt is sent as positional argument
    // Continue CLI likely reads prompt from command-line argument, not stdin
    shellProcess.stdin.end();

    // Collect stdout with real-time logging for debugging
    shellProcess.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Log to console for debugging (can be removed in production)
      console.log("[CLI stdout]", chunk);
    });

    // Collect stderr with real-time logging for debugging
    shellProcess.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      // Log to console for debugging (can be removed in production)
      console.error("[CLI stderr]", chunk);
    });

    // Handle process exit
    shellProcess.on("exit", (code, signal) => {
      processCompleted = true;
      console.log(`[CLI] Process exited with code: ${code}, signal: ${signal}`);
      console.log(
        `[CLI] stdout length: ${stdout.length}, stderr length: ${stderr.length}`
      );
      console.log(`[CLI] stdout preview: ${stdout.substring(0, 200)}`);
      console.log(`[CLI] stderr preview: ${stderr.substring(0, 200)}`);
      console.log(`[CLI] Timeout occurred: ${timeoutOccurred}`);

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // Cleanup temp file if used
      if (cleanupPromptFile) {
        cleanupPromptFile();
      }
      
      // If timeout occurred before exit, reject with timeout error
      if (timeoutOccurred) {
        console.warn(`[CLI] Process exited after timeout occurred - execution may be incomplete`);
        return reject({
          code: "TIMEOUT",
          message: `Execution timed out after ${timeout}ms (${Math.floor(timeout / 1000)}s). Process exited with code ${code} but execution may be incomplete.`,
          stdout: stdout,
          stderr: stderr,
          exitCode: code,
          signal: signal,
        });
      }

      // code is null when process was killed by a signal
      if (code === null) {
        // Check if it was killed due to quota/rate limit errors (429)
        // The CLI might crash when it hits rate limits
        const allOutput = (stdout || "") + (stderr || "");
        console.log(
          `[CLI] Checking for quota errors in output (length: ${allOutput.length})`
        );

        // Enhanced detection for 429 errors - check multiple patterns
        // Look for "Status: 429" in various formats
        const status429Matches = allOutput.match(/Status:\s*429/gi) || [];
        const requestId429Matches =
          allOutput.match(/Request ID:.*Status:\s*429/gi) || [];
        const has429Pattern =
          status429Matches.length > 0 ||
          requestId429Matches.length > 0 ||
          (allOutput.includes("429") &&
            (allOutput.includes("Status") || allOutput.includes("rate limit")));

        const quotaError = detectQuotaError(allOutput);

        if (quotaError || has429Pattern) {
          const errorCount = Math.max(
            status429Matches.length,
            requestId429Matches.length,
            (allOutput.match(/429/g) || []).length
          );
          console.log(
            `[CLI] Quota error detected - found ${errorCount} rate limit error(s)`
          );
          return reject({
            code: "QUOTA_ERROR",
            message: quotaError
              ? `${quotaError.message}. ${quotaError.details}`
              : `API rate limit/quota exceeded (Status: 429). Found ${errorCount} rate limit error(s). The process was terminated due to quota limits. Please wait a few minutes and try again.`,
            quotaInfo: quotaError
              ? {
                  retryTime: quotaError.retryTime,
                  quotaLimit: quotaError.quotaLimit,
                }
              : null,
            stdout: stdout,
            stderr: stderr,
            signal: signal,
          });
        }

        // Log the last 500 chars of output for debugging
        const lastOutput = allOutput.slice(-500);
        console.log(`[CLI] Last 500 chars of output: ${lastOutput}`);

        const signalInfo = signal
          ? ` by signal: ${signal}`
          : " (unknown signal)";
        const outputInfo =
          stdout || stderr
            ? `\nOutput so far:\n${stdout || ""}\n${stderr || ""}`
            : "";
        console.error(`[CLI] Process killed${signalInfo}`, outputInfo);
        return reject({
          code: "PROCESS_KILLED",
          message: `Process was killed${signalInfo}. This usually means the process crashed or was terminated unexpectedly.${outputInfo}`,
          stdout: stdout,
          stderr: stderr,
          signal: signal,
        });
      }

      if (code === 0) {
        // Even with exit code 0, check if execution actually completed
        // Continue CLI might exit with 0 even if interrupted or incomplete
        const allOutput = (stdout || "") + (stderr || "");
        const trimmedOutput = allOutput.trim();
        
        console.log(`[CLI] Checking execution completion (output length: ${trimmedOutput.length})`);
        
        // Check for indicators that execution was incomplete or failed
        const incompleteIndicators = [
          /execution.*incomplete/i,
          /task.*not.*completed/i,
          /interrupted/i,
          /cancelled/i,
          /timeout/i,
          /killed/i,
          /terminated/i,
          /aborted/i,
        ];
        
        const hasIncompleteIndicator = incompleteIndicators.some(pattern => 
          pattern.test(allOutput)
        );
        
        // Check if output is suspiciously empty or too short (might indicate early exit)
        // For execution tasks, we expect some output (at least confirmation or result)
        const outputTooShort = trimmedOutput.length < 10;
        
        // Check for error patterns even with exit code 0
        const errorPatterns = [
          /error.*executing/i,
          /failed.*to.*execute/i,
          /execution.*failed/i,
          /could.*not.*complete/i,
          /unable.*to.*complete/i,
        ];
        
        const hasErrorPattern = errorPatterns.some(pattern => 
          pattern.test(allOutput)
        );
        
        // Check for success indicators (positive signal that execution completed)
        const successIndicators = [
          /completed/i,
          /finished/i,
          /done/i,
          /success/i,
          /executed/i,
        ];
        
        const hasSuccessIndicator = successIndicators.some(pattern => 
          pattern.test(allOutput)
        );
        
        // If we have timeout flag set, be more strict about success
        if (timeoutOccurred) {
          console.warn(`[CLI] ⚠️ Timeout occurred before exit - execution may be incomplete`);
          return reject({
            code: "TIMEOUT",
            message: `Execution timed out but process exited with code 0. Execution may be incomplete.`,
            stdout: stdout,
            stderr: stderr,
          });
        }
        
        if (hasIncompleteIndicator || hasErrorPattern) {
          console.warn(`[CLI] ⚠️ Exit code 0 but execution appears incomplete or failed`);
          console.warn(`[CLI] Incomplete indicator: ${hasIncompleteIndicator}, Error pattern: ${hasErrorPattern}`);
          return reject({
            code: "INCOMPLETE_EXECUTION",
            message: `Process exited with code 0 but execution appears incomplete or failed. Output: ${trimmedOutput.substring(0, 500)}`,
            stdout: stdout,
            stderr: stderr,
          });
        }
        
        if (outputTooShort && !hasSuccessIndicator) {
          console.warn(`[CLI] ⚠️ Exit code 0 but output is suspiciously short (${trimmedOutput.length} chars) and no success indicator found`);
          // For execution tasks, very short output without success indicators is suspicious
          // But don't reject - some tasks might legitimately have minimal output
          // Just log it for debugging
        }
        
        if (hasSuccessIndicator) {
          console.log(`[CLI] ✅ Success indicator found in output`);
        }
        
        console.log(`[CLI] ✅ Execution completed successfully (exit code 0, output: ${trimmedOutput.length} chars)`);
        resolve({
          success: true,
          stdout: stdout.trim(),
          stderr: stderr ? stderr.trim() : null,
          error: null,
        });
      } else {
        // Check for quota errors FIRST (429 rate limit errors)
        // Combine stdout and stderr to check for quota errors
        const allOutput = (stdout || "") + (stderr || "");
        const quotaError = detectQuotaError(allOutput);
        if (
          quotaError ||
          /Status:\s*429/.test(allOutput) ||
          allOutput.includes("Status: 429")
        ) {
          return reject({
            code: "QUOTA_ERROR",
            message: quotaError
              ? `${quotaError.message}. ${quotaError.details}`
              : "API rate limit/quota exceeded (Status: 429). Please try again later.",
            quotaInfo: quotaError
              ? {
                  retryTime: quotaError.retryTime,
                  quotaLimit: quotaError.quotaLimit,
                }
              : null,
            stdout: stdout,
            stderr: stderr,
          });
        }

        // Check for authentication errors
        if (
          stderr?.includes("x-api-key") ||
          stderr?.includes("authentication_error") ||
          stderr?.includes("invalid") ||
          stdout?.includes("x-api-key") ||
          stdout?.includes("authentication_error")
        ) {
          return reject({
            code: "AUTH_ERROR",
            message: "Continue.dev API authentication failed",
            stdout: stdout,
            stderr: stderr,
          });
        }

        // Check if there's any useful error information in stdout/stderr
        const errorMessage =
          stderr || stdout || `Process exited with code ${code}`;

        return reject({
          code: "EXECUTION_ERROR",
          message: errorMessage.substring(0, 500), // Limit error message length
          stdout: stdout,
          stderr: stderr,
          exitCode: code,
          signal: signal,
        });
      }
    });

    // Handle process errors
    shellProcess.on("error", (error) => {
      console.error("[CLI] Process error:", error);
      console.error("[CLI] Error stack:", error.stack);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      // Cleanup temp file if used
      if (cleanupPromptFile) {
        cleanupPromptFile();
      }
      reject({
        code: "SPAWN_ERROR",
        message: error.message || "Failed to spawn process",
        stdout: stdout,
        stderr: stderr,
        error: error,
      });
    });

    // Handle process close (different from exit - happens after streams close)
    shellProcess.on("close", (code, signal) => {
      console.log(`[CLI] Process closed with code: ${code}, signal: ${signal}`);
    });

    // Set timeout
    // Note: LLM processing can take time, so ensure timeout is reasonable
    // Default is 5 minutes (300000ms), but complex tasks may need more
    timeoutId = setTimeout(() => {
      timeoutOccurred = true;
      console.warn(`[CLI] ⏱️ Timeout occurred after ${timeout}ms (${Math.floor(timeout / 1000)}s)`);
      console.warn(`[CLI] Process completed: ${processCompleted}, killed: ${shellProcess.killed}`);
      
      // If process already completed, don't kill it
      if (processCompleted) {
        console.log(`[CLI] Process already completed, timeout occurred but execution finished`);
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        return; // Let the exit handler deal with it
      }
      
      // Try to kill the process gracefully first
      console.log(`[CLI] Attempting to kill process gracefully (SIGTERM)...`);
      shellProcess.kill("SIGTERM");

      // Give it a moment to exit gracefully
      setTimeout(() => {
        if (!shellProcess.killed && !processCompleted) {
          console.log(`[CLI] Process still running, force killing (SIGKILL)...`);
          shellProcess.kill("SIGKILL");
        }
        // Cleanup temp file if used
        if (cleanupPromptFile) {
          cleanupPromptFile();
        }
        
        // Only reject if process hasn't completed yet
        if (!processCompleted) {
          reject({
            code: "TIMEOUT",
            message: `Execution timed out after ${timeout}ms (${Math.floor(
              timeout / 1000
            )}s). The process was terminated.`,
            stdout: stdout,
            stderr: stderr,
          });
        }
      }, 2000);
    }, timeout);
  });
}

// Helper function to execute code using Continue.dev CLI
async function executeCodeWithContinue(codeSnippet, todo, projectPath) {
  // Build execution prompt
  const executionPrompt = `CRITICAL INSTRUCTIONS - READ CAREFULLY:
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

  // Get timeout from database settings, default to 10 minutes (600000ms)
  // LLM processing can take time, especially for complex tasks that involve
  // code execution, file operations, and multiple API calls
  let timeout = 600000; // 10 minutes default
  try {
    const timeoutSetting = await dbHelpers.getSetting("continue_timeout");
    if (timeoutSetting && timeoutSetting.value) {
      timeout = parseInt(timeoutSetting.value, 10) || 600000;
    }
  } catch (error) {
    console.warn(
      "Failed to get continue_timeout setting, using default (10 minutes):",
      error
    );
  }

  try {
    const result = await executeContinueCLI(
      executionPrompt,
      projectPath,
      timeout
    );

    return {
      success: result.success,
      stdout: result.stdout || "",
      stderr: result.stderr || null,
      error: result.error || null,
      errorCode: null,
      errorSignal: null,
      filePath: null,
      rawResponse: result.stdout || "",
    };
  } catch (error) {
    const errorOutput = error.stderr || error.stdout || error.message || "";

    // Check for quota/rate limit errors first
    const quotaError = detectQuotaError(errorOutput);
    if (quotaError || error.code === "QUOTA_ERROR") {
      return {
        success: false,
        stdout: null,
        stderr: errorOutput,
        error:
          error.message || `${quotaError?.message}. ${quotaError?.details}`,
        errorCode: "QUOTA_ERROR",
        errorSignal: null,
        rawResponse: errorOutput,
        quotaInfo: error.quotaInfo || {
          retryTime: quotaError?.retryTime,
          quotaLimit: quotaError?.quotaLimit,
        },
      };
    }

    if (
      error.code === "AUTH_ERROR" ||
      errorOutput.includes("x-api-key") ||
      errorOutput.includes("authentication_error") ||
      errorOutput.includes("invalid")
    ) {
      return {
        success: false,
        stdout: null,
        stderr: errorOutput,
        error: error.message || "Continue.dev API authentication failed",
        errorCode: "AUTH_ERROR",
        errorSignal: null,
        rawResponse: errorOutput,
      };
    }

    return {
      success: false,
      stdout: null,
      stderr: errorOutput,
      error: error.message || "Execution failed",
      errorCode: error.code || null,
      errorSignal: null,
      rawResponse: errorOutput,
    };
  }
}

// Helper function to get error fix suggestion from Continue.dev
async function getErrorFixSuggestion(
  todo,
  errorMessage,
  errorStdout,
  errorStderr,
  command,
  projectPath,
  iterationNumber
) {
  try {
    const errorContext = `Please analyze this error and provide a fix. The fix should be:
1. A corrected command or code snippet that addresses the error
2. An explanation of what went wrong
3. If the error is due to directory conflicts or missing prerequisites, suggest the appropriate fix

TODO TITLE: ${todo.title}
TODO DESCRIPTION: ${todo.description}
ORIGINAL CODE/COMMAND: ${todo.code_snippet}

EXECUTION ERROR (Attempt ${iterationNumber}):
Command: ${command}
Error: ${errorMessage}
${errorStdout ? `\nStdout:\n${errorStdout}` : ""}
${errorStderr ? `\nStderr:\n${errorStderr}` : ""}

PROJECT CONTEXT:
Project: ${todo.project_name}
Working Directory: ${projectPath}

Return your response as JSON:
{
  "analysis": "Explanation of what went wrong",
  "fix": "The corrected command/code to fix the issue",
  "fixType": "command|code|manual",
  "reasoning": "Why this fix should work"
}`;

    console.log(
      `[ERROR-FIX] Requesting fix suggestion from Continue.dev (iteration ${iterationNumber})...`
    );

    let result;
    try {
      result = await executeContinueCLI(errorContext, projectPath, 30000);
    } catch (error) {
      const errorOutput = error.stderr || error.stdout || error.message || "";

      // Check for quota/rate limit errors
      const quotaError = detectQuotaError(errorOutput);
      if (quotaError || error.code === "QUOTA_ERROR") {
        console.error(
          `[ERROR-FIX] Quota/rate limit error on iteration ${iterationNumber}`
        );
        return null;
      }

      if (
        error.code === "AUTH_ERROR" ||
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid")
      ) {
        console.error(
          `[ERROR-FIX] Continue.dev API authentication error on iteration ${iterationNumber}`
        );
        return null;
      }

      console.error(
        `[ERROR-FIX] Continue.dev error on iteration ${iterationNumber}:`,
        error.message
      );
      return null;
    }

    const stdout = result.stdout || "";

    // Check stdout for authentication errors
    if (
      stdout.includes("x-api-key") ||
      stdout.includes("authentication_error") ||
      stdout.includes("invalid")
    ) {
      console.error(
        `[ERROR-FIX] Continue.dev API authentication error in response`
      );
      return null;
    }

    // Try to extract JSON from response
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const suggestion = JSON.parse(jsonMatch[0]);
        console.log(`[ERROR-FIX] Received fix suggestion from LLM`);
        return suggestion;
      } catch (parseError) {
        console.warn(`[ERROR-FIX] Failed to parse JSON, using raw response`);
        return {
          analysis: "Could not parse LLM response",
          fix: stdout.trim(),
          fixType: "command",
          reasoning: "Raw LLM response",
        };
      }
    } else {
      // Use raw response as fix
      return {
        analysis: "LLM response format unclear",
        fix: stdout.trim(),
        fixType: "command",
        reasoning: "Using raw LLM output",
      };
    }
  } catch (error) {
    console.error(`[ERROR-FIX] Failed to get fix suggestion:`, error.message);
    return null;
  }
}

module.exports = {
  detectQuotaError,
  executeCodeWithContinue,
  getErrorFixSuggestion,
  executeContinueCLI, // Export for direct use if needed
};
