const express = require("express");
const fs = require("fs");
const path = require("path");
const { dbHelpers } = require("../db");

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
        const configPath = path.join(__dirname, "../config.yaml");

        let activeProvider = settings.active_api_provider;
        if (!activeProvider) {
          const activeProviderSetting = await dbHelpers.getSetting(
            "active_api_provider"
          );
          activeProvider = activeProviderSetting?.value || "gemini";
        }

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

        if (fs.existsSync(configPath)) {
          let configContent = fs.readFileSync(configPath, "utf8");

          if (!configContent.includes('name: "Opsidian Configuration"')) {
            configContent = configContent.replace(
              /^name:\s*[^\n]+/m,
              'name: "Opsidian Configuration"'
            );
          }

          if (activeProvider === "openai") {
            configContent = configContent.replace(
              /(\s+provider:\s*)[^\n]+/,
              `$1openai`
            );
            configContent = configContent.replace(
              /(\s+model:\s*)[^\n]+/,
              `$1gpt-4.1-nano-2025-04-14`
            );
            configContent = configContent.replace(
              /(\s+- name:\s*)[^\n]+/,
              `$1OpenAI GPT-4.1 nano`
            );
          } else {
            configContent = configContent.replace(
              /(\s+provider:\s*)[^\n]+/,
              `$1gemini`
            );
            configContent = configContent.replace(
              /(\s+model:\s*)[^\n]+/,
              `$1gemini-2.0-flash-exp`
            );
            configContent = configContent.replace(
              /(\s+- name:\s*)[^\n]+/,
              `$1Gemini-flash`
            );
          }

          configContent = configContent.replace(
            /(\s+apiKey:\s*)"[^"]*"/,
            `$1"${apiKey}"`
          );

          fs.writeFileSync(configPath, configContent, "utf8");
          console.log(`Updated config.yaml with ${activeProvider} API key`);
        } else {
          const yamlContent =
            activeProvider === "openai"
              ? `name: "Opsidian Configuration"
version: "1.0"
schema: v1
models:
  - name: OpenAI GPT-4.1 nano
    provider: openai
    model: gpt-4.1-nano-2025-04-14
    apiKey: "${apiKey}"
    roles:
      - chat
      - autocomplete
`
              : `name: "Opsidian Configuration"
version: "1.0"
schema: v1
models:
  - name: Gemini-flash
    provider: gemini
    model: gemini-2.0-flash-exp
    apiKey: "${apiKey}"
    roles:
      - chat
      - autocomplete
`;
          fs.writeFileSync(configPath, yamlContent, "utf8");
          console.log(
            `Created config.yaml with ${activeProvider} configuration`
          );
        }
      } catch (configError) {
        console.error("Error updating config.yaml:", configError);
      }
    }

    res.json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    console.error("Update settings error:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

module.exports = router;

