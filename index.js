// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Environment (Render এ environment variables হিসেবে যোগ করো)
const { TWILIO_SID, TWILIO_AUTH, TWILIO_PHONE, EMAIL_FROM, EMAIL_PASS } = process.env;

// Twilio & Nodemailer init (works only if env values are set)
let twClient = null;
if (TWILIO_SID && TWILIO_AUTH) twClient = twilio(TWILIO_SID, TWILIO_AUTH);

let mailer = null;
if (EMAIL_FROM && EMAIL_PASS) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
  });
}

// OTP store (in-memory). Production: replace with Redis.
const otpStore = {}; // { recipient: { otp, type, expiresAt, attempts } }
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

// 5-digit OTP
function genOtp5() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

// Home route (serves public/index.html automatically)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Send OTP
// Body: { type: "sms"|"email", to: "+8801XXXXXXX" | "someone@mail.com" }
app.post('/send-otp', async (req, res) => {
  try {
    const { type, to } = req.body;
    if (!type || !to) return res.status(400).json({ success:false, error:'type_and_to_required' });

    const otp = genOtp5();
    otpStore[to] = { otp, type, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };

    if (type === 'sms') {
      if (!twClient || !TWILIO_PHONE) return res.status(500).json({ success:false, error:'sms_not_configured' });
      await twClient.messages.create({ body:`Your OTP code: ${otp}`, from: TWILIO_PHONE, to });
      return res.json({ success:true, method:'sms', message:'otp_sent' });
    }

    if (type === 'email') {
      if (!mailer) return res.status(500).json({ success:false, error:'email_not_configured' });
      await mailer.sendMail({
        from: EMAIL_FROM,
        to,
        subject: 'Your verification code',
        text: `Your OTP code: ${otp}\nIt expires in 5 minutes.`
      });
      return res.json({ success:true, method:'email', message:'otp_sent' });
    }

    return res.status(400).json({ success:false, error:'invalid_type' });
  } catch (err) {
    console.error('send-otp err:', err && err.message ? err.message : err);
    return res.status(500).json({ success:false, error:'server_error', detail: (err && err.message) || err });
  }
});

// Verify OTP
// Body: { to:"recipient", otp:"12345" }
app.post('/verify-otp', (req, res) => {
  try {
    const { to, otp } = req.body;
    if (!to || !otp) return res.status(400).json({ success:false, error:'to_and_otp_required' });

    const row = otpStore[to];
    if (!row) return res.status(400).json({ success:false, error:'no_active_otp' });

    if (Date.now() > row.expiresAt) { delete otpStore[to]; return res.status(400).json({ success:false, error:'otp_expired' }); }

    row.attempts = (row.attempts||0) + 1;
    if (row.attempts > MAX_ATTEMPTS) { delete otpStore[to]; return res.status(429).json({ success:false, error:'too_many_attempts' }); }

    if (String(row.otp) === String(otp)) {
      delete otpStore[to];
      return res.json({ success:true, message:'verified' });
    } else {
      const attemptsLeft = MAX_ATTEMPTS - row.attempts;
      return res.status(400).json({ success:false, error:'invalid_otp', attemptsLeft });
    }
  } catch (err) {
    console.error('verify-otp err', err);
    return res.status(500).json({ success:false, error:'server_error' });
  }
});

// Health
app.get('/health', (req,res) => res.json({ok:true}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
