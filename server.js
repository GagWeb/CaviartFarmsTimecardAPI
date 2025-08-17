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















// ====== DEBUG LOGGING ENHANCEMENTS (paste near top) ======

// config
const DEBUG = true; // flip to false to quickly quiet these logs
const BURST_THRESHOLD = 10; // requests
const BURST_WINDOW_MS = 10 * 1000; // window to count burst (10s)
const COUNTER_CLEANUP_MS = 60 * 1000; // cleanup interval for counters

// small logger helper
function log(level, reqId, ...args) {
  if (!DEBUG) return;
  const prefix = `[${new Date().toISOString()}] [${level}]${reqId ? ' [' + reqId + ']' : ''}`;
  console.log(prefix, ...args);
}
function warn(reqId, ...args) { log('WARN', reqId, ...args); }
function info(reqId, ...args) { log('INFO', reqId, ...args); }
function errorLog(reqId, ...args) { log('ERROR', reqId, ...args); }

// mask helper for sensitive values
function mask(val) {
  if (val == null) return val;
  const s = String(val);
  if (s.length <= 8) return '****';
  return s.slice(0,4) + '...' + s.slice(-3);
}

// Per-IP request tracker for burst detection
const ipCounters = new Map();
function recordIpRequest(ip) {
  const now = Date.now();
  if (!ipCounters.has(ip)) ipCounters.set(ip, []);
  ipCounters.get(ip).push(now);
  // trim to window
  const windowStart = now - BURST_WINDOW_MS;
  const arr = ipCounters.get(ip).filter(t => t >= windowStart);
  ipCounters.set(ip, arr);
  return arr.length;
}
// periodic cleanup to avoid memory growth
setInterval(() => {
  const cutoff = Date.now() - COUNTER_CLEANUP_MS;
  for (const [ip, arr] of ipCounters.entries()) {
    const trimmed = arr.filter(t => t >= cutoff);
    if (trimmed.length === 0) ipCounters.delete(ip);
    else ipCounters.set(ip, trimmed);
  }
}, COUNTER_CLEANUP_MS);

// Express-level inline middleware (you already have one; this augments it — paste after your current app.use logger)
app.use((req, res, next) => {
  const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.floor(Math.random()*1000);
  const start = Date.now();
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection && req.connection.remoteAddress;

  // record IP burst count
  const ipCount = recordIpRequest(ip);
  if (ipCount >= BURST_THRESHOLD) {
    warn(reqId, `Burst detected from IP=${ip}. ${ipCount} reqs in last ${Math.round(BURST_WINDOW_MS/1000)}s`);
  }

  info(reqId, 'Incoming EXPRESS request', {
    method: req.method,
    url: req.originalUrl,
    ip,
    httpVersion: req.httpVersion,
    ua: req.headers && req.headers['user-agent'],
    accept: req.headers && req.headers.accept,
    cookie: req.headers && (req.headers.cookie ? mask(req.headers.cookie) : undefined),
  });

  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    info(reqId, `Express response`, {
      statusCode: res.statusCode,
      durationMs: duration,
      contentLength: res.getHeader && res.getHeader('content-length'),
    });
    originalEnd.apply(res, args);
  };

  // attach reqId for downstream logs
  req._reqId = reqId;
  next();
});

// Fastify hooks (put these after you create `fastify` and before routes)
fastify.addHook('onRequest', async (request, reply) => {
  const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.floor(Math.random()*1000);
  request.logId = reqId;
  const ip = request.ip || request.raw && (request.raw.headers['x-forwarded-for'] || request.raw.connection.remoteAddress);
  const headers = request.headers || {};
  // record ip burst
  const ipCount = recordIpRequest(ip);
  if (ipCount >= BURST_THRESHOLD) {
    warn(reqId, `Burst detected from IP=${ip}. ${ipCount} reqs in last ${Math.round(BURST_WINDOW_MS/1000)}s`);
  }

  info(reqId, 'Incoming FASTIFY request', {
    method: request.method,
    url: request.url,
    ip,
    ua: headers['user-agent'],
    accept: headers.accept,
    cookie: headers.cookie ? mask(headers.cookie) : undefined,
  });
});

