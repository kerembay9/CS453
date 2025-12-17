#!/usr/bin/env node

/**
 * Helper script to check if code signing is properly configured
 */

const fs = require('fs');
const { execSync } = require('child_process');

console.log('🔍 Checking code signing configuration...\n');

// Check for environment variables
const cscName = process.env.CSC_NAME;
const cscLink = process.env.CSC_LINK;
const cscKeyPassword = process.env.CSC_KEY_PASSWORD;

let signingConfigured = false;

if (cscName) {
  console.log('✅ CSC_NAME is set:', cscName);
  signingConfigured = true;
  
  // Try to verify the certificate exists
  try {
    const identities = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
    if (identities.includes(cscName)) {
      console.log('✅ Certificate found in keychain');
    } else {
      console.log('⚠️  Warning: Certificate not found in keychain');
      console.log('   Make sure the certificate name matches exactly (case-sensitive)');
    }
  } catch (error) {
    console.log('⚠️  Could not verify certificate in keychain');
  }
} else if (cscLink) {
  console.log('✅ CSC_LINK is set:', cscLink);
  if (fs.existsSync(cscLink)) {
    console.log('✅ Certificate file exists');
  } else {
    console.log('❌ Certificate file not found at:', cscLink);
  }
  
  if (cscKeyPassword) {
    console.log('✅ CSC_KEY_PASSWORD is set');
    signingConfigured = true;
  } else {
    console.log('⚠️  Warning: CSC_KEY_PASSWORD is not set');
    console.log('   You need to set CSC_KEY_PASSWORD to use the certificate file');
  }
} else {
  console.log('❌ No code signing configuration found');
  console.log('\nTo enable code signing, set one of:');
  console.log('  - CSC_NAME="Developer ID Application: Your Name (TEAM_ID)"');
  console.log('  - CSC_LINK="/path/to/certificate.p12" and CSC_KEY_PASSWORD="password"');
  console.log('\nSee CODE_SIGNING.md for detailed instructions.');
}

// Check for notarization
const appleId = process.env.APPLE_ID;
const appleAppSpecificPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const appleTeamId = process.env.APPLE_TEAM_ID;

console.log('\n📦 Notarization configuration:');
if (appleId && appleAppSpecificPassword && appleTeamId) {
  console.log('✅ Notarization is configured');
  console.log('   APPLE_ID:', appleId);
  console.log('   APPLE_TEAM_ID:', appleTeamId);
  console.log('   APPLE_APP_SPECIFIC_PASSWORD: [set]');
} else {
  console.log('⚠️  Notarization not configured (optional but recommended)');
  console.log('   Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID to enable');
}

console.log('\n' + '='.repeat(50));
if (signingConfigured) {
  console.log('✅ Code signing is configured. You can build with: npm run build');
} else {
  console.log('⚠️  Code signing is NOT configured.');
  console.log('   The build will work but the app will not be signed.');
  console.log('   See CODE_SIGNING.md for setup instructions.');
}
console.log('='.repeat(50));

