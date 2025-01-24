const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
const session = require('express-session');
const { Pool } = require('pg');
const auth = require('./middleware/keycloak');
var https = require("https");
const crypto = require('crypto');

const axios = require('axios');
const qs = require('qs');

dotenv.config();

// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, 'public/uploads/');
//   },
//   filename: (req, file, cb) => {
//     // Sanitize filename by removing special characters and spaces
//     const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
//     const timestamp = Date.now();
//     const uniqueFilename = `${timestamp}-${sanitizedName}`;
//     console.log('Original filename:', file.originalname);
//     console.log('Sanitized filename:', uniqueFilename);
//     cb(null, uniqueFilename);
//   }
// });

// const uploadStorage = multer({ storage: storage });
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

    //const shortUrl1 = urlShortener64.encode(formData.sr_url);
    const short_key = generateUniqueKey();

    console.log("Encoded Short URL Key:", short_key);



    sendWhatsappreferral(formData.sr_to_doctor, formData.sr_requester_comments, short_key, formData.sr_host_name);
    const result = await executeQuery(
      'INSERT INTO public.tr_study_referrals(sr_to_doctor, sr_status, sr_requester_id, sr_requester_comments, short_key, referred_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING sr_id',
      [formData.sr_to_doctor, 'active', formData.sr_requester_id, formData.sr_requester_comments, short_key, formData.sr_url]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error sending study referral:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

function generateUniqueKey() {
  return crypto.randomBytes(16).toString('hex'); // 16 bytes = 32 characters in hexadecimal
}

const urlShortener64 = (() => {
  const encode = (longUrl) => {
    try {
      // Convert URL to Base64
      const buffer = Buffer.from(longUrl, 'utf8');
      const base64 = buffer.toString('base64');
      
      // Make it URL safe
      return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    } catch (err) {
      console.error('URL encoding error:', err);
      throw new Error('Invalid URL provided');
    }
  };

  const decode = (shortKey) => {
    try {
      // Restore Base64 padding
      let base64 = shortKey
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      
      // Add padding if needed
      while (base64.length % 4) {
        base64 += '=';
      }
      
      // Decode Base64 back to URL
      const buffer = Buffer.from(base64, 'base64');
      return buffer.toString('utf8');
    } catch (err) {
      console.error('URL decoding error:', err);
      return null;
    }
  };

  return { encode, decode };
})();





async function sendWhatsappreferral(doc_id, comment, shortUrl, host) {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'SELECT doc_clinic, doc_name, doc_phone_number FROM public.tr_doctor_referrel WHERE doc_id = $1 AND is_deleted = $2',
      [doc_id, false]
    );

    if (result.rows.length === 0) {
      throw new Error('No doctor found with the given ID');
    }

    const doctor = result.rows[0];
    const toContact = doctor.doc_phone_number;

    // Sanitize and encode message components
    //const sanitizedDoctorName = encodeURIComponent(doctor.doc_name);
    const sanitizedComment = comment ? encodeURIComponent(comment.trim()) : '';
    const referralUrl = `${process.env.REFER_HOST}/teleapp/refer_to/${shortUrl}`;

    // Construct message with proper encoding
    const messageBody = `Hello Dr. ${doctor.doc_name} \nPlease check: ${referralUrl}`;

    const options = {
      method: "POST",
      hostname: process.env.WHATSAPP_HOST,
      path: "/instance95879/messages/chat",
      headers: {
        "content-type": "application/json"
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          console.log("WhatsApp API Response:", body);
          resolve(body);
        });
        res.on("error", reject);
      });

      req.on("error", reject);

      const postData = JSON.stringify({
        token: process.env.WHATSAPP_TOKEN,
        to: toContact,
        body: messageBody,
        priority: 1,
        referenceId: `ref_${Date.now()}`,
        msgId: `msg_${Date.now()}`,
        mentions: ""
      });

      console.log("WhatsApp request payload:", postData);
      req.write(postData);
      req.end();
    });
  } catch (err) {
    console.error('Error in sendWhatsappreferral:', err);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * API to URL redirect for referral
*/
app.get('/refer_to/:url_str', async (req, res) => {
  console.log('read_study_url   req.headers', req.params);
  try {

    const result = await executeQuery(
      'SELECT referred_url FROM public.tr_study_referrals WHERE short_key=$1 ORDER BY sr_id DESC',
      [req.params.url_str]
    );

    console.log("Decoded Long URL 1234:", result.rows);
    res.redirect(result.rows[0].referred_url);

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
