require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const fs = require('fs');

// Check if we're in dry-run mode
const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) {
  console.log('Running in dry-run mode - changes will be detected but emails will only be logged, not sent');
}

// Configuration
const config = {
  baseApiUrl: 'https://api.sporttia.com/v7/timetable', // Base API URL
  facilityId: 3418, // Facility ID (idSC parameter)
  whitelistFacilities: [
    'Pista 1',
    'Pista 2',
    'Pista Cristal',
    'Pista San Pablo',
  ],
  whitelistedStartTimes: [
    '19:00',
    '19:30',
    '20:30',
    '21:00',
    '22:00',
    // '22:30',
  ],
  email: {
    service: 'gmail', // Email service (hardcoded)
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    from: 'doesntmatter@gmail.com', // Hardcoded sender
    to: process.env.EMAIL_USER, // Hardcoded recipient
  }
};

// Create email transporter
const transporter = nodemailer.createTransport({
  service: config.email.service,
  auth: config.email.auth
});

// Helper function to format date as YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Function to fetch tournament table data
async function scrapeTournamentData() {
  try {
    const tournamentUrl = 'https://www.todotorneos.com/torneo/torneoliga.php?&torneo=363177';
    console.log(`Fetching tournament data from: ${tournamentUrl}`);

    const response = await axios.get(tournamentUrl);
    const $ = cheerio.load(response.data);

    // Find the table with id "clasificacion"
    const table = $('#clasificacion');
    if (!table.length) {
      console.log('Tournament table not found');
      return '<p>Tournament table not available</p>';
    }

    let html = '<table border="1" cellpadding="5" style="border-collapse: collapse; width: 100%;">';

    // Process table rows
    table.find('tr').each((_, row) => {
      const cells = $(row).find('td, th');
      if (cells.length) { // amount of columns to add
        html += '<tr>';
        // Only take first 4 columns
        for (let i = 0; i < 4; i++) {
          const cellText = $(cells[i]).text().trim();
          const tag = cells.eq(i).is('th') ? 'th' : 'td';
          html += `<${tag}>${cellText}</${tag}>`;
        }
        html += '</tr>';
      }
    });

    html += '</table><br>';
    return html;
  } catch (error) {
    console.error('Error fetching tournament data:', error.message);
    return '<p>Error fetching tournament data</p>';
  }
}

// Function to fetch API data
async function scrapeWebsite() {
  try {
    const results = {};
    const requests = [];

    // Get 8 days of data (today + 7 days ahead), excluding weekends
    for (let i = 0; i < 8; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);

      // Skip weekends (Saturday = 6, Sunday = 0)
      if (date.getDay() === 0 || date.getDay() === 6) {
        continue;
      }

      const formattedDate = formatDate(date);

      const apiUrl = `${config.baseApiUrl}?idSC=${config.facilityId}&date=${formattedDate}&weekly=false`;
      console.log(`Preparing to fetch API data for ${formattedDate}: ${apiUrl}`);

      // Store each request in an array
      requests.push(
        axios.get(apiUrl)
          .then(response => {
            results[formattedDate] = response.data;
            return { date: formattedDate, success: true };
          })
          .catch(error => {
            console.error(`Error fetching data for ${formattedDate}:`, error.message);
            return { date: formattedDate, success: false, error: error.message };
          })
      );
    }

    // Wait for all requests to complete
    await Promise.all(requests);

    // Parse the combined API responses
    const { htmlContent, slotCount } = parseApiResponse(results);

    // Fetch tournament data
    const tournamentHtml = await scrapeTournamentData();

    // Send email notification
    return sendEmail(htmlContent, slotCount, tournamentHtml);
  } catch (error) {
    console.error('Error in scrapeWebsite function:', error.message);
  }
}

