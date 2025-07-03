const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const shopifyWebhook = require("./routes/shopifyWebhook");
app.use("/webhook/shopify", shopifyWebhook);

app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});
