const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_PATH = path.join(__dirname, "audio_files.db");

// Initialize database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  } else {
    console.log("Connected to SQLite database");
  }
});

// Create audio_files table if it doesn't exist
db.serialize(() => {
  db.run(
    `
    CREATE TABLE IF NOT EXISTS audio_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      transcription_text TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    )
  `,
    (err) => {
      if (err) {
        console.error("Error creating table:", err.message);
      } else {
        console.log("Audio files table ready");
      }
    }
  );
});

// Helper functions for database operations
const dbHelpers = {
  // Insert new audio file record
  insertAudioFile: (projectName, filename, filePath) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO audio_files (project_name, filename, file_path, status)
        VALUES (?, ?, ?, 'processing')
      `);

      stmt.run([projectName, filename, filePath], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });

      stmt.finalize();
    });
  },

  // Update transcription result
  updateTranscription: (id, transcriptionText, status) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        UPDATE audio_files
        SET transcription_text = ?, status = ?, processed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      stmt.run([transcriptionText, status, id], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });

      stmt.finalize();
    });
  },

  // Get audio files by project
  getAudioFilesByProject: (projectName) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM audio_files WHERE project_name = ? ORDER BY uploaded_at DESC",
        [projectName],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  },

  // Get audio file by ID
  getAudioFileById: (id) => {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM audio_files WHERE id = ?", [id], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  // Delete audio file
  deleteAudioFile: (id) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare("DELETE FROM audio_files WHERE id = ?");

      stmt.run([id], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });

      stmt.finalize();
    });
  },
};

module.exports = { db, dbHelpers };
