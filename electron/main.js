const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const { execSync } = require("child_process");

// Suppress harmless warnings
process.on("uncaughtException", (error) => {
  // Suppress sysctlbyname warnings
  if (error.message && error.message.includes("sysctlbyname")) {
    return;
  }
  console.error("Uncaught Exception:", error);
});

// Suppress console errors from DevTools (autofill warnings)
const originalConsoleError = console.error;
console.error = (...args) => {
  const message = args.join(" ");
  // Filter out harmless DevTools autofill warnings
  if (
    message.includes("Autofill.enable") ||
    message.includes("Autofill.setAddresses") ||
    message.includes("sysctlbyname")
  ) {
    return; // Suppress these warnings
  }
  originalConsoleError.apply(console, args);
};

// Find Node.js executable path
function findNodeExecutable() {
  try {
    // Common Node.js installation paths on macOS (only actual executables)
    const possiblePaths = [
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node", // Homebrew on Apple Silicon
      "/usr/bin/node",
      "/opt/nodejs/bin/node",
    ];

    // Try to find it using shell with proper PATH
    try {
      // Use shell to find node with proper environment
      const env = {
        ...process.env,
        PATH:
          process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
      };
      const nodePath = execSync("which node", {
        encoding: "utf8",
        env: env,
        shell: "/bin/bash",
      }).trim();
      if (nodePath && fs.existsSync(nodePath)) {
        console.log("Found node via which:", nodePath);
        return nodePath;
      }
    } catch (e) {
      console.log("which node failed, trying other methods");
    }

    // Try possible paths (only check actual executables)
    for (const nodePath of possiblePaths) {
      if (fs.existsSync(nodePath)) {
        // Verify it's actually executable
        try {
          fs.accessSync(nodePath, fs.constants.X_OK);
          console.log("Found node at:", nodePath);
          return nodePath;
        } catch (e) {
          console.log("Node found but not executable:", nodePath);
        }
      }
    }

    // Try to find node in common nvm locations
    const homeDir = process.env.HOME || "";
    if (homeDir) {
      try {
        const nvmVersions = fs.readdirSync(
          path.join(homeDir, ".nvm/versions/node")
        );
        if (nvmVersions.length > 0) {
          // Use the latest version
          const latestVersion = nvmVersions.sort().reverse()[0];
          const nvmNodePath = path.join(
            homeDir,
            ".nvm/versions/node",
            latestVersion,
            "bin/node"
          );
          if (fs.existsSync(nvmNodePath)) {
            // Verify it's actually executable
            try {
              fs.accessSync(nvmNodePath, fs.constants.X_OK);
              console.log("Found node via nvm:", nvmNodePath);
              return nvmNodePath;
            } catch (e) {
              console.log("NVM node found but not executable:", nvmNodePath);
            }
          }
        }
      } catch (e) {
        // nvm not found or no versions
      }
    }

    // Last resort: return null to use shell execution
    console.warn("Could not find node executable, will try with shell");
    return null;
  } catch (error) {
    console.error("Error finding node executable:", error);
    return null;
  }
}

let mainWindow;
let backendServer;
let frontendServer;
const BACKEND_PORT = 3001;
const FRONTEND_PORT = 3000;

