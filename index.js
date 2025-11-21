require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Shopify sends raw body for HMAC verification
app.use(bodyParser.raw({ type: 'application/json' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Verify Shopify webhook HMAC
function verifyHmac(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.body, 'utf8')
    .digest('base64');

  return digest === hmacHeader;
}

// Convert raw body → JSON
function getJson(req) {
  return JSON.parse(req.body.toString('utf8'));
}

function calcPoints(totalPrice) {
  return Math.floor(parseFloat(totalPrice)); // RM1 = 1 point
}

app.post('/shopify/orders-paid', async (req, res) => {
  try {
    // 1. Validate HMAC
    if (!verifyHmac(req)) {
      console.error("❌ Invalid HMAC");
      return res.status(401).send("Invalid HMAC");
    }

    // 2. Parse order data
    const order = getJson(req);
    const customer = order.customer;

    if (!customer) return res.status(200).send("No customer");

    const shopifyCustomerId = String(customer.id);
    const email = customer.email;
    const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

    const totalPrice = order.total_price;
    const points = calcPoints(totalPrice);
    const orderId = String(order.id);

    console.log(`💰 Order paid: ${orderId} | RM${totalPrice} | +${points} points`);

    // 3. Upsert user into Supabase
    const { data: user } = await supabase
      .from('users')
      .upsert(
        {
          shopify_customer_id: shopifyCustomerId,
          email,
          name
        },
        { onConflict: 'shopify_customer_id' }
      )
      .select()
      .single();

    // 4. Find or create wallet
    let { data: wallet } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (!wallet) {
      const { data: newWallet } = await supabase
        .from('wallets')
        .insert({ user_id: user.id })
        .select()
        .single();
      wallet = newWallet;
    }

    // 5. Add transaction record
    await supabase.from('wallet_transactions').insert({
      wallet_id: wallet.id,
      type: 'earn',
      source: 'order',
      shopify_order_id: orderId,
      points_change: points,
      note: "Points from order"
    });

    // 6. Update balances
    await supabase
      .from('wallets')
      .update({
        points: wallet.points + points,
        lifetime_points: wallet.lifetime_points + points,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.id);

    return res.status(200).send("OK");

  } catch (error) {
    console.error("❌ Error:", error);
    return res.status(500).send("Server error");
  }
});

app.listen(3000, () => {
  console.log("🚀 THCO Wallet API running on port 3000");
});
