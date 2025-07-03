const { XeroClient } = require("xero-node");
require("dotenv").config();

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  scopes: "openid profile email accounting.transactions offline_access",
});

(async () => {
  await xero.initialize();
  await xero.setTokenSet({
    access_token: process.env.XERO_ACCESS_TOKEN,
    refresh_token: process.env.XERO_REFRESH_TOKEN,
    id_token: process.env.XERO_ID_TOKEN,
    expires_at: Date.now() + 3600 * 1000,
  });

  const connections = await xero.updateTenants();
  global.tenantId = connections[0].tenantId;
})();

module.exports = { xero, tenantId: global.tenantId };