// Start Express backend
function startBackend() {
  return new Promise((resolve, reject) => {
    // In production, use the bundled backend from extraResources
    // In development, use the local backend
    const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
    const backendPath = isDev
      ? path.join(__dirname, "..", "CS453-backend", "server.js")
      : path.join(process.resourcesPath, "CS453-backend", "server.js");
    const backendCwd = isDev
      ? path.join(__dirname, "..", "CS453-backend")
      : path.join(process.resourcesPath, "CS453-backend");

    // Check if paths exist
    if (!fs.existsSync(backendPath)) {
      const error = new Error(`Backend path does not exist: ${backendPath}`);
      console.error(error.message);
      console.error("__dirname:", __dirname);
      console.error("process.resourcesPath:", process.resourcesPath);
      console.error("app.isPackaged:", app.isPackaged);
      reject(error);
      return;
    }

    console.log("Starting backend from:", backendPath);
    console.log("Backend CWD:", backendCwd);

    const nodeExecutable = findNodeExecutable();
    console.log("Using Node.js executable:", nodeExecutable);

    const spawnOptions = {
      cwd: backendCwd,
      env: {
        ...process.env,
        PATH:
          process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
        PORT: BACKEND_PORT,
        NODE_ENV: isDev ? "development" : "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    };

    // If we found a node path, use it directly; otherwise use shell
    const backendProcess = nodeExecutable
      ? spawn(nodeExecutable, [backendPath], spawnOptions)
      : spawn("node", [backendPath], { ...spawnOptions, shell: true });

    let backendOutput = "";
    let backendError = "";

    backendProcess.stdout.on("data", (data) => {
      const output = data.toString();
      backendOutput += output;
      console.log(`Backend stdout: ${output}`);
      if (output.includes("Backend running")) {
        resolve(backendProcess);
      }
    });

    backendProcess.stderr.on("data", (data) => {
      const error = data.toString();
      backendError += error;
      console.error(`Backend stderr: ${error}`);
    });

    backendProcess.on("error", (error) => {
      console.error("Failed to start backend process:", error);
      reject(
        new Error(
          `Backend startup error: ${error.message}\n\nBackend path: ${backendPath}\nBackend CWD: ${backendCwd}\n\nError output: ${backendError}`
        )
      );
    });

    backendProcess.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `Backend process exited with code ${code}\n\nOutput: ${backendOutput}\n\nErrors: ${backendError}`
          )
        );
      }
    });

    // Give it a moment to start
    setTimeout(() => {
      if (!backendProcess.killed && backendProcess.exitCode === null) {
        // Process is still running, assume it started successfully
        resolve(backendProcess);
      } else if (backendProcess.killed) {
        reject(new Error("Backend process was killed before it could start"));
      }
    }, 3000);

    backendServer = backendProcess;
  });
}

// Start Next.js standalone server
function startFrontend() {
  return new Promise((resolve, reject) => {
    // In production, use the bundled frontend from extraResources
    // In development, use the local frontend
    const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
    const frontendPath = isDev
      ? path.join(__dirname, "..", "CS453-frontend", ".next", "standalone")
      : path.join(
          process.resourcesPath,
          "CS453-frontend",
          ".next",
          "standalone"
        );

    // Next.js standalone includes the project folder name in the path
    // Try the nested path first (production), then fall back to direct path (dev)
    let serverPath = path.join(frontendPath, "CS453-frontend", "server.js");
    if (!fs.existsSync(serverPath) && isDev) {
      // Fall back to direct path for development
      serverPath = path.join(frontendPath, "server.js");
    }

    // Check if paths exist
    if (!fs.existsSync(serverPath)) {
      const error = new Error(
        `Frontend server path does not exist: ${serverPath}`
      );
      console.error(error.message);
      console.error("Frontend path:", frontendPath);
      reject(error);
      return;
    }

    // The working directory should be where server.js is located
    const frontendCwd = path.dirname(serverPath);

    console.log("Starting frontend from:", serverPath);
    console.log("Frontend CWD:", frontendCwd);

    const nodeExecutable = findNodeExecutable();
    console.log("Using Node.js executable:", nodeExecutable);

    const spawnOptions = {
      cwd: frontendCwd,
      env: {
        ...process.env,
        PATH:
          process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
        PORT: FRONTEND_PORT,
        NODE_ENV: isDev ? "development" : "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    };

    // If we found a node path, use it directly; otherwise use shell
    const frontendProcess = nodeExecutable
      ? spawn(nodeExecutable, [serverPath], spawnOptions)
      : spawn("node", [serverPath], { ...spawnOptions, shell: true });

    let frontendOutput = "";
    let frontendError = "";

    frontendProcess.stdout.on("data", (data) => {
      const output = data.toString();
      frontendOutput += output;
      console.log(`Frontend stdout: ${output}`);
      if (
        output.includes("Ready") ||
        output.includes("started") ||
        output.includes("Local:")
      ) {
        resolve(frontendProcess);
      }
    });

    frontendProcess.stderr.on("data", (data) => {
      const error = data.toString();
      frontendError += error;
      console.error(`Frontend stderr: ${error}`);
    });

    frontendProcess.on("error", (error) => {
      console.error("Failed to start frontend process:", error);
      reject(
        new Error(
          `Frontend startup error: ${error.message}\n\nFrontend path: ${serverPath}\nFrontend CWD: ${frontendPath}\n\nError output: ${frontendError}`
        )
      );
    });

    frontendProcess.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `Frontend process exited with code ${code}\n\nOutput: ${frontendOutput}\n\nErrors: ${frontendError}`
          )
        );
      }
    });

    // Give it a moment to start
    setTimeout(() => {
      if (!frontendProcess.killed && frontendProcess.exitCode === null) {
        // Process is still running, assume it started successfully
        resolve(frontendProcess);
      } else if (frontendProcess.killed) {
        reject(new Error("Frontend process was killed before it could start"));
      }
    }, 5000);

    frontendServer = frontendProcess;
  });
}

