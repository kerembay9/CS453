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
    // Check if it's a git repository (check both .git directory and git rev-parse)
    const gitDir = path.join(projectPath, ".git");
    let isGitRepo = fs.existsSync(gitDir);
    
    // Also check if git commands work in this directory
    // (might be a subdirectory of a git repo)
    try {
      const { stdout: gitTopLevel } = await execAsync("git rev-parse --show-toplevel", {
        cwd: projectPath,
      });
      const topLevel = gitTopLevel.trim();
      // If git top level is the project path itself, it's a git repo
      // If it's a parent directory, we should initialize a new repo here
      if (path.resolve(topLevel) !== path.resolve(projectPath)) {
        console.log(
          `[GIT-CHECKPOINT] Git repository found in parent directory: ${topLevel}, but not in project directory: ${projectPath}`
        );
        console.log(`[GIT-CHECKPOINT] Initializing new git repository in project directory...`);
        isGitRepo = false; // Will initialize new repo
      } else {
        isGitRepo = true;
      }
    } catch (gitCheckError) {
      // Not a git repo at all
      console.log(`[GIT-CHECKPOINT] Not a git repository (git rev-parse failed)`);
      isGitRepo = false;
    }
    
    // If not a git repo, try to initialize one
    if (!isGitRepo) {
      console.log(`[GIT-CHECKPOINT] Initializing new git repository...`);
      try {
        await execAsync("git init", { cwd: projectPath });
        console.log(`[GIT-CHECKPOINT] Git repository initialized successfully`);
        
        // Configure git user if not already configured (needed for commits)
        try {
          await execAsync('git config user.email "todo-executor@system.local"', { cwd: projectPath });
          await execAsync('git config user.name "Todo Executor"', { cwd: projectPath });
        } catch (configError) {
          console.warn(`[GIT-CHECKPOINT] Failed to configure git user (may already be configured):`, configError.message);
        }
        
        // Create/update .gitignore to exclude cache files
        const gitignorePath = path.join(projectPath, ".gitignore");
        const gitignoreContent = `# Python cache files
__pycache__/
*.py[cod]
*$py.class
*.so
.Python

# Virtual environments
venv/
env/
ENV/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
`;
        try {
          if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, gitignoreContent, "utf8");
            console.log(`[GIT-CHECKPOINT] Created .gitignore file`);
          }
        } catch (gitignoreError) {
          console.warn(`[GIT-CHECKPOINT] Failed to create .gitignore:`, gitignoreError.message);
        }

        // Create initial commit with current files
        try {
          await execAsync("git add -A", { cwd: projectPath });
          await execAsync('git commit -m "Initial commit"', { cwd: projectPath });
          const { stdout: commitStdout } = await execAsync("git rev-parse HEAD", {
            cwd: projectPath,
          });
          const commitHash = commitStdout.trim();
          console.log(`[GIT-CHECKPOINT] Initial commit created: ${commitHash}`);
          return commitHash;
        } catch (initCommitError) {
          console.warn(`[GIT-CHECKPOINT] Failed to create initial commit (may be empty repo):`, initCommitError.message);
          // Return null if we can't create initial commit (empty repo)
          return null;
        }
      } catch (initError) {
        console.error(`[GIT-CHECKPOINT] Failed to initialize git repository:`, initError.message);
        return null; // Can't create checkpoint without git
      }
    }
    
    console.log(`[GIT-CHECKPOINT] Git directory found: ${gitDir}`);

    // Ensure .gitignore exists to exclude cache files
    const gitignorePath = path.join(projectPath, ".gitignore");
    const gitignoreContent = `# Python cache files
__pycache__/
*.py[cod]
*$py.class
*.so
.Python

# Virtual environments
venv/
env/
ENV/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
`;
    try {
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, gitignoreContent, "utf8");
        console.log(`[GIT-CHECKPOINT] Created .gitignore file`);
      }
    } catch (gitignoreError) {
      console.warn(`[GIT-CHECKPOINT] Failed to create/update .gitignore:`, gitignoreError.message);
    }

    // Stage all changes (gitignore will automatically exclude cache files)
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

// Helper function to get git diff between two commits or before/after execution
async function getGitDiff(projectPath, fromCommit = null) {
  console.log(
    `[GIT-DIFF] Getting diff for: ${projectPath}, from commit: ${fromCommit || "HEAD"}`
  );
  try {
    // Check if it's a git repository
    const gitDir = path.join(projectPath, ".git");
    if (!fs.existsSync(gitDir)) {
      console.log(`[GIT-DIFF] Not a git repository: ${gitDir} does not exist`);
      return null;
    }

    // Add new files with intent-to-add (git add -N) so they appear in diff
    // This doesn't actually stage them, just makes them visible in diff
    try {
      await execAsync("git add -N .", { cwd: projectPath });
      console.log(`[GIT-DIFF] Added new files with intent-to-add for diff visibility`);
    } catch (addError) {
      console.warn(`[GIT-DIFF] Failed to add new files with intent-to-add:`, addError.message);
      // Continue anyway, might still get some diff
    }

    // Get diff from commit to current state
    // Exclude __pycache__, .pyc, .pyo files and other binary/cache files
    let diffCommand;
    if (fromCommit) {
      // Diff from specific commit to current working directory
      // Use :(exclude) to exclude patterns
      diffCommand = `git diff ${fromCommit} -- . ':(exclude)__pycache__/**' ':(exclude)**/*.pyc' ':(exclude)**/*.pyo'`;
    } else {
      // Diff from HEAD to current working directory (unstaged changes)
      diffCommand = `git diff HEAD -- . ':(exclude)__pycache__/**' ':(exclude)**/*.pyc' ':(exclude)**/*.pyo'`;
    }

    console.log(`[GIT-DIFF] Running: ${diffCommand}`);
    const { stdout: diffStdout } = await execAsync(diffCommand, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    const diff = diffStdout.trim();
    if (!diff) {
      console.log(`[GIT-DIFF] No changes found`);
      return null;
    }

    console.log(`[GIT-DIFF] Diff retrieved (${diff.length} chars)`);
    return diff;
  } catch (error) {
    console.error(`[GIT-DIFF] Failed to get git diff:`, error.message);
    // If commit doesn't exist, try to get unstaged changes
    if (fromCommit) {
      try {
        console.log(`[GIT-DIFF] Trying unstaged changes instead...`);
        const { stdout: diffStdout } = await execAsync(`git diff -- . ':(exclude)__pycache__/**' ':(exclude)**/*.pyc' ':(exclude)**/*.pyo'`, {
          cwd: projectPath,
          maxBuffer: 10 * 1024 * 1024,
        });
        const diff = diffStdout.trim();
        if (diff) {
          console.log(`[GIT-DIFF] Unstaged diff retrieved (${diff.length} chars)`);
          return diff;
        }
      } catch (fallbackError) {
        console.error(`[GIT-DIFF] Fallback also failed:`, fallbackError.message);
      }
    }
    return null;
  }
}

module.exports = {
  createGitCheckpoint,
  getGitDiff,
};

