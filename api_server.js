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
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('INSERT INTO public.tr_doctor_referrel(doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email) VALUES ($1, $2, $3, $4, $5) RETURNING doc_id', [`${formData.doc_name}`, `${formData.doc_name}`, `${formData.doc_name}`, `${formData.doc_phone_number}`, `${formData.doc_email}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          client.release();
          console.log(result.rows[0]);
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});

app.post('/send_study_referral', (req, res) => {
  const formData = req.body;

  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      sendWhatsappreferral(formData.sr_to_doctor, formData.sr_requester_comments);
      pool.query('INSERT INTO public.tr_study_referrals(sr_to_doctor, sr_status, sr_requester_id, sr_requester_comments) VALUES ($1, $2, $3, $4) RETURNING sr_id', [`${formData.sr_to_doctor}`, `active`, `${formData.sr_requester_id}`, `${formData.sr_requester_comments}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          client.release();
          res.send({ 'data': result.rows, 'status': 200 });

        }
      });
    });
});
function sendWhatsappreferral(doc_id, comment) {
  let updatedComment = '';
  if(comment != ''){
    updatedComment = comment.replace("http://localhost:3000", "http://ciaiteleradiology.com").replace("Dr. Laxman", "Doctor");
  }
  pool
    .connect()
    .then(client => {
      console.log('get_referral_doctors called...');
      client.query('SELECT doc_clinic, doc_name, doc_phone_number FROM public.tr_doctor_referrel WHERE doc_id = $1 AND is_deleted=$2 UNION SELECT srv_name, srv_secrt, srv_auth_cd FROM public.env_info WHERE _id=1', [doc_id, false], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows);
          let accountSid = '';
          let authToken = '';
          let phoneNum = '';
          let docName = '';
          if (result.rows[0].doc_clinic == 'watsp') {
            accountSid = result.rows[0].doc_name;
            authToken = result.rows[0].doc_phone_number;
            docName = result.rows[1].doc_name;
            phoneNum = result.rows[1].doc_phone_number;
          }
          else {
            accountSid = result.rows[1].doc_name;
            authToken = result.rows[1].doc_phone_number;
            docName = result.rows[0].doc_name;
            phoneNum = result.rows[0].doc_phone_number;
          }
          // const docName = result.rows[0].doc_name;
          // const phoneNum = result.rows[0].doc_phone_number;
          console.log("Cresd ", accountSid, authToken);
          const toContact = 'whatsapp:+91' + phoneNum;

          // const accountSid = result.rows[1].doc_name;
          // const authToken = result.rows[1].doc_phone_number;
          const twillioClient = require('twilio')(accountSid, authToken);
          client.release();
          console.log("Connection closed...");
          twillioClient.messages
            .create({
              body: updatedComment,
              from: 'whatsapp:+14155238886',
              to: toContact
            })
            .then(message => console.log(message.sid));

        }
      });
    });


}
app.get('/get_referral_doctors', (req, res) => {
  pool
    .connect()
    .then(client => {
      console.log('get_referral_doctors called...');
      client.query('SELECT * FROM public.tr_doctor_referrel', function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });

        }
      });
    });
});

/**
 * Read Modalities to show in dropdown
*/
app.get('/read_modalities', (req, res) => {
  pool
    .connect()
    .then(client => {
      console.log('read_modalities called...');
      client.query('SELECT * FROM public.tr_modalities WHERE is_modality_deleted=$1 ORDER BY modality_id ASC ', [false], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});
/**
 * read lab templates 
 * params
 * lab_id
*/
app.get('/read_templates/:lab_id', (req, res) => {
  let lab_id = req.params.lab_id;
  pool
    .connect()
    .then(client => {
      console.log('read_templates called...', lab_id);
      client.query('SELECT * FROM public.tr_templates WHERE lab_id=$1 AND is_deleted = $2 ORDER BY template_id ASC', [lab_id, false], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});

/**
 * read a single template content for update
 * params
 *  lab_id
 *  template_id
*/
app.get('/read_study_template/:lab_id/:template_id', (req, res) => {
  let lab_id = req.params.lab_id;
  let template_id = req.params.template_id;
  pool
    .connect()
    .then(client => {
      console.log('read_templates called...', lab_id);
      client.query('SELECT * FROM public.tr_templates WHERE lab_id=$1 AND template_id=$2 AND is_deleted = $3 ORDER BY template_id ASC', [lab_id, template_id, false], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});

/**
 * read a single template content for update
 * params
 *  lab_id
 *  template_id
*/
app.get('/read_study_template_for_generate/:lab_id/:modality', (req, res) => {
  let lab_id = req.params.lab_id;
  let modality = req.params.modality;
  pool
    .connect()
    .then(client => {
      console.log('read_study_template_for_generate called...', lab_id);
      client.query('SELECT * FROM public.tr_templates WHERE lab_id=$1 AND modality=$2 AND is_deleted = $3 ORDER BY template_id ASC', [lab_id, modality, false], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows[0], 'status': 200 });
        }
      });
    });
});

/**
 * update a single template content
 * params
 *  lab_id
 *  template_id
*/

app.post('/create_template', (req, res) => {
  if (req.body) {
    let template_body = req.body;
    pool
      .connect()
      .then(client => {
        console.log('create_template ---> ', template_body);
        pool.query('INSERT INTO public.tr_templates(modality, template_content, lab_id) VALUES ($1, $2, $3) RETURNING template_id', [`${template_body.modality}`, `${template_body.template_content}`, `${template_body.lab_id}`], function (err, result, done) {

          if (err) {
            client.release();
            return console.error('error running query', err);
          }
          else {
            client.release();
            console.log(result.rows[0]);
            res.send({ 'data': result.rows, 'status': 200 });
          }
        });
      });
    // let fileName = req.body.labName;
    // //fileName = fileName.replace(/ /g, "_") + '.json';
    // const data = readDataFromFile(fileName);
    // console.log("Before ", data);
    // const newItem = req.body;
    // var today = new Date();
    // var dd = String(today.getDate()).padStart(2, '0');
    // var mm = today.getMonth();
    // var yyyy = today.getFullYear();

    // today = dd + '/' + mm + '/' + yyyy;
    // console.log(today);
    // newItem.currentDate = today;

    // const i = data.findIndex(x => x.modality === req.body.modality)
    // if (i > -1) {
    //   console.log("Object found inside the array.", i);
    //   data[i] = newItem

    // } else {
    //   console.log("Object Not found insert new one.");
    //   data.push(newItem);
    // }
    // saveDataToFile(data, fileName);
    // res.send('Item added successfully...');
  }
  else {
    res.send('create_template Error');
  }

});

app.post('/update_template', (req, res) => {
  if (req.body) {
    let template_body = req.body;
    pool
      .connect()
      .then(client => {
        console.log('update_template ---> ', template_body);
        // 'UPDATE public.tr_templates SET template_content = $1 WHERE modality = $2', [template_body.template_content, template_body.modality],
        pool.query('UPDATE public.tr_templates SET template_content = $1 WHERE modality = $2', [template_body.template_content, template_body.modality], function (err, result, done) {
          if (err) {
            client.release();
            return console.error('error running query', err);
          }
          else {
            client.release();
            console.log(result.rows[0]);
            res.send({ 'data': result.rows, 'status': 200 });
          }
        });
      });
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
    .then(client => {
      console.log('Connected to PostgreSQL database');
      pool.query('SELECT * FROM tr_templates', function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows[0]);
          res.send({ 'data': result.rows, 'status': 200 });
        }
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