function createWindow() {
  // Get icon path - works in both dev and production
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  const iconPath = isDev
    ? path.join(__dirname, "..", "opsidian-desktop-logo.png")
    : path.join(process.resourcesPath, "..", "opsidian-desktop-logo.png");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    icon: iconPath,
    title: "Opsidian",
  });

  // Allow navigation and redirects
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    // Allow navigation to localhost (our frontend server)
    const parsedUrl = new URL(navigationUrl);
    if (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1"
    ) {
      // Allow navigation within localhost
      return;
    }
    // Allow GitHub OAuth flow
    if (
      parsedUrl.hostname === "github.com" ||
      parsedUrl.hostname.endsWith(".github.com")
    ) {
      // Allow navigation to GitHub for OAuth
      return;
    }
    // Block navigation to other external URLs
    event.preventDefault();
  });

  // Allow redirects
  mainWindow.webContents.on("will-redirect", (event, navigationUrl) => {
    // Allow redirects to localhost
    const parsedUrl = new URL(navigationUrl);
    if (
      parsedUrl.hostname === "localhost" ||
      parsedUrl.hostname === "127.0.0.1"
    ) {
      // Allow redirect within localhost
      return;
    }
    // Allow GitHub OAuth redirects
    if (
      parsedUrl.hostname === "github.com" ||
      parsedUrl.hostname.endsWith(".github.com")
    ) {
      // Allow redirect to GitHub for OAuth
      return;
    }
    // Block redirects to other external URLs
    event.preventDefault();
  });

  // Load the frontend
  mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}/admin/login`);

  // Open DevTools only in development mode
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Filter out harmless console errors from renderer
  mainWindow.webContents.on("console-message", (event, level, message) => {
    // Suppress harmless autofill and sysctlbyname warnings
    if (
      message.includes("Autofill.enable") ||
      message.includes("Autofill.setAddresses") ||
      message.includes("sysctlbyname")
    ) {
      event.preventDefault(); // Suppress these messages
      return;
    }
  });

  // Log navigation events
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription, validatedURL) => {
      console.error(
        "Failed to load:",
        validatedURL,
        errorCode,
        errorDescription
      );
      dialog.showErrorBox(
        "Failed to Load",
        `Failed to load ${validatedURL}\n\nError: ${errorDescription} (${errorCode})`
      );
    }
  );

  // Log successful navigation for debugging
  mainWindow.webContents.on("did-navigate", (event, url) => {
    console.log("Navigated to:", url);
    // Handle OAuth callback - if we're redirected back to localhost after GitHub OAuth
    const parsedUrl = new URL(url);
    if (
      (parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname === "127.0.0.1") &&
      parsedUrl.pathname.includes("/admin/dashboard")
    ) {
      // OAuth callback completed, reload to ensure session is set
      setTimeout(() => {
        mainWindow.webContents.reload();
      }, 500);
    }
  });

  mainWindow.webContents.on("did-navigate-in-page", (event, url) => {
    console.log("In-page navigation to:", url);
  });

  // Handle new window requests (for OAuth popups if needed)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Allow GitHub OAuth to open in the same window
    if (url.includes("github.com") || url.includes("localhost")) {
      return { action: "allow" };
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    console.log("App is packaged:", app.isPackaged);
    console.log("Resources path:", process.resourcesPath);
    console.log("App path:", app.getAppPath());
    console.log("__dirname:", __dirname);

    // Start backend first
    console.log("Starting backend...");
    await startBackend();
    console.log("Backend started successfully");

    // Start frontend server
    console.log("Starting frontend...");
    await startFrontend();
    console.log("Frontend server started successfully");

    // Wait a bit for servers to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Create window
    createWindow();
  } catch (error) {
    console.error("Failed to start servers:", error);
    const errorMessage = error.message || String(error);
    dialog.showErrorBox(
      "Failed to Start Opsidian",
      `The application failed to start:\n\n${errorMessage}\n\nPlease check the console for more details.`
    );
    // Don't quit immediately, give user time to read the error
    setTimeout(() => {
      app.quit();
    }, 5000);
  }
});

app.on("window-all-closed", () => {
  // Clean up servers
  if (backendServer) {
    backendServer.kill();
  }
  if (frontendServer) {
    frontendServer.kill();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (backendServer) {
    backendServer.kill();
  }
  if (frontendServer) {
    frontendServer.kill();
  }
});
