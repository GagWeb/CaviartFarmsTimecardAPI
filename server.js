/**
 * This is the main Node.js server script for your project
 * Check out the two endpoints this back-end API provides in fastify.get and fastify.post below
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require("path");
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});
const express = require('express');
const app = express();
const axios = require('axios');

const PANTRY_ID = 'bba6023d-25bc-4317-a973-a0fc6de534b7'; // from getpantry.cloud
const BASKET = 'CaviartFarmsTimecardAPI'; // your basket name
const BASE_URL = `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/${BASKET}`;

require('dotenv').config();

// Require the fastify framework and instantiate it
const fastify = require("fastify")({
  // Set this to true for detailed logging:
  logger: false,
});

const crypto = require('crypto');

function sha256(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

// ADD FAVORITES ARRAY VARIABLE FROM TODO HERE

// Setup our static files
fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/", // optional: default '/'
});

// Formbody lets us parse incoming forms
fastify.register(require("@fastify/formbody"));

// View is a templating manager for fastify
fastify.register(require("@fastify/view"), {
  engine: {
    handlebars: require("handlebars"),
  },
});


// === CONFIGURATION ===
const BASE_URL     = 'https://caviartfarmstimecardapi.onrender.com/h';
const MAX_RETRIES  = 3;       // how many times to retry on 429
const DEBOUNCE_MS  = 300;     // hold-off before firing a new request

// === UTILITY FUNCTIONS ===
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// simple debounce (if you don’t want to pull in lodash.debounce)
function debounce(fn, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

// detect iOS Safari (including iPadOS)
const ua = navigator.userAgent || '';
const isIOS_Safari = /Safari/.test(ua) && /iPhone|iPad|iPod/.test(ua);

// === CLIENT-SIDE CACHING / DEDUPLICATION STATE ===
let inFlightPromise = null;
let lastETag        = null;

// === PUBLIC API ===
// call readData(); multiple calls within DEBOUNCE_MS will collapse
const readData = debounce(() => _readDataWithRetries(), DEBOUNCE_MS);

// === INTERNAL WORKHORSE ===
async function _readDataWithRetries(retries = 0) {
  // 1) Deduplicate: if there’s already a call in progress, return it
  if (inFlightPromise) {
    return inFlightPromise;
  }

  // 2) Kick off the actual request
  inFlightPromise = (async () => {
    try {
      // 3) Conditional cache header
      const headers = {};
      if (lastETag) {
        headers['If-None-Match'] = lastETag;
      }

      const res = await axios.get(BASE_URL, { headers });

      // 4) Handle 304 Not Modified
      if (res.status === 304) {
        return null; // no new data
      }

      // 5) Store new ETag for next time
      if (res.headers.etag) {
        lastETag = res.headers.etag;
      }

      return res.data;
    } catch (err) {
      const status = err.response?.status;

      // 6) Rate-limit retry logic
      if (status === 429 && retries < MAX_RETRIES) {
        // read server’s Retry-After or pick a base delay
        const serverDelay = parseInt(err.response.headers['retry-after'] || '0', 10) * 1000;
        const baseDelay   = isIOS_Safari ? 60000 : 30000; // slower back-off on iOS Safari
        const delay       = serverDelay > 0 ? serverDelay : baseDelay;

        console.warn(`429 hit (Safari? ${isIOS_Safari}). retry #${retries+1} in ${delay/1000}s`);
        await sleep(delay);
        return _readDataWithRetries(retries + 1);
      }

      // 7) Bubble up any other errors
      throw err;
    } finally {
      // 8) Clear the in-flight marker no matter what
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}


async function writeData(data, url = BASE_URL) {
  try {
    await axios.post(url, data);
    console.log("Pantry updated.");
  } catch (err) {
    console.error("Failed to update Pantry:", err.message);
  }
}


function formatData(obj) {
  return JSON.stringify(obj, null, 2);
}



fastify.get('/h', async (request, reply) => {
  // Pull the `code` param from the URL
  const { code } = request.query;

  // Serve a minimal HTML page; everything else happens inside the <script> below
  reply.type('text/html').send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Clock In/Out</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 2rem;
          }
          input {
            font-size: 1.5rem;
            padding: 0.5rem;
          }
          button {
            font-size: 2rem;
            padding: 0.5rem 1rem;
          }
          #warning {
            color: red;
            margin-top: 1rem;
            font-size: 1.25rem;
          }
        </style>
      </head>
      <body>
        <h1>Clock In / Out</h1>
        <form id="loginForm">
          <div>
            <label for="name">Name:</label>
            <input id="name" type="text" placeholder="name" autocomplete="off" />
          </div>
          <br/>
          <div>
            <label for="pass">Password:</label>
            <input id="pass" type="text" placeholder="password" autocomplete="off" />
          </div>
          <br/>
          <button id="submit" type="submit">Clock in/out</button>
        </form>
        <div id="warning"></div>

        <script>
        (function() {
          // ELEMENT REFERENCES
          const nameInput = document.getElementById('name');
          const passInput = document.getElementById('pass');
          const warningDiv = document.getElementById('warning');
          const loginForm = document.getElementById('loginForm');

          // Utility: delay (ms)
          function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
          }

          // Step 1: When page loads, try to prefill from localStorage, but ONLY after verifying both /verify and /timecheck succeed.
          async function init() {
            const storedName = localStorage.getItem('loginName');
            const storedPass = localStorage.getItem('pass');
            if (!storedName || !storedPass) {
              // Nothing to prefill; user must type in manually
              return;
            }

            try {
              // 1A) Check /verify
              const verifyResp = await fetch(
                '/verify?username=' + 
                  encodeURIComponent(storedName) +
                  '&pass=' + 
                  encodeURIComponent(storedPass)
              );
              if (!verifyResp.ok) throw new Error('Verify request failed');
              const isVerified = await verifyResp.json();
              if (!isVerified) {
                console.warn('Stored credentials did not verify.');
                return;
              }

              // 1B) Check /timecheck
              const timeResp = await fetch('/timecheck?hash=' + encodeURIComponent('${code}'));
              if (!timeResp.ok) throw new Error('Timecheck request failed');
              const isTimeValid = await timeResp.json();
              if (!isTimeValid) {
                console.warn('Timecheck failed.');
                return;
              }

              // Only if both are true do we prefill
              nameInput.value = storedName;
              passInput.value = storedPass;
            } catch (err) {
              console.error('Prefill failed:', err);
            }
          }

          // Step 2: The form “submit” handler
          loginForm.addEventListener('submit', async function(event) {
            event.preventDefault();
            warningDiv.textContent = ''; // clear any existing warning

            const rawName = nameInput.value.trim().toLowerCase();
            const rawPass = passInput.value.trim();
            if (!rawName || !rawPass) {
              warningDiv.textContent = 'Please enter both name and password.';
              return;
            }

            try {
              // 2A) Verify credentials
              const verifyResp = await fetch(
                '/verify?username=' +
                  encodeURIComponent(rawName) +
                  '&pass=' +
                  encodeURIComponent(rawPass)
              );
              if (!verifyResp.ok) throw new Error('Verify request failed');
              const isVerified = await verifyResp.json();
              if (!isVerified) {
                warningDiv.textContent = 'Name or password is incorrect.';
                return;
              }

              // 2B) Verify timecode
              const timeResp = await fetch('/timecheck?hash=' + encodeURIComponent('${code}'));
              if (!timeResp.ok) throw new Error('Timecheck request failed');
              const isTimeValid = await timeResp.json();
              if (!isTimeValid) {
                warningDiv.textContent = 'Invalid timecode. Cannot clock in/out. You may have to scan the QR code again.';
                return;
              }

              // 2C) Fetch the latest JSON from Pantry (instead of embedding at render time)
              const dataResp = await fetch('/data.json');
              if (!dataResp.ok) throw new Error('Failed to fetch data.json');
              const data = await dataResp.json();

              // 2D) Look up this user in the JSON
              const employeeKey = rawName;
              if (!data[employeeKey]) {
                warningDiv.textContent = 'Sorry, that name does not exist.';
                return;
              }
              const employeeData = data[employeeKey];

              // 2E) Compute “current time” (in seconds since epoch, converted to EST)
              let now = Math.floor(Date.now() / 1000);
              // Convert UTC to Eastern. If you ever need DST, swap to 4h or use a library.
              now -= 60 * 60 * 5; 

              // 2F) Decide whether to “clock in” (push new record) or “clock out” (update last record)
              let lastAction = employeeData.lastAction;
              let isBackupRun = false;

              if (lastAction === 'in') {
                // If they forgot to clock out for >12 hours, assume they really did clock out
                const lastHourEntry = employeeData.hours[employeeData.hours.length - 1];
                if (now - lastHourEntry.in > 60 * 60 * 12) {
                  lastAction = 'out';
                  isBackupRun = true;
                }
              }

              if (lastAction === 'out') {
                // Clocking in → push a new entry with “in”=now, “out”=now+1 as placeholder
                employeeData.hours.push({ in: now, out: now + 1 });
                employeeData.lastAction = 'in';
              } else {
                // lastAction === 'in' → clocking out, so update the “out” timestamp
                const lastHourEntry = employeeData.hours[employeeData.hours.length - 1];
                lastHourEntry.out = now;
                employeeData.lastAction = 'out';
              }

              // 2G) Write the updated data object back to Pantry
              data[employeeKey] = employeeData;
              const updateResp = await fetch('/updateData', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ data })
              });
              if (!updateResp.ok) throw new Error('Failed to send /updateData');

              // 2H) Store “last used credentials” in localStorage
              localStorage.setItem('loginName', rawName);
              localStorage.setItem('pass', rawPass);

              // 2I) Show success message (and optional backup‐run note)
              document.body.innerHTML = 
                '<h1>You have successfully clocked ' + employeeData.lastAction + '.</h1>' +
                (isBackupRun
                  ? '<br/><h2>It looks like you may have forgotten to clock out previously. Please confirm with Terry if this is in error.</h2>'
                  : ''
                );

            } catch (err) {
              console.error('Unexpected error in login flow:', err);
              warningDiv.textContent = 'An unexpected error occurred. Please try again.';
            }
          });

          // Fire the “init” logic now
          init();

        })();
        </script>
      </body>
    </html>
  `);
});


fastify.get('/email', async(request, reply) => {
  var totalData = await readData();
  var employee;
  var keys = Object.keys(totalData);
  var data;
  for(var j = 0; j < keys.length; j++){
    console.log(keys[j]);
    var htmlContent = "";
    data = totalData[keys[j]]["hours"];
    employee = keys[j];
    var totalHours = 0;
    
    for(var i = 0; i < data.length; i++){
      console.log(data[i]);
      htmlContent += "<tr><td>" + new Date(data[i]["in"] * 1000).toISOString().replace('T', ' ').substring(0, 19) + "</td>";
      htmlContent += "<td>" + new Date(data[i]["out"] * 1000).toISOString().replace('T', ' ').substring(0, 19) + "</td>";
      htmlContent += "<td>" + (Math.round((Math.round((data[i]["out"] - data[i]["in"]) / 60) / 60) * 10))/10 + "</td></tr>";
      totalHours += (Math.round((Math.round((data[i]["out"] - data[i]["in"]) / 60) / 60) * 10))/10;
    }

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: "lizziejinks@gmail.com",
      subject: employee + "'s Hours",
      html: "<style>td, th {border: 1px solid #dddddd;text-align: left;padding: 8px;}tr:nth-child(even) {background-color: #dddddd;}</style><table style='font-size: 50%; border-collapse: collapse; width: 100%;'><tr><th>In</th><th>Out</th><th>Hours</th></tr>" + htmlContent + "</table><br><br><h2>Total Hours: " + totalHours + "</h2>"
    };
    
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("❌ sendMail error:", error);
      } else {
        console.log("✅ Email sent:", info);
      }
    });

  }
  
  await writeData(totalData, `https://getpantry.cloud/apiv1/pantry/${PANTRY_ID}/basket/Backup`);
  var newData = totalData;
  for(var i = 0; i < keys.length; i++){
    newData[keys[i]]["hours"] = new Array();
  }
  await writeData(newData);
  
});

fastify.get('/data.json', async(request, reply) => {
  return await readData();
});

fastify.get('/verify', async(request, reply) => {
  const {username, pass} = request.query;
  var data = await readData();
  console.log(pass + " | " + sha256(pass) + " | " + data[username]["pass"] + " | " + (data[username]["pass"] == sha256(pass)));
  if(data[username] == null){
    return false;
  }else{
    return (data[username]["pass"] == sha256(pass));
  }
});

fastify.get('/timecheck', async(request, reply) => {
  const {hash} = request.query;
  var time = new Date().getTime();
  time = Math.floor(time / 1000); // to seconds
  time = Math.floor(time / 60);   // to minutes
  time = Math.floor(time / 60);   // to hour for testing
  var correctHash = sha256(time + process.env.secret);
  console.log(correctHash);
  if(hash == correctHash){
    return true;
  }else{
    return false;
  }
});

fastify.post('/updateData', async(request, reply) => {
  const {data} = request.body;
  await writeData(data);
  return true;
});



// Run the server and report out to the logs
fastify.listen(
  { port: process.env.PORT, host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Your app is listening on ${address}`);
  }
);
