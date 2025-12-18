#!/bin/bash

echo "Clearing Electron cache for Opsidian..."

# Application Support directory (contains cookies, localStorage, etc.)
APP_SUPPORT="$HOME/Library/Application Support/Opsidian"
if [ -d "$APP_SUPPORT" ]; then
    echo "Removing: $APP_SUPPORT"
    rm -rf "$APP_SUPPORT"
    echo "✓ Application Support cleared"
else
    echo "⚠ Application Support directory not found"
fi

# Cache directory
CACHE_DIR="$HOME/Library/Caches/Opsidian"
if [ -d "$CACHE_DIR" ]; then
    echo "Removing: $CACHE_DIR"
    rm -rf "$CACHE_DIR"
    echo "✓ Cache directory cleared"
else
    echo "⚠ Cache directory not found"
fi

# Preferences (optional - only if you want to reset all preferences)
# PREFERENCES="$HOME/Library/Preferences/com.opsidian.app.plist"
# if [ -f "$PREFERENCES" ]; then
#     echo "Removing preferences (optional)"
#     rm -f "$PREFERENCES"
# fi

echo ""
echo "✅ Electron cache cleared! Restart the app to see changes."