// Function to parse API response and extract FREE slots based on whitelist
function parseApiResponse(data) {
  try {
    const availableSlots = {};
    let totalSlotCount = 0;

    // Process each day's data
    Object.keys(data).forEach(date => {
      const dayData = data[date];

      if (dayData && dayData.one && dayData.one.columns) {
        const freeSlots = [];

        // Go through each facility (column)
        dayData.one.columns.forEach(column => {
          const facilityName = column.facility.name;

          // Skip facilities not in the whitelist
          if (!config.whitelistFacilities.includes(facilityName) && !isDryRun) {
            return;
          }

          // Go through each time slot
          column.pieces.forEach(piece => {
            // Check if the slot is FREE
            if (piece.mark === 'FREE') {
              // Extract the start time in HH:MM format
              const startTimeObj = new Date(piece.ini);
              const startTimeHours = startTimeObj.getHours().toString().padStart(2, '0');
              const startTimeMinutes = startTimeObj.getMinutes().toString().padStart(2, '0');
              const startTime = `${startTimeHours}:${startTimeMinutes}`;

              // Skip if start time is not in the whitelist
              if (!config.whitelistedStartTimes.includes(startTime) && !isDryRun) {
                return;
              }

              // Format times for display
              const formattedStartTime = startTimeObj.toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
              });

              const endTime = new Date(piece.end).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
              });

              freeSlots.push({
                facility: facilityName,
                start: formattedStartTime,
                end: endTime,
                date: new Date(piece.ini).toISOString().split('T')[0] // YYYY-MM-DD
              });
              totalSlotCount++;
            }
          });
        });

        // Add free slots for this day if any were found
        if (freeSlots.length > 0) {
          const rawDate = dayData.one.date;
          availableSlots[rawDate] = freeSlots;
        }
      }
    });

    // Format the results as HTML
    let htmlContent = '';

    if (Object.keys(availableSlots).length === 0) {
      htmlContent = '<p><strong>No available slots found</strong></p>';
    } else {
      // Sort dates chronologically
      const sortedDates = Object.keys(availableSlots).sort();

      sortedDates.forEach(rawDate => {
        // Format date using system locale
        const displayDate = new Date(rawDate).toLocaleDateString(undefined, {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        htmlContent += `<h3>${displayDate}</h3>`;

        // Group slots by time for this date
        const timeSlots = {};
        availableSlots[rawDate].forEach(slot => {
          if (!timeSlots[slot.start]) {
            timeSlots[slot.start] = [];
          }
          timeSlots[slot.start].push(slot.facility);
        });

        // Create table with facility columns
        htmlContent += '<table border="1" cellpadding="5" style="border-collapse: collapse; width: 100%;">';
        htmlContent += '<tr>';
        config.whitelistFacilities.forEach(facility => {
          htmlContent += `<th>${facility}</th>`;
        });
        htmlContent += '</tr>';

        // Sort times and create rows
        const sortedTimes = Object.keys(timeSlots).sort();
        sortedTimes.forEach(time => {
          htmlContent += '<tr>';
          config.whitelistFacilities.forEach(facility => {
            if (timeSlots[time].includes(facility)) {
              htmlContent += `<td>${time}</td>`;
            } else {
              htmlContent += '<td></td>';
            }
          });
          htmlContent += '</tr>';
        });

        htmlContent += '</table><br>';
      });
    }

    return { htmlContent, slotCount: totalSlotCount };
  } catch (error) {
    console.error('Error parsing API response:', error.message);
    return { htmlContent: `<p>Error parsing API response: ${error.message}</p>`, slotCount: 0 };
  }
}

// Function to send email notification
async function sendEmail(content, slotCount, tournamentData = '') {
  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject: `${slotCount} free slots available`,
    html: `
      <h3>Available Slots:</h3>
      <pre style="background-color: #f4f4f4; padding: 10px; overflow: auto;">${content}</pre>
      <h3>Leaderboard:</h3>
      <pre style="background-color: #f2f2f2; padding: 10px; overflow: auto;">${tournamentData}</pre>
    `
  };

  // In dry-run mode, just save to tmp.html
  if (isDryRun) {
    // Save to tmp.html file
    try {
      fs.writeFileSync('tmp.html', mailOptions.html);
      console.log('\nOutput saved to tmp.html');
    } catch (error) {
      console.error('Error saving to tmp.html:', error.message);
    }
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
  console.log(`Scraper started. Checking ${config.baseApiUrl}`);
  await scrapeWebsite();
  console.log('Scrape completed');
})();
