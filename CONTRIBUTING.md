# Contributing to AI Automation Assistant

First off, thank you for considering contributing to AI Automation Assistant! 🎉

## Code of Conduct

This project and everyone participating in it is governed by respect, professionalism, and inclusivity. By participating, you are expected to uphold this code.

## How Can I Contribute?

### 🐛 Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When creating a bug report, include as many details as possible:

**Bug Report Template:**
```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '...'
3. Scroll down to '...'
4. See error

**Expected behavior**
What you expected to happen.

**Screenshots**
If applicable, add screenshots.

**Environment:**
 - OS: [e.g. Windows 11]
 - Browser: [e.g. Chrome 120]
 - Node version: [e.g. 18.17.0]

**Additional context**
Any other context about the problem.
```

### 💡 Suggesting Features

Feature requests are welcome! Please provide:

- **Clear use case**: Why is this feature needed?
- **Detailed description**: What should it do?
- **Examples**: How would it work?
- **Alternatives**: What alternatives have you considered?

### 🔧 Pull Requests

1. **Fork the repository** and create your branch from `master`
2. **Make your changes** following our coding standards
3. **Test your changes** thoroughly
4. **Update documentation** if needed
5. **Commit with clear messages** following our convention
6. **Submit a pull request**

## Development Setup

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn
- Git
- A code editor (VS Code recommended)

### Local Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/manus-proxy.git
cd manus-proxy

# 2. Install dependencies
npm install

# 3. Create .env file
cp .env.example .env

# 4. Add your API keys to .env
GEMINI_API_KEY=your_key_here
MANUS_API_KEY=your_key_here

# 5. Start development server
npm start

# 6. Open browser
# Navigate to http://localhost:3000
```

### Project Structure

```
manus-proxy/
├── server.js              # Main application (backend + frontend)
├── package.json           # Dependencies and scripts
├── .env.example          # Environment template
├── .gitignore            # Git ignore rules
├── README.md             # Project documentation
├── CONTRIBUTING.md       # This file
├── LICENSE               # MIT License
└── CHANGELOG.md          # Version history
```

## Coding Standards

### JavaScript Style Guide

We follow modern JavaScript best practices:

**✅ DO:**
```javascript
// Use const/let, never var
const apiKey = process.env.GEMINI_API_KEY;
let score = 0;

// Use async/await
async function fetchData() {
  const response = await fetch(url);
  return await response.json();
}

// Use template literals
const message = `Hello, ${name}!`;

// Use descriptive variable names
const userMessage = input.value.trim();

// Add comments for complex logic
// Calculate confidence score based on keyword matching
const confidence = Math.min(100, manusScore);
```

**❌ DON'T:**
```javascript
// Don't use var
var x = 5;

// Don't use callbacks when async/await is better
fetch(url).then(res => res.json()).then(data => ...);

// Don't use unclear variable names
const x = input.value;

// Don't leave commented-out code
// const oldFunction = () => { ... };
```

### Commit Message Convention

We use conventional commits for clear history:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding tests
- `chore`: Maintenance tasks

**Examples:**
```bash
feat(chat): add markdown rendering for bot messages

- Added marked.js for markdown parsing
- Added highlight.js for code syntax highlighting
- Added copy buttons on code blocks

Closes #42

---

fix(routing): improve email detection pattern

Changed regex to match "my last X emails" pattern more reliably.

Fixes #38

---

docs(readme): update API documentation

Added examples for all endpoints and improved formatting.
```

### Code Review Process

All submissions require review. We use GitHub pull requests for this purpose. The process:

1. **Automated checks** run on every PR (linting, tests)
2. **Code review** by maintainers
3. **Address feedback** if any changes are requested
4. **Merge** once approved

**Review Checklist:**
- [ ] Code follows style guidelines
- [ ] Comments added for complex logic
- [ ] Documentation updated if needed
- [ ] No console.log statements left
- [ ] Works on mobile and desktop
- [ ] Accessible (keyboard + screen reader)
- [ ] No security issues (API keys, XSS, etc.)

## Testing

### Manual Testing

Before submitting a PR, test:

1. **Basic functionality**
   - Send messages
   - Receive responses
   - Chat history saves/loads

2. **Edge cases**
   - Empty messages
   - Very long messages
   - Special characters
   - API errors

3. **Browser compatibility**
   - Chrome/Edge
   - Firefox
   - Safari (if possible)

4. **Responsive design**
   - Desktop (1920x1080)
   - Tablet (768x1024)
   - Mobile (375x667)

5. **Accessibility**
   - Keyboard navigation (Tab, Enter, Escape)
   - Screen reader (NVDA, JAWS, or VoiceOver)
   - Color contrast

### Automated Testing (Coming Soon)

```bash
# Run tests
npm test

# Run linter
npm run lint

# Check formatting
npm run format:check

# Fix formatting
npm run format:fix
```

## Security

### Reporting Security Issues

**Do NOT open a public issue for security vulnerabilities!**

Instead, email [your-email@example.com] with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We'll respond within 48 hours.

### Security Best Practices

- **Never commit API keys** or secrets
- **Always use environment variables** for sensitive data
- **Validate all user input** on both client and server
- **Use HTTPS** in production
- **Keep dependencies updated** regularly
- **Follow OWASP guidelines** for web security

## Documentation

### When to Update Documentation

Update documentation when you:
- Add new features
- Change existing features
- Fix bugs that affect usage
- Update dependencies
- Change API endpoints

### Documentation Files

- `README.md` - Main project documentation
- `CONTRIBUTING.md` - This file
- `CHANGELOG.md` - Version history
- Code comments - Inline documentation

### Writing Good Documentation

**✅ Good Example:**
```markdown
## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/GetwaveS201/manus-proxy.git
   cd manus-proxy
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with your API keys:
   ```env
   GEMINI_API_KEY=your_key_here
   MANUS_API_KEY=your_key_here
   ```
```

**❌ Bad Example:**
```markdown
Install it and run it.
```

## Questions?

- 💬 **GitHub Discussions**: For general questions
- 🐛 **GitHub Issues**: For bug reports and feature requests
- 📧 **Email**: [your-email@example.com]

## Recognition

Contributors will be:
- Listed in README.md
- Mentioned in CHANGELOG.md
- Credited in release notes

Thank you for contributing! 🙌

---

**Remember:** The best way to contribute is to be respectful, patient, and helpful to others. Happy coding! 🚀
