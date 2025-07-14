const express = require("express");
const { XeroClient } = require("xero-node");
const fs = require('fs');
const path = require('path');
const router = express.Router();

// Add request tracking
let isAuthInProgress = false;
let lastAuthTime = 0;
const AUTH_COOLDOWN = 5000; // 5 seconds cooldown between auth requests

// ✅ Xero SDK initialization with simpler scopes
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

// 🔗 Route to trigger OAuth login
router.get("/auth", async (req, res) => {
  try {
    const now = Date.now();
    
    // Prevent rapid successive requests
    if (isAuthInProgress) {
      console.log("⚠️ Auth request already in progress, please wait...");
      return res.send("⚠️ Authorization already in progress. Please wait and try again in a few seconds.");
    }
    
    if (now - lastAuthTime < AUTH_COOLDOWN) {
      console.log("⚠️ Auth request too soon, applying cooldown...");
      return res.send("⚠️ Please wait a few seconds before trying again.");
    }
    
    isAuthInProgress = true;
    lastAuthTime = now;
    
    console.log("🔄 Starting OAuth flow...");
    const consentUrl = await xero.buildConsentUrl();
    console.log("🔗 Redirecting to:", consentUrl);
    
    res.redirect(consentUrl);
    
    // Reset the flag after a delay
    setTimeout(() => {
      isAuthInProgress = false;
    }, 10000); // 10 seconds
    
  } catch (err) {
    isAuthInProgress = false;
    console.error("❌ Error creating consent URL:", err);
    res.status(500).send("OAuth setup failed: " + err.message);
  }
});

// 🔁 Callback handler function (shared between routes)
const callbackHandler = async (req, res) => {
  try {
    console.log("📥 Received callback from Xero");
    console.log("🔍 Callback URL:", req.url);
    
    const tokenSet = await xero.apiCallback(req.url);
    
    console.log("✅ Access Token received:", tokenSet.access_token ? "Yes" : "No");
    console.log("🔁 Refresh Token received:", tokenSet.refresh_token ? "Yes" : "No");
    console.log("🧠 ID Token received:", tokenSet.id_token ? "Yes" : "No");

    if (!tokenSet.access_token) {
      return res.send(`
        <h2>❌ OAuth Failed</h2>
        <pre>Error: Access token is undefined!</pre>
        <a href="/oauth/auth">🔄 Try again</a>
      `);
    }

    // Try to update tenants with better error handling
    let tenantId = null;
    try {
      console.log("🔄 Fetching tenant information...");
      await xero.updateTenants();
      tenantId = xero.tenants[0]?.tenantId;
      console.log("🏢 Tenant ID:", tenantId);
      console.log("🏢 Number of tenants:", xero.tenants.length);
    } catch (tenantErr) {
      console.warn("⚠️ Could not fetch tenant information:", tenantErr.message);
      console.log("💡 Tokens are still valid, but tenant access may be limited");
    }

    const tokensFilePath = path.join(__dirname, '..', 'tokens.json');

    const tokenData = {
      access_token: tokenSet.access_token,
      refresh_token: tokenSet.refresh_token,
      id_token: tokenSet.id_token,
      tenant_id: tenantId,
      expires_at: tokenSet.expires_at,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(tokensFilePath, JSON.stringify(tokenData, null, 2), 'utf-8');
    console.log("💾 Tokens saved to tokens.json");

    // Initialize the Xero client with fresh tokens for other modules
    try {
      const { initializeWithTokens } = require("../xero/client");
      await initializeWithTokens(xero.readTokenSet());
    } catch (initErr) {
      console.warn("⚠️ Could not initialize Xero client:", initErr.message);
    }

    // Reset auth flag on successful callback
    isAuthInProgress = false;

    res.send(`
      <html>
        <head>
          <title>✅ OAuth Success</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 30px; }
            .success { background: #e8f5e9; padding: 20px; border-left: 6px solid #4CAF50; }
            code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
          </style>
        </head>
        <body>
          <div class="success">
            <h2>✅ OAuth Success!</h2>
            <p><strong>Access Token:</strong> <code>${tokenSet.access_token.slice(0, 12)}...${tokenSet.access_token.slice(-8)}</code></p>
            <p><strong>Refresh Token:</strong> <code>${tokenSet.refresh_token.slice(0, 12)}...${tokenSet.refresh_token.slice(-8)}</code></p>
            <p><strong>ID Token:</strong> <code>${tokenSet.id_token.slice(0, 12)}...${tokenSet.id_token.slice(-8)}</code></p>
            <p><strong>Tenant ID:</strong> <code>${tenantId || 'Not available'}</code></p>
            <p><strong>Tokens Saved:</strong> ✅ <code>tokens.json</code></p>
          </div>
          
          <br>
          <a href="/oauth/status">📊 View OAuth Status</a>
        </body>
      </html>
    `);
  } catch (err) {
    isAuthInProgress = false;
    console.error("❌ OAuth callback failed:", err);
    res.send(`
      <h2>❌ OAuth Callback Error</h2>
      <pre>${err.message}</pre>
      <a href="/oauth/auth">🔄 Try again</a>
    `);
  }
};

// 🔁 Callback route after user authorizes
router.get("/callback", callbackHandler);

// Status endpoint for OAuth
router.get("/status", (req, res) => {
  let savedTokens = null;
  
  // 📖 Read tokens from JSON file
  try {
    if (fs.existsSync('tokens.json')) {
      const tokenData = fs.readFileSync('tokens.json', 'utf8');
      savedTokens = JSON.parse(tokenData);
      console.log("📖 Tokens loaded from tokens.json");
    }
  } catch (fileErr) {
    console.error("❌ Failed to read tokens from file:", fileErr.message);
  }
  
  res.json({
    authInProgress: isAuthInProgress,
    lastAuthTime: lastAuthTime ? new Date(lastAuthTime).toISOString() : null,
    hasTokens: !!xero.readTokenSet()?.access_token,
    tenantCount: xero.tenants?.length || 0,
    savedTokens: savedTokens ? {
      hasAccessToken: !!savedTokens.access_token,
      hasRefreshToken: !!savedTokens.refresh_token,
      hasIdToken: !!savedTokens.id_token,
      tenantId: savedTokens.tenant_id,
      savedAt: savedTokens.timestamp,
      expiresAt: savedTokens.expires_at
    } : null
  });
});

module.exports = router;
module.exports.callbackHandler = callbackHandler; 