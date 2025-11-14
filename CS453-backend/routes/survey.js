const express = require("express");
const { dbHelpers } = require("../db");

const router = express.Router();

// Validate code snippet - toggle valid boolean
router.post("/validate-code/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    if (!todo.code_snippet) {
      return res.status(400).json({ error: "No code snippet to validate" });
    }

    // Toggle the valid field: if null/false, set to true; if true, set to false
    const newValidValue = !todo.valid;

    await dbHelpers.updateTodo(todoId, { valid: newValidValue });

    res.json({
      success: true,
      valid: newValidValue,
    });
  } catch (error) {
    console.error("Validate code error:", error);
    res.status(500).json({ error: "Failed to validate code" });
  }
});

// Check correctness - toggle correct boolean
router.post("/check-correctness/:todoId", async (req, res) => {
  try {
    const { todoId } = req.params;

    const todo = await dbHelpers.getTodoById(todoId);
    if (!todo) {
      return res.status(404).json({ error: "Todo not found" });
    }

    if (!todo.code_snippet) {
      return res.status(400).json({ error: "No code snippet to check" });
    }

    // Toggle the correct field: if null/false, set to true; if true, set to false
    const newCorrectValue = !todo.correct;

    await dbHelpers.updateTodo(todoId, { correct: newCorrectValue });

    res.json({
      success: true,
      correct: newCorrectValue,
    });
  } catch (error) {
    console.error("Check correctness error:", error);
    res.status(500).json({ error: "Failed to check correctness" });
  }
});

module.exports = router;

