const browsers = require('playwright');
const browserName = process.env.PREVIEW_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error(`Unsupported test browser: ${browserName}`);
const browserType = {
  async launch(options) {
    const browser = await browsers[browserName].launch(options);
    // Windows WebKit reports a macOS UA with a Win32 platform. Monaco chooses
    // keyboard bindings from the UA, while the app uses navigator.platform.
    // Keep the test context internally consistent with this machine's keyboard.
    if (browserName === 'webkit' && process.platform === 'win32') {
      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15';
      for (const method of ['newPage', 'newContext']) {
        const create = browser[method].bind(browser);
        browser[method] = options => create({ userAgent, ...options });
      }
    }
    return browser;
  }
};
module.exports = { browserName, browserType };
