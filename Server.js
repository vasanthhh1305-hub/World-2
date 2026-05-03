require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./doctors.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    trial_expiry TEXT,
    subscription_expiry TEXT,
    device_fingerprint TEXT
  )`);
});

app.post('/api/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) return res.status(400).json({ error: 'Invalid phone' });
  const otp = Math.floor(100000 + Math.random() * 900000);
  console.log(`OTP for ${phone}: ${otp}`);
  res.json({ message: 'OTP sent (use 123456)' });
});

app.post('/api/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  if (otp !== '123456') return res.status(401).json({ error: 'Invalid OTP' });
  db.get(`SELECT * FROM users WHERE phone = ?`, [phone], (err, user) => {
    if (!user) {
      const trialExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      db.run(`INSERT INTO users (phone, trial_expiry) VALUES (?, ?)`, [phone, trialExpiry], () => {
        const token = jwt.sign({ phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { phone, trialExpiry, subscriptionExpiry: null } });
      });
    } else {
      const token = jwt.sign({ phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
      res.json({ token, user: { phone, trialExpiry: user.trial_expiry, subscriptionExpiry: user.subscription_expiry } });
    }
  });
});

app.get('/api/subscription/status', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    db.get(`SELECT * FROM users WHERE phone = ?`, [decoded.phone], (err, user) => {
      const now = new Date();
      const hasActive = (user?.trial_expiry && new Date(user.trial_expiry) > now) || (user?.subscription_expiry && new Date(user.subscription_expiry) > now);
      res.json({ hasActive, trialExpiry: user?.trial_expiry, subscriptionExpiry: user?.subscription_expiry });
    });
  });
});

app.post('/api/verify-device', (req, res) => {
  const { fingerprint } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    db.get(`SELECT * FROM users WHERE phone = ?`, [decoded.phone], (err, user) => {
      const hasPaid = user?.subscription_expiry && new Date(user.subscription_expiry) > new Date();
      if (!hasPaid) return res.json({ allowed: true });
      if (!user?.device_fingerprint) {
        db.run(`UPDATE users SET device_fingerprint = ? WHERE phone = ?`, [fingerprint, decoded.phone]);
        res.json({ allowed: true });
      } else {
        res.json({ allowed: user.device_fingerprint === fingerprint });
      }
    });
  });
});

app.get('/api/plans', (req, res) => {
  res.json([
    { id: '2m', name: '2 Months', price: 199, days: 60 },
    { id: '6m', name: '6 Months', price: 499, days: 180 },
    { id: '12m', name: '12 Months', price: 999, days: 365 }
  ]);
});

app.post('/api/create-order', (req, res) => {
  const { planId } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    const orderId = 'order_' + Math.random().toString(36).substring(7);
    res.json({ orderId, amount: { '2m':199, '6m':499, '12m':999 }[planId] });
  });
});

app.post('/api/razorpay-webhook', express.raw({type: 'application/json'}), (req, res) => {
  const body = req.body.toString();
  try {
    const event = JSON.parse(body);
    if (event.event === 'payment.captured') {
      const phone = event.payload.payment.entity.notes?.phone;
      const days = event.payload.payment.entity.notes?.days;
      if (phone && days) {
        const newExpiry = new Date();
        newExpiry.setDate(newExpiry.getDate() + days);
        db.run(`UPDATE users SET subscription_expiry = ?, trial_expiry = ? WHERE phone = ?`, [newExpiry.toISOString(), null, phone]);
      }
    }
    res.json({ received: true });
  } catch(e) {
    res.status(400).send('Invalid JSON');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
