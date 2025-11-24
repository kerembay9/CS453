const express = require("express");
const cors = require("cors");
const session = require("express-session");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
require("dotenv").config();

const { ScreenContinueConnection } = require("./helpers/screenContinue");
const { CONTINUE_CONFIG_PATH } = require("./helpers/config");

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
        secure: process.env.NODE_ENV === "production", // HTTPS only in production
        httpOnly: true, // Prevents XSS attacks
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: "lax", // CSRF protection
      },
    })
  );
} else {
  console.error("SESSION_SECRET is not set");
  process.exit(1);
}
app.use(passport.initialize());
app.use(passport.session());

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

// Routes
app.use("/auth", authRoutes);
app.use("/api", projectRoutes);

app.listen(3001, () => {
  console.log("Backend running on port 3001");
  console.log(
    "Screen session 'opsidian-continue' will be created per-project when executing todos"
  );
});
