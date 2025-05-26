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


function readData(file='data.json') {
  const raw = fs.readFileSync(path.join(__dirname, file));
  return JSON.parse(raw);
  
}

// Save data to file
function writeData(data, file="data.json") {
  fs.writeFileSync(
    path.join(__dirname, file),
    JSON.stringify(data, null, 2)
  );
}

function formatData(obj) {
  return JSON.stringify(obj, null, 2);
}



fastify.get('/h', async(request, reply) => {
  const {code} = request.query;
  reply.type('text/html').send(`
    <html>
      <head><title>Fastify Page</title></head>
      <body id="document">
        <h1>Clock In / Out</h1><br>
        <input id="name" placeholder="name" style="font-size: 250%;"><br>
        <input id="pass" placeholder="password" style="font-size: 250%;"><br>
        <button id="submit" style="font-size: 400%;">Clock in/out</button>
        <h3 style="color: red;" id="warning"></h3>
        <script>
        var isCorrect = true;
            fetch('/verify?username=' + localStorage.getItem("loginName") + '&pass=' + localStorage.getItem("pass"))
            .then(response => {
              if (response.ok) {
                return response.json(); // Parse the response data as JSON
              } else {
                throw new Error('API request failed');
              }
            })
            .then(data => {
              if(data == false){
                isCorrect = false;
              }
              console.log(data); // Example: Logging the data to the console
            })
            .catch(error => {
              // Handle any errors here
              console.error(error); // Example: Logging the error to the console
            });
            fetch('/timecheck?hash=${code}')
            .then(response => {
              if (response.ok) {
                return response.json(); // Parse the response data as JSON
              } else {
                throw new Error('API request failed');
              }
            })
            .then(data => {
              if(data == false){
                isCorrect = false;
              }
              console.log(data); // Example: Logging the data to the console
            })
            .catch(error => {
              // Handle any errors here
              console.error(error); // Example: Logging the error to the console
            });
            if(isCorrect == true){
              document.getElementById("name").value = localStorage.getItem("loginName");
              document.getElementById("pass").value = localStorage.getItem("pass")
            }else{
              console.log("Not true");
            }
        document.getElementById("submit").addEventListener("click", login);
        document.getElementById("name").addEventListener("submit", login);
        document.getElementById("pass").addEventListener("submit", login);

        async function login(){
          document.getElementById("name").value = document.getElementById("name").value.toLocaleLowerCase().replaceAll(" ", "");
          if(localStorage.getItem("loginName") != null && localStorage.getItem("pass") != null){
          var isCorrect = true;
            await fetch('/verify?username=' + document.getElementById("name").value + '&pass=' + document.getElementById("pass").value)
            .then(response => {
              if (response.ok) {
                return response.json(); // Parse the response data as JSON
              } else {
                throw new Error('API request failed');
              }
            })
            .then(data => {
              if(data == false){
                isCorrect = false;
                document.getElementById("warning").innerText = "The name and/or password is wrong. Please make sure they are spelled properly and keep in mind the password is case-sensitive!";
                return;
              }
              console.log(data); // Example: Logging the data to the console
            })
            .catch(error => {
              // Handle any errors here
              console.error(error); // Example: Logging the error to the console
            });

            await fetch('/timecheck?hash=${code}')
            .then(response => {
              if (response.ok) {
                return response.json(); // Parse the response data as JSON
              } else {
                throw new Error('API request failed');
              }
            })
            .then(data => {
              if(data == false){
                isCorrect = false;
              }
              console.log(data); // Example: Logging the data to the console
            })
            .catch(error => {
              // Handle any errors here
              console.error(error); // Example: Logging the error to the console
            });

            if(isCorrect == true){
            var data = ${formatData(readData())};
            console.log(data);
              var name = document.getElementById("name").value;
              console.log(name);
              if(data[name] == null) {
                document.getElementById("warning").innerHTML = "Sorry, but that was not a valid name. Make sure it is spelled properly.";
                return;
              }
              var employeeData = data[name];
              var time = new Date().getTime(); // milliseconds
              time = Math.floor(time / 1000); // seconds
              time -= 60 * 60 * 5; // converts from UTC to Eastern -- change it to 60 * 60 * 4 during daylight savings.
              var lastAction = employeeData['lastAction'];
              
              
              var isBackupRun = false;
              if(lastAction == "in"){
                if(time - employeeData['hours'][employeeData['hours'].length - 1].in > 60 * 60 * 12){ // 12 hours
                  lastAction = "out";
                  isBackupRun = true;
                }
              }
              
              
              if(lastAction == "out"){
                employeeData['hours'].push({'in': time, 'out': time + 1});
                employeeData['lastAction'] = "in";
              }else{
                employeeData['hours'][employeeData['hours'].length - 1]['out'] = time;
                employeeData['lastAction'] = "out";
              }
              
              data[name] = employeeData;
              var newData = data;
              
              fetch('/updateData', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ data: newData })
              })
              .then(response => {
                if (response.ok) {
                  return response.json();
                } else {
                  throw new Error('API request failed');
                }
              })
              .then(data => {
                if (data === false) {
                  isCorrect = false;
                }
                console.log(data);
              })
              .catch(error => {
                console.error(error);
              });
              localStorage.setItem("loginName", document.getElementById("name").value);
              localStorage.setItem("pass", document.getElementById("pass").value);
              document.body.innerHTML = "<h1>You have successfully clocked " + employeeData['lastAction'] + ". Thank you!</h1>";
              if(isBackupRun){
                document.body.innerHTML += "<br><h1>Our system suspects that you didn't clock out yesterday. Please tell Terry when you left whenever possible, or if you believe this alert to be a mistake.</h1><br>Other than that, you are good to go. Thanks!";
              }
            }
            
          }else{
            var isCorrect = true;
            fetch('/verify?username=' + document.getElementById("name").value + '&pass=' + document.getElementById("pass").value)
            .then(response => {
              if (response.ok) {
                return response.json(); // Parse the response data as JSON
              } else {
                throw new Error('API request failed');
              }
            })
            .then(data => {
              if(data == false){
                isCorrect = false;
                document.getElementById("warning").innerHTML = "The name and/or password is wrong. Please make sure they are spelled properly and keep in mind the password is case-sensitive!";
                return;
              }
              console.log(data); // Example: Logging the data to the console
            })
            .catch(error => {
              // Handle any errors here
              console.error(error); // Example: Logging the error to the console
            });

            fetch('/timecheck?hash=${code}')
            .then(response => {
              if (response.ok) {
                return response.json(); // Parse the response data as JSON
              } else {
                throw new Error('API request failed');
              }
            })
            .then(data => {
              if(data == false){
                isCorrect = false;
              }
              console.log(data); // Example: Logging the data to the console
            })
            .catch(error => {
              // Handle any errors here
              console.error(error); // Example: Logging the error to the console
            });

            if(isCorrect == true){
              localStorage.setItem("loginName", document.getElementById("name").value);
              localStorage.setItem("pass", document.getElementById("pass").value);
              
              var data = ${formatData(readData())};
              console.log(data);
              var name = document.getElementById("name").value;
              if(data[name] == null) {
                document.getElementById("warning").innerHTML = "Sorry, but that was not a valid name. Make sure it is spelled properly.";
                return;
              }
              var employeeData = data[name];
              var time = new Date().getTime(); // milliseconds
              time = Math.floor(time / 1000); // seconds
              time -= 60 * 60 * 5; // converts from UTC to Eastern -- change it to 60 * 60 * 4 during daylight savings.
              var lastAction = employeeData['lastAction'];
              if(lastAction == "out"){
                employeeData['hours'].push({'in': time, 'out': time + 1});
                employeeData['lastAction'] = "in";
              }else{
                employeeData['hours'][employeeData['hours'].length - 1]['out'] = time;
                employeeData['lastAction'] = "out";
              }
              
              data[name] = employeeData;
              var newData = data;
              
              fetch('/updateData', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ data: newData })
              })
              .then(response => {
                if (response.ok) {
                  return response.json();
                } else {
                  throw new Error('API request failed');
                }
              })
              .then(data => {
                if (data === false) {
                  isCorrect = false;
                }
                console.log(data);
              })
              .catch(error => {
                console.error(error);
              });
              document.body.innerHTML = "<h1>You have successfully logged " + employeeData['lastAction'] + ". Thank you!</h1>";
              
            }
          }
         });
        </script>
      </body>
    </html>
  `);
});

fastify.get('/email', async(request, reply) => {
  var totalData = readData();
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
  
  writeData(totalData, "backup-data.json");
  var newData = totalData;
  for(var i = 0; i < keys.length; i++){
    newData[keys[i]]["hours"] = new Array();
  }
  writeData(newData, "data.json");
  
});

fastify.get('/data.json', async(request, reply) => {
  return readData();
});
fastify.get('/backup-data.json', async(request, reply) => {
  return readData('backup-data.json');
});

fastify.get('/verify', async(request, reply) => {
  const {username, pass} = request.query;
  var data = readData();
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
  writeData(data);
  return true;
});


/*fastify.get('/get-name', async(request, reply) => {
  var data = readData();
  const {id} = request.query;
  return data[id][0];
});*/




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
