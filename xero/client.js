const { XeroClient } = require("xero-node");
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

// Function to initialize with fresh tokens (call after OAuth)
async function initializeWithTokens(tokenSet) {
  await xero.initialize();
  await xero.setTokenSet(tokenSet);
  
  const connections = await xero.updateTenants();
  global.tenantId = connections[0].tenantId;
  
  return connections[0].tenantId;
}

// Function to get tenant ID (safer approach)
function getTenantId() {
  return global.tenantId || null;
}

module.exports = { 
  xero, 
  initializeWithTokens,
  getTenantId,
  get tenantId() {
    return global.tenantId;
  }
};
