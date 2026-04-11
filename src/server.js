import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import { sendOtpToPhone, verifyPhoneOtp } from './authService.js';
import { ensureUserProfile } from './userService.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'DOT backend API' });
});

// POST /auth/send-otp { phone }
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone is required (E.164 format, e.g. +2637...)' });
    }

    await sendOtpToPhone(phone);
    return res.json({ success: true, message: 'OTP sent' });
  } catch (error) {
    console.error('send-otp error', error);
    return res.status(500).json({ error: error.message || 'Failed to send OTP' });
  }
});

// POST /auth/verify-otp { phone, token }
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, token } = req.body;
    if (!phone || !token) {
      return res.status(400).json({ error: 'phone and token are required' });
    }

    const data = await verifyPhoneOtp({ phone, token });

    // data contains { session, user }
    return res.json({
      success: true,
      user: data.user,
      session: data.session
    });
  } catch (error) {
    console.error('verify-otp error', error);
    return res.status(500).json({ error: error.message || 'Failed to verify OTP' });
  }
});

// POST /users/ensure-profile { userId, email, phone, fullName, role }
app.post('/users/ensure-profile', async (req, res) => {
  try {
    const { userId, email, phone, fullName, role } = req.body;

    if (!userId || !role) {
      return res.status(400).json({ error: 'userId and role are required' });
    }

    await ensureUserProfile({ userId, email, phone, fullName, role });
    return res.json({ success: true });
  } catch (error) {
    console.error('ensure-profile error', error);
    return res.status(500).json({ error: error.message || 'Failed to ensure user profile' });
  }
});

app.listen(PORT, () => {
  console.log(`DOT backend API listening on http://localhost:${PORT}`);
});