fastify.addHook('onResponse', async (request, reply) => {
  const reqId = request.logId || 'no-id';
  info(reqId, 'Fastify response', {
    url: request.url,
    statusCode: reply.statusCode,
    durationMs: (reply.getResponseTime && typeof reply.getResponseTime === 'function') ? reply.getResponseTime() : undefined,
  });
});

// Axios interceptors (logs all outgoing requests + responses)
axios.interceptors.request.use(cfg => {
  const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString();
  cfg.headers = cfg.headers || {};
  cfg.headers['X-Debug-ReqId'] = reqId; // helps correlate
  info(reqId, 'AXIOS Request', {
    method: cfg.method,
    url: cfg.url,
    timeout: cfg.timeout,
    headersSnapshot: {
      'User-Agent': cfg.headers['User-Agent'] || cfg.headers['user-agent'],
      'Content-Type': cfg.headers['Content-Type'] || cfg.headers['content-type'],
    },
    dataLength: cfg.data ? (typeof cfg.data === 'string' ? cfg.data.length : JSON.stringify(cfg.data).length) : 0
  });
  // attach reqId so response interceptor can use it
  cfg._reqId = reqId;
  return cfg;
}, err => {
  errorLog('axios-req', 'AXIOS request error', err && err.message);
  return Promise.reject(err);
});

axios.interceptors.response.use(resp => {
  const reqId = resp.config && resp.config._reqId ? resp.config._reqId : 'axios-resp';
  info(reqId, 'AXIOS Response', {
    url: resp.config && resp.config.url,
    status: resp.status,
    statusText: resp.statusText,
    headersSample: {
      'content-length': resp.headers && resp.headers['content-length'],
      'retry-after': resp.headers && resp.headers['retry-after']
    },
    dataLength: resp.data ? (typeof resp.data === 'string' ? resp.data.length : JSON.stringify(resp.data).length) : 0
  });
  return resp;
}, err => {
  const resp = err && err.response;
  const reqId = err && err.config && err.config._reqId ? err.config._reqId : 'axios-err';
  if (resp && resp.status === 429) {
    warn(reqId, 'AXIOS got 429', {
      url: err.config && err.config.url,
      'retry-after': resp.headers && resp.headers['retry-after'],
      status: resp.status,
      bodySample: resp.data ? (typeof resp.data === 'string' ? resp.data.slice(0,200) : JSON.stringify(resp.data).slice(0,200)) : undefined
    });
  } else {
    errorLog(reqId, 'AXIOS error', {
      message: err.message,
      url: err.config && err.config.url,
      status: resp && resp.status
    });
  }
  return Promise.reject(err);
});

// Instrument readData and writeData (replace existing ones or augment them)
async function readData(retries = 0) {
  const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString();
  info(reqId, `readData attempt #${retries}`, { url: BASE_URL });
  try {
    const res = await axios.get(BASE_URL, { headers: { 'X-Local-ReqId': reqId } });
    info(reqId, 'readData success', { status: res.status, contentLength: res.headers['content-length'] });
    return res.data;
  } catch (err) {
    const resp = err && err.response;
    if (resp && resp.status === 429) {
      const retryAfterHeader = resp.headers && (resp.headers['retry-after'] || resp.headers['Retry-After']);
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 30000;
      warn(reqId, `readData 429: retrying after ${retryAfter / 1000}s (attempt ${retries + 1})`, {
        headers: resp.headers,
        bodySample: resp.data ? (typeof resp.data === 'string' ? resp.data.slice(0,200) : JSON.stringify(resp.data).slice(0,200)) : undefined
      });
      if (retries >= MAX_RETRIES) {
        errorLog(reqId, `readData gave up after ${MAX_RETRIES} retries`);
        return null;
      }
      await sleep(retryAfter);
      return readData(retries + 1);
    } else {
      errorLog(reqId, 'readData failed', { message: err.message, stack: err.stack ? err.stack.split('\n')[0] : undefined });
      return null;
    }
  }
}

async function writeData(data, url = BASE_URL) {
  const reqId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString();
  const dataLen = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
  info(reqId, 'writeData start', { url, dataLength: dataLen });
  try {
    const res = await axios.post(url, data, { headers: { 'Content-Type': 'application/json', 'X-Local-ReqId': reqId } });
    info(reqId, 'writeData success', { status: res.status, statusText: res.statusText });
  } catch (err) {
    errorLog(reqId, 'writeData failed', { message: err.message, stack: err.stack ? err.stack.split('\n')[0] : undefined });
  }
}

