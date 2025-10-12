<!-- fff35e40-91bc-4691-9009-082098545ca2 3a226479-0cf3-4622-8775-5c2eb3bd433f -->
# Audio Processing & Transcription System

## Backend Changes

### 1. Setup SQLite Database

- Install `sqlite3` package in backend
- Create `/CS453-backend/db.js` to initialize SQLite database with an `audio_files` table
- Table schema: `id`, `project_name`, `filename`, `file_path`, `status` (pending/processing/completed/failed), `transcription_text`, `uploaded_at`, `processed_at`

### 2. Update Upload Audio Endpoint

**File: `/CS453-backend/routes/projects.js`**

- After moving file, create a database record with status='processing'
- Return the audio file ID to the client

### 3. Add N8N Webhook Callback Handler

**File: `/CS453-backend/routes/projects.js`**

- Create `POST /webhook/transcription-complete` endpoint
- Receives transcription results from n8n/ElevenLabs
- Updates database record with transcription text and status='completed' or 'failed'

### 4. Add Audio Files Endpoints

**File: `/CS453-backend/routes/projects.js`**

- `GET /audio-files/:projectName` - List all audio files for a project with status and transcription
- `GET /audio-file/:id` - Get specific audio file details by ID
- `DELETE /audio-file/:id` - Delete audio file and database record

## Frontend Changes

### 5. Update API Client

**File: `/CS453-frontend/src/lib/api.js`**

- Add `getAudioFiles(projectName)` function
- Add `getAudioFile(id)` function
- Add `deleteAudioFile(id)` function

### 6. Create Audio Files Component

**File: `/CS453-frontend/src/components/AudioFiles.js`**

- Display list of uploaded audio files for a project
- Show status badges (processing, completed, failed)
- Show transcription text when completed
- Add delete button for each audio file
- Add refresh button to check status updates

### 7. Update Projects Component

**File: `/CS453-frontend/src/components/Projects.js`**

- Add "View Audio Files" button for each project
- Integrate AudioFiles component (expandable view or modal)
- Show audio file count badge on each project

### To-dos

- [ ] Install sqlite3 and create database initialization module
- [ ] Modify upload-audio endpoint to save records to database
- [ ] Create webhook callback endpoint for n8n to send transcription results
- [ ] Add endpoints to list, get, and delete audio files
- [ ] Add audio file API functions to frontend api.js
- [ ] Create AudioFiles component to display and manage audio files
- [ ] Update Projects component to integrate AudioFiles viewing