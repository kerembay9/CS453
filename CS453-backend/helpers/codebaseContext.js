const fsp = require("fs/promises");
const path = require("path");

// Helper function to build codebase context
async function buildCodebaseContext(projectPath) {
  try {
    const context = {
      projectName: path.basename(projectPath),
      fileTree: [],
      keyFiles: {},
    };

    // Read directory tree
    async function readDir(dirPath, relativePath = "") {
      const items = await fsp.readdir(dirPath, { withFileTypes: true });

      for (const item of items) {
        const itemPath = path.join(dirPath, item.name);
        const relativeItemPath = path.join(relativePath, item.name);

        // Skip common directories to ignore
        if (
          item.isDirectory() &&
          (item.name === "node_modules" ||
            item.name === ".git" ||
            item.name === "dist" ||
            item.name === "build" ||
            item.name === ".next" ||
            item.name === "coverage")
        ) {
          continue;
        }

        if (item.isDirectory()) {
          context.fileTree.push({
            type: "directory",
            name: item.name,
            path: relativeItemPath,
          });
          await readDir(itemPath, relativeItemPath);
        } else {
          context.fileTree.push({
            type: "file",
            name: item.name,
            path: relativeItemPath,
            size: (await fsp.stat(itemPath)).size,
          });
        }
      }
    }

    await readDir(projectPath);

    // Identify and read key files
    const keyFilePatterns = [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "README.md",
      "index.js",
      "index.ts",
      "main.js",
      "app.js",
      "server.js",
      "config.js",
      "webpack.config.js",
      "next.config.js",
      "tailwind.config.js",
      "tsconfig.json",
      "jsconfig.json",
      ".env",
      ".env.example",
    ];

    for (const file of context.fileTree) {
      if (
        file.type === "file" &&
        (keyFilePatterns.includes(file.name) ||
          file.name.endsWith(".js") ||
          file.name.endsWith(".ts") ||
          file.name.endsWith(".jsx") ||
          file.name.endsWith(".tsx"))
      ) {
        // Limit file size to avoid huge files
        if (file.size < 100000) {
          // 100KB limit
          try {
            const content = await fsp.readFile(
              path.join(projectPath, file.path),
              "utf8"
            );
            context.keyFiles[file.path] = content.substring(0, 5000); // Limit content to 5KB per file
          } catch (err) {
            console.warn(`Could not read file ${file.path}:`, err.message);
          }
        }
      }
    }

    return context;
  } catch (error) {
    console.error("Error building codebase context:", error);
    return {
      projectName: path.basename(projectPath),
      fileTree: [],
      keyFiles: {},
      error: error.message,
    };
  }
}

module.exports = {
  buildCodebaseContext,
};

