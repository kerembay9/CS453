const { exec } = require("child_process");
const { promisify } = require("util");
const { CONTINUE_CONFIG_PATH } = require("./config");

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
      errorObj.status === "RESOURCE_EXHAUSTED" ||
      (errorObj.message &&
        (errorObj.message.includes("quota") ||
          errorObj.message.includes("Quota exceeded") ||
          errorObj.message.includes("rate limit") ||
          errorObj.message.includes("Rate limit")));

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
    if (
      errorOutput.includes("quota") ||
      errorOutput.includes("Quota exceeded") ||
      errorOutput.includes("429") ||
      errorOutput.includes("RESOURCE_EXHAUSTED")
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

// Helper function to execute code using Continue.dev CLI
async function executeCodeWithContinue(codeSnippet, todo, projectPath) {
  // Build execution prompt - just pass todo content directly to Continue.dev
  const executionPrompt = `${todo.title}
${todo.description}

${codeSnippet}`;

  const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${executionPrompt}" --allow Write`;

  console.log(`[EXECUTE-CONTINUE] Continue command: ${continueCommand}`);
  // Determine timeout based on code snippet content
  let timeout = 60000; // Default 60 seconds for Continue.dev
  if (
    codeSnippet.includes("npx") ||
    codeSnippet.includes("npm install") ||
    codeSnippet.includes("yarn")
  ) {
    timeout = 600000; // 10 minutes for package installation
  } else if (
    codeSnippet.includes("npm") ||
    codeSnippet.includes("yarn") ||
    codeSnippet.includes("pnpm")
  ) {
    timeout = 120000; // 2 minutes for other npm commands
  }

  console.log(`[EXECUTE-CONTINUE] ==========================================`);
  console.log(`[EXECUTE-CONTINUE] Executing via Continue.dev CLI...`);
  console.log(`[EXECUTE-CONTINUE] Project path: ${projectPath}`);
  console.log(`[EXECUTE-CONTINUE] Todo title: ${todo.title}`);
  console.log(
    `[EXECUTE-CONTINUE] Code snippet preview: ${codeSnippet.substring(
      0,
      100
    )}...`
  );
  console.log(`[EXECUTE-CONTINUE] Full command: ${continueCommand}...`);
  console.log(`[EXECUTE-CONTINUE] Command timeout: ${timeout}ms`);

  try {
    console.log(`[EXECUTE-CONTINUE] Starting execAsync...`);
    const { stdout, stderr } = await execAsync(continueCommand, {
      timeout: timeout,
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      cwd: projectPath,
      env: {
        ...process.env,
        CI: "true",
        npm_config_yes: "true",
      },
    });

    console.log(`[EXECUTE-CONTINUE] Command executed successfully`);
    console.log(
      `[EXECUTE-CONTINUE] Stdout length: ${stdout?.length || 0} characters`
    );
    console.log(
      `[EXECUTE-CONTINUE] Stderr length: ${stderr?.length || 0} characters`
    );
    console.log(
      `[EXECUTE-CONTINUE] Stdout preview: ${
        stdout?.substring(0, 500) || "(empty)"
      }`
    );
    if (stderr) {
      console.log(`[EXECUTE-CONTINUE] Stderr: ${stderr.substring(0, 500)}`);
    }

    // Try to parse Continue.dev response as JSON
    let result;
    try {
      // Extract JSON from response
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        console.log(`[EXECUTE-CONTINUE] Found JSON in response, parsing...`);
        result = JSON.parse(jsonMatch[0]);
        console.log(
          `[EXECUTE-CONTINUE] Parsed result:`,
          JSON.stringify(result, null, 2)
        );
        console.log(`[EXECUTE-CONTINUE] Result success: ${result.success}`);
        console.log(
          `[EXECUTE-CONTINUE] Result filePath: ${result.filePath || "(null)"}`
        );
      } else {
        console.log(
          `[EXECUTE-CONTINUE] No JSON found in stdout, treating as plain text`
        );

        // If no JSON found, treat entire output as stdout
        result = {
          success: true,
          stdout: stdout,
          stderr: stderr || null,
          error: null,
          output: stdout,
        };
      }
    } catch (parseError) {
      console.error(`[EXECUTE-CONTINUE] JSON parse error:`, parseError.message);
      console.error(`[EXECUTE-CONTINUE] Parse error stack:`, parseError.stack);
      // If parsing fails, treat as success with raw output
      result = {
        success: true,
        stdout: stdout,
        stderr: stderr || null,
        error: null,
        output: stdout,
      };
    }

    const returnValue = {
      success: result.success !== false,
      stdout: result.stdout || result.output || stdout,
      stderr: result.stderr || stderr || null,
      error: result.error || null,
      errorCode: null,
      errorSignal: null,
      filePath: result.filePath || null, // Path to saved file (for code snippets)
      rawResponse: stdout,
    };

    console.log(`[EXECUTE-CONTINUE] Returning:`, {
      success: returnValue.success,
      hasStdout: !!returnValue.stdout,
      hasStderr: !!returnValue.stderr,
      filePath: returnValue.filePath,
      error: returnValue.error,
    });
    console.log(
      `[EXECUTE-CONTINUE] ==========================================`
    );

    return returnValue;
  } catch (execError) {
    console.error(
      `[EXECUTE-CONTINUE] ==========================================`
    );
    console.error(`[EXECUTE-CONTINUE] Command execution failed!`);
    console.error(`[EXECUTE-CONTINUE] Error code: ${execError.code}`);
    console.error(`[EXECUTE-CONTINUE] Error signal: ${execError.signal}`);
    console.error(`[EXECUTE-CONTINUE] Error message: ${execError.message}`);

    // Check for authentication errors
    const errorOutput =
      execError.stdout || execError.stderr || execError.message || "";

    console.error(
      `[EXECUTE-CONTINUE] Error stdout length: ${execError.stdout?.length || 0}`
    );
    console.error(
      `[EXECUTE-CONTINUE] Error stderr length: ${execError.stderr?.length || 0}`
    );
    console.error(
      `[EXECUTE-CONTINUE] Error stdout: ${
        execError.stdout?.substring(0, 1000) || "(empty)"
      }`
    );
    console.error(
      `[EXECUTE-CONTINUE] Error stderr: ${
        execError.stderr?.substring(0, 1000) || "(empty)"
      }`
    );

    // Check for quota/rate limit errors first
    const quotaError = detectQuotaError(errorOutput);
    if (quotaError) {
      console.error(`[EXECUTE-CONTINUE] Quota/rate limit error detected`);
      return {
        success: false,
        stdout: null,
        stderr: errorOutput,
        error: `${quotaError.message}. ${quotaError.details}`,
        errorCode: "QUOTA_ERROR",
        errorSignal: null,
        rawResponse: errorOutput,
        quotaInfo: {
          retryTime: quotaError.retryTime,
          quotaLimit: quotaError.quotaLimit,
        },
      };
    }

    if (
      errorOutput.includes("x-api-key") ||
      errorOutput.includes("authentication_error") ||
      errorOutput.includes("invalid")
    ) {
      console.error(`[EXECUTE-CONTINUE] Authentication error detected`);
      return {
        success: false,
        stdout: null,
        stderr: errorOutput,
        error: "Continue.dev API authentication failed",
        errorCode: "AUTH_ERROR",
        errorSignal: null,
        rawResponse: errorOutput,
      };
    }

    // Try to parse error output as JSON
    let errorResult;
    try {
      const jsonMatch = errorOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        console.log(
          `[EXECUTE-CONTINUE] Found JSON in error output, parsing...`
        );
        errorResult = JSON.parse(jsonMatch[0]);
        console.log(
          `[EXECUTE-CONTINUE] Parsed error result:`,
          JSON.stringify(errorResult, null, 2)
        );
      }
    } catch (parseErr) {
      console.error(
        `[EXECUTE-CONTINUE] Failed to parse error JSON:`,
        parseErr.message
      );
    }

    const returnValue = {
      success: false,
      stdout: execError.stdout || errorResult?.stdout || null,
      stderr: execError.stderr || errorResult?.stderr || errorOutput,
      error: errorResult?.error || execError.message || "Execution failed",
      errorCode: execError.code || null,
      errorSignal: execError.signal || null,
      rawResponse: errorOutput,
    };

    console.error(`[EXECUTE-CONTINUE] Returning error:`, {
      success: returnValue.success,
      error: returnValue.error,
      errorCode: returnValue.errorCode,
    });
    console.error(
      `[EXECUTE-CONTINUE] ==========================================`
    );

    return returnValue;
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
    const errorContext = `
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

Please analyze this error and provide a fix. The fix should be:
1. A corrected command or code snippet that addresses the error
2. An explanation of what went wrong
3. If the error is due to directory conflicts or missing prerequisites, suggest the appropriate fix

Return your response as JSON:
{
  "analysis": "Explanation of what went wrong",
  "fix": "The corrected command/code to fix the issue",
  "fixType": "command|code|manual",
  "reasoning": "Why this fix should work"
}`;

    const prompt = errorContext;
    const continueCommand = `cn --config "${CONTINUE_CONFIG_PATH}" -p "${prompt.replace(
      /"/g,
      '\\"'
    )}" --auto`;
    console.log(`[ERROR-FIX] Continue command: ${continueCommand}`);
    console.log(
      `[ERROR-FIX] Requesting fix suggestion from Continue.dev (iteration ${iterationNumber})...`
    );
    let stdout;
    try {
      const result = await execAsync(continueCommand, {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 10,
        cwd: projectPath,
        env: {
          ...process.env, // Pass all environment variables including CONTINUE_API_KEY
        },
      });
      stdout = result.stdout;
    } catch (execError) {
      const errorOutput =
        execError.stdout || execError.stderr || execError.message || "";

      // Check for quota/rate limit errors
      const quotaError = detectQuotaError(errorOutput);
      if (quotaError) {
        console.error(
          `[ERROR-FIX] Quota/rate limit error on iteration ${iterationNumber}`
        );
        // Return null to indicate no fix suggestion available (can't use LLM)
        return null;
      }

      if (
        errorOutput.includes("x-api-key") ||
        errorOutput.includes("authentication_error") ||
        errorOutput.includes("invalid")
      ) {
        console.error(
          `[ERROR-FIX] Continue.dev API authentication error on iteration ${iterationNumber}`
        );
        // Return null to indicate no fix suggestion available
        return null;
      }
      // For other errors, return null as well
      console.error(
        `[ERROR-FIX] Continue.dev error on iteration ${iterationNumber}:`,
        execError.message
      );
      return null;
    }

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
};

