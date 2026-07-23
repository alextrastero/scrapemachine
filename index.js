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
    'Pista cristal nueva 4',
    'Pista Cristal 3',
    'Pista 1',
  ],
  whitelistedStartTimes: [
    '20:30',
  ],
  email: {
    service: 'gmail', // Email service (hardcoded)
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    },
    from: 'doesntmatter@gmail.com', // Hardcoded sender
    to: process.env.EMAIL_USER, // Hardcoded recipient
  },
  booking: {
    windowDays: parseInt(process.env.BOOKING_WINDOW_DAYS, 10) || 7, // how many days ahead the booking window opens
    releaseHour: parseInt(process.env.BOOKING_RELEASE_HOUR, 10) || 9, // hour (local time) the window is assumed to flip FREE, adjust once known
    apiRoot: 'https://api.sporttia.com/v7',
    userId: parseInt(process.env.SPORTTIA_USER_ID, 10),
    userName: process.env.SPORTTIA_USER_NAME,
    sessionToken: process.env.SPORTTIA_SESSION_TOKEN, // _play-session-token cookie value
    pollIntervalMs: parseInt(process.env.BOOKING_POLL_INTERVAL_MS, 10) || 10000, // how often to re-check while polling
    pollMaxDurationMs: parseInt(process.env.BOOKING_POLL_MAX_DURATION_MS, 10) || 20 * 60 * 1000, // give up after this long
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

// Picks the best FREE slot for a single date's timetable columns, ranked by
// config.whitelistedStartTimes order first, then config.whitelistFacilities order.
// Returns { facilityName, pieceId, ini, end, price } or null if nothing matches.
function findBestSlot(columns) {
  for (const time of config.whitelistedStartTimes) {
    for (const facilityName of config.whitelistFacilities) {
      const column = columns.find(c => c.facility.name === facilityName);
      if (!column) continue;

      const piece = column.pieces.find(p => {
        if (p.mark !== 'FREE') return false;
        const startTimeObj = new Date(p.ini);
        const startTime = `${startTimeObj.getHours().toString().padStart(2, '0')}:${startTimeObj.getMinutes().toString().padStart(2, '0')}`;
        return startTime === time;
      });

      if (piece) {
        return {
          facilityName,
          facilityId: column.facility.id,
          pieceId: piece.id,
          ini: piece.ini,
          end: piece.end,
          price: piece.price,
        };
      }
    }
  }
  return null;
}

// Auth headers for the authenticated Sporttia endpoints (fares, bookings, me)
function bookingAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Cookie': `_play-session-token=${config.booking.sessionToken}`,
  };
}

// Looks up the member ('Socios') rate id for a given facility + time range.
// Required before booking, since the booking payload references this rate id.
async function getMemberRate(idFacility, ini, end) {
  const url = `${config.booking.apiRoot}/bookings/fares?ini=${ini}&end=${end}&idFacility=${idFacility}&idUser=${config.booking.userId}`;
  const response = await axios.get(url, { headers: bookingAuthHeaders() });

  const rate = response.data.fullRates
    .flatMap(r => r.prices)
    .find(p => p.name === 'Socios');

  if (!rate) throw new Error('Socios rate not found in fares response');
  return rate;
}

// Books a slot returned by findBestSlot(). Real side effect: creates an actual
// reservation on the Sporttia account and (per the account's payment setup) a bill.
async function bookSlot(slot) {
  const rate = await getMemberRate(slot.facilityId, slot.ini, slot.end);

  const payload = {
    idFacility: slot.facilityId,
    ini: slot.ini,
    end: slot.end,
    individual: false,
    idUser: config.booking.userId,
    name: config.booking.userName,
    occupants: [
      { idUser: config.booking.userId, idBoleto: null, rate: [{ id: rate.id, duration: rate.duration }] }
    ],
    isWithinGameCancellationPeriod: false,
    paymentForm: '',
  };

  const response = await axios.post(`${config.booking.apiRoot}/bookings`, payload, { headers: bookingAuthHeaders() });
  return response.data;
}

