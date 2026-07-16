# Rais feature inside Dispatch Bot

Rais runs through the existing dispatcher Telegram bot. Use `/rais` as shown below, or replace it with the bot's actual @username.

## Configuration

Add these settings to the dispatcher bot environment and to Render:

```text
RAIS_ENABLED=true
RAIS_ALLOWED_CHAT_IDS=<comma-separated Telegram chat IDs>
RAIS_ALLOWED_USERNAMES=<optional comma-separated usernames>
GMAIL_CLIENT_ID=<Google OAuth client ID>
GMAIL_CLIENT_SECRET=<Google OAuth client secret>
GMAIL_REDIRECT_URI=<Google OAuth redirect URI>
GMAIL_REFRESH_TOKEN=<Google OAuth refresh token>
DEFAULT_EMAIL_TO=<fallback recipient>
BOT_DASHBOARD_PASSWORD=<strong dashboard password>
```

Run `/rais_chatid` in a Telegram group to get its chat ID. Chats listed in
`RAIS_ALLOWED_CHAT_IDS` are dedicated to Rais so their driver photos and
documents are never processed as dispatcher rate confirmations.

Whole-bot dashboard: `/dashboard/` on the deployed service URL.


/rais onsite at PU 8997849

/rais onsite at DEL 8997849

/rais checking BOL 8997849

/rais checking POD 8997849

/rais traffic 8997849

### 6. Forward a Driver Update
**Option A — Tag in the same message:**
Type the update text and tag the bot in one message
```
Load# 8997849
Status: Rolling
Current Loc: Chicago, IL
Miles left: 120
/rais
```

**Option B — Reply to driver's message:**
Reply to the driver's message → tag bot
```
/rais 8997849
```
Sends that exact message text to the broker.

---

## Bot replies
- `✓` — Email sent successfully
- `Load not found. Check number.` — Load number not in Gmail. Check it.
- `No files found. Reply to first photo.` — You didn't reply to a photo
- `Reply to first photo then tag me.` — For BOL/POD, must reply to first photo
- `Need a load number.` — You forgot the load number

---

## Rules
1. Load number must be in the message
2. For BOL/POD/traffic — always reply to the **first** photo the driver sent
3. Bot collects all photos between the first photo and your tag automatically
4. Load number must match the subject line of the email thread exactly

---

## Examples of load numbers
- Regular: `8997849`
- With dash: `31426-50165`

Both formats work.

---

## Quick reference
| Situation | Command |
|---|---|
| Arrived at pickup | `/rais onsite at PU [load#]` |
| Arrived at delivery | `/rais onsite at DEL [load#]` |
| Picked up, sending BOL | Reply to first BOL photo → `/rais checking BOL [load#]` |
| Delivered, sending POD | Reply to first POD photo → `/rais checking POD [load#]` |
| Traffic photos | Reply to first photo → `/rais traffic [load#]` |
| Driver status update | Tag bot in message with update text + load# |
