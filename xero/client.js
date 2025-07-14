const { XeroClient } = require("xero-node");
const fs = require('fs');
const path = require('path');
require("dotenv").config();

// Initialize Xero client for webhook processing (without auto-connecting)
const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  scopes: [
    "openid",
    "profile", 
    "email",
    "accounting.transactions",
    "accounting.settings",
    "offline_access"
  ],
  clockTolerance: 60
});

// Function to load tokens from tokens.json file
function loadTokensFromFile() {
  try {
    const tokensFilePath = path.join(__dirname, '..', 'tokens.json');
    if (fs.existsSync(tokensFilePath)) {
      const tokenData = fs.readFileSync(tokensFilePath, 'utf8');
      const tokens = JSON.parse(tokenData);
      console.log("📖 Tokens loaded from tokens.json");
      return tokens;
    }
  } catch (err) {
    console.error("❌ Failed to load tokens from file:", err.message);
  }
  return null;
}

// Function to initialize Xero with tokens (from file or provided)
async function ensureXeroConnection(providedTokens = null) {
  try {
    // Try to use provided tokens first, then fallback to file
    let tokens = providedTokens || loadTokensFromFile();
    
    if (!tokens || !tokens.access_token) {
      throw new Error("No valid tokens found. Please complete OAuth flow first.");
    }

    // Check if tokens are expired (basic check)
    if (tokens.expires_at && new Date() > new Date(tokens.expires_at * 1000)) {
      console.warn("⚠️ Tokens may be expired, attempting to use anyway...");
    }

    // Initialize Xero client with tokens
    await xero.initialize();
    await xero.setTokenSet({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      expires_at: tokens.expires_at
    });
    
    // Update tenants to get tenant ID
    const connections = await xero.updateTenants();
    if (!connections || connections.length === 0) {
      throw new Error("No Xero organizations found. Please check your permissions.");
    }
    
    global.tenantId = connections[0].tenantId;
    console.log("✅ Xero connection established with tenant:", global.tenantId);
    
    return connections[0].tenantId;
    
  } catch (err) {
    console.error("❌ Failed to establish Xero connection:", err.message);
    throw new Error(`Xero connection failed: ${err.message}`);
  }
}

// Function to initialize with fresh tokens (call after OAuth)
async function initializeWithTokens(tokenSet) {
  return await ensureXeroConnection(tokenSet);
}

// Function to get tenant ID with automatic connection attempt
async function getTenantId() {
  // Return existing tenant ID if available
  if (global.tenantId) {
    return global.tenantId;
  }
  
  // Try to establish connection if not available
  try {
    return await ensureXeroConnection();
  } catch (err) {
    console.error("❌ Could not get tenant ID:", err.message);
    return null;
  }
}

module.exports = { 
  xero, 
  initializeWithTokens,
  getTenantId,
  ensureXeroConnection,
  loadTokensFromFile,
  get tenantId() {
    return global.tenantId;
  }
};