// Emails a success/failure/no-match notification for an auto-book run.
// Respects the global --dry-run flag (logs instead of sending).
async function notifyBookingResult({ success, slot, result, error }) {
  const bookingId = result?.booking?.id ?? result?.id;

  const subject = success
    ? `Booked: ${slot.facilityName} at ${slot.ini}`
    : slot
      ? `Auto-book FAILED for ${slot.facilityName} at ${slot.ini}`
      : 'Auto-book: no matching slot found';

  const html = success
    ? `<p>Booked <strong>${slot.facilityName}</strong> at ${slot.ini} for €${slot.price}.</p><p>Booking id: ${bookingId}</p>`
    : slot
      ? `<p>Found <strong>${slot.facilityName}</strong> at ${slot.ini} but booking failed: ${error?.message || 'unknown error'}</p>`
      : '<p>No matching FREE slot appeared for the target date within the polling window.</p>';

  const mailOptions = { from: config.email.from, to: config.email.to, subject, html };

  if (isDryRun) {
    console.log('[dry-run] Would send notification email:', subject);
    return;
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Notification email sent:', info.messageId);
  } catch (mailError) {
    console.error('Error sending notification email:', mailError.message);
  }
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

// Dry-run: fetch the target booking-window date and log which slot findBestSlot would pick
async function findSlotDryRun() {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + config.booking.windowDays);
  const formattedDate = formatDate(targetDate);

  const apiUrl = `${config.baseApiUrl}?idSC=${config.facilityId}&date=${formattedDate}&weekly=false`;
  console.log(`Checking ${formattedDate} (today + ${config.booking.windowDays} days): ${apiUrl}`);

  const response = await axios.get(apiUrl);
  const columns = response.data.one.columns;
  const slot = findBestSlot(columns);

  if (slot) {
    console.log(`Would book: ${slot.facilityName} at ${slot.ini} (piece id ${slot.pieceId}, price ${slot.price})`);
  } else {
    console.log('No matching FREE slot found for this date yet.');
  }
}

// Repeatedly checks the target date until a whitelisted slot goes FREE, then books it
// (unless dryRun is true, in which case it reports the match without calling bookSlot).
async function pollAndBook({ dryRun = false } = {}) {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + config.booking.windowDays);
  const formattedDate = formatDate(targetDate);
  const apiUrl = `${config.baseApiUrl}?idSC=${config.facilityId}&date=${formattedDate}&weekly=false`;

  const deadline = Date.now() + config.booking.pollMaxDurationMs;
  console.log(`Polling ${formattedDate} (dryRun=${dryRun}) every ${config.booking.pollIntervalMs}ms until ${new Date(deadline).toISOString()}`);

  while (Date.now() < deadline) {
    let slot = null;
    try {
      const response = await axios.get(apiUrl);
      slot = findBestSlot(response.data.one.columns);
    } catch (error) {
      console.error('Error checking availability:', error.message);
    }

    if (slot) {
      console.log(`Match found: ${slot.facilityName} at ${slot.ini} (piece id ${slot.pieceId}, price ${slot.price})`);

      if (dryRun) {
        console.log('Dry run - not booking.');
        return { slot, booked: false };
      }

      try {
        const result = await bookSlot(slot);
        const bookingId = result?.booking?.id ?? result?.id;
        console.log(`Booked! booking id ${bookingId}`, JSON.stringify(result));
        await notifyBookingResult({ success: true, slot, result });
        return { slot, booked: true, result };
      } catch (error) {
        console.error('Booking attempt failed:', error.message);
        await notifyBookingResult({ success: false, slot, error });
        return { slot, booked: false, error };
      }
    }

    await new Promise(resolve => setTimeout(resolve, config.booking.pollIntervalMs));
  }

  console.log('Polling window elapsed without finding a matching FREE slot.');
  if (!dryRun) {
    await notifyBookingResult({ success: false, slot: null });
  }
  return { slot: null, booked: false };
}

const isFindSlot = process.argv.includes('--find-slot');
const isPollDryRun = process.argv.includes('--poll-dry-run');
const isAutoBook = process.argv.includes('--auto-book');

// For GitHub Actions, just run once
(async () => {
  if (isFindSlot) {
    await findSlotDryRun();
    return;
  }
  if (isPollDryRun) {
    await pollAndBook({ dryRun: true });
    return;
  }
  if (isAutoBook) {
    await pollAndBook({ dryRun: isDryRun });
    return;
  }
  console.log(`Scraper started. Checking ${config.baseApiUrl}`);
  await scrapeWebsite();
  console.log('Scrape completed');
})();
