const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = 3300;
const pg = require('pg')
const Pool = require('pg').Pool


const pool = new Pool({
  user: 'orthanc',
  password: 'orthanc',
  host: '91.108.110.46',
  port: '5432',
  database: 'teleradiology',
});
const FILE_NAME = 'data.json';

app.use(cors())
// Middleware to parse request body
app.use(bodyParser.json());

// Create operation
app.post('/create', (req, res) => {
  const data = readDataFromFile();
  const newItem = req.body;
  data.push(newItem);
  saveDataToFile(data);
  res.send('Item added successfully.');
});

app.post('/add_referral_doctor', (req, res) => {
  const formData = req.body;

  pool
    .connect()
    .then(() => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('INSERT INTO public.tr_doctor_referrel(doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email) VALUES ($1, $2, $3, $4, $5) RETURNING doc_id', [`${formData.doc_name}`, `${formData.doc_name}`, `${formData.doc_name}`, `${formData.doc_phone_number}`, `${formData.doc_email}`], function (err, result, done) {

        if (err) {
          return console.error('error running query', err);
        }
        else{
          console.log(result.rows[0]);
          res.send({'data':result.rows,'status':200});
        }
      });
    });
});

app.post('/send_study_referral', (req, res) => {
  const formData = req.body;

  pool
    .connect()
    .then(() => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('INSERT INTO public.tr_study_referrals(sr_to_doctor, sr_status, sr_requester_id, sr_requester_comments) VALUES ($1, $2, $3, $4) RETURNING sr_id', [`${formData.sr_to_doctor}`, `active`, `${formData.sr_requester_id}`, `${formData.sr_requester_comments}`], function (err, result, done) {

        if (err) {
          return console.error('error running query', err);
        }
        else{
          console.log(result.rows[0]);
          res.send({'data':result.rows,'status':200});
        }
      });
    });
});

app.get('/get_referral_doctors', (req, res) => {
  const formData = req.body;

  pool
    .connect()
    .then(() => {
      console.log('get_referral_doctors --> Connected to PostgreSQL database data ----> formData', formData);
      pool.query('SELECT * FROM public.tr_doctor_referrel', function (err, result, done) {

        if (err) {
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          res.send({'data':result.rows,'status':200});
        }
        
        //output: 1
      });
    });
});




app.post('/create_template', (req, res) => {
  if (req.body) {
    let fileName = req.body.labName;
    //fileName = fileName.replace(/ /g, "_") + '.json';
    const data = readDataFromFile(fileName);
    console.log("Before ", data);
    const newItem = req.body;
    var today = new Date();
    var dd = String(today.getDate()).padStart(2, '0');
    var mm = today.getMonth();
    var yyyy = today.getFullYear();

    today = dd + '/' + mm + '/' + yyyy;
    console.log(today);
    newItem.currentDate = today;

    const i = data.findIndex(x => x.modality === req.body.modality)
    if (i > -1) {
      console.log("Object found inside the array.", i);
      data[i] = newItem

    } else {
      console.log("Object Not found insert new one.");
      data.push(newItem);
    }
    saveDataToFile(data, fileName);
    res.send('Item added successfully...');
  }
  else {
    res.send('create_template Error');
  }

});

// Read operation
app.get('/read/:id', (req, res) => {
  const data = readDataFromFile();
  const item = data.find((item) => item.id === parseInt(req.params.id));
  if (item) {
    res.send(item);
  } else {
    res.status(404).send('Item not found.');
  }
});
app.get('/read_modality/:modality/:labName', (req, res) => {
  pool
    .connect()
    .then(() => {
      console.log('Connected to PostgreSQL database');
      pool.query('SELECT * FROM tr_templates', function (err, result, done) {

        if (err) {
          return console.error('error running query', err);
        }
        console.log(result.rows[0]);
        //output: 1
      });
    })
    .catch((err) => {
      console.error('Error connecting to PostgreSQL database', err);
    });

  res.set('Access-Control-Allow-Origin', '*');

  let fileName = req.params.labName;
  const data = readDataFromFile(fileName);
  //console.log("Reached....1234", data);
  const item = data.find((item) => item.modality == req.params.modality);
  if (item) {
    res.send(item);
  } else {
    res.status(404).send('Item not found.');
  }
});


app.get('/read_json/:labName', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  let fileName = req.params.labName;
  //fileName = fileName.replace(/ /g, "_") + '.json';
  const data = readDataFromFile(fileName);

  if (data) {
    res.send(data);
  } else {
    res.status(404).send('Item not found.');
  }
});

// Update operation
app.put('/update/:id', (req, res) => {
  const data = readDataFromFile();
  const index = data.findIndex((item) => item.id === parseInt(req.params.id));
  if (index !== -1) {
    data[index] = req.body;
    saveDataToFile(data);
    res.send('Item updated successfully.');
  } else {
    res.status(404).send('Item not found.');
  }
});

// Delete operation
app.delete('/delete/:id', (req, res) => {
  const data = readDataFromFile();
  const index = data.findIndex((item) => item.id === parseInt(req.params.id));
  if (index !== -1) {
    data.splice(index, 1);
    saveDataToFile(data);
    res.send('Item deleted successfully.');
  } else {
    res.status(404).send('Item not found.');
  }
});

// Utility functions to read/write data from/to file
function readDataFromFile(fileName) {
  try {
    const data = fs.readFileSync('templates-json/' + fileName);
    return JSON.parse(data);
  } catch (error) {
    return [];
  }
}

function saveDataToFile(data, fileName) {
  fs.writeFileSync('templates-json/' + fileName, JSON.stringify(data), 'utf8');
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}.`);
});

