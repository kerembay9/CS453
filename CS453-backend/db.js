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
      }
    }
  );

  // Create execution_history table if it doesn't exist
  db.run(
    `
    CREATE TABLE IF NOT EXISTS execution_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      git_commit_hash TEXT,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reverted BOOLEAN DEFAULT 0,
      FOREIGN KEY (todo_id) REFERENCES todos (id) ON DELETE CASCADE
    )
  `,
    (err) => {
      if (err) {
        console.error("Error creating execution_history table:", err.message);
      } else {
        // Add reverted column if it doesn't exist (for existing databases)
        db.run(
          `ALTER TABLE execution_history ADD COLUMN reverted BOOLEAN DEFAULT 0`,
          (alterErr) => {
            // Ignore error if column already exists
            if (alterErr && !alterErr.message.includes("duplicate column")) {
              console.warn(
                "Note: reverted column may already exist:",
                alterErr.message
              );
            }
          }
        );
      }
    }
  );

  // Create execution_iterations table for tracking retry attempts and fixes
  db.run(
    `
    CREATE TABLE IF NOT EXISTS execution_iterations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_history_id INTEGER NOT NULL,
      todo_id INTEGER NOT NULL,
      iteration_number INTEGER NOT NULL,
      command TEXT NOT NULL,
      error_message TEXT,
      error_stdout TEXT,
      error_stderr TEXT,
      llm_suggestion TEXT,
      applied_fix TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (execution_history_id) REFERENCES execution_history (id) ON DELETE CASCADE,
      FOREIGN KEY (todo_id) REFERENCES todos (id) ON DELETE CASCADE
    )
  `,
    (err) => {
      if (err) {
        console.error(
          "Error creating execution_iterations table:",
          err.message
        );
      }
    }
  );

  // Create settings table for application configuration
  db.run(
    `
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
    (err) => {
      if (err) {
        console.error("Error creating settings table:", err.message);
      } else {
        // Initialize default settings
        db.run(
          `INSERT OR IGNORE INTO settings (key, value, description) VALUES 
            ('max_retries', '3', 'Maximum number of retry attempts for code execution'),
            ('continue_api_key', '', 'Continue.dev API key (Gemini/Gemini API key) - DEPRECATED: Use gemini_api_key'),
            ('gemini_api_key', '', 'Gemini API key for Continue.dev'),
            ('openai_api_key', '', 'OpenAI API key for Continue.dev'),
            ('active_api_provider', 'gemini', 'Active API provider: openai or gemini'),
            ('continue_timeout', '30000', 'Timeout for Continue.dev commands in milliseconds'),
            ('file_upload_limit_mb', '100', 'Maximum file upload size in megabytes'),
            ('n8n_webhook_url', 'http://localhost:5678/webhook-test/ec52a91a-54e0-47a2-afa3-f191c87c7043', 'N8N webhook URL for integrations')`,
          (initErr) => {
            if (initErr) {
              console.error(
                "Error initializing default settings:",
                initErr.message
              );
            }
          }
        );
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

  // Execution history helper functions
  insertExecutionHistory: (todoId, projectName, gitCommitHash) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO execution_history (todo_id, project_name, git_commit_hash)
        VALUES (?, ?, ?)
      `);

      stmt.run([todoId, projectName, gitCommitHash], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });

      stmt.finalize();
    });
  },

  getExecutionHistoryByTodoId: (todoId) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM execution_history WHERE todo_id = ? ORDER BY executed_at DESC",
        [todoId],
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

  getLatestExecutionHistoryByTodoId: (todoId) => {
    return new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM execution_history WHERE todo_id = ? ORDER BY executed_at DESC LIMIT 1",
        [todoId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  },

  getExecutionHistoryByProject: (projectName) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM execution_history WHERE project_name = ? ORDER BY executed_at DESC",
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

  updateExecutionHistory: (id, updates) => {
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

      values.push(id);

      const stmt = db.prepare(
        `UPDATE execution_history SET ${fields.join(", ")} WHERE id = ?`
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

  // Execution iterations helper functions
  insertExecutionIteration: (
    executionHistoryId,
    todoId,
    iterationNumber,
    command,
    errorMessage,
    errorStdout,
    errorStderr,
    llmSuggestion,
    appliedFix,
    status
  ) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO execution_iterations (
          execution_history_id, todo_id, iteration_number, command,
          error_message, error_stdout, error_stderr, llm_suggestion, applied_fix, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        [
          executionHistoryId,
          todoId,
          iterationNumber,
          command,
          errorMessage,
          errorStdout,
          errorStderr,
          llmSuggestion,
          appliedFix,
          status,
        ],
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

  getExecutionIterations: (executionHistoryId) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM execution_iterations WHERE execution_history_id = ? ORDER BY iteration_number ASC",
        [executionHistoryId],
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

  getExecutionIterationsByTodoId: (todoId) => {
    return new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM execution_iterations WHERE todo_id = ? ORDER BY created_at DESC",
        [todoId],
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

  // Settings helper functions
  getSetting: (key) => {
    return new Promise((resolve, reject) => {
      db.get("SELECT * FROM settings WHERE key = ?", [key], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  getAllSettings: () => {
    return new Promise((resolve, reject) => {
      db.all("SELECT * FROM settings ORDER BY key", [], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  },

  updateSetting: (key, value, description = null) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO settings (key, value, description, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          description = COALESCE(excluded.description, description),
          updated_at = CURRENT_TIMESTAMP
      `);

      stmt.run([key, value, description], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });

      stmt.finalize();
    });
  },

  updateSettings: (settings) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `);

      const promises = Object.entries(settings).map(([key, value]) => {
        return new Promise((res, rej) => {
          stmt.run([key, String(value)], function (err) {
            if (err) rej(err);
            else res(this.changes);
          });
        });
      });

      Promise.all(promises)
        .then(() => {
          stmt.finalize();
          resolve();
        })
        .catch((err) => {
          stmt.finalize();
          reject(err);
        });
    });
  },
};

module.exports = { db, dbHelpers };
