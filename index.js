require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── YOUR DOC IDS ────────────────────────────────────────────────────
const DOC_IDS = {
  familyInfo: 'paste-doc-id-here',
  calendar:   'https://docs.google.com/document/d/1H5xT8z4fymzDEGQIqn1cvw65W9RG8iJasKdSZ_Y13mM/edit?usp=sharing',
  medical:    'paste-doc-id-here',
};
// ─────────────────────────────────────────────────────────────────────

async function getDocText(docId, authClient) {
  const docs = google.docs({ version: 'v1', auth: authClient });
  const res = await docs.documents.get({ documentId: docId });
  return res.data.body.content
    .map(block => block.paragraph?.elements?.map(e => e.textRun?.content).join('') || '')
    .join('')
    .trim();
}

let FAMILY_CONTEXT = 'Loading family information...';

async function refreshContext() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/documents.readonly'],
    });
    const authClient = await auth.getClient();

    const [familyInfo, calendar, medical] = await Promise.all([
      getDocText(DOC_IDS.familyInfo, authClient),
      getDocText(DOC_IDS.calendar, authClient),
      getDocText(DOC_IDS.medical, authClient),
    ]);

    FAMILY_CONTEXT = `
You are a warm, patient assistant for [his name].
Always be friendly and concise — this is via text message so keep replies short.
If he seems confused or needs help, remind him he can call [wife] at [phone].

FAMILY INFORMATION:
${familyInfo}

UPCOMING CALENDAR:
${calendar}

MEDICAL INFORMATION:
${medical}
    `;

    console.log('Family context refreshed from Google Docs');
  } catch (err) {
    console.error('Failed to refresh context:', err.message);
  }
}

// Refresh on startup and every 30 minutes
refreshContext();
setInterval(refreshContext, 30 * 60 * 1000);

const conversations = {};

app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const userMessage = req.body.Body;

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
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Sorry, having trouble right now. Please call [wife] at [phone].</Message></Response>`);
  }
});

app.listen(3000, () => console.log('Running on port 3000'));
