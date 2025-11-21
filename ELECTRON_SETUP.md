# Electron Setup for Opsidian

This guide explains how to build Opsidian as a standalone Mac application using Electron.

## Prerequisites

- Node.js (v18 or higher)
- npm
- macOS (for building Mac apps)

## Setup Steps

1. **Install dependencies:**

   ```bash
   npm install
   ```

   This will install Electron dependencies and also install dependencies for both backend and frontend.

2. **Build the frontend:**

   ```bash
   npm run build:frontend
   ```

   This builds the Next.js app as a static export in `CS453-frontend/out`.

3. **Test the Electron app (development):**

   ```bash
   npm run electron:dev
   ```

   This runs Electron in development mode with DevTools open.

4. **Build the Mac app:**

   ```bash
   npm run build:electron
   ```

   This creates a DMG file in the `dist` folder that you can distribute.

   Or build everything at once:

   ```bash
   npm run build
   ```

## How It Works

- **Electron main process** (`electron/main.js`):

  - Starts the Express backend server on port 3001
  - Serves the static Next.js frontend on port 3000
  - Opens a BrowserWindow pointing to the frontend

- **Backend**: Runs as a Node.js child process from Electron
- **Frontend**: Served as static files via Express

## File Structure

```
opsidian/
├── electron/
│   └── main.js          # Electron main process
├── CS453-backend/       # Express backend
├── CS453-frontend/      # Next.js frontend
│   └── out/            # Static export (generated)
├── package.json        # Root package.json with Electron config
└── dist/              # Built app (generated)
```

## Environment Variables

Make sure to set up your `.env` file in `CS453-backend/` with:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`

These will be used when the app runs.

## Distribution

After building, you'll find:

- `dist/Opsidian-<version>.dmg` - Mac disk image for distribution
- `dist/mac/` - Mac app bundle

Users can install the app by:

1. Opening the DMG file
2. Dragging Opsidian to Applications folder
3. Running the app from Applications

## Troubleshooting

- **Port conflicts**: If ports 3000 or 3001 are in use, the app won't start. Close other services using these ports.
- **Build errors**: Make sure both backend and frontend dependencies are installed.
- **API errors**: Ensure the backend starts successfully - check the console output.