// Nodemailer: augment existing send callback logging (you already had transporter.sendMail inside /email)
// in that callback ensure we log accepted/rejected/messageId
// e.g.
// transporter.sendMail(mailOptions, (error, info) => {
//   if (error) {
//     console.error("❌ sendMail error:", error);
//   } else {
//     console.log("✅ Email sent:", info);
//   }
// });
// (existing code already logs; the above is confirmation to keep messageId etc.)

// Route-specific logging suggestions
// inside /verify (fastify.get('/verify'...)) augment to log:
//   - request received with username (masked), request.ip, computed sha256 vs stored hash (mask the full hash)
//
// e.g. replace your console.log(pass + " | " + sha256(pass) + " | " + data[username]["pass"] + " | " + (data[username]["pass"] == sha256(pass)));
// with:
  // const computed = sha256(pass);
  // info(request.logId, '/verify', { username: username ? username.slice(0,3) + '...' : undefined, passMask: mask(pass), computedHashSample: computed.slice(0,8) });
  // if (!data[username]) { warn(request.logId, '/verify missing user', { username }); return false; }
  // info(request.logId, '/verify result', { match: data[username]["pass"] === computed });

// inside /timecheck log the computed hash and whether it matched (but do not log secret)
  // info(request.logId, '/timecheck', { providedHash: mask(hash), computedSample: computed.slice(0,8), result: hash === computed });

// inside /updateData log the body size and which keys changed
  // info(request.logId, '/updateData', { bodyLength: JSON.stringify(request.body).length });
  // if request.body && request.body.data then log Object.keys(request.body.data).slice(0,20)

// /data.json: log that a client requested data.json and whether readData returned null

// /h (the HTML endpoint) - log page render requests and the incoming code param
  // info(request.logId, '/h render', { code: request.query && request.query.code ? mask(request.query.code) : undefined });

// Example small helpers to place inside routes (use these wherever you want)
function routeInfo(request, label, obj) {
  const id = (request && request.logId) || (request && request._reqId) || 'route';
  info(id, label, obj);
}
function routeWarn(request, label, obj) {
  const id = (request && request.logId) || (request && request._reqId) || 'route';
  warn(id, label, obj);
}

// Global process-level logs
process.on('unhandledRejection', (reason, p) => {
  errorLog('process', 'Unhandled Rejection at Promise', { reason: reason && reason.stack ? reason.stack.split('\n')[0] : reason });
});
process.on('uncaughtException', (err) => {
  errorLog('process', 'Uncaught Exception', { message: err && err.message, stack: err && err.stack ? err.stack.split('\n')[0] : undefined });
  // Consider process.exit(1) in production after logging
});
process.on('SIGINT', () => {
  info('process', 'SIGINT received — shutting down gracefully');
  process.exit(0);
});
process.on('SIGTERM', () => {
  info('process', 'SIGTERM received — shutting down gracefully');
  process.exit(0);
});





















require('dotenv').config();

// Require the fastify framework and instantiate it
const fastify = require("fastify")({
  // Set this to true for detailed logging:
  logger: true,
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


// Max number of retries if 429 is received
const MAX_RETRIES = 3;

// Delay helper (in ms)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readData(retries = 0) {
  try {
    const res = await axios.get(BASE_URL);
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 429) {
      if (retries >= MAX_RETRIES) {
        console.error(`Rate limit hit. Tried ${MAX_RETRIES} times. Giving up.`);
        return null;
      }

      const retryAfter = err.response.headers['retry-after']
        ? parseInt(err.response.headers['retry-after'], 10) * 1000
        : 30000; // default to 30 seconds

      console.warn(`429 Too Many Requests. Retrying in ${retryAfter / 1000}s...`);
      await sleep(retryAfter);
      return readData(retries + 1);
    } else {
      console.error("Failed to read from Pantry:", err.message);
      return null;
    }
  }
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
                warningDiv.textContent = 'Invalid timecode. Cannot clock in/out.';
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
