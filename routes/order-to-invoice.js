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

// Custom frontend endpoint for order submission
router.post("/custom/order", async (req, res) => {
  const orderData = req.body;
  
  try {
    console.log("🛒 Received custom order:", orderData);
    
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
    
    // Set default currency if not provided
    if (!orderData.currency) {
      orderData.currency = "USD";
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
      orderId: orderData.id,
      orderNumber: orderData.order_number || orderData.id,
      error: error.message,
      errorDetails: {
        stack: error.stack,
        response: error.response ? {
          status: error.response.status,
          body: error.response.body
        } : null
      },
      errorAt: new Date().toISOString(),
      orderData: orderData // Store for debugging
    };
    
    invoiceRecords.set(`error-${orderData.id}`, errorRecord);
    
    // Return detailed error response
    res.status(500).json({
      success: false,
      error: error.message || "Unknown error occurred",
      details: error.response?.body || null,
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

module.exports = router; 