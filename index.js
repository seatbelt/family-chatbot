require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── YOUR DOC IDS ────────────────────────────────────────────────────
const DOC_IDS = {
  familyInfo: '1H5xT8z4fymzDEGQIqn1cvw65W9RG8iJasKdSZ_Y13mM',
  calendar:   '1H5xT8z4fymzDEGQIqn1cvw65W9RG8iJasKdSZ_Y13mM',
};
// ─────────────────────────────────────────────────────────────────────

// ─── ADMIN NUMBERS (family members who can save info) ────────────────
const ADMIN_NUMBERS = [
  '+19176991249', // Julie
  '+19177475625', // Astrid
  '+19176478537', // Jeff
  '+17032982684', // Beccah
  '+19144713904', // Peter
  '+19178218241', // John
];
// ─────────────────────────────────────────────────────────────────────

// ─── GOOGLE AUTH HELPER ──────────────────────────────────────────────
async function getAuthClient(scopes) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes,
  });
  return auth.getClient();
}
// ─────────────────────────────────────────────────────────────────────

async function getDocText(docId, authClient) {
  const docs = google.docs({ version: 'v1', auth: authClient });
  const res = await docs.documents.get({ documentId: docId });
  return res.data.body.content
    .map(block => block.paragraph?.elements?.map(e => e.textRun?.content).join('') || '')
    .join('')
    .trim();
}

async function getWeather(location) {
  try {
    const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=4`);
    const text = await response.text();
    return text.trim();
  } catch (err) {
    return 'Weather unavailable right now';
  }
}

async function appendToDoc(docId, note) {
  const authClient = await getAuthClient(['https://www.googleapis.com/auth/documents']);
  const docs = google.docs({ version: 'v1', auth: authClient });
  const timestamp = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: 1 },
          text: `[${timestamp}] ${note}\n`
        }
      }]
    }
  });
}

let FAMILY_CONTEXT = 'Loading family information...';

async function refreshContext() {
  try {
    const authClient = await getAuthClient(['https://www.googleapis.com/auth/documents.readonly']);

    const [familyInfo, calendar, weather] = await Promise.all([
      getDocText(DOC_IDS.familyInfo, authClient),
      getDocText(DOC_IDS.calendar, authClient),
      getWeather('New York City'),
    ]);

    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    FAMILY_CONTEXT = `
You are a warm, patient personal assistant for John, a family member who uses this via text message.
Today's date is ${today}.
Always be friendly, clear, and concise — replies should be short since this is SMS.
If John seems confused or needs help, remind him he can call Julie at (917) 699-1249.

You have two jobs:
1. When questions relate to family, schedules, contacts, or anything in the info below — use that information to answer.
2. For everything else — recipes, general knowledge, weather, history, recommendations, directions — answer naturally from your own knowledge like a helpful assistant would.

Never say you "only have access to" the family document. You are a general assistant who also happens to know family details.

When someone asks for directions or how to get somewhere, always include a Google Maps link in this format:
https://www.google.com/maps/dir/?api=1&destination=ADDRESS+WITH+PLUS+SIGNS
For example: https://www.google.com/maps/dir/?api=1&destination=140+Riverside+Drive+New+York+NY

CURRENT WEATHER (New York City):
${weather}

FAMILY INFORMATION & CALENDAR:
${familyInfo}
    `;

    console.log('Family context refreshed from Google Docs');
  } catch (err) {
    console.error('Failed to refresh context:', err.message, err.code, err.status);
  }
}

// Refresh on startup and every 30 minutes
refreshContext();
setInterval(refreshContext, 30 * 60 * 1000);

const conversations = {};

app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const userMessage = req.body.Body;

  // ─── ADMIN: Save info to Google Doc ────────────────────────────────
  if (ADMIN_NUMBERS.includes(from) && userMessage.toUpperCase().startsWith('ADMIN:')) {
    const note = userMessage.slice(6).trim();
    try {
      await appendToDoc(DOC_IDS.familyInfo, note);
      await refreshContext(); // Update Claude immediately
      res.set('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Got it, saved ✅ — "${note}"</Message></Response>`);
    } catch (err) {
      console.error('Failed to save admin note:', err.message);
      res.set('Content-Type', 'text/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, couldn't save that right now. Try again.</Message></Response>`);
    }
    return;
  }
  // ───────────────────────────────────────────────────────────────────

  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: userMessage });
  if (conversations[from].length > 20) {
    conversations[from] = conversations[from].slice(-20);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: FAMILY_CONTEXT,
      messages: conversations[from],
    });

    const reply = response.content[0].text;
    conversations[from].push({ role: 'assistant', content: reply });

    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);

  } catch (error) {
    console.error('Error:', error);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, having trouble right now. Please call Julie at (917) 699-1249.</Message></Response>`);
  }
});

app.listen(3000, () => console.log('Running on port 3000'));
