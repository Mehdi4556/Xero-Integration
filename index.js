require('./force-timing-patch'); // ⬅️ Must be first to patch JWT error
require('dotenv').config();

const express = require("express");

const app = express();
app.use(express.json());

// Routes
const shopifyWebhook = require("./routes/shopifyWebhook");
const orderToInvoice = require("./routes/order-to-invoice");
const oauthRoutes = require("./routes/oauth");

app.use("/webhook/shopify", shopifyWebhook);
app.use("/api", orderToInvoice);
app.use("/oauth", oauthRoutes);

// Add callback route at root level for Xero redirect compatibility
// Import the callback handler directly from oauth routes
const { callbackHandler } = require("./routes/oauth");
app.get("/callback", callbackHandler);

// Add a main status page
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h1>🔗 Shopify-Xero Integration</h1>
        <p>Your integration server is running successfully!</p>
        
        <h3>🔐 OAuth Setup:</h3>
        <ul>
          <li><a href="/oauth/auth">🚀 Start Xero OAuth Flow</a></li>
          <li><a href="/oauth/status">📊 OAuth Status</a></li>
        </ul>
        
        <h3>📦 Order Processing:</h3>
        <ul>
          <li><strong>POST</strong> /api/shopify/order - Shopify Webhook Handler</li>
          <li><strong>POST</strong> /api/custom/order - Custom Order Submission</li>
          <li><strong>POST</strong> /api/send-quote-to-xero - 📝 Send Quote to Xero as Draft Invoice</li>
          <li><a href="/api/invoices">📋 View Invoice Records</a></li>
          <li><a href="/test">🧪 Test Order Form</a></li>
        </ul>
        
        <h3>🗂️ Legacy Endpoints:</h3>
        <ul>
          <li><strong>POST</strong> /webhook/shopify/order - Original Shopify Handler</li>
        </ul>
        
        <hr>
        <p>✅ JWT timing issues resolved | ✅ OAuth integration ready | ✅ Order-to-invoice processing ready</p>
      </body>
    </html>
  `);
});

// Test form for custom orders
app.get("/test", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Test Order Form</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
          .form-group { margin: 15px 0; }
          label { display: block; margin-bottom: 5px; font-weight: bold; }
          input, textarea { width: 100%; padding: 8px; margin-bottom: 10px; border: 1px solid #ddd; border-radius: 4px; }
          button { background: #007cff; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
          button:hover { background: #0056b3; }
          .result { margin: 20px 0; padding: 15px; border-radius: 4px; }
          .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
          .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        </style>
      </head>
      <body>
        <h1>🧪 Test Order Form</h1>
        <p>Use this form to test the order-to-invoice integration.</p>
        
        <form id="orderForm">
          <div class="form-group">
            <label>Customer First Name:</label>
            <input type="text" id="firstName" value="John" required>
          </div>
          
          <div class="form-group">
            <label>Customer Last Name:</label>
            <input type="text" id="lastName" value="Doe" required>
          </div>
          
          <div class="form-group">
            <label>Customer Email:</label>
            <input type="email" id="email" value="john.doe@example.com" required>
          </div>
          
          <div class="form-group">
            <label>Product Name:</label>
            <input type="text" id="productName" value="Test Product" required>
          </div>
          
          <div class="form-group">
            <label>Quantity:</label>
            <input type="number" id="quantity" value="1" min="1" required>
          </div>
          
          <div class="form-group">
            <label>Price (per unit):</label>
            <input type="number" id="price" value="100.00" step="0.01" min="0" required>
          </div>
          
          <div class="form-group">
            <label>Currency:</label>
            <input type="text" id="currency" value="" placeholder="Auto-detect from Xero">
            <small style="color: #666;">Leave blank to use your Xero organization's base currency</small>
          </div>
          
          <button type="submit">🚀 Create Invoice</button>
        </form>
        
        <div id="result"></div>
        
        <script>
          document.getElementById('orderForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const resultDiv = document.getElementById('result');
            resultDiv.innerHTML = '<p>⏳ Processing...</p>';
            
            const orderData = {
              customer: {
                first_name: document.getElementById('firstName').value,
                last_name: document.getElementById('lastName').value,
                email: document.getElementById('email').value
              },
              line_items: [{
                title: document.getElementById('productName').value,
                quantity: parseInt(document.getElementById('quantity').value),
                price: parseFloat(document.getElementById('price').value)
              }],
              currency: document.getElementById('currency').value || undefined // Let server auto-detect
            };
            
            try {
              const response = await fetch('/api/custom/order', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(orderData)
              });
              
              const result = await response.json();
              
              if (result.success) {
                resultDiv.innerHTML = \`
                  <div class="result success">
                    <h3>✅ Invoice Created Successfully!</h3>
                    <p><strong>Invoice ID:</strong> \${result.invoice.id}</p>
                    <p><strong>Invoice Number:</strong> \${result.invoice.number}</p>
                    <p><strong>Status:</strong> \${result.invoice.status}</p>
                    <p><strong>Total:</strong> \${result.invoice.total}</p>
                    <p><a href="\${result.invoice.url}" target="_blank">📄 View in Xero</a></p>
                  </div>
                \`;
              } else {
                resultDiv.innerHTML = \`
                  <div class="result error">
                    <h3>❌ Error Creating Invoice</h3>
                    <p><strong>Error:</strong> \${result.error}</p>
                    <p><strong>Message:</strong> \${result.message}</p>
                  </div>
                \`;
              }
            } catch (error) {
              resultDiv.innerHTML = \`
                <div class="result error">
                  <h3>❌ Network Error</h3>
                  <p><strong>Error:</strong> \${error.message}</p>
                </div>
              \`;
            }
          });
        </script>
      </body>
    </html>
  `);
});

app.listen(3000, () => {
  console.log("🚀 Shopify-Xero Integration Server running on http://localhost:3000");
  console.log("🔐 Visit http://localhost:3000/oauth/auth to start OAuth flow");
  console.log("📊 Visit http://localhost:3000/oauth/status for OAuth status");
  console.log("🏠 Visit http://localhost:3000 for main dashboard");
});
