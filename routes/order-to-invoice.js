const express = require("express");
const router = express.Router();
const { xero, getTenantId } = require("../xero/client");

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
    
    // Check if we have valid tokens
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error("Xero not connected. Please complete OAuth flow first.");
    }

    // Transform order to Xero invoice format
    const invoiceData = transformOrderToInvoice(order);
    
    console.log("🔄 Creating invoice in Xero...");
    
    // Create invoice in Xero
    const response = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [invoiceData]
    });
    
    const createdInvoice = response.body.invoices[0];
    
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
    console.error("❌ Error creating invoice:", error);
    
    // Store error record
    const errorRecord = {
      orderId: order.id,
      orderNumber: order.order_number || order.name,
      error: error.message,
      errorAt: new Date().toISOString(),
      orderData: order // Store for debugging
    };
    
    invoiceRecords.set(`error-${order.id}`, errorRecord);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to create invoice"
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
        error: "Missing required fields: customer and line_items"
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
    
    // Transform and create invoice (same process as Shopify)
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error("Xero not connected. Please complete OAuth flow first.");
    }
    
    const invoiceData = transformOrderToInvoice(orderData);
    
    console.log("🔄 Creating invoice in Xero...");
    
    const response = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [invoiceData]
    });
    
    const createdInvoice = response.body.invoices[0];
    
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
    console.error("❌ Error creating custom invoice:", error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to create invoice"
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

module.exports = router; 