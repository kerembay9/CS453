const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const execAsync = promisify(exec);

// Helper function to create git checkpoint
async function createGitCheckpoint(projectPath) {
  console.log(
    `[GIT-CHECKPOINT] Starting checkpoint creation for: ${projectPath}`
  );
  try {
    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      console.log(
        `[GIT-CHECKPOINT] Not a git repository: ${gitDir} does not exist`
      );
      return null; // Not a git repo, can't create checkpoint
    }
    console.log(`[GIT-CHECKPOINT] Git directory found: ${gitDir}`);

    // Stage all changes
    console.log(`[GIT-CHECKPOINT] Staging all changes...`);
    try {
      await execAsync("git add -A", { cwd: projectPath });
      console.log(`[GIT-CHECKPOINT] Changes staged successfully`);
    } catch (addError) {
      console.error(
        `[GIT-CHECKPOINT] Failed to stage changes:`,
        addError.message
      );
      throw addError;
    }

    // Check if there are any changes to commit
    try {
      const { stdout: statusStdout } = await execAsync(
        "git status --porcelain",
        { cwd: projectPath }
      );
      console.log(
        `[GIT-CHECKPOINT] Git status: ${statusStdout || "(no output)"}`
      );
      if (!statusStdout.trim()) {
        // No changes, get current HEAD
        console.log(
          `[GIT-CHECKPOINT] No changes to commit, getting current HEAD...`
        );
        const { stdout: headStdout } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const headHash = headStdout.trim();
        console.log(`[GIT-CHECKPOINT] Current HEAD: ${headHash}`);
        return headHash;
      }
    } catch (statusError) {
      console.log(
        `[GIT-CHECKPOINT] No commits yet, attempting initial commit...`
      );
      // No commits yet, create initial commit
      try {
        await execAsync('git commit -m "Checkpoint before todo execution"', {
          cwd: projectPath,
        });
        const { stdout: commitStdout } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const commitHash = commitStdout.trim();
        console.log(`[GIT-CHECKPOINT] Initial commit created: ${commitHash}`);
        return commitHash;
      } catch (commitError) {
        console.error(
          `[GIT-CHECKPOINT] Failed to create initial commit:`,
          commitError.message
        );
        // Can't commit (maybe no files or git not configured)
        return null;
      }
    }

    // Create a checkpoint commit
    console.log(`[GIT-CHECKPOINT] Creating checkpoint commit...`);
    try {
      await execAsync('git commit -m "Checkpoint before todo execution"', {
        cwd: projectPath,
      });
      const { stdout: commitStdout } = await execAsync("git rev-parse HEAD", {
        cwd: projectPath,
      });
      const commitHash = commitStdout.trim();
      console.log(`[GIT-CHECKPOINT] Checkpoint commit created: ${commitHash}`);
      return commitHash;
    } catch (commitError) {
      console.error(`[GIT-CHECKPOINT] Commit failed:`, commitError.message);
      // Commit failed, try to get current HEAD anyway
      try {
        const { stdout: headStdout } = await execAsync("git rev-parse HEAD", {
          cwd: projectPath,
        });
        const headHash = headStdout.trim();
        console.log(
          `[GIT-CHECKPOINT] Using current HEAD as fallback: ${headHash}`
        );
        return headHash;
      } catch (headError) {
        console.error(
          `[GIT-CHECKPOINT] Failed to get HEAD:`,
          headError.message
        );
        return null;
      }
    }
  } catch (error) {
    console.error(
      `[GIT-CHECKPOINT] Failed to create git checkpoint:`,
      error.message
    );
    console.error(`[GIT-CHECKPOINT] Error stack:`, error.stack);
    return null;
  }
}

module.exports = {
  createGitCheckpoint,
};

