# GitHub Pages Setup

This repository includes a GitHub Pages site in the `docs/` folder that hosts downloadable Mac builds of Opsidian.

## Setup Instructions

1. **Enable GitHub Pages:**
   - Go to your repository settings on GitHub
   - Navigate to "Pages" in the left sidebar
   - Under "Source", select "Deploy from a branch"
   - Choose "main" branch and "/docs" folder
   - Click "Save"

2. **Your site will be available at:**
   - `https://[your-username].github.io/[repository-name]/`
   - Or if you have a custom domain, configure it in the Pages settings

## What's Included

- `index.html` - Landing page with download links
- `Opsidian-1.0.0-arm64.dmg` - Apple Silicon (M1/M2/M3) build
- `Opsidian-1.0.0.dmg` - Intel Mac (x86_64) build
- `opsidian-desktop-logo.png` - Logo image

## Updating Downloads

When you build new versions:

1. Build your Electron app: `npm run build`
2. Copy the new DMG files to the `docs/` folder:
   ```bash
   cp dist/Opsidian-1.0.0-arm64.dmg docs/
   cp dist/Opsidian-1.0.0.dmg docs/
   ```
3. Update the version number in `docs/index.html` if needed
4. Commit and push the changes

## Notes

- The `.nojekyll` file ensures GitHub Pages serves the files as-is without Jekyll processing
- Make sure to keep the DMG files updated when you release new versions
- The page is responsive and works on mobile devices

