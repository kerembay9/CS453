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

  // Create todos table if it doesn't exist
  db.run(
    `
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      audio_file_id INTEGER,
      project_name TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      code_snippet TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      complexity TEXT NOT NULL DEFAULT 'medium',
      valid BOOLEAN,
      correct BOOLEAN,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (audio_file_id) REFERENCES audio_files (id) ON DELETE CASCADE
    )
  `,
    (err) => {
      if (err) {
        console.error("Error creating todos table:", err.message);
      } else {
        console.log("Todos table ready");
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

  // Todo helper functions
  insertTodo: (
    audioFileId,
    projectName,
    title,
    description,
    codeSnippet,
    complexity
  ) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO todos (audio_file_id, project_name, title, description, code_snippet, complexity)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        [audioFileId, projectName, title, description, codeSnippet, complexity],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );

      stmt.finalize();
    });
  },

  getTodosByAudioFile: (audioFileId) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM todos WHERE audio_file_id = ? ORDER BY created_at DESC",
        [audioFileId],
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

  getTodosByProject: (projectName) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM todos WHERE project_name = ? ORDER BY created_at DESC",
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

  getTodoById: (id) => {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM todos WHERE id = ?", [id], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  updateTodo: (id, updates) => {
    return new Promise((resolve, reject) => {
      const fields = [];
      const values = [];

      Object.keys(updates).forEach((key) => {
        if (updates[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(updates[key]);
        }
      });

      if (fields.length === 0) {
        resolve(0);
        return;
      }

      fields.push("updated_at = CURRENT_TIMESTAMP");
      values.push(id);

      const stmt = db.prepare(
        `UPDATE todos SET ${fields.join(", ")} WHERE id = ?`
      );

      stmt.run(values, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });

      stmt.finalize();
    });
  },

  deleteTodo: (id) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare("DELETE FROM todos WHERE id = ?");

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
