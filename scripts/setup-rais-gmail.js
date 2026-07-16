import 'dotenv/config';
import readline from 'readline';
import { google } from 'googleapis';

const required = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Missing Gmail settings: ${missing.join(', ')}`);
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
  ],
});

console.log('\n1. Open this Google authorization URL:\n');
console.log(authUrl);
console.log('\n2. After authorization, paste the returned code below.\n');

const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
prompt.question('Code: ', async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Revoke the old grant and retry.');
    }
    console.log('\nAdd this value to local .env and Render:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  } finally {
    prompt.close();
  }
});
