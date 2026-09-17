import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import FormData from 'form-data';
import fetch from 'node-fetch';

import path from 'path';
import { fileURLToPath } from 'url';

import { initDB } from './db/init.js';
import { seedDB } from './db/seed.js';
import productsRouter from './routes/products.js';
import adminRouter from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Configure CORS allowlist
const defaultOrigins = [
  'https://asian-crackers-api.onrender.com',
  'https://asian-crackers.onrender.com',
  'https://vijayramanan12.github.io',
  'http://localhost:5000',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:8080',
  'null', // Allows local file:// origins during testing
];

const configuredOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((u) => u.trim())
  : [];

const allowedOrigins = Array.from(new Set([...defaultOrigins, ...configuredOrigins]));

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      // In development or if explicitly wildcard, allow
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      return callback(new Error(`Origin '${origin}' not allowed by CORS policy.`));
    },
    credentials: true,
  })
);

app.use(cookieParser());

// Expand JSON payload limit to accept high-resolution base64 invoices
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve frontend static assets (HTML, CSS, images) if hosted together
app.use(express.static(rootDir));

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'asian-crackers-backend',
    timestamp: new Date().toISOString(),
  });
});

// Modular Routes
app.use('/api/products', productsRouter);
app.use('/api/admin', adminRouter);

// WhatsApp Bill Dispatch (Preserved exactly as original)
app.post('/api/send-whatsapp-bill', async (req, res) => {
  try {
    const { customerName, customerPhone, pdfBase64, fileName, grandTotal, itemsListText } = req.body;

    if (!customerPhone || !pdfBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing recipient phone number or PDF payload.',
      });
    }

    if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN || WHATSAPP_TOKEN.includes('your_full_temporary_access_token')) {
      return res.status(500).json({
        success: false,
        error: 'Invalid Meta credentials. Please check PHONE_NUMBER_ID and WHATSAPP_TOKEN in your backend .env file.',
      });
    }

    // Format phone: strip non-numeric characters, add country code 91 if missing
    let cleanPhone = customerPhone.replace(/\D/g, '');
    if (cleanPhone.length === 10) {
      cleanPhone = `91${cleanPhone}`;
    }

    // STEP 1: Upload PDF buffer to Meta WhatsApp Media Endpoint
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const form = new FormData();
    form.append('file', pdfBuffer, {
      filename: fileName || 'Asian_Crackers_Invoice.pdf',
      contentType: 'application/pdf',
    });
    form.append('type', 'application/pdf');
    form.append('messaging_product', 'whatsapp');

    const mediaUploadRes = await fetch(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          ...form.getHeaders(),
        },
        body: form,
      }
    );

    const mediaData = await mediaUploadRes.json();

    if (!mediaUploadRes.ok || !mediaData.id) {
      console.error('Meta Media API Error:', mediaData);
      return res.status(500).json({
        success: false,
        error: mediaData.error?.message || 'Meta Media API failed to upload invoice buffer.',
      });
    }

    const mediaId = mediaData.id;

    // STEP 2: Send WhatsApp Document Message with Caption
    const messagePayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'document',
      document: {
        id: mediaId,
        caption: `வணக்கம் ${customerName}!\nHere is your official wholesale bill from Asian Crackers, Sivakasi.\nTotal: ₹${grandTotal}.\nThank you for celebrating with us!`,
        filename: fileName || 'Asian_Crackers_Invoice.pdf',
      },
    };

    const sendRes = await fetch(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      }
    );

    const sendData = await sendRes.json();

    if (!sendRes.ok) {
      console.error('Meta Message Dispatch Error:', sendData);
      return res.status(500).json({
        success: false,
        error: sendData.error?.message || 'WhatsApp message dispatch rejected by Meta.',
      });
    }

    return res.json({
      success: true,
      messageId: sendData.messages?.[0]?.id,
    });
  } catch (err) {
    console.error('Backend Server Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error processing bill.',
    });
  }
});

// Start Server and Database Initialization
const startServer = async () => {
  if (process.env.DATABASE_URL) {
    try {
      console.log('Connecting to PostgreSQL database...');
      await initDB();
      await seedDB();
      console.log('Database initialized and ready.');
    } catch (dbErr) {
      console.error('Database initialization error:', dbErr.message);
      console.error('Server will continue running, but product database operations may fail until DATABASE_URL is resolved.');
    }
  } else {
    console.warn('WARNING: DATABASE_URL is not set. Please configure DATABASE_URL in your environment.');
  }

  app.listen(PORT, HOST, () => {
    console.log(`Asian Crackers Backend running at http://${HOST}:${PORT}`);
  });
};

startServer();