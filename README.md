# Opsidian Desktop App

Opsidian is an Electron-based desktop application that combines a Next.js frontend with an Express.js backend, providing a comprehensive development environment.

## Project Structure

```
CS453/
├── CS453-backend/          # Express.js backend server
├── CS453-frontend/          # Next.js frontend application
├── electron/                # Electron main process and configuration
├── docs/                    # Documentation website
└── dist/                    # Build output directory
```

## Prerequisites

Before building and running the application, ensure you have the following installed:

- **Node.js** (v18 or higher recommended)
- **npm** (comes with Node.js)
- **macOS** (for building the desktop app - the current build targets macOS, and we only tested in macOS too)

## Installation

1. **Clone the main repository:**
```bash
git clone https://github.com/kerembay9/CS453
cd CS453
```

2. **Clone the frontend repository:**
```bash
cd CS453-frontend
git clone https://github.com/kerembay9/CS453-frontend .
cd ..
```


3. **Install dependencies for all components:**
```bash
# Install root dependencies (Electron)
npm install

# Install backend dependencies
cd CS453-backend
npm install
cd ..

# Install frontend dependencies
cd CS453-frontend
npm install
cd ..
```

Alternatively, you can use the postinstall script which automatically installs backend and frontend dependencies:
```bash
npm install
```

This will automatically install dependencies for:
- Root project (Electron)
- Backend (`CS453-backend/`)
- Frontend (`CS453-frontend/`)

## Configuration

### Backend Environment Variables

The backend requires several environment variables. Create a `.env` file in the `CS453-backend/` directory:

```bash
cd CS453-backend
```

Create `.env` with the following variables:

```env
SESSION_SECRET=your-session-secret-here
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=http://localhost:3001/auth/github/callback
PORT=3001
NODE_ENV=development
ELEVENLABS_API_KEY=your_api_key_here
```

**Note:** You'll need to create a GitHub OAuth App to get the `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The callback URL should match the one in your `.env` file.

### Frontend Environment Variables

The frontend also requires environment variables. Create a `.env` file in the `CS453-frontend/` directory:

```bash
cd CS453-frontend
```

Create `.env` with the following variables:

```env
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key-here
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

**Note:** 
- `NEXTAUTH_URL` should match the frontend URL (default: `http://localhost:3000`)
- `NEXTAUTH_SECRET` should be a random string used for session encryption
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` should match the values used in the backend `.env` file
- The frontend is configured to connect to the backend at `http://localhost:3001`. If you need to change this, update the API configuration in `CS453-frontend/src/lib/api.js`.

## Running

### Running in Development Mode

1. **Build the frontend:**
```bash
npm run build:frontend
```


2. **Run the Electron app (in a new terminal):**
```bash
npm run electron:dev
```

This will:
- Start the Electron application
- Automatically launch the backend and frontend servers
- Open DevTools for debugging
- Load the frontend in the Electron window

## How to Test the App

Once the application is running, follow these steps to test the full functionality:

1. **Login:**
   - The app will open to the login page
   - Enter credentials:
     - **Username:** `admin`
     - **Password:** `admin`
   - Click login to access the dashboard

2. **Configure AI Provider:**
   - Navigate to **Settings** from the sidebar
   - Select an AI provider:
     - **Gemini** (Google)
     - **OpenAI** (Alternative)
   - Enter your API key for the selected provider
   - Click **Save Settings** to store the configuration

3. **Connect to GitHub:**
   - In the settings page, click **Connect to GitHub**
   - An OAuth authorization screen will open in a new window
   - Authorize the application to access your GitHub account
   - You will be redirected back to the app after successful authorization

4. **Clone a Repository:**
   - Navigate to the **Projects** section
   - Click **Add Repository** or use the repository management interface
   - Enter the repository URL or select from your GitHub repositories
   - Clone the repository to your local workspace

5. **Upload a Sound File:**
   - Navigate to the project you just cloned
   - Use the audio file upload feature
   - Select and upload a sound file (e.g., `.mp3`, `.wav`, etc.)
   - The file will be processed and stored

6. **Test the Application:**
   - With the repository cloned and sound file uploaded, you can now test the full workflow
   - Try interacting with your codebase using the AI features
   - Test the audio playback functionality
   - Verify that all features are working as expected

**Note:** Make sure you have valid API keys for your chosen AI provider before testing. 

## Port Configuration

Default ports used by the application:
- **Frontend:** `3000`
- **Backend:** `3001`
