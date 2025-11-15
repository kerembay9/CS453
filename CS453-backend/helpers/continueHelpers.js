const { exec } = require("child_process");
const { promisify } = require("util");
const { CONTINUE_CONFIG_PATH } = require("./config");
const { ScreenContinueConnection } = require("./screenContinue");
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

// Helper function to execute code using Continue.dev CLI via screen session
async function executeCodeWithContinue(codeSnippet, todo, projectPath) {
  // Build execution prompt - just pass todo content directly to Continue.dev
  // Note: This is a one-way communication with an agentic AI - execute directly without asking follow-up questions
  const executionPrompt = `CRITICAL INSTRUCTIONS - READ CAREFULLY:
1. This is a ONE-WAY communication. You are an agentic AI that MUST execute tasks directly.
2. DO NOT ask questions. DO NOT ask for confirmation. DO NOT ask "Would you like me to..." or similar.
3. If you encounter any issues (Node.js version, missing dependencies, etc.), handle them automatically:
   - For Node.js version issues: Use the current Node.js version or install the required version automatically
   - For missing dependencies: Install them automatically
   - For configuration issues: Configure automatically using sensible defaults
4. Execute the task immediately without any user interaction.

TASK TO EXECUTE:
${todo.title}
${todo.description}

${codeSnippet}

Remember: Execute immediately. No questions. No confirmations. Just do it.`;

  // Get timeout from database settings, default to 5 minutes (300000ms)
  let timeout = 300000;
  try {
    const timeoutSetting = await dbHelpers.getSetting("continue_timeout");
    if (timeoutSetting && timeoutSetting.value) {
      timeout = parseInt(timeoutSetting.value, 10) || 300000;
    }
  } catch (error) {
    console.warn("Failed to get continue_timeout setting, using default:", error);
  }

  try {
    // Create screen connection for this project
    const connection = new ScreenContinueConnection(
      CONTINUE_CONFIG_PATH,
      projectPath
    );

    // Session is created at server startup, just verify it exists
    await connection.ensureScreenSession();

    const result = await connection.sendMessageAndWait(
      todo.id, // Pass todo ID instead of message
      timeout
    );

    const stdout = result.stdout || "";

    // Try to parse Continue.dev response as JSON
    let parsedResult;
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResult = JSON.parse(jsonMatch[0]);
      } else {
        parsedResult = null;
      }
    } catch (parseError) {
      parsedResult = null;
    }

    return {
      success: result.success && parsedResult?.success !== false,
      stdout:
        parsedResult?.stdout || parsedResult?.output || result.stdout || stdout,
      stderr: parsedResult?.stderr || result.stderr || null,
      error: parsedResult?.error || result.error || null,
      errorCode: null,
      errorSignal: null,
      filePath: parsedResult?.filePath || null,
      rawResponse: result.rawResponse || stdout,
    };
  } catch (error) {
    const errorOutput = error.message || "";

    // Check for quota/rate limit errors first
    const quotaError = detectQuotaError(errorOutput);
    if (quotaError) {
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

    return {
      success: false,
      stdout: null,
      stderr: errorOutput,
      error: error.message || "Execution failed",
      errorCode: null,
      errorSignal: null,
      rawResponse: errorOutput,
    };
  }
}

// Helper function to get error fix suggestion from Continue.dev via screen session
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

    console.log(
      `[ERROR-FIX] Requesting fix suggestion from Continue.dev (iteration ${iterationNumber})...`
    );

    // Create screen connection for this project
    const connection = new ScreenContinueConnection(
      CONTINUE_CONFIG_PATH,
      projectPath
    );

    // Session is created at server startup, just verify it exists
    await connection.ensureScreenSession();

    let result;
    try {
      result = await connection.sendMessageAndWait(errorContext, 30000);
    } catch (error) {
      const errorOutput = error.message || "";

      // Check for quota/rate limit errors
      const quotaError = detectQuotaError(errorOutput);
      if (quotaError) {
        console.error(
          `[ERROR-FIX] Quota/rate limit error on iteration ${iterationNumber}`
        );
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
};
