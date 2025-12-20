const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

// Try to use js-yaml if available, otherwise fall back to basic YAML generation
let yaml;
try {
  yaml = require("js-yaml");
} catch (e) {
  console.warn(
    "[YAML-CONFIG] js-yaml not installed. Using basic YAML generation. Install with: npm install js-yaml"
  );
  yaml = null;
}

/**
 * Safely update config.yaml with atomic writes
 * @param {string} configPath - Path to config.yaml file
 * @param {object} updates - Object with provider, model, apiKey, name
 * @returns {Promise<void>}
 */
async function updateConfigYaml(configPath, updates) {
  const { provider, model, apiKey, name } = updates;

  // Validate inputs (ollama doesn't need apiKey)
  if (!provider || !model) {
    throw new Error("Missing required fields: provider, model");
  }
  if (provider !== "ollama" && !apiKey) {
    throw new Error("Missing required field: apiKey (required for openai and gemini)");
  }

  if (!["openai", "gemini", "ollama"].includes(provider)) {
    throw new Error(`Invalid provider: ${provider}. Must be 'openai', 'gemini', or 'ollama'`);
  }

  // Escape API key for YAML (handle special characters)
  const escapedApiKey = apiKey.replace(/"/g, '\\"');

  let configData;

  // Read existing config if it exists
  if (fs.existsSync(configPath)) {
    try {
      const existingContent = await fsp.readFile(configPath, "utf8");

      if (yaml) {
        // Use js-yaml to parse and update
        try {
          configData = yaml.load(existingContent);
          if (!configData || typeof configData !== "object") {
            throw new Error("Invalid YAML structure");
          }
        } catch (parseError) {
          console.warn(
            "[YAML-CONFIG] Failed to parse existing YAML, creating new config:",
            parseError.message
          );
          configData = null;
        }
      } else {
        configData = null; // Fall back to regex if js-yaml not available
      }
    } catch (readError) {
      console.warn(
        "[YAML-CONFIG] Failed to read existing config:",
        readError.message
      );
      configData = null;
    }
  }

  let yamlContent;

  if (yaml && configData) {
    // Update parsed YAML structure
    configData.name = name || (provider === "ollama" ? "My Local Config" : "Opsidian Configuration");
    configData.version = configData.version || (provider === "ollama" ? "0.0.1" : "1.0");
    configData.schema = configData.schema || "v1";

    if (!configData.models || !Array.isArray(configData.models)) {
      configData.models = [];
    }

    // Update or create first model entry
    if (configData.models.length === 0) {
      if (provider === "ollama") {
        // Ollama uses 'uses' field instead of provider/model/apiKey
        configData.models.push({
          uses: `ollama/${model}`,
        });
      } else {
        configData.models.push({
          name: name || (provider === "openai" ? "OpenAI GPT-5 nano" : "Gemini-flash"),
          provider: provider,
          model: model,
          apiKey: apiKey,
          roles: ["chat", "autocomplete"],
        });
      }
    } else {
      // Update first model
      if (provider === "ollama") {
        // Ollama uses 'uses' field instead of provider/model/apiKey
        configData.models[0] = {
          uses: `ollama/${model}`,
        };
      } else {
        configData.models[0] = {
          name: name || (provider === "openai" ? "OpenAI GPT-5 nano" : "Gemini-flash"),
          provider: provider,
          model: model,
          apiKey: apiKey,
          roles: configData.models[0].roles || ["chat", "autocomplete"],
        };
      }
    }

    // Validate structure before stringifying
    try {
      yamlContent = yaml.dump(configData, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
      });
    } catch (dumpError) {
      throw new Error(`Failed to generate YAML: ${dumpError.message}`);
    }
  } else {
    // Fallback: Generate YAML manually (if js-yaml not available or parse failed)
    if (provider === "ollama") {
      // Ollama uses 'uses' field format
      const configName = name || "My Local Config";
      yamlContent = `name: ${configName}
version: 0.0.1
schema: v1
models:
  - uses: ollama/${model}
`;
    } else {
      const modelName =
        name || (provider === "openai" ? "OpenAI GPT-5 nano" : "Gemini-flash");
      yamlContent = `name: "Opsidian Configuration"
version: "1.0"
schema: v1
models:
  - name: ${modelName}
    provider: ${provider}
    model: ${model}
    apiKey: "${escapedApiKey}"
    roles:
      - chat
      - autocomplete
`;
    }
  }

  // Atomic write: write to temp file, then rename
  const tempFile = path.join(
    os.tmpdir(),
    `config-${Date.now()}-${Math.random().toString(36).substring(7)}.yaml`
  );

  try {
    // Write to temp file
    await fsp.writeFile(tempFile, yamlContent, "utf8");

    // Validate the written file by reading it back (if js-yaml available)
    if (yaml) {
      try {
        const validationContent = await fsp.readFile(tempFile, "utf8");
        const validated = yaml.load(validationContent);
        if (!validated || !validated.models || !Array.isArray(validated.models)) {
          throw new Error("Generated YAML failed validation");
        }
      } catch (validationError) {
        await fsp.unlink(tempFile).catch(() => {});
        throw new Error(`YAML validation failed: ${validationError.message}`);
      }
    }

    // Ensure config directory exists
    const configDir = path.dirname(configPath);
    await fsp.mkdir(configDir, { recursive: true });

    // Atomic rename (this is atomic on most filesystems)
    await fsp.rename(tempFile, configPath);

    console.log(`[YAML-CONFIG] Successfully updated config.yaml with ${provider} configuration`);
  } catch (writeError) {
    // Clean up temp file on error
    await fsp.unlink(tempFile).catch(() => {});
    throw new Error(`Failed to write config.yaml: ${writeError.message}`);
  }
}

/**
 * Read and parse config.yaml
 * @param {string} configPath - Path to config.yaml file
 * @returns {Promise<object|null>} - Parsed config or null if file doesn't exist
 */
async function readConfigYaml(configPath) {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = await fsp.readFile(configPath, "utf8");
    if (yaml) {
      return yaml.load(content);
    } else {
      // Basic parsing without js-yaml (very limited)
      console.warn(
        "[YAML-CONFIG] js-yaml not available, cannot parse YAML properly"
      );
      return { raw: content };
    }
  } catch (error) {
    throw new Error(`Failed to read config.yaml: ${error.message}`);
  }
}

module.exports = {
  updateConfigYaml,
  readConfigYaml,
};

