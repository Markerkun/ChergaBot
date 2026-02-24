const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const TOKEN = '8614330054:AAFKCX9CGEVhCiN5kM7YnNCvl9rUSHX22Bk';
const bot = new TelegramBot(TOKEN, { polling: true });

// Store: chatId -> { carNumber, lastData, intervalId }
const watchers = {};

async function scrapeCarData(carNumber) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto('https://echerha.gov.ua/en', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Type car number into search
    await page.waitForSelector('input[placeholder*="number"], input[type="search"], input[name="search"]', { timeout: 10000 });
    const input = await page.$('input[placeholder*="number"], input[type="search"], input[name="search"]');
    
    if (!input) throw new Error('Search input not found');

    await input.click({ clickCount: 3 });
    await input.type(carNumber, { delay: 100 });
    await page.keyboard.press('Enter');

    // Wait for results
    await page.waitForTimeout(4000);

    // Try to get the result table/row
    const result = await page.evaluate(() => {
      // Look for table rows with queue registration data
      const rows = document.querySelectorAll('table tr, .queue-info, [class*="queue"], [class*="result"]');
      const data = {};

      // Try to find "Реєстрація в черзі" column or any queue info
      document.querySelectorAll('*').forEach(el => {
        const text = el.innerText || '';
        if (text.includes('Реєстрація') || text.includes('Registration') || text.includes('Queue')) {
          // Get next sibling or parent content
          if (el.nextElementSibling) {
            data.registration = el.nextElementSibling.innerText;
          }
        }
      });

      // Also grab all visible table data
      const tableData = [];
      document.querySelectorAll('table tr').forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length > 0) {
          const rowData = Array.from(cells).map(c => c.innerText.trim()).join(' | ');
          if (rowData.trim()) tableData.push(rowData);
        }
      });

      // Look for any card/result blocks
      const cards = [];
      document.querySelectorAll('[class*="card"], [class*="result"], [class*="item"]').forEach(el => {
        if (el.innerText && el.innerText.trim().length > 5) {
          cards.push(el.innerText.trim());
        }
      });

      return {
        registration: data.registration || null,
        tableData,
        cards: cards.slice(0, 5),
        bodyText: document.body.innerText.substring(0, 2000)
      };
    });

    await browser.close();
    return result;

  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }
}

function formatResult(carNumber, data) {
  let msg = `🚗 *Car: ${carNumber}*\n\n`;

  if (data.registration) {
    msg += `📋 *Queue Registration:*\n${data.registration}\n\n`;
  }

  if (data.tableData && data.tableData.length > 0) {
    msg += `📊 *Table Data:*\n`;
    data.tableData.forEach(row => {
      msg += `• ${row}\n`;
    });
    msg += '\n';
  }

  if (data.cards && data.cards.length > 0) {
    msg += `📝 *Info:*\n`;
    data.cards.forEach(card => {
      msg += `${card}\n---\n`;
    });
  }

  if (!data.registration && (!data.tableData || data.tableData.length === 0) && (!data.cards || data.cards.length === 0)) {
    msg += '❌ No data found for this car number. Make sure the number is registered in the queue.';
  }

  return msg;
}

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `👋 Welcome to eЧерга Monitor Bot!\n\n` +
    `Commands:\n` +
    `• Send your car number to check queue status\n` +
    `• /watch <car_number> - Monitor every 15 min\n` +
    `• /stop - Stop monitoring\n` +
    `• /status - Show current monitoring\n\n` +
    `Example: /watch AA1234BB`
  );
});

// /watch command - start monitoring
bot.onText(/\/watch (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const carNumber = match[1].trim().toUpperCase();

  // Stop existing watcher if any
  if (watchers[chatId] && watchers[chatId].intervalId) {
    clearInterval(watchers[chatId].intervalId);
  }

  bot.sendMessage(chatId, `🔍 Starting to monitor *${carNumber}*...\nChecking now and every 15 minutes.`, { parse_mode: 'Markdown' });

  // First check immediately
  try {
    const data = await scrapeCarData(carNumber);
    const msg_text = formatResult(carNumber, data);
    bot.sendMessage(chatId, msg_text, { parse_mode: 'Markdown' });

    watchers[chatId] = {
      carNumber,
      lastData: JSON.stringify(data),
      intervalId: null
    };

    // Set up interval - every 15 minutes
    const intervalId = setInterval(async () => {
      try {
        bot.sendMessage(chatId, `🔄 Checking ${carNumber}...`);
        const newData = await scrapeCarData(carNumber);
        const newDataStr = JSON.stringify(newData);

        if (newDataStr !== watchers[chatId].lastData) {
          // Data changed!
          bot.sendMessage(chatId, `🚨 *UPDATE DETECTED for ${carNumber}!*`, { parse_mode: 'Markdown' });
          bot.sendMessage(chatId, formatResult(carNumber, newData), { parse_mode: 'Markdown' });
          watchers[chatId].lastData = newDataStr;
        } else {
          bot.sendMessage(chatId, `✅ No changes for *${carNumber}* (${new Date().toLocaleTimeString()})`, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        bot.sendMessage(chatId, `⚠️ Error checking ${carNumber}: ${err.message}`);
      }
    }, 15 * 60 * 1000); // 15 minutes

    watchers[chatId].intervalId = intervalId;

  } catch (err) {
    bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nPossible causes:\n• Car number not found\n• Website temporarily unavailable\n• reCAPTCHA blocked the request`);
  }
});

// Send car number directly (without /watch)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip commands
  if (!text || text.startsWith('/')) return;

  // Looks like a car number (letters and numbers, 5-10 chars)
  if (/^[A-Za-zА-ЯҐЄІЇа-яґєії0-9]{4,12}$/.test(text.replace(/\s/g, ''))) {
    const carNumber = text.trim().toUpperCase();
    bot.sendMessage(chatId, `🔍 Searching for *${carNumber}*...`, { parse_mode: 'Markdown' });

    try {
      const data = await scrapeCarData(carNumber);
      bot.sendMessage(chatId, formatResult(carNumber, data), { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  }
});

// /stop command
bot.onText(/\/stop/, (msg) => {
  const chatId = msg.chat.id;
  if (watchers[chatId] && watchers[chatId].intervalId) {
    clearInterval(watchers[chatId].intervalId);
    const car = watchers[chatId].carNumber;
    delete watchers[chatId];
    bot.sendMessage(chatId, `✅ Stopped monitoring *${car}*`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `ℹ️ No active monitoring to stop.`);
  }
});

// /status command
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  if (watchers[chatId] && watchers[chatId].intervalId) {
    bot.sendMessage(chatId, `📡 Currently monitoring: *${watchers[chatId].carNumber}*`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `ℹ️ No active monitoring. Use /watch <car_number> to start.`);
  }
});

console.log('✅ Bot started! Waiting for messages...');
