const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
require("dotenv").config();


const app = express();
const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");

app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(express.json());
if (process.env.SESSION_SECRET !== undefined) {
  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Allow cookies over HTTP for localhost (needed for Electron)
        httpOnly: true, // Prevents XSS attacks
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: "lax", // CSRF protection - "lax" allows cookies on top-level redirects
        path: '/', // Ensure cookie is available for all paths
      },
    })
  );
} else {
  console.error("SESSION_SECRET is not set");
  process.exit(1);
}
app.use(passport.initialize());
app.use(passport.session());

// Require GitHub OAuth credentials
if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
  console.error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set");
  process.exit(1);
}

passport.use(
  new GitHubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL:
        process.env.GITHUB_CALLBACK_URL ||
        "http://localhost:3001/auth/github/callback",
    },
    (accessToken, refreshToken, profile, done) => {
      profile.accessToken = accessToken;
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// Authentication middleware - require user to be authenticated
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  return res.status(401).json({ error: "Authentication required" });
};

app.get("/", (req, res) => res.send("Backend is running"));

// Routes
app.use("/auth", authRoutes);
app.use("/api", projectRoutes);

app.listen(3001, () => {
  console.log("Backend running on port 3001");
  // log the environment variables
  console.log("Environment variables:", process.env);
});
