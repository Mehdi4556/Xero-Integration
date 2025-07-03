const express = require("express");
const router = express.Router();
const { xero, tenantId } = require("../xero/client");

router.post("/order", async (req, res) => {
  const order = req.body;

  try {
    const item = order.line_items[0];
    const props = Object.fromEntries(item.properties.map(p => [p.name, p.value]));

    const area = parseFloat(props.Length) * parseFloat(props.Width);
    const price = area * parseFloat(props.PricePerSqFt || 1.5);

    const invoice = {
      type: "ACCREC",
      contact: {
        emailAddress: order.email,
        name: `${order.customer.first_name} ${order.customer.last_name}`,
      },
      lineItems: [
        {
          description: `${item.title} - ${props.Length}ft x ${props.Width}ft`,
          quantity: 1,
          unitAmount: price.toFixed(2),
        },
      ],
      status: "AUTHORISED",
    };

    await xero.accountingApi.createInvoices(tenantId, { invoices: [invoice] });

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error creating invoice:", error);
    res.status(500).send("Failed to create invoice");
  }
});

module.exports = router;
