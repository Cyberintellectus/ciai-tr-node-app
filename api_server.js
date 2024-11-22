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

app.use(express.static(__dirname + '/public'));

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

  console.log("File--->", req.file - 0)
  console.log("File info ", req.file);
  req.file.name = req.file.originalname;
  req.file.url = req.protocol + '://' + req.get('host') + '/uploads/' + req.file.filename;
  return res.send({ "result": [req.file] });
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
      client.query('SELECT template_id, sub_modality FROM public.tr_templates WHERE modality=$1', [modality], function (err, result, done) {

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
      client.query('SELECT * FROM tr_modalities WHERE modality_status=$1 ORDER BY modality_name ASC', ['active'], function (err, result, done) {

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
      client.query('SELECT count(*) FROM tr_templates WHERE lab_id=$1 AND sub_modality=$2 ORDER BY t1.modality_name ASC', [labId, subModality], function (err, result, done) {

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
  if (type == 'm') {
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
        pool.query('UPDATE public.tr_templates SET template_content = $1 WHERE modality = $2 AND sub_modality=$3', [template_body.template_content, template_body.modality, template_body.sub_modality], function (err, result, done) {
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

/**
 * Subscription APIs
 */

/**
 * API to create a lab by super admin
 * Params
 * - lab_name
 * - lab_address
 * - lab_image
 * - lab_city
 * - lab_state
 * - lab_zipcode
 * - lab_status
 * - lab_unique_identifier
 * - lab_created_by
 */
app.post('/create_lab', auth.isAuthorized, (req, res) => {
  const formData = req.body;

  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> create_lab', formData);

      pool.query('INSERT INTO public.tr_labs(lab_name, lab_address, lab_image, lab_city, lab_state, lab_zipcode, lab_status, lab_unique_identifier, lab_created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING lab_id', [`${formData.lab_name}`, `${formData.lab_address}`, `${formData.lab_image}`, `${formData.lab_city}`, `${formData.lab_state}`, `${formData.lab_zipcode}`, `active`, `${formData.lab_unique_identifier}`, `${formData.lab_created_by}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running create_lab query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'data': result, 'status': 200 });
        }
      });
    });
});


app.post('/update_lab', auth.isAuthorized, (req, res) => {
  const formData = req.body;
  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('UPDATE public.tr_labs SET lab_name=$1, lab_address=$2, lab_city=$3,lab_phone=$4 lab_updated_by=$5, lab_updated_date=CURRENT_DATE WHERE lab_id=$6 RETURNING lab_id', [`${formData.lab_name} `, `${formData.lab_address} `, `${formData.lab_city} `, `${formData.lab_phone} `, `${formData.lab_updated_by} `, `${formData.lab_id}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running  update_lab query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'result': result, 'status': 200 });
        }
      });
    });
});


/**
 * API to create a new subscription type by super admin
 * params
 * - subscription_type_name
 * - subscription_description
 * - subscription_type_created_by
 */
app.post('/create_subscription', auth.isAuthorized, (req, res) => {
  const formData = req.body;

  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> create_lab', formData);

      pool.query('INSERT INTO public.tr_subscription_types(subscription_type_name, subscription_type_status, subscription_description, subscription_type_created_by) VALUES ($1, $2, $3, $4) RETURNING subscription_type_id', [`${formData.subscription_type_name}`, `active`, `${formData.subscription_description}`, `${formData.subscription_type_created_by}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running subscription_description query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'data': result, 'status': 200 });
        }
      });
    });
});


/**
 * API to create a subscription for a lab by super admin
 * params
 *  - lab_id
 *  - subscription_type_id
 *  - lab_sub_created_by
 */
app.post('/create_lab_subscription', auth.isAuthorized, (req, res) => {
  const formData = req.body;
  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> create_lab_subscription', formData);

      pool.query('INSERT INTO public.tr_labs_subscriptions(lab_sub_status, lab_id, subscription_type_id, lab_sub_created_by) VALUES ($1, $2, $3, $4) RETURNING lab_sub_id', [`active`, `${formData.lab_id}`, `${formData.subscription_type_id}`, `${formData.lab_sub_created_by}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running create_lab_subscription query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'data': result, 'status': 200 });
        }
      });
    });
});


/**
 * API to update a subscription features  by super admin
 * params
 * - subscription_type_id
 * - lab_sub_updated_by
 * - lab_sub_id
 * - lab_id
 */

app.post('/update_lab_subscription', auth.isAuthorized, (req, res) => {
  const formData = req.body;
  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('UPDATE public.tr_labs_subscriptions SET subscription_type_id=$1, lab_sub_updated_by=$2, lab_sub_updated_date=CURRENT_DATE WHERE lab_sub_id=$3 AND lab_id=$4 RETURNING lab_sub_id', [`${formData.subscription_type_id} `, `${formData.lab_sub_updated_by} `, `${formData.lab_sub_id} `, `${formData.lab_id} `], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running  update_lab_subscription query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'result': result, 'status': 200 });
        }
      });
    });
});

/**
 * API to get all subscriptions to super admin
 */
