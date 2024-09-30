const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require("multer");

const auth = require('./middleware/keycloak');
const accountSid1 = process.env.ACCOUNT_SID;
const authToken1 = process.env.AUTH_TOKEN;



//const twillioClient = require('twilio')(accountSid, authToken);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/")
  },
  filename: (req, file, cb) => {
    console.log("file.originalname ", file.originalname);
    cb(null, Date.now() + "-" + file.originalname)
  },
})

const uploadStorage = multer({ storage: storage })
dotenv.config();

const app = express();
const PORT = 3300;
const pg = require('pg')
const Pool = require('pg').Pool

app.use(express.static(__dirname+'/public'));

const pool = new Pool({
  user: process.env.USER,
  password: process.env.PASSWORD,
  host: process.env.HOST,
  port: '5432',
  database: process.env.DB,
});
app.use(cors())
// Middleware to parse request body
app.use(bodyParser.json());

app.post('/login', (req, res) => {
  const formData = req.body;
  console.log("formData", formData);
  const token = jwt.sign({ id: formData.email }, 'secret');

  // Return the token to the user
  res.json({ token });
  //res.send('Item added successfully.');
});

// Create operation
app.post("/create", uploadStorage.single("file-0"), (req, res) => {
  
  console.log("File--->", req.file-0)
  console.log("File info ", req.file);
  req.file.name = req.file.originalname;
  req.file.url = req.protocol + '://' + req.get('host')+'/uploads/'+req.file.filename;
  return res.send({"result":[req.file]});
})


