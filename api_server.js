const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const session = require('express-session');
const { Pool } = require('pg');
const auth = require('./middleware/keycloak');
var https = require("https");

const axios = require('axios');
const qs = require('qs');

dotenv.config();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    console.log('file.originalname ', file.originalname);
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const uploadStorage = multer({ storage: storage });
const app = express();
const PORT = process.env.PORT || 3300;

app.use(express.static(__dirname + '/public'));

const pool = new Pool({
  user: process.env.USER,
  password: process.env.PASSWORD,
  host: process.env.HOST,
  port: process.env.DB_PORT || '5432',
  database: process.env.DB,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Realm', 'ClientId']
}));

app.use(bodyParser.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'someSecret',
  resave: false,
  saveUninitialized: true
}));

const executeQuery = async (query, params = []) => {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(query, params);
    return result;
  } catch (err) {
    console.error('Database query error:', err);
    throw err;
  } finally {
    if (client) {
      try {
        client.release();
      } catch (err) {
        console.error('Error releasing client:', err);
      }
    }
  }
};

app.get('/secure', auth.isAuthorized, (req, res) => {
  res.json({ message: 'You have accessed a secure route!', user: req.user });
});


app.post('/get_cloud_token', auth.isAuthorized, async (req, res) => {
  try {
    const url = `${process.env.TELE_HOST}/keycloak/realms/${process.env.CLOUD_REALM}/protocol/openid-connect/token`;

    const payload = qs.stringify({
      'client_id': process.env.CLOUD_CLIENT_ID,
      'grant_type': 'password',
      'scope': 'openid',
      'username': process.env.CLOUD_USER,
      'password': process.env.CLOUD_PWD
    });

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    axios.post(url, payload, { headers: headers })
      .then(response => {
        const tokenData = response.data;
        console.log(tokenData);
        res.json({ data: tokenData, status: 200 });
      });

  } catch (err) {
    res.status(500).json({ error: 'Auth Error', details: err.message });
  }
});



