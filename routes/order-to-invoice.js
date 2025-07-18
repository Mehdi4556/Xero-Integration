const express = require("express");
const router = express.Router();
const { xero, getTenantId, ensureXeroConnection, loadTokensFromFile } = require("../xero/client");

// In-memory storage for invoice records (use a database in production)
const invoiceRecords = new Map();

// Utility function to transform order data to Xero invoice format
function transformOrderToInvoice(order) {
  // Handle different order structures
  const customer = order.customer || {};
  const billing = order.billing_address || customer.default_address || {};
  const shipping = order.shipping_address || billing;
  
  // Create contact information
  const contact = {
    name: customer.first_name && customer.last_name 
      ? `${customer.first_name} ${customer.last_name}`
      : billing.name || order.customer_name || "Walk-in Customer",
    emailAddress: order.email || customer.email || billing.email,
    ...(billing.phone && { phone: billing.phone }),
    addresses: []
  };

  // Add billing address if available
  if (billing.address1) {
    contact.addresses.push({
      addressType: "POBOX",
      addressLine1: billing.address1,
      addressLine2: billing.address2 || "",
      city: billing.city || "",
      region: billing.province || billing.state || "",
      postalCode: billing.zip || "",
      country: billing.country || ""
    });
  }

  // Transform line items
  const lineItems = (order.line_items || []).map(item => {
    // Handle custom properties for area calculation (backward compatibility)
    const props = item.properties ? Object.fromEntries(
      item.properties.map(p => [p.name, p.value])
    ) : {};

    let unitAmount = parseFloat(item.price) || 0;
    let description = item.title || item.name || "Product";
    let quantity = parseInt(item.quantity) || 1;

    // Special handling for area-based pricing (your current logic)
    if (props.Length && props.Width && props.PricePerSqFt) {
      const area = parseFloat(props.Length) * parseFloat(props.Width);
      unitAmount = area * parseFloat(props.PricePerSqFt);
      description = `${item.title} - ${props.Length}ft x ${props.Width}ft (${area.toFixed(2)} sq ft)`;
      quantity = 1;
    }

    return {
      description: description,
      quantity: quantity,
      unitAmount: unitAmount.toFixed(2),
      accountCode: "200", // Default sales account - adjust as needed
      ...(item.sku && { itemCode: item.sku }),
      ...(item.taxable && { taxType: "OUTPUT" }) // Add tax if applicable
    };
  });

  // Calculate totals
  const subtotal = lineItems.reduce((sum, item) => 
    sum + (parseFloat(item.unitAmount) * item.quantity), 0
  );
  
  const taxAmount = parseFloat(order.total_tax) || 0;
  const shippingAmount = parseFloat(order.shipping_lines?.[0]?.price || 0);
  const discountAmount = parseFloat(order.total_discounts) || 0;

  // Add shipping as line item if present
  if (shippingAmount > 0) {
    lineItems.push({
      description: "Shipping",
      quantity: 1,
      unitAmount: shippingAmount.toFixed(2),
      accountCode: "200"
    });
  }

  // Add discount as line item if present
  if (discountAmount > 0) {
    lineItems.push({
      description: "Discount",
      quantity: 1,
      unitAmount: (-discountAmount).toFixed(2),
      accountCode: "200"
    });
  }

  return {
    type: "ACCREC", // Accounts Receivable
    contact: contact,
    lineItems: lineItems,
    date: new Date().toISOString().split('T')[0], // Today's date
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
    invoiceNumber: order.order_number || order.name || `INV-${Date.now()}`,
    reference: `Order: ${order.order_number || order.id}`,
    status: "AUTHORISED", // or "DRAFT" if you want to review first
    currencyCode: order.currency || "USD",
    ...(order.note && { lineAmountTypes: "Exclusive" })
  };
}

// GET handler for Shopify webhook endpoint (for verification)
router.get("/shopify/order", (req, res) => {
  res.json({
    success: true,
    message: "Shopify webhook endpoint is active",
    method: "This endpoint accepts POST requests only",
    usage: "Send POST requests with Shopify order data to create Xero invoices",
    timestamp: new Date().toISOString()
  });
});

