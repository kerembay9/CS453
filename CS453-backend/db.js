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

  // Create execution_history table if it doesn't exist
  db.run(
    `
    CREATE TABLE IF NOT EXISTS execution_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL,
      project_name TEXT NOT NULL,
      git_commit_hash TEXT,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (todo_id) REFERENCES todos (id) ON DELETE CASCADE
    )
  `,
    (err) => {
      if (err) {
        console.error("Error creating execution_history table:", err.message);
      } else {
        console.log("Execution history table ready");
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
        console.error("Error creating execution_iterations table:", err.message);
      } else {
        console.log("Execution iterations table ready");
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

  // Execution iterations helper functions
  insertExecutionIteration: (executionHistoryId, todoId, iterationNumber, command, errorMessage, errorStdout, errorStderr, llmSuggestion, appliedFix, status) => {
    return new Promise((resolve, reject) => {
      const stmt = db.prepare(`
        INSERT INTO execution_iterations (
          execution_history_id, todo_id, iteration_number, command,
          error_message, error_stdout, error_stderr, llm_suggestion, applied_fix, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        [executionHistoryId, todoId, iterationNumber, command, errorMessage, errorStdout, errorStderr, llmSuggestion, appliedFix, status],
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
};

module.exports = { db, dbHelpers };