app.post('/update_referral_doctor', auth.isAuthorized, async (req, res) => {
  console.log('update_referral_doctor   req.headers', req.headers);
  try {
    const { doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, doc_id } = req.body;
    const result = await executeQuery(
      'UPDATE public.tr_doctor_referrel SET doc_name=$1, doc_specialization=$2, doc_clinic=$3, doc_phone_number=$4, doc_email=$5, doctor_updated_by=$6,doc_updated_date=CURRENT_DATE  WHERE doc_id=$7 AND lab_id=$8 RETURNING doc_id',
      [doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, req.headers.usersub, doc_id, req.headers.labid]
    );
    res.json({ result, status: 200 });
  } catch (err) {
    console.error('Error updating referral doctor:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});



app.post('/add_referral_doctor', auth.isAuthorized, async (req, res) => {
  console.log('add_referral_doctor   req.headers', req.headers);
  try {
    const { doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email } = req.body;
    const result = await executeQuery(
      'INSERT INTO public.tr_doctor_referrel(doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, doctor_created_by, doc_created_date, lab_id) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7) RETURNING doc_id',
      [doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, req.headers.usersub, req.headers.labid]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error adding referral doctor:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.get('/get_referral_doctors', auth.isAuthorized, async (req, res) => {
  console.log('get_referral_doctors   req.headers', req.headers);
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_doctor_referrel WHERE is_deleted = false AND lab_id=$1 ORDER BY doc_id', [req.headers.labid]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error getting referral doctors:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.get('/get_sub_modalities/:modality', auth.isAuthorized, async (req, res) => {
  console.log('get_sub_modalities   req.headers', req.headers);
  try {
    const result = await executeQuery(
      'SELECT template_id, sub_modality FROM public.tr_templates WHERE modality=$1 AND lab_id=$2',
      [req.params.modality, req.headers.labid]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error getting sub modalities:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.post('/send_study_referral', auth.isAuthorized, async (req, res) => {
  try {
    const formData = req.body;

    const shortUrl1 = urlShortener64.encode(formData.sr_url);
    console.log("Encoded Short URL Key:", shortUrl1);



    sendWhatsappreferral(formData.sr_to_doctor, formData.sr_requester_comments, shortUrl1, formData.sr_host_name);
    const result = await executeQuery(
      'INSERT INTO public.tr_study_referrals(sr_to_doctor, sr_status, sr_requester_id, sr_requester_comments) VALUES ($1, $2, $3, $4) RETURNING sr_id',
      [formData.sr_to_doctor, 'active', formData.sr_requester_id, formData.sr_requester_comments]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error sending study referral:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

const urlShortener64 = (() => {
  const urlMap = new Map();
  const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  const encodeToBase64 = (input) => {
    let hashValue = 0;
    for (let i = 0; i < input.length; i++) {
      hashValue = (hashValue * 31 + input.charCodeAt(i)) >>> 0; // Simple hash function
    }

    // Convert the hash value to a base-64 string
    let base64String = "";
    do {
      base64String = base64Chars[hashValue % 64] + base64String;
      hashValue = Math.floor(hashValue / 64);
    } while (hashValue > 0);

    return base64String;
  };

  const encode = (longUrl) => {
    const shortUrlKey = encodeToBase64(longUrl);
    urlMap.set(shortUrlKey, longUrl);
    return shortUrlKey;
  };

  const decode = (shortUrlKey) => {
    return urlMap.get(shortUrlKey) || null;
  };

  return { encode, decode };
})();

// Example usage:
// const longUrl1 = "https://example.com/some/very/long/url/with/query?params=true";
// const shortUrl = urlShortener64.encode(longUrl1);
// console.log("Encoded Short URL Key:", shortUrl);

// const originalUrl = urlShortener64.decode(shortUrl);
// console.log("Decoded Long URL:", originalUrl);




function sendWhatsappreferral(doc_id, comment, shortUrl, host) {
  pool.connect().then(client => {
    console.log('sendWhatsappreferral called...');
    client.query('SELECT doc_clinic, doc_name, doc_phone_number FROM public.tr_doctor_referrel WHERE doc_id = $1 AND is_deleted=$2', [doc_id, false], (err, result) => {
      if (err) {
        client.release();
        return console.error('Error running query', err);
      }

      if (result.rows.length === 0) {
        client.release();
        return console.error('No doctor found with the given ID');
      }

      const doctor = result.rows[0];
      const toContact = doctor.doc_phone_number;

      client.release();
      console.log("Connection closed...");

      const options = {
        method: "POST",
        hostname: "api.ultramsg.com",
        path: "/instance95879/messages/chat",
        headers: {
          "content-type": "application/json"
        }
      };

      const req = https.request(options, res => {
        let chunks = [];

        res.on("data", chunk => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          const body = Buffer.concat(chunks);
          console.log(body.toString());
        });
      });

      const postData = JSON.stringify({
        token: "1c63atui3vx70epu9hhh",
        to: toContact,
        body: `Please click this link ${process.env.REFER_HOST}/teleapp/refer_to/${shortUrl}`,
        priority: 1,
        referenceId: "",
        msgId: "",
        mentions: ""
      });

      console.log("<------------WhatsApp ------------> \n");
      console.log("WhatsApp postData ", postData);
      req.write(postData);
      req.end();
    });
  }).catch(err => {
    console.error('Error connecting to the database', err);
  });
}

/**
 * API to URL redirect for referral
*/
app.get('/refer_to/:url_str', async (req, res) => {
  console.log('read_study_template   req.headers', req.headers);
  try {
    const decodedUrl = urlShortener64.decode(req.params.url_str);
    console.log("Decoded Long URL:", decodedUrl);
    res.redirect(decodedUrl);

  } catch (err) {
    console.error('Error reading study template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});



/**
 * API to Read modalaitied to all lab admins
*/
app.get('/read_modalities/:lab_id', auth.isAuthorized, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT * FROM tr_modalities WHERE modality_status=$1 ORDER BY modality_name ASC',
      ['active']
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error reading modalities:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.get('/read_templates', auth.isAuthorized, async (req, res) => {
  console.log('read_templates   req.headers', req.headers);
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND is_deleted = $2 ORDER BY template_id ASC',
      [req.headers.labid, false]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error reading templates:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.post('/create_template', auth.isAuthorized, async (req, res) => {
  console.log('create_template --->   req.headers', req.headers);
  try {
    const { modality, template_content, lab_id, sub_modality } = req.body;
    const result = await executeQuery(
      'INSERT INTO public.tr_templates(modality, template_content, lab_id, sub_modality, template_created_by, create_date) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE) RETURNING template_id',
      [modality, template_content, lab_id, sub_modality, req.headers.usersub]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error creating template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.post('/update_template', auth.isAuthorized, async (req, res) => {
  console.log('updated_template --->   req.headers', req.headers);
  try {
    const { template_content, modality, sub_modality } = req.body;
    const result = await executeQuery(
      'UPDATE public.tr_templates SET template_content = $1, template_updated_by=$2, updated_date=CURRENT_DATE  WHERE modality = $3 AND sub_modality=$4 AND lab_id=$5',
      [template_content, req.headers.usersub, modality, sub_modality, req.headers.labid]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error updating template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// app.get('/read_modality/:modality/:labName', auth.isAuthorized, async (req, res) => {
//   try {
//     const result = await executeQuery('SELECT * FROM tr_templates');
//     res.set('Access-Control-Allow-Origin', '*');

//     const fileName = req.params.labName;
//     const data = readDataFromFile(fileName);
//     const item = data.find((item) => item.modality === req.params.modality);

//     if (item) {
//       res.json(item);
//     } else {
//       res.status(404).json({ error: 'Item not found' });
//     }
//   } catch (err) {
//     console.error('Error reading modality:', err);
//     res.status(500).json({ error: 'Database error', details: err.message });
//   }
// });

// app.get('/read_modalities_for_lab/:lab_id/:sub_modality', auth.isAuthorized, async (req, res) => {
//   try {
//     const result = await executeQuery(
//       'SELECT count(*) FROM tr_templates WHERE lab_id=$1 AND sub_modality=$2',
//       [req.params.lab_id, req.params.sub_modality]
//     );
//     res.json({ data: result.rows, status: 200 });
//   } catch (err) {
//     console.error('Error reading modalities for lab:', err);
//     res.status(500).json({ error: 'Database error', details: err.message });
//   }
// });

app.get('/read_study_template/:lab_id/:template_id', auth.isAuthorized, async (req, res) => {
  console.log('read_study_template   req.headers', req.headers);
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND template_id=$2 AND is_deleted = $3 ORDER BY template_id ASC',
      [req.headers.labid, req.params.template_id, false]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error reading study template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.get('/read_study_template_for_generate/:lab_id/:modality/:type', auth.isAuthorized, async (req, res) => {
  console.log('read_study_template_for_generate   req.headers', req.headers);
  try {
    const query = req.params.type === 'm'
      ? 'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND template_id=$2 AND is_deleted = $3 ORDER BY template_id ASC'
      : 'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND modality=$2 AND is_deleted = $3 ORDER BY template_id ASC';

    const result = await executeQuery(query, [req.headers.labid, req.params.modality, false]);
    res.json({ data: result.rows[0], status: 200 });
  } catch (err) {
    console.error('Error reading study template for generate:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

/**
 * API to get lab subscriptions to lab admin
 * params
 *  :lab_id
 */


app.get('/get_lab_subscriptions/:lab_id', auth.isAuthorized, async (req, res) => {
  console.log('get_lab_subscriptions   req.headers', req.headers);
  try {
    const firstQueryResult = await executeQuery(
      `select 
	t1.lab_id, 
	t1.lab_name, t1.lab_unique_identifier, 
	t3.subscription_type_id,t2.subscription_type_name,t2.subscription_description, 
	t3.lab_sub_status 
	from tr_labs t1 inner join tr_labs_subscriptions t3 on t1.lab_id=t3.lab_id 
	AND t3.lab_sub_status='active' 
	AND t1.lab_unique_identifier=$1
	inner join tr_subscription_types t2 on t3.subscription_type_id = t2.subscription_type_id`,
      [req.headers.realm]
    );
    // res.json({ data: result.rows, status: 200 });
    if (firstQueryResult.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscriptions found' });
    }

    const subscriptionTypeId = firstQueryResult.rows[0].subscription_type_name;

    // Second query to get features based on subscription_type_id
    const secondQueryResult = await executeQuery(
      `SELECT 
	st.subscription_type_id,
	st.subscription_type_name,
    STRING_AGG(ft.feature_unique_name, ', ') AS features_list
FROM 
    tr_subscription_types st
LEFT JOIN 
    tr_subscription_fetaures sf ON st.subscription_type_id = sf.subscription_id
LEFT JOIN 
    tr_features ft ON sf.feature_id = ft.feature_id
WHERE st.subscription_type_name=$1
GROUP BY 
    st.subscription_type_id, st.subscription_type_name
ORDER BY 
    st.subscription_type_id`,
      [subscriptionTypeId]
    );

    // Combine results
    const finalResult = {
      labSubscriptions: firstQueryResult.rows,
      features: secondQueryResult.rows
    };

    res.json({ data: finalResult, status: 200 });

  } catch (err) {
    console.error('Error reading study template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});


app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});