// Shopify webhook endpoint for order creation
router.post("/shopify/order", async (req, res) => {
  const order = req.body;
  
  try {
    console.log("📦 Received Shopify order:", order.order_number || order.id);
    
    // 🔧 Enhanced connection verification
    console.log("🔍 Checking Xero connection...");
    
    // Load and verify tokens
    const savedTokens = loadTokensFromFile();
    if (!savedTokens) {
      throw new Error("No tokens found in tokens.json. Please complete OAuth flow first.");
    }
    
    console.log("📊 Token status:", {
      hasAccessToken: !!savedTokens.access_token,
      hasRefreshToken: !!savedTokens.refresh_token,
      tenantId: savedTokens.tenant_id,
      savedAt: savedTokens.savedAt
    });
    
    // Ensure Xero connection is established
    const tenantId = await ensureXeroConnection();
    if (!tenantId) {
      throw new Error("Failed to establish Xero connection. Please check your OAuth setup.");
    }
    
    console.log("✅ Xero connection verified. Tenant ID:", tenantId);

    // Transform order to Xero invoice format
    const invoiceData = transformOrderToInvoice(order);
    
    console.log("📋 Invoice payload:", JSON.stringify({
      type: invoiceData.type,
      contact: invoiceData.contact.name,
      lineItemsCount: invoiceData.lineItems.length,
      lineItems: invoiceData.lineItems.map(item => ({
        description: item.description,
        quantity: item.quantity,
        unitAmount: item.unitAmount,
        accountCode: item.accountCode
      })),
      currencyCode: invoiceData.currencyCode,
      status: invoiceData.status
    }, null, 2));
    
    console.log("🔄 Creating invoice in Xero...");
    
    // Create invoice in Xero with enhanced error handling
    const response = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [invoiceData]
    });
    
    // Validate response
    if (!response.body || !response.body.invoices || response.body.invoices.length === 0) {
      throw new Error("Xero API returned empty response");
    }
    
    const createdInvoice = response.body.invoices[0];
    
    // Check for validation errors in the response
    if (createdInvoice.validationErrors && createdInvoice.validationErrors.length > 0) {
      const validationDetails = createdInvoice.validationErrors.map(err => err.message).join(", ");
      
      // Special handling for currency errors
      if (validationDetails.includes("not subscribed to currency")) {
        const currencyMatch = validationDetails.match(/currency (\w+)/);
        const rejectedCurrency = currencyMatch ? currencyMatch[1] : order.currency;
        
        // Try to get the organization's base currency for helpful error message
        try {
          const orgResponse = await xero.accountingApi.getOrganisations(tenantId);
          const orgCurrency = orgResponse.body.organisations[0].baseCurrency;
          throw new Error(`Currency ${rejectedCurrency} is not enabled for your Xero organization. Your organization's base currency is ${orgCurrency}. Please either: 1) Enable ${rejectedCurrency} in your Xero settings, or 2) Use ${orgCurrency} as the currency`);
        } catch (orgErr) {
          throw new Error(`Currency ${rejectedCurrency} is not enabled for your Xero organization. Please enable this currency in your Xero settings or use your organization's base currency instead.`);
        }
      }
      
      throw new Error(`Xero validation errors: ${validationDetails}`);
    }
    
    // Store invoice record
    const invoiceRecord = {
      orderId: order.id,
      orderNumber: order.order_number || order.name,
      xeroInvoiceId: createdInvoice.invoiceID,
      xeroInvoiceNumber: createdInvoice.invoiceNumber,
      status: createdInvoice.status,
      total: createdInvoice.total,
      createdAt: new Date().toISOString(),
      customerEmail: order.email,
      customerName: invoiceData.contact.name
    };
    
    invoiceRecords.set(order.id, invoiceRecord);
    
    console.log("✅ Invoice created successfully:", {
      invoiceId: createdInvoice.invoiceID,
      invoiceNumber: createdInvoice.invoiceNumber,
      status: createdInvoice.status,
      total: createdInvoice.total
    });
    
    // Return success response with invoice details
    res.json({
      success: true,
      invoice: {
        id: createdInvoice.invoiceID,
        number: createdInvoice.invoiceNumber,
        status: createdInvoice.status,
        total: createdInvoice.total,
        url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${createdInvoice.invoiceID}`
      },
      message: "Invoice created successfully"
    });
    
  } catch (error) {
    // 🚨 Enhanced error logging and response
    console.error("❌ Error Creating Invoice (Shopify)");
    console.error("Error:", error);
    console.error("Message:", error.message);
    console.error("Stack:", error.stack);
    
    // Log Xero-specific error details if available
    if (error.response) {
      console.error("📄 Xero API Response Status:", error.response.status);
      console.error("📄 Xero API Response Headers:", error.response.headers);
      console.error("📄 Xero API Response Body:", JSON.stringify(error.response.body, null, 2));
    }
    
    // Store detailed error record for debugging
    const errorRecord = {
      orderId: order.id,
      orderNumber: order.order_number || order.name,
      error: error.message,
      errorDetails: {
        stack: error.stack,
        response: error.response ? {
          status: error.response.status,
          body: error.response.body
        } : null
      },
      errorAt: new Date().toISOString(),
      orderData: order // Store for debugging
    };
    
    invoiceRecords.set(`error-${order.id}`, errorRecord);
    
    // Return detailed error response
    res.status(500).json({
      success: false,
      error: error.message || "Unknown error occurred",
      details: error.response?.body || null,
      message: "Failed to create invoice",
      timestamp: new Date().toISOString(),
      orderId: order.id
    });
  }
});

// Function to verify system readiness
async function verifySystemReadiness() {
  const issues = [];
  
  // Check environment variables
  if (!process.env.XERO_CLIENT_ID) issues.push("Missing XERO_CLIENT_ID environment variable");
  if (!process.env.XERO_CLIENT_SECRET) issues.push("Missing XERO_CLIENT_SECRET environment variable");
  if (!process.env.XERO_REDIRECT_URI) issues.push("Missing XERO_REDIRECT_URI environment variable");
  
  // Check tokens file
  const savedTokens = loadTokensFromFile();
  if (!savedTokens) {
    issues.push("No tokens.json file found");
  } else {
    if (!savedTokens.access_token) issues.push("No access_token in tokens.json");
    if (!savedTokens.refresh_token) issues.push("No refresh_token in tokens.json");
    if (!savedTokens.tenant_id) issues.push("No tenant_id in tokens.json");
  }
  
  return issues;
}

// Custom frontend endpoint for order submission
router.post("/custom/order", async (req, res) => {
  const orderData = req.body;
  
  try {
    console.log("🛒 Received custom order:", JSON.stringify(orderData, null, 2));
    
    // Pre-flight system check
    console.log("🔍 Running pre-flight system checks...");
    const systemIssues = await verifySystemReadiness();
    if (systemIssues.length > 0) {
      console.error("⚠️ System readiness issues:", systemIssues);
      throw new Error(`System not ready: ${systemIssues.join(", ")}`);
    }
    console.log("✅ Pre-flight checks passed");
    
    // Validate required fields
    if (!orderData.customer || !orderData.line_items || orderData.line_items.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: customer and line_items",
        details: "Order must include customer information and at least one line item"
      });
    }
    
    // Generate order ID if not provided
    if (!orderData.id) {
      orderData.id = `custom-${Date.now()}`;
    }
    
    // Set default currency if not provided (get from Xero organization)
    if (!orderData.currency) {
      try {
        const tenantId = await ensureXeroConnection();
        const orgResponse = await xero.accountingApi.getOrganisations(tenantId);
        const orgCurrency = orgResponse.body.organisations[0].baseCurrency;
        orderData.currency = orgCurrency;
        console.log(`💰 Using organization's base currency: ${orgCurrency}`);
      } catch (currencyErr) {
        console.warn("⚠️ Could not fetch organization currency, defaulting to USD:", currencyErr.message);
        orderData.currency = "USD";
      }
    }
    
    // 🔧 Enhanced connection verification with detailed logging
    console.log("🔍 Checking Xero connection...");
    
    // Load and verify tokens
    const savedTokens = loadTokensFromFile();
    if (!savedTokens) {
      throw new Error("No tokens found in tokens.json. Please complete OAuth flow first.");
    }
    
    console.log("📊 Token status:", {
      hasAccessToken: !!savedTokens.access_token,
      hasRefreshToken: !!savedTokens.refresh_token,
      tenantId: savedTokens.tenant_id,
      savedAt: savedTokens.savedAt
    });
    
    // Ensure Xero connection is established
    const tenantId = await ensureXeroConnection();
    if (!tenantId) {
      throw new Error("Failed to establish Xero connection. Please check your OAuth setup.");
    }
    
    console.log("✅ Xero connection verified. Tenant ID:", tenantId);
    
    // Transform order to invoice format
    const invoiceData = transformOrderToInvoice(orderData);
    
    console.log("📋 Invoice payload:", JSON.stringify({
      type: invoiceData.type,
      contact: invoiceData.contact.name,
      lineItemsCount: invoiceData.lineItems.length,
      lineItems: invoiceData.lineItems.map(item => ({
        description: item.description,
        quantity: item.quantity,
        unitAmount: item.unitAmount,
        accountCode: item.accountCode
      })),
      currencyCode: invoiceData.currencyCode,
      status: invoiceData.status
    }, null, 2));
    
    console.log("🔄 Creating invoice in Xero...");
    
    // Create invoice in Xero with enhanced error handling
    const response = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [invoiceData]
    });
    
    // Validate response
    if (!response.body || !response.body.invoices || response.body.invoices.length === 0) {
      throw new Error("Xero API returned empty response");
    }
    
    const createdInvoice = response.body.invoices[0];
    
    // Check for validation errors in the response
    if (createdInvoice.validationErrors && createdInvoice.validationErrors.length > 0) {
      const validationDetails = createdInvoice.validationErrors.map(err => err.message).join(", ");
      
      // Special handling for currency errors
      if (validationDetails.includes("not subscribed to currency")) {
        const currencyMatch = validationDetails.match(/currency (\w+)/);
        const rejectedCurrency = currencyMatch ? currencyMatch[1] : orderData.currency;
        
        // Try to get the organization's base currency for helpful error message
        try {
          const orgResponse = await xero.accountingApi.getOrganisations(tenantId);
          const orgCurrency = orgResponse.body.organisations[0].baseCurrency;
          throw new Error(`Currency ${rejectedCurrency} is not enabled for your Xero organization. Your organization's base currency is ${orgCurrency}. Please either: 1) Enable ${rejectedCurrency} in your Xero settings, or 2) Use ${orgCurrency} as the currency`);
        } catch (orgErr) {
          throw new Error(`Currency ${rejectedCurrency} is not enabled for your Xero organization. Please enable this currency in your Xero settings or use your organization's base currency instead.`);
        }
      }
      
      throw new Error(`Xero validation errors: ${validationDetails}`);
    }
    
    // Store invoice record
    const invoiceRecord = {
      orderId: orderData.id,
      orderNumber: orderData.order_number || orderData.id,
      xeroInvoiceId: createdInvoice.invoiceID,
      xeroInvoiceNumber: createdInvoice.invoiceNumber,
      status: createdInvoice.status,
      total: createdInvoice.total,
      createdAt: new Date().toISOString(),
      customerEmail: orderData.customer.email,
      customerName: invoiceData.contact.name
    };
    
    invoiceRecords.set(orderData.id, invoiceRecord);
    
    console.log("✅ Invoice created successfully:", {
      invoiceId: createdInvoice.invoiceID,
      invoiceNumber: createdInvoice.invoiceNumber,
      status: createdInvoice.status,
      total: createdInvoice.total
    });
    
    res.json({
      success: true,
      invoice: {
        id: createdInvoice.invoiceID,
        number: createdInvoice.invoiceNumber,
        status: createdInvoice.status,
        total: createdInvoice.total,
        url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${createdInvoice.invoiceID}`
      },
      message: "Invoice created successfully"
    });
    
  } catch (error) {
    // 🚨 Enhanced error logging and response
    console.error("❌ Error Creating Invoice");
    console.error("Error Object Type:", typeof error);
    console.error("Error Constructor:", error.constructor.name);
    console.error("Error:", error);
    console.error("Error Message:", error.message);
    console.error("Error Name:", error.name);
    console.error("Error Stack:", error.stack);
    console.error("Error String:", String(error));
    console.error("Error JSON:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
    
    // Log all enumerable properties
    console.error("Error Properties:");
    for (const key in error) {
      console.error(`  ${key}:`, error[key]);
    }
    
    // Log Xero-specific error details if available
    if (error.response) {
      console.error("📄 Xero API Response Status:", error.response.status);
      console.error("📄 Xero API Response StatusText:", error.response.statusText);
      console.error("📄 Xero API Response Headers:", error.response.headers);
      
      try {
        console.error("📄 Xero API Response Body:", JSON.stringify(error.response.body, null, 2));
      } catch (e) {
        console.error("📄 Xero API Response Body (raw):", error.response.body);
      }
      
      if (error.response.data) {
        console.error("📄 Xero API Response Data:", JSON.stringify(error.response.data, null, 2));
      }
    }
    
    // Check if it's an axios error
    if (error.isAxiosError) {
      console.error("🌐 Axios Error Details:");
      console.error("  Request URL:", error.config?.url);
      console.error("  Request Method:", error.config?.method);
      console.error("  Request Headers:", error.config?.headers);
      console.error("  Request Data:", error.config?.data);
    }
    
    // Store detailed error record for debugging
    const errorRecord = {
      orderId: orderData.id,
      orderNumber: orderData.order_number || orderData.id,
      error: error.message || error.toString() || "Unknown error",
      errorType: error.constructor.name,
      errorDetails: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        stringified: String(error),
        allProperties: JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          body: error.response.body,
          data: error.response.data
        } : null,
        isAxiosError: error.isAxiosError || false
      },
      errorAt: new Date().toISOString(),
      orderData: orderData // Store for debugging
    };
    
    invoiceRecords.set(`error-${orderData.id}`, errorRecord);
    
    // Determine the best error message to return
    let errorMessage = "Unknown error occurred";
    if (error.message) {
      errorMessage = error.message;
    } else if (error.toString && error.toString() !== "[object Object]") {
      errorMessage = error.toString();
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    
    // Return detailed error response
    res.status(500).json({
      success: false,
      error: errorMessage,
      errorType: error.constructor.name,
      details: {
        response: error.response?.body || error.response?.data || null,
        isAxiosError: error.isAxiosError || false,
        allErrorData: JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
      },
      message: "Failed to create invoice",
      timestamp: new Date().toISOString(),
      orderId: orderData.id
    });
  }
});

// Get invoice records endpoint
router.get("/invoices", (req, res) => {
  const records = Array.from(invoiceRecords.values());
  res.json({
    success: true,
    invoices: records.filter(r => !r.error),
    errors: records.filter(r => r.error),
    total: records.length
  });
});

// Get specific invoice record
router.get("/invoice/:orderId", (req, res) => {
  const record = invoiceRecords.get(req.params.orderId);
  if (!record) {
    return res.status(404).json({
      success: false,
      error: "Invoice record not found"
    });
  }
  
  res.json({
    success: true,
    invoice: record
  });
});

// Test endpoint to verify Xero connection
router.get("/test/connection", async (req, res) => {
  try {
    console.log("🧪 Testing Xero connection...");
    
    // Run system checks
    const systemIssues = await verifySystemReadiness();
    if (systemIssues.length > 0) {
      return res.json({
        success: false,
        error: "System not ready",
        issues: systemIssues
      });
    }
    
    // Test connection
    const tenantId = await ensureXeroConnection();
    if (!tenantId) {
      return res.json({
        success: false,
        error: "Failed to establish Xero connection"
      });
    }
    
    // Try to fetch organisations (simple test API call)
    const orgResponse = await xero.accountingApi.getOrganisations(tenantId);
    const organisation = orgResponse.body.organisations[0];
    
    console.log("✅ Xero connection test successful");
    
    res.json({
      success: true,
      message: "Xero connection working",
      organisation: {
        name: organisation.name,
        countryCode: organisation.countryCode,
        currencyCode: organisation.baseCurrency
      },
      tenantId: tenantId
    });
    
  } catch (error) {
    console.error("❌ Xero connection test failed:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Connection test failed",
      details: error.response?.body || null
    });
  }
});

// Debug endpoint to check connection status
router.get("/debug/status", async (req, res) => {
  try {
    console.log("🔍 Debug: Checking system status...");
    
    // Load tokens from file
    const savedTokens = loadTokensFromFile();
    
    // Check Xero connection
    let connectionStatus = "disconnected";
    let tenantId = null;
    let connectionError = null;
    
    try {
      tenantId = await ensureXeroConnection();
      connectionStatus = tenantId ? "connected" : "failed";
    } catch (err) {
      connectionStatus = "error";
      connectionError = err.message;
    }
    
    res.json({
      success: true,
      debug: {
        timestamp: new Date().toISOString(),
        tokens: savedTokens ? {
          hasAccessToken: !!savedTokens.access_token,
          hasRefreshToken: !!savedTokens.refresh_token,
          tenantId: savedTokens.tenant_id,
          savedAt: savedTokens.savedAt,
          expiresAt: savedTokens.expires_at
        } : null,
        xeroConnection: {
          status: connectionStatus,
          tenantId: tenantId,
          error: connectionError
        },
        environment: {
          nodeEnv: process.env.NODE_ENV,
          hasClientId: !!process.env.XERO_CLIENT_ID,
          hasClientSecret: !!process.env.XERO_CLIENT_SECRET,
          redirectUri: process.env.XERO_REDIRECT_URI
        },
        invoiceRecords: {
          total: invoiceRecords.size,
          errors: Array.from(invoiceRecords.keys()).filter(key => key.startsWith('error-')).length
        }
      }
    });
    
  } catch (error) {
    console.error("❌ Debug endpoint error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      debug: {
        timestamp: new Date().toISOString(),
        error: "Failed to retrieve debug information"
      }
    });
  }
});

// Utility function to transform quote data to Xero invoice format
function transformQuoteToInvoice(quoteData) {
  const { customerName, customerEmail, customerPhone, quoteId, items, currency } = quoteData;
  
  // Create contact information
  const contact = {
    name: customerName || "Walk-in Customer",
    emailAddress: customerEmail,
    ...(customerPhone && { phone: customerPhone })
  };

  // Transform quote items to Xero line items
  const lineItems = items.map(item => ({
    description: item.description || "Product",
    quantity: parseInt(item.quantity) || 1,
    unitAmount: parseFloat(item.unitAmount) || 0,
    accountCode: "200" // Use AccountCode 200 as specified
  }));

  return {
    type: "ACCREC", // Accounts Receivable
    contact: contact,
    lineItems: lineItems,
    date: new Date().toISOString().split('T')[0], // Today's date
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
    reference: `Quote: ${quoteId}`, // Set reference as specified
    status: "DRAFT", // Create as DRAFT invoice
    currencyCode: currency || "USD",
    lineAmountTypes: "Exclusive"
  };
}

// POST /api/send-quote-to-xero - Send quote to Xero as draft invoice
router.post("/send-quote-to-xero", async (req, res) => {
  console.log("📋 Received quote data for Xero integration:");
  console.log("📋 Request body:", JSON.stringify(req.body, null, 2));
  console.log("📋 Content-Type:", req.headers['content-type']);
  console.log("📋 Request method:", req.method);
  
  try {
    const { quoteId, customer, items } = req.body;
    
    console.log("📋 Extracted data:");
    console.log("  - quoteId:", quoteId);
    console.log("  - customer:", customer);
    console.log("  - items:", items);

    // Validation - Check required fields
    if (!quoteId || !customer?.name) {
      console.log("❌ Quote validation failed: Missing required fields");
      return res.status(400).json({
        success: false,
        error: 'Customer name and quote ID are required',
        timestamp: new Date().toISOString()
      });
    }

    // Validation - Check if items list is empty
    if (!items || !items.length) {
      console.log("❌ Quote validation failed: Empty items list");
      return res.status(400).json({
        success: false,
        error: 'Items list cannot be empty',
        timestamp: new Date().toISOString()
      });
    }

    console.log("🔐 Ensuring Xero connection...");
    
    // Check if xero client is available
    if (!xero) {
      throw new Error("Xero client not initialized");
    }
    
    // Ensure we have a valid Xero connection
    const tenantId = await ensureXeroConnection();
    if (!tenantId) {
      throw new Error("Unable to establish Xero connection. Please complete OAuth flow.");
    }
    
    console.log("✅ Xero connection verified. Tenant ID:", tenantId);
    console.log("✅ Xero client available:", !!xero);
    console.log("✅ Xero accounting API available:", !!xero.accountingApi);

    // Create Xero invoice payload
    const invoicePayload = {
      Type: 'ACCREC',
      Contact: {
        Name: customer.name,
        ...(customer.email && { EmailAddress: customer.email }),
        ...(customer.phone && { Phone: customer.phone })
      },
      LineItems: items.map((item) => ({
        Description: item.description,
        Quantity: item.quantity,
        UnitAmount: item.unitAmount,
        AccountCode: '200', // Use AccountCode 200 as specified
      })),
      Status: 'DRAFT',
      LineAmountTypes: 'Exclusive',
      Reference: `Quote: ${quoteId}`,
      Date: new Date().toISOString().split('T')[0], // Today's date
      DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
    };
    
    console.log("📋 Quote invoice payload summary:", JSON.stringify({
      Type: invoicePayload.Type,
      Contact: invoicePayload.Contact.Name,
      LineItemsCount: invoicePayload.LineItems.length,
      Status: invoicePayload.Status,
      Reference: invoicePayload.Reference
    }, null, 2));
    
    console.log("🚀 Full invoice payload being sent to Xero:", JSON.stringify(invoicePayload, null, 2));
    console.log("🏢 Using Tenant ID:", tenantId);
    
    console.log("🔄 Creating draft invoice in Xero...");
    
    // Create draft invoice in Xero
    const response = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [invoicePayload]
    });
    
    console.log("📥 Raw Xero response status:", response?.status);
    console.log("📥 Raw Xero response body:", JSON.stringify(response?.body, null, 2));
    
    // Validate response
    if (!response.body || !response.body.invoices || response.body.invoices.length === 0) {
      throw new Error("Xero API returned empty response");
    }
    
    const createdInvoice = response.body.invoices[0];
    
    // Check for validation errors in the response
    if (createdInvoice.validationErrors && createdInvoice.validationErrors.length > 0) {
      const validationDetails = createdInvoice.validationErrors.map(err => err.message).join(", ");
      
      // Special handling for currency errors
      if (validationDetails.includes("not subscribed to currency")) {
        const currencyMatch = validationDetails.match(/currency (\w+)/);
        const rejectedCurrency = currencyMatch ? currencyMatch[1] : 'USD';
        
        console.log(`❌ Currency error for quote ${quoteId}: ${rejectedCurrency} not enabled`);
        
        // Try to get the organization's base currency for helpful error message
        try {
          const orgResponse = await xero.accountingApi.getOrganisations(tenantId);
          const orgCurrency = orgResponse.body.organisations[0].baseCurrency;
          throw new Error(`Currency ${rejectedCurrency} is not enabled for your Xero organization. Your organization's base currency is ${orgCurrency}. Please either: 1) Enable ${rejectedCurrency} in your Xero settings, or 2) Use ${orgCurrency} as the currency`);
        } catch (orgErr) {
          throw new Error(`Currency ${rejectedCurrency} is not enabled for your Xero organization. Please enable this currency in your Xero settings or use your organization's base currency instead.`);
        }
      }
      
      console.log(`❌ Xero validation errors for quote ${quoteId}:`, validationDetails);
      throw new Error(`Xero validation failed: ${validationDetails}`);
    }
    
    // Check if invoice was created successfully
    if (!createdInvoice.invoiceID) {
      throw new Error("Invoice was not created properly - missing invoice ID");
    }
    
    console.log("✅ Draft invoice created successfully for quote:", {
      quoteId: quoteId,
      invoiceId: createdInvoice.invoiceID,
      invoiceNumber: createdInvoice.invoiceNumber,
      status: createdInvoice.status,
      currency: createdInvoice.currencyCode,
      total: createdInvoice.total
    });
    
    // Success response
    res.json({
      success: true,
      xeroResponse: {
        invoiceId: createdInvoice.invoiceID,
        invoiceNumber: createdInvoice.invoiceNumber,
        status: createdInvoice.status,
        reference: createdInvoice.reference,
        total: createdInvoice.total,
        url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${createdInvoice.invoiceID}`
      },
      message: "Quote successfully sent to Xero as draft invoice",
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    // Enhanced error logging
    console.error('❌ Internal Error Details:');
    console.error('Error object:', err);
    console.error('Error message:', err?.message);
    console.error('Error stack:', err?.stack);
    console.error('Xero response data:', err?.response?.data);
    console.error('Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
    
    // Log failure details
    console.log("❌ Quote to Xero failure details:", {
      quoteId: req.body.quoteId,
      customer: req.body.customer?.name,
      itemsCount: req.body.items?.length,
      error: err?.message,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: err?.message || 'Unknown error occurred',
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router; 