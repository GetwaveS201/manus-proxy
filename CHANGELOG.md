# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- User authentication system
- API rate limiting
- Conversation export (JSON, Markdown, PDF)
- Custom AI model selection
- Plugin architecture
- Docker support
- Comprehensive test suite
- Multi-language support (i18n)
- Voice input/output

## [2.0.0] - 2024-02-15

### Added
- 🎨 **Complete UI/UX Overhaul**
  - Beautiful dark theme with purple accents (#0f0f23, #667eea)
  - Professional sidebar with chat history
  - Modern gradient buttons and animations
  - Responsive design for mobile, tablet, and desktop

- 📝 **Markdown & Code Support**
  - Full markdown rendering using marked.js
  - Syntax highlighting with highlight.js (Atom One Dark theme)
  - Copy buttons on all code blocks
  - Styled headers, lists, tables, blockquotes, and links

- ♿ **Comprehensive Accessibility**
  - Semantic HTML5 elements (main, aside, nav, header)
  - ARIA roles and labels throughout
  - Full keyboard navigation support
  - Screen reader optimized
  - Focus-visible indicators
  - WCAG 2.1 AA compliant

- ⌨️ **Keyboard Shortcuts**
  - `Ctrl/Cmd + K` - New chat
  - `Escape` - Clear input
  - `Ctrl/Cmd + /` - Focus input
  - `Enter` - Send message
  - `Tab` - Navigate through elements

- 💾 **Enhanced Chat Management**
  - Persistent chat history with localStorage
  - Delete chats with confirmation dialog
  - Message timestamps
  - Chat titles from first message
  - QuotaExceededError handling (auto-trims to 10 chats)

- 📋 **Copy Functionality**
  - Copy entire messages with one click
  - Copy code blocks separately
  - Visual feedback on copy
  - Clipboard API integration

- 🎯 **Improved AI Routing**
  - Added email detection pattern ("my last X emails")
  - Expanded execution verb list (summarize, list, show, get)
  - Better confidence scoring
  - Handles Manus pending status responses

### Fixed
- 🐛 **Critical JavaScript Bugs**
  - Fixed chat.innerHTML variable name collision bug
  - Added localStorage error handling with try-catch
  - Fixed QuotaExceededError when storage is full
  - Added AbortController for request cancellation
  - Improved double-submit prevention
  - Fixed empty message validation

- 🎨 **UI/UX Improvements**
  - Dark theme scrollbar colors (#16162a, #2d2d44)
  - Mobile responsive breakpoints (768px, 480px)
  - Better contrast ratios for readability
  - Fixed message spacing and alignment
  - Improved loading states

- 🔧 **API Handling**
  - Better Gemini API leaked key detection
  - Improved Manus response extraction
  - Fixed "Processing..." stuck issue
  - Better error messages for users

### Changed
- Replaced inline `onclick` handlers with `addEventListener`
- Improved AI routing logic with pattern matching
- Enhanced error messages with helpful instructions
- Migrated from plaintext to markdown rendering for bot messages
- Updated frontend from basic chat to professional interface

### Security
- Removed all API keys from repository
- Added comprehensive .gitignore
- Environment variable validation
- Input sanitization improvements

## [1.0.0] - 2024-02-10

### Added
- ✨ **Initial Release**
  - Dual-AI routing system
  - Gemini API integration for Q&A
  - Manus API integration for automation tasks
  - Basic chat interface
  - Score-based routing algorithm
  - Environment variable configuration
  - Express.js server
  - CORS support
  - Request ID tracking
  - Colored console logging

- 🎯 **Smart Routing**
  - Question word detection (what, how, when, where, why)
  - Action verb detection (build, create, find, calculate)
  - Greeting detection (hi, hello, thanks)
  - Short message handling
  - Confidence scoring (0-100)

- 🔧 **Error Handling**
  - API quota exceeded detection
  - Leaked API key detection
  - Network error handling
  - Invalid request handling
  - User-friendly error messages

- 📊 **Logging System**
  - Color-coded log levels (INFO, WARN, ERROR, DEBUG)
  - Request ID correlation
  - Timestamp tracking
  - Detailed error logging

- 🌐 **Deployment**
  - Render.com deployment configuration
  - Auto-deploy on git push
  - Environment variable management
  - Health check endpoint

### Technical Details
- **Backend**: Node.js + Express.js
- **APIs**: Google Gemini AI + Anthropic Manus
- **Deployment**: Render.com
- **Frontend**: Vanilla JavaScript (HTML/CSS/JS in server.js)

## [0.1.0] - 2024-02-05

### Added
- 🚀 **Initial Prototype**
  - Basic Express server
  - Gemini API connection
  - Simple routing logic
  - Command-line testing

---

## Version Numbering

We use Semantic Versioning (MAJOR.MINOR.PATCH):

- **MAJOR** version for incompatible API changes
- **MINOR** version for new functionality (backwards compatible)
- **PATCH** version for backwards compatible bug fixes

## Types of Changes

- `Added` for new features
- `Changed` for changes in existing functionality
- `Deprecated` for soon-to-be removed features
- `Removed` for now removed features
- `Fixed` for bug fixes
- `Security` for vulnerability fixes

## Links

- [Unreleased]: https://github.com/GetwaveS201/manus-proxy/compare/v2.0.0...HEAD
- [2.0.0]: https://github.com/GetwaveS201/manus-proxy/compare/v1.0.0...v2.0.0
- [1.0.0]: https://github.com/GetwaveS201/manus-proxy/compare/v0.1.0...v1.0.0
- [0.1.0]: https://github.com/GetwaveS201/manus-proxy/releases/tag/v0.1.0
