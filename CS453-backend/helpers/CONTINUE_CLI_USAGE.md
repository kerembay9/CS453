# Continue CLI Integration Guide

## Overview

The backend now uses the updated Continue CLI with simple I/O mode. This replaces the previous screen session approach with a direct CLI call.

## How It Works

The `executeContinueCLI()` function:
1. Calls the Continue CLI directly using `npm run dev "prompt"`
2. Runs in the project directory (so commands execute in the right context)
3. Returns only the clean response (no debug logs, no UI elements)
4. Handles errors, quota limits, and authentication issues

## Usage

### Basic Usage

```javascript
const { executeContinueCLI } = require('./helpers/continueHelpers');

const prompt = "Your prompt here";
const projectPath = "/path/to/project";
const timeout = 300000; // 5 minutes

try {
  const result = await executeContinueCLI(prompt, projectPath, timeout);
  console.log("Response:", result.stdout);
} catch (error) {
  console.error("Error:", error.message);
  if (error.code === "QUOTA_ERROR") {
    console.log("Quota info:", error.quotaInfo);
  }
}
```

### Using with Todo Execution

The `executeCodeWithContinue()` function is already integrated and works the same way as before:

```javascript
const { executeCodeWithContinue } = require('./helpers/continueHelpers');

const result = await executeCodeWithContinue(
  todo.code_snippet,
  todo,
  projectPath
);

if (result.success) {
  console.log("Output:", result.stdout);
} else {
  console.error("Error:", result.error);
}
```

## Configuration

The CLI uses the config file specified in `helpers/config.js`:
- `CONTINUE_CONFIG_PATH` - Path to the Continue config.yaml file

## Advantages Over Screen Session Approach

1. **Simpler**: Direct process execution, no screen session management
2. **More Reliable**: No screen buffer parsing or UI element cleaning
3. **Cleaner Output**: Only the response, no debug logs or UI artifacts
4. **Easier to Debug**: Standard stdout/stderr capture
5. **Better Error Handling**: Direct access to process errors

## Error Handling

The function handles:
- **Quota Errors**: Detects API quota/rate limit errors and provides retry information
- **Authentication Errors**: Detects API key/authentication failures
- **Execution Errors**: Standard process execution errors
- **Timeouts**: Configurable timeout (default 5 minutes)

## Path Configuration

The CLI path is automatically calculated from the backend location:
- Backend: `CS453-backend/helpers/`
- CLI: `continue/extensions/cli/`
- Relative path: `../../continue/extensions/cli`

If your folder structure is different, update the path in `executeContinueCLI()`.

