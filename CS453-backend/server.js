const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
require("dotenv").config();

const app = express();
const execAsync = promisify(exec);

app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-secret",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

const upload = multer({ dest: "uploads/" });

passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID || "dummy",
      clientSecret: process.env.GITHUB_CLIENT_SECRET || "dummy",
      callbackURL: "http://localhost:3001/auth/github/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      profile.accessToken = accessToken;
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.get("/", (req, res) => res.send("Backend is running"));

// Auth routes
app.get(
  "/auth/github",
  passport.authenticate("github", { scope: ["repo", "user"] })
);
app.get(
  "/auth/github/callback",
  passport.authenticate("github"),
  (req, res) => {
    res.redirect("http://localhost:3000/admin/dashboard");
  }
);
app.get("/auth/user", (req, res) => res.json(req.user || null));
app.post("/auth/logout", (req, res) => {
  req.logout(() => res.json({ success: true }));
});

// Clone repository
app.post("/api/clone-repo", async (req, res) => {
  const { repoUrl, repoName } = req.body;
  const projectsDir = path.join(__dirname, "projects");

  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  const repoPath = path.join(projectsDir, repoName);

  if (fs.existsSync(repoPath)) {
    return res.status(400).json({ error: "Repository already exists" });
  }

  try {
    await execAsync(`git clone ${repoUrl} "${repoPath}"`);
    res.json({ success: true, message: "Repository cloned successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to clone repository" });
  }
});

// Get projects
app.get("/api/projects", (req, res) => {
  const projectsDir = path.join(__dirname, "projects");

  if (!fs.existsSync(projectsDir)) {
    return res.json({ projects: [] });
  }

  const projects = fs.readdirSync(projectsDir).filter((item) => {
    const itemPath = path.join(projectsDir, item);
    return fs.statSync(itemPath).isDirectory();
  });

  res.json({ projects });
});

// Delete project
app.delete("/api/projects", async (req, res) => {
  const { projectName } = req.body;
  const projectPath = path.join(__dirname, "projects", projectName);

  if (fs.existsSync(projectPath)) {
    try {
      await execAsync(`rm -rf "${projectPath}"`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete project" });
    }
  } else {
    res.status(404).json({ error: "Project not found" });
  }
});

// Upload audio
app.post("/api/upload-audio", upload.single("audio"), (req, res) => {
  const { projectName } = req.body;
  const file = req.file;

  if (!file || !projectName) {
    return res.status(400).json({ error: "Missing file or project name" });
  }

  const projectPath = path.join(__dirname, "projects", projectName);
  const filePath = path.join(projectPath, file.originalname);

  try {
    fs.renameSync(file.path, filePath);
    res.json({ success: true, message: "Audio uploaded successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to upload audio" });
  }
});

app.listen(3001, () => {
  console.log("Backend running on port 3001");
});
