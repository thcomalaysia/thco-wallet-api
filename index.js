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
  const amount = parseFloat(totalPrice) || 0;
  const rate = 3; // 每 RM1 = 3 积分
  return Math.floor(amount * rate);
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

// 简单允许前端跨域读取（只读 GET，足够用）
app.use((req, res, next) => {
  // 把域名改成你的店铺域名，例如 https://thcomalaysia.com
  res.setHeader('Access-Control-Allow-Origin', 'https://thcomalaysia.com');
  next();
});

// 通过 email 查询钱包积分
app.get('/wallet/by-email', async (req, res) => {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'email is required',
      });
    }

    // 1️⃣ 查用户
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, name, email')
      .eq('email', email)
      .maybeSingle();

    if (userError) {
      console.error('Supabase user error:', userError);
      return res.status(500).json({ success: false, message: 'User lookup failed' });
    }

    if (!user) {
      // 没有这个用户，返回 0 积分
      return res.json({
        success: true,
        email,
        name: null,
        hasWallet: false,
        points: 0,
        lifetime_points: 0,
      });
    }

    // 2️⃣ 查钱包
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('points, lifetime_points')
      .eq('user_id', user.id)
      .maybeSingle();

    if (walletError) {
      console.error('Supabase wallet error:', walletError);
      return res.status(500).json({ success: false, message: 'Wallet lookup failed' });
    }

    return res.json({
      success: true,
      email: user.email,
      name: user.name,
      hasWallet: !!wallet,
      points: wallet?.points ?? 0,
      lifetime_points: wallet?.lifetime_points ?? 0,
    });
  } catch (err) {
    console.error('GET /wallet/by-email error:', err);
    return res.status(500).json({ success: false, message: 'Unexpected error' });
  }
});

app.listen(3000, () => {
  console.log("🚀 THCO Wallet API running on port 3000");
});