app.post('/update_referral_doctor', auth.isAuthorized, (req, res) => {
  const formData = req.body;
  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('UPDATE public.tr_doctor_referrel SET doc_name=$1, doc_specialization=$2, doc_clinic=$3, doc_phone_number=$4, doc_email=$5 WHERE doc_id=$6 RETURNING doc_id', [`${formData.doc_name} `, `${formData.doc_specialization} `, `${formData.doc_clinic} `, `${formData.doc_phone_number} `, `${formData.doc_email}`, `${formData.doc_id}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'result': result, 'status': 200 });
        }
      });
    });
});


app.post('/add_referral_doctor', auth.isAuthorized, (req, res) => {
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

app.post('/send_study_referral', auth.isAuthorized, (req, res) => {
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
          //const toContact = 'whatsapp:+91' + phoneNum;
          const toContact = phoneNum;

          // const accountSid = result.rows[1].doc_name;
          // const authToken = result.rows[1].doc_phone_number;
          //const twillioClient = require('twilio')(accountSid, authToken);
          client.release();
          console.log("Connection closed...");
          // twillioClient.messages
          //   .create({
          //     body: comment,
          //     from: 'whatsapp:+14155238886',
          //     to: toContact
          //   })
          //   .then(message => console.log(message.sid));

          
          var http = require("https");

          var options = {
            "method": "POST",
            "hostname": "api.ultramsg.com",
            "port": null,
            "path": "/instance95879/messages/chat",
            "headers": {
              "content-type": "application/json"
            }
          };
          
          var req = http.request(options, function (res) {
            var chunks = [];
          
            res.on("data", function (chunk) {
              chunks.push(chunk);
            });
          
            res.on("end", function () {
              var body = Buffer.concat(chunks);
              console.log(body.toString());
            });
          }); 
          var postData = JSON.stringify({
              "token": "c63atui3vx70epu9",
              "to": toContact,
              "body": comment,
              "priority": 1,
              "referenceId": "",
              "msgId": "",
              "mentions": ""
          });
          console.log("<------------WhatsApp ------------> \n");
          console.log("WhatsApp postData ", postData);
          req.write(postData);
          req.end();











        }
      });
    });
}
app.get('/send-whatsapp-message', async (req, res) => {
  // const twillioClient = require('twilio')('AC51a2b91e7519cda345df153fe67eae80', '4e5035cd2b2047050eaaee0d7a8468ce');
  const twillioClient = require('twilio')('AC51a2b91e7519cda345df153fe67eae80', 'd2d8ff3ce2d4a79bdfcb1b44f5822c5a');
  //client.release();
  console.log("Connection closed...");
  twillioClient.messages
    .create({
      body: 'test comment added',
      from: 'whatsapp:+14155238886',
      to: 'whatsapp:+919948326550'
    })
    .then(message => console.log(message));
});


app.get('/get_referral_doctors', auth.isAuthorized, async (req, res) => {
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
app.get('/get_sub_modalities/:modality', auth.isAuthorized, async (req, res) => {
  let modality = req.params.modality;
  pool
    .connect()
    .then(client => {
      console.log('get_referral_doctors called...');
      client.query('SELECT template_id, sub_modality FROM public.tr_templates WHERE modality=$1',[modality], function (err, result, done) {

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
app.get('/docker-sample', auth.isAuthorized, (req, res) => {
  const menuItems = [
    {
      name: "Croissant",
      price: "$1",
      onMenu: true
    },
    {
      name: "Latte",
      price: "$5",
      onMenu: true
    },
    {
      name: "Roti Canai",
      price: "$0.50",
      onMenu: true
    },
    {
      name: "Hot Chocolate",
      price: "$5",
      onMenu: false
    },
    {
      name: "Satay",
      price: "$8",
      onMenu: false
    },
    {
      name: "Pad Thai",
      price: "$7",
      onMenu: false
    }
  ];

  try {
    let filtered = menuItems.filter(item => {
      if (item.onMenu === true) {
        return item;
      }
    });

    // Return filtered data
    res.json(filtered);
  } catch (error) {
    return next(error);
  }

});


app.get('/read_modalities/:lab_id', auth.isAuthorized, (req, res) => {
  let labId = req.params.lab_id;
  pool
    .connect()
    .then(client => {
      console.log('read_modalities called...');
      client.query('SELECT * FROM tr_modalities WHERE modality_status=$1 ORDER BY modality_name ASC',['active'], function (err, result, done) {

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
 * Check Template exist for Modality and sub modality
 */
app.get('/read_modalities_for_lab/:lab_id/:sub_modality', auth.isAuthorized, (req, res) => {
  let labId = req.params.lab_id;
  let subModality = req.params.sub_modality;
  pool
    .connect()
    .then(client => {
      console.log('read_modalities called...');
      client.query('SELECT count(*) FROM tr_templates WHERE lab_id=$1 AND sub_modality=$2 ORDER BY t1.modality_name ASC',[labId, subModality], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result, 'status': 200 });
        }
      });
    });
});
/**
 * read lab templates 
 * params
 * lab_id
*/
app.get('/read_templates/:lab_id', auth.isAuthorized, (req, res) => {
  console.log("ENV Info updated.......")
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
app.get('/read_study_template/:lab_id/:template_id', auth.isAuthorized, (req, res) => {
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
app.get('/read_study_template_for_generate/:lab_id/:modality/:type', auth.isAuthorized, (req, res) => {
  let lab_id = req.params.lab_id;
  let modality = req.params.modality;
  let type = req.params.type;
  let query = 'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND modality=$2 AND is_deleted = $3 ORDER BY template_id ASC';
  if(type == 'm'){
    query = 'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND template_id=$2 AND is_deleted = $3 ORDER BY template_id ASC';
  }
  console.log("Query---> ", query);
  pool
    .connect()
    .then(client => {
      console.log('read_study_template_for_generate called...', lab_id);
      client.query(query, [lab_id, modality, false], function (err, result, done) {

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

app.post('/create_template', auth.isAuthorized, (req, res) => {
  if (req.body) {
    let template_body = req.body;
    pool
      .connect()
      .then(client => {
        console.log('create_template ---> ', template_body);
        pool.query('INSERT INTO public.tr_templates(modality, template_content, lab_id, sub_modality) VALUES ($1, $2, $3, $4) RETURNING template_id', [`${template_body.modality}`, `${template_body.template_content}`, `${template_body.lab_id}`, `${template_body.sub_modality}`], function (err, result, done) {

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

app.post('/update_template', auth.isAuthorized, (req, res) => {
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
app.get('/read_modality/:modality/:labName', auth.isAuthorized, (req, res) => {
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


app.get('/read_json/:labName', auth.isAuthorized, (req, res) => {
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
app.put('/update/:id', auth.isAuthorized, (req, res) => {
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
app.delete('/delete/:id', auth.isAuthorized, (req, res) => {
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


