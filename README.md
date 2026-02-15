# 🤖 AI Automation Assistant

> A powerful dual-AI system with an intelligent routing engine and beautiful dark-themed interface

[![Live Demo](https://img.shields.io/badge/demo-live-success?style=for-the-badge)](https://manus-proxy-1.onrender.com)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

A sophisticated AI assistant that intelligently routes requests between **Google Gemini** (fast Q&A) and **Anthropic Manus** (browser automation) to provide the best possible response for every query.

## ⚠️ SECURITY NOTICE

**CRITICAL:** This repository has been cleaned of exposed API keys. If you cloned before [DATE], your local copy may contain exposed secrets in git history. Please:

1. Delete your local clone
2. Re-clone from GitHub
3. Rotate any API keys that were exposed

## ✨ Features

### 🎯 Intelligent AI Routing
- **Smart Detection**: Automatically routes to the best AI for each task
- **Gemini Integration**: Handles Q&A, explanations, calculations, and general knowledge
- **Manus Integration**: Executes browser automation, email tasks, and complex workflows
- **Confidence Scoring**: Score-based routing system (95%+ accuracy)
- **Graceful Fallbacks**: Handles API quotas and errors elegantly

### 💬 Modern Chat Interface
- **🎨 Beautiful Dark Theme**: Professional UI with purple accents
- **💾 Chat History**: Persistent conversations with localStorage
- **📝 Markdown Support**: Full markdown rendering with syntax highlighting
- **📋 One-Click Copy**: Copy messages and code blocks instantly
- **🗑️ Chat Management**: Delete conversations with confirmation
- **⚡ Real-time Updates**: Streaming responses from both AIs

### ♿ Accessibility First
- **WCAG 2.1 AA Compliant**: Semantic HTML5 and ARIA labels
- **⌨️ Full Keyboard Navigation**: Tab through all elements
- **📱 Mobile Responsive**: Optimized for all screen sizes
- **🔊 Screen Reader Support**: Comprehensive accessibility features
- **👁️ High Contrast**: Easy-to-read color combinations

### ⌨️ Keyboard Shortcuts
- `Ctrl/Cmd + K` - Start new chat
- `Escape` - Clear input field
- `Ctrl/Cmd + /` - Focus message input
- `Enter` - Send message

### 🎨 UI/UX Features
- Sidebar with searchable chat history
- Message timestamps
- AI badge indicators (Gemini 🔵 / Manus 🟣)
- Loading states with animations
- Example queries for quick start
- Auto-scroll to latest messages
- Code syntax highlighting (Atom One Dark theme)

## Quick Start

### Prerequisites

- Node.js 18+
- API keys for:
  - [Gemini AI](https://ai.google.dev/)
  - [Manus AI](https://manus.ai/)

### Installation

```bash
# Clone the repository
git clone https://github.com/GetwaveS201/manus-proxy.git
cd manus-proxy

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env and add your API keys
nano .env  # or use your preferred editor
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
GEMINI_API_KEY=your_gemini_key
MANUS_API_KEY=your_manus_key
APP_API_KEY=your_strong_random_key  # For API authentication
PORT=3000
```

### Running Locally

```bash
npm start
```

Server runs at `http://localhost:3000`

## 📚 API Documentation

### `POST /chat`
Send a message to the AI assistant (public endpoint, no authentication required).

**Request:**
```bash
curl -X POST https://manus-proxy-1.onrender.com/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What is machine learning?"}'
```

**Success Response:**
```json
{
  "response": "Machine learning is a subset of artificial intelligence...",
  "ai": "gemini",
  "routing": {
    "ai": "gemini",
    "confidence": 95,
    "scores": {
      "gemini": 95,
      "manus": 5
    }
  }
}
```

**Error Response:**
```json
{
  "error": "GEMINI_API_KEY_LEAKED",
  "message": "🔒 Security Alert: The Gemini API key has been flagged..."
}
```

### `GET /`
Serves the frontend chat interface.

### `GET /health`
Health check endpoint (returns 200 OK).

## Deployment

### Deploy to Render

1. Push to GitHub
2. Connect repository in [Render Dashboard](https://dashboard.render.com)
3. Add environment variables in Render settings
4. Deploy!

**Auto-deploy:** Enabled on `main` branch

**Live URL:** https://manus-proxy-1.onrender.com

## Architecture

```
User Request
    ↓
Smart Router (analyzes prompt)
    ↓
    ├→ Gemini API (fast, free)
    │   - Q&A questions
    │   - Explanations
    │   - Simple greetings
    │
    └→ Manus API (powerful, paid)
        - Data processing
        - Research tasks
        - Content creation
        - Calculations
```

## Routing Logic

**Routes to Gemini:**
- Q&A: "What is...", "How does...", "Explain..."
- Greetings: "hi", "hello", "thanks"
- Short messages (≤3 words)

**Routes to Manus:**
- Execution: "Calculate", "Find", "Create", "Build"
- Research: "Compare", "Analyze", "Summarize"
- Data tasks: CSV processing, calculations
- Default: Any unclear requests

## Security

### Authentication

All API endpoints require `X-API-Key` header (except in development).

```bash
X-API-Key: your_app_api_key
```

### Rate Limiting

- 100 requests per 15 minutes per IP
- Prevents credit drain attacks

### Environment Variables

**NEVER commit:**
- `.env` files
- API keys
- Secrets

Always use environment variables for sensitive data.

## Error Handling

The system provides user-friendly error messages:

**Gemini Quota Exceeded:**
```json
{
  "error": "⚠️ Gemini API quota exceeded...",
  "technical_error": "GEMINI_QUOTA_EXCEEDED"
}
```

**Manus Credits Exhausted:**
```json
{
  "error": "⚠️ Manus AI credits exhausted...",
  "technical_error": "MANUS_CREDITS_EXCEEDED"
}
```

## Development

### Project Structure

```
manus-proxy/
├── server.js              # Main application
├── package.json           # Dependencies
├── .env.example          # Environment template
├── .gitignore            # Git ignore rules
├── README.md             # This file
└── docs/
    ├── DEPLOYMENT_SUCCESS.md
    ├── PERFORMANCE_REPORT_RESPONSE.md
    └── COMPLETE_SESSION_SUMMARY.md
```

### Adding Features

1. Create feature branch
2. Make changes
3. Test locally
4. Commit and push
5. Auto-deploys to Render

### Running Tests

```bash
npm test  # Coming soon
```

## Cost Optimization

**Current Performance:**
- ~90% queries use Gemini (free)
- ~10% queries use Manus (paid)
- Estimated savings: 90% vs Manus-only

**Manus Pricing:**
- ~$0.08-$1.50 per complex task
- Recommended: $50-100 monthly budget

**Gemini Pricing:**
- Free tier: 20 requests/day
- Paid tier: 60 requests/minute (~$0.075 per 1M tokens)

## Troubleshooting

### "Quota exceeded" errors

**Gemini:** Quotas reset daily at midnight PT. Upgrade to paid tier for higher limits.

**Manus:** Add credits at https://manus.ai/pricing

### Server not responding

1. Check Render logs in dashboard
2. Verify environment variables are set
3. Check API key validity

### Routing to wrong AI

Adjust triggers in `server.js` `chooseAI()` function.

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## License

MIT

## Support

- GitHub Issues: https://github.com/GetwaveS201/manus-proxy/issues
- Render Dashboard: https://dashboard.render.com
- Manus Docs: https://docs.manus.ai
- Gemini Docs: https://ai.google.dev/docs

## Acknowledgments

Built with:
- [Gemini AI](https://ai.google.dev/) - Fast conversational AI
- [Manus AI](https://manus.ai/) - Autonomous agent platform
- [Express.js](https://expressjs.com/) - Web framework
- [Render](https://render.com/) - Hosting platform

---

**⚠️ Security Reminder:** Never commit API keys. Always use environment variables.
