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
  blacklistFacilities: [
    'Pista 1',
    'Pista 2',
    'Pista Cristal',
    // 'Pista San Pablo',
  ], // Only include these facilities
  whitelistedStartTimes: [
    '19:30',
    '21:00',
    // '22:30',
  ], // Only include slots starting at these times
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

// Function to fetch API data
async function scrapeWebsite() {
  try {
    const results = {};
    const requests = [];

    // Get 8 days of data (today + 7 days ahead)
    for (let i = 0; i < 8; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
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

    // Send email notification
    return sendEmail(htmlContent, slotCount);
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
          if (!config.blacklistFacilities.includes(facilityName)) {
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
              if (!config.whitelistedStartTimes.includes(startTime)) {
                return;
              }

              // Format times for display
              const formattedStartTime = startTimeObj.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
              });

              const endTime = new Date(piece.end).toLocaleTimeString('en-US', {
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
      htmlContent = '<p><strong>No available slots found matching your criteria.</strong></p>';
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
        config.blacklistFacilities.forEach(facility => {
          htmlContent += `<th>${facility}</th>`;
        });
        htmlContent += '</tr>';

        // Sort times and create rows
        const sortedTimes = Object.keys(timeSlots).sort();
        sortedTimes.forEach(time => {
          htmlContent += '<tr>';
          config.blacklistFacilities.forEach(facility => {
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
async function sendEmail(content, slotCount) {
  const mailOptions = {
    from: config.email.from,
    to: config.email.to,
    subject: `${slotCount} free slots available`,
    html: `
      <h2>API Data Report</h2>
      <p><strong>Fetch Time:</strong> ${new Date().toISOString()}</p>
      <p><strong>API Source:</strong> ${config.baseApiUrl} (Facility ID: ${config.facilityId})</p>
      <h3>Data:</h3>
      <pre style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; overflow: auto;">${content}</pre>
    `
  };

  // In dry-run mode, just log and save to tmp.html
  if (isDryRun) {
    console.log('\n======= DRY RUN: EMAIL WOULD BE SENT =======\n');
    console.log('From:', mailOptions.from);
    console.log('To:', mailOptions.to);
    console.log('Subject:', mailOptions.subject);
    console.log('\nEmail Body Preview:');
    console.log(mailOptions.html.substring(0, 500) + '...');

    // Save to tmp.html file
    try {
      fs.writeFileSync('tmp.html', mailOptions.html);
      console.log('\nOutput saved to tmp.html');
    } catch (error) {
      console.error('Error saving to tmp.html:', error.message);
    }

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
  console.log(`Scraper started. Checking ${config.baseApiUrl}`);
  await scrapeWebsite();
  console.log('Scrape completed');
})();
