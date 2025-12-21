const express = require("express");
const fs = require("fs");
const path = require("path");
const { dbHelpers } = require("../db");
const { updateConfigYaml } = require("../helpers/yamlConfig");
const { CONTINUE_CONFIG_PATH } = require("../helpers/config");

const router = express.Router();

// Get all settings
router.get("/", async (req, res) => {
  try {
    const settings = await dbHelpers.getAllSettings();
    const settingsObj = {};
    settings.forEach((setting) => {
      settingsObj[setting.key] = {
        value: setting.value,
        description: setting.description,
        updated_at: setting.updated_at,
      };
    });

    // Migration: Copy continue_api_key to gemini_api_key if gemini_api_key is empty
    if (
      settingsObj.continue_api_key?.value &&
      (!settingsObj.gemini_api_key?.value ||
        settingsObj.gemini_api_key.value === "")
    ) {
      try {
        await dbHelpers.updateSetting(
          "gemini_api_key",
          settingsObj.continue_api_key.value,
          "Gemini API key for Continue.dev"
        );
        settingsObj.gemini_api_key = {
          value: settingsObj.continue_api_key.value,
          description: "Gemini API key for Continue.dev",
          updated_at: new Date().toISOString(),
        };
        console.log("Migrated continue_api_key to gemini_api_key");
      } catch (migrationError) {
        console.error("Error migrating API key:", migrationError);
      }
    }

    res.json(settingsObj);
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({ error: "Failed to get settings" });
  }
});

// Check if config.yaml exists
router.get("/check-config", async (req, res) => {
  try {
    const exists = fs.existsSync(CONTINUE_CONFIG_PATH);
    res.json({ exists });
  } catch (error) {
    console.error("Check config error:", error);
    res.status(500).json({ error: "Failed to check config" });
  }
});

// Get a single setting
router.get("/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const setting = await dbHelpers.getSetting(key);
    if (!setting) {
      return res.status(404).json({ error: "Setting not found" });
    }
    res.json({
      key: setting.key,
      value: setting.value,
      description: setting.description,
    });
  } catch (error) {
    console.error("Get setting error:", error);
    res.status(500).json({ error: "Failed to get setting" });
  }
});

// Update settings
router.put("/", async (req, res) => {
  try {
    const settings = req.body;
    await dbHelpers.updateSettings(settings);

    // Update config.yaml based on active API provider
    const shouldUpdateConfig =
      settings.gemini_api_key !== undefined ||
      settings.openai_api_key !== undefined ||
      settings.active_api_provider !== undefined ||
      settings.continue_api_key !== undefined;

    if (shouldUpdateConfig) {
      try {
        // Get active provider
        let activeProvider = settings.active_api_provider;
        if (!activeProvider) {
          const activeProviderSetting = await dbHelpers.getSetting(
            "active_api_provider"
          );
          activeProvider = activeProviderSetting?.value || "gemini";
        }

        // Handle ollama provider (no API key needed)
        if (activeProvider === "ollama") {
          // Ollama uses a different config format with 'uses' field
          await updateConfigYaml(CONTINUE_CONFIG_PATH, {
            provider: "ollama",
            model: "gpt-oss-20b",
            apiKey: "", // No API key needed for Ollama
            name: "My Local Config",
          });
        } else {
          // Get API key for the active provider
          let apiKey = "";
          if (activeProvider === "openai") {
            apiKey = settings.openai_api_key;
            if (!apiKey) {
              const openaiKeySetting = await dbHelpers.getSetting(
                "openai_api_key"
              );
              apiKey = openaiKeySetting?.value || "";
            }
          } else {
            apiKey = settings.gemini_api_key;
            if (!apiKey) {
              const geminiKeySetting = await dbHelpers.getSetting(
                "gemini_api_key"
              );
              apiKey = geminiKeySetting?.value || "";
              if (!apiKey) {
                const continueKeySetting = await dbHelpers.getSetting(
                  "continue_api_key"
                );
                apiKey = continueKeySetting?.value || "";
              }
            }
          }

          // Validate API key is present
          if (!apiKey) {
            console.warn(
              "[SETTINGS] No API key found for provider:",
              activeProvider
            );
          } else {
            // Use safe YAML update with atomic writes
            const model =
              activeProvider === "openai"
                ? "gpt-5-mini"
                : "gemini-2.5-flash-lite";
            const modelName =
              activeProvider === "openai"
                ? "OpenAI GPT-5 mini"
                : "Gemini-flash";

            await updateConfigYaml(CONTINUE_CONFIG_PATH, {
              provider: activeProvider,
              model: model,
              apiKey: apiKey,
              name: modelName,
            });
          }
        }
      } catch (configError) {
        console.error("[SETTINGS] Error updating config.yaml:", configError);
        // Don't fail the entire request if config update fails
        // The settings are still saved in the database
      }
    }

    res.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    console.error("Update settings error:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

module.exports = router;