app.get('/get_all_subscription_types', auth.isAuthorized, (req, res) => {

  pool
    .connect()
    .then(client => {
      console.log('tr_subscription_types called...');
      client.query('SELECT * FROM public.tr_subscription_types ORDER BY subscription_type_id ASC', function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});

/**
 * API to get all labs info to super admin
 */
app.get('/get_all_labs_info', auth.isAuthorized, (req, res) => {

  pool
    .connect()
    .then(client => {
      console.log('get_all_labs_info called...');
      client.query(`SELECT * FROM public.tr_labs WHERE lab_status='active' ORDER BY lab_id ASC`, function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running get_all_labs_info query', err);
        }
        else {
          console.log(result.rows);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});




/**
 * API to get all features for all subscriptions
 */
app.get('/get_all_subscription_features', auth.isAuthorized, (req, res) => {

  pool
    .connect()
    .then(client => {
      console.log('get_all_subscription_features called...');
      client.query('SELECT * FROM public.tr_feature_subscription_map ORDER BY feature_id ASC', function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running get_all_subscription_features query', err);
        }
        else {
          console.log(result.rows);
          const finalresult = result = result.rows.reduce((acc, feature) => {
            acc[feature.feature_unique_identifier] = feature;
            return acc;
          }, {});

          client.release();
          console.log("Connection closed...")
          res.send({ 'data': finalresult, 'status': 200 });
        }
      });
    });
});

/**
 * API to create a subscription features  by super admin
 * Params
 * - feature_name
 * - feature_unique_identifier
 * - feature_is_available_for__basic - true/false
 * - feature_is_available_for__standard - true/false
 * - feature_is_available_for__premium - true/false
 * - feature_access_created_by - true/false
 * 
 */
app.post('/create_subscription_feature', auth.isAuthorized, (req, res) => {
  const formData = req.body;
  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> create_lab', formData);

      pool.query('INSERT INTO public.tr_feature_subscription_map(feature_name, feature_unique_identifier, feature_is_available_for__basic, feature_is_available_for__standard, feature_is_available_for__premium, feature_access_created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING feature_id', [`${formData.feature_name}`, `${formData.feature_unique_identifier}`, `${formData.feature_is_available_for__basic}`, `${formData.feature_is_available_for__standard}`, `${formData.feature_is_available_for__premium}`, `${formData.feature_access_created_by}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running create_lab query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'data': result, 'status': 200 });
        }
      });
    });
});

/**
 * API to update a subscription features  by super admin
 * Params
 * - feature_is_available_for__basic - true/false
 * - feature_is_available_for__standard - true/false
 * - feature_is_available_for__premium - true/false
 * - feature_access_updated_by - true/false
 * -feature_id
 * 
 */

app.post('/update_subscription_feature', auth.isAuthorized, (req, res) => {
  const formData = req.body;
  pool
    .connect()
    .then(client => {
      console.log('Connected to PostgreSQL database data ----> formData', formData);
      pool.query('UPDATE public.tr_feature_subscription_map SET feature_is_available_for__basic=$1, feature_is_available_for__standard=$2, feature_is_available_for__premium=$3, feature_access_updated_by=$4, feature_access_updated_date=CURRENT_DATE WHERE feature_id=$5 RETURNING feature_id', [`${formData.feature_is_available_for__basic} `, `${formData.feature_is_available_for__standard} `, `${formData.feature_is_available_for__premium} `, `${formData.feature_access_updated_by} `, `${formData.feature_id}`], function (err, result, done) {

        if (err) {
          client.release();
          return console.error('error running  update_subscription_feature query', err);
        }
        else {
          client.release();
          console.log(result);
          res.send({ 'result': result, 'status': 200 });
        }
      });
    });
});




/**
 * API to get all labs subscriptions to super admin
 * params
 *  :lab_id
 */

app.get('/get_all_labs_subscriptions', auth.isAuthorized, (req, res) => {
  pool
    .connect()
    .then(client => {
      console.log('All Labs Subscriptions called...');
      client.query(`select t1.lab_id, t1.lab_name, t1.lab_unique_identifier, t3.subscription_type_id,t2.subscription_type_name,t2.subscription_description, t3.lab_sub_status, t3.lab_sub_id from tr_labs t1 inner join tr_labs_subscriptions t3 on t1.lab_id=t3.lab_id AND t3.lab_sub_status='active' inner join tr_subscription_types t2 on t3.subscription_type_id = t2.subscription_type_id`, function (err, result, done) {
        if (err) {
          client.release();
          return console.error('error running query', err);
        }
        else {
          console.log(result.rows);
          client.release();
          console.log("Connection closed...")
          res.send({ 'data': result.rows, 'status': 200 });
        }
      });
    });
});

/**
 * API to get lab subscriptions to lab admin
 * params
 *  :lab_id
 */

app.get('/get_lab_subscriptions/:lab_id', auth.isAuthorized, (req, res) => {
  let labId = req.params.lab_id;
  pool
    .connect()
    .then(client => {
      console.log('Lab subscription for labId ...', labId);
      client.query(`select t1.lab_id, t1.lab_name, t1.lab_unique_identifier, t3.subscription_type_id,t2.subscription_type_name,t2.subscription_description, t3.lab_sub_status from tr_labs t1 inner join tr_labs_subscriptions t3 on t1.lab_id=t3.lab_id AND t3.lab_sub_status='active' AND t1.lab_id=$1 inner join tr_subscription_types t2 on t3.subscription_type_id = t2.subscription_type_id`, [labId], function (err, result, done) {

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


