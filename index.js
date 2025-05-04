require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

// Check if we're in dry-run mode
const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) {
  console.log('Running in dry-run mode - changes will be detected but emails will only be logged, not sent');
}

// Configuration
const config = {
  url: 'https://example.com', // URL to scrape (hardcoded)
  email: {
    service: 'gmail', // Email service (hardcoded)
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    from: 'doesntmatter@gmail.com', // Hardcoded sender
    to: process.env.EMAIL_USER, // Hardcoded recipient
    subject: 'Website Update Notification' // Hardcoded subject
  }
};

// Create email transporter
const transporter = nodemailer.createTransport({
  service: config.email.service,
  auth: config.email.auth
});

// Function to scrape website
async function scrapeWebsite() {
  try {
    console.log(`Scraping ${config.url} at ${new Date().toISOString()}`);

    const response = await axios.get(config.url);
    const $ = cheerio.load(response.data);
    const content = $('body').html().trim(); // Get the full HTML content

    // Send email notification
    return sendEmail(content);
  } catch (error) {
    console.error('Error scraping website:', error.message);
  }
}

// Function to send email notification
async function sendEmail(content) {
  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject: config.email.subject,
    html: `
      <p>Time: ${new Date().toISOString()}</p>
      <pre>${content}</pre>
    `
  };

  // In dry-run mode, just log
  if (isDryRun) {
    console.log('\n======= DRY RUN: EMAIL WOULD BE SENT =======\n');
    console.log('From:', mailOptions.from);
    console.log('To:', mailOptions.to);
    console.log('Subject:', mailOptions.subject);
    console.log('\nEmail Body Preview:');
    console.log(mailOptions.html.substring(0, 500) + '...');
    console.log('\n==============================================\n');
    return;
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
  } catch (error) {
    console.error('Error sending email:', error.message);
  }
}

// For GitHub Actions, just run once
(async () => {
  console.log(`Scraper started. Checking ${config.url}`);
  await scrapeWebsite();
  console.log('Scrape completed');
})();
