const express = require("express");
const { XeroClient } = require("xero-node");
const fs = require('fs');
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

    // Try to update tenants with better error handling
    try {
      console.log("🔄 Fetching tenant information...");
      await xero.updateTenants();
      
      // ✅ Log Them Yourself (Manually)
      console.log("Access Token:", xero.readTokenSet().access_token);
      console.log("Refresh Token:", xero.readTokenSet().refresh_token);
      console.log("ID Token:", xero.readTokenSet().id_token);
      
      const tenantId = xero.tenants[0]?.tenantId;
      console.log("🏢 Tenant ID:", tenantId);
      console.log("🏢 Number of tenants:", xero.tenants.length);

      // 💾 Save tokens to JSON file (quick hack for testing)
      const tokenData = {
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        id_token: tokenSet.id_token,
        tenant_id: tenantId,
        expires_at: tokenSet.expires_at,
        timestamp: new Date().toISOString()
      };
      
      try {
        fs.writeFileSync('tokens.json', JSON.stringify(tokenData, null, 2));
        console.log("💾 Tokens saved to tokens.json");
      } catch (fileErr) {
        console.error("❌ Failed to save tokens to file:", fileErr.message);
      }
      
      // Initialize the Xero client with fresh tokens for other modules
      const { initializeWithTokens } = require("../xero/client");
      await initializeWithTokens(xero.readTokenSet());
      
      res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>✅ OAuth Success!</h2>
            <p><strong>Access Token:</strong> ${tokenSet.access_token ? 'Received' : 'Missing'}</p>
            <p><strong>Refresh Token:</strong> ${tokenSet.refresh_token ? 'Received' : 'Missing'}</p>
            <p><strong>Tenant ID:</strong> ${tenantId || 'Not available'}</p>
            <p><strong>Tenants:</strong> ${xero.tenants.length}</p>
            <p><strong>Tokens Saved:</strong> Yes (tokens.json)</p>
            <p>Check your terminal for full details.</p>
            <hr>
            <p><a href="/oauth/auth">🔄 Try again</a> | <a href="/oauth/status">📊 Check Status</a></p>
          </body>
        </html>
      `);
      
    } catch (tenantErr) {
      console.warn("⚠️ Could not fetch tenant information:", tenantErr.message);
      console.log("💡 Tokens are still valid, but tenant access may be limited");
      
      // Still save tokens even if tenant fetch fails
      const tokenData = {
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        id_token: tokenSet.id_token,
        tenant_id: null,
        expires_at: tokenSet.expires_at,
        timestamp: new Date().toISOString(),
        tenant_error: tenantErr.message
      };
      
      try {
        fs.writeFileSync('tokens.json', JSON.stringify(tokenData, null, 2));
        console.log("💾 Tokens saved to tokens.json (without tenant info)");
      } catch (fileErr) {
        console.error("❌ Failed to save tokens to file:", fileErr.message);
      }
      
      res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>⚠️ Partial Success</h2>
            <p><strong>Access Token:</strong> ${tokenSet.access_token ? 'Received' : 'Missing'}</p>
            <p><strong>Refresh Token:</strong> ${tokenSet.refresh_token ? 'Received' : 'Missing'}</p>
            <p><strong>Issue:</strong> Could not fetch organization details</p>
            <p><strong>Reason:</strong> ${tenantErr.message}</p>
            <p><strong>Tokens Saved:</strong> Yes (tokens.json)</p>
            <p>Your tokens are valid, but you may need additional permissions.</p>
            <hr>
            <p><a href="/oauth/auth">🔄 Try again</a> | <a href="/oauth/status">📊 Check Status</a></p>
          </body>
        </html>
      `);
    }
    
    // Reset auth flag on successful callback
    isAuthInProgress = false;
    
  } catch (err) {
    isAuthInProgress = false;
    console.error("❌ OAuth callback failed:", err);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>❌ OAuth Failed</h2>
          <p><strong>Error:</strong> ${err.message}</p>
          <pre>${JSON.stringify(err, null, 2)}</pre>
          <hr>
          <p><a href="/oauth/auth">🔄 Try again</a></p>
        </body>
      </html>
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