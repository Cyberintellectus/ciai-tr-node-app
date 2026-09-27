const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require('multer');
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

// Exact origins or "https://*.domain" wildcards; never reflect arbitrary origins
const corsOriginPatterns = (process.env.CORS_ALLOWED_ORIGINS || 'https://ciaiteleradiology.com,https://*.ciaiteleradiology.com')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)
  .map((o) => {
    const escaped = o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace('\\*\\.', '(?:[a-z0-9-]+\\.)+') + '$', 'i');
  });

app.use(cors({
  origin: (origin, callback) => callback(null, !!origin && corsOriginPatterns.some((re) => re.test(origin))),
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Realm', 'ClientId', 'Isaccess', 'Usersub', 'Labid', 'Abcdefg', 'X1234']
}));

app.use(bodyParser.json());

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

/**
 * Resolves the caller's lab from the verified token realm. Client-sent Labid
 * headers / lab_id fields are ignored so a user cannot act on another lab.
 */
const resolveLab = async (req, res, next) => {
  try {
    const result = await executeQuery(
      `SELECT t1.lab_id FROM tr_labs t1
       LEFT JOIN tr_labs_subscriptions t3 ON t3.lab_id = t1.lab_id AND t3.lab_sub_status = 'active'
       WHERE t1.lab_unique_identifier = $1
       ORDER BY (t3.lab_id IS NULL), t1.lab_id
       LIMIT 1`,
      [req.auth.realm]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'No lab registered for this realm' });
    }
    req.labId = result.rows[0].lab_id;
    if (req.labId && String(req.labId) !== String(req.labId)) {
      console.warn(`Labid header mismatch: sub=${req.auth.sub} realm=${req.auth.realm} sent=${req.labId} actual=${req.labId} path=${req.path}`);
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Premium features need both the realm role and an active lab subscription
 * that includes the feature (same rule the viewer UI uses to show it).
 */
const requireFeature = (feature) => async (req, res, next) => {
  try {
    if (!req.auth.roles.includes(feature)) {
      console.warn(`Feature denied (role): ${feature} sub=${req.auth.sub} realm=${req.auth.realm}`);
      return res.status(403).json({ error: 'Feature not available for this user' });
    }
    const result = await executeQuery(
      `SELECT 1 FROM tr_labs_subscriptions ls
       JOIN tr_subscription_fetaures sf ON sf.subscription_id = ls.subscription_type_id
       JOIN tr_features ft ON ft.feature_id = sf.feature_id
       WHERE ls.lab_id = $1 AND ls.lab_sub_status = 'active' AND ft.feature_unique_name = $2
       LIMIT 1`,
      [req.labId, feature]
    );
    if (result.rows.length === 0) {
      console.warn(`Feature denied (subscription): ${feature} sub=${req.auth.sub} lab=${req.labId}`);
      return res.status(403).json({ error: 'Feature not included in lab subscription' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Hosts referral links may point to (and /refer_to may redirect to), incl. subdomains
const referralUrlHosts = (process.env.REFERRAL_URL_HOSTS || 'ciaiteleradiology.com')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const isAllowedReferralUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return referralUrlHosts.some((h) => host === h || host.endsWith('.' + h));
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

    const response = await axios.post(url, payload, { headers: headers });
    res.json({ data: response.data, status: 200 });

  } catch (err) {
    console.error('Error getting cloud token:', err.message);
    res.status(500).json({ error: 'Auth Error' });
  }
});



app.post('/update_referral_doctor', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const { doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, doc_id } = req.body;
    const result = await executeQuery(
      'UPDATE public.tr_doctor_referrel SET doc_name=$1, doc_specialization=$2, doc_clinic=$3, doc_phone_number=$4, doc_email=$5, doctor_updated_by=$6,doc_updated_date=CURRENT_DATE  WHERE doc_id=$7 AND lab_id=$8 RETURNING doc_id',
      [doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, req.auth.sub, doc_id, req.labId]
    );
    res.json({ result, status: 200 });
  } catch (err) {
    console.error('Error updating referral doctor:', err);
    res.status(500).json({ error: 'Database error' });
  }
});



app.post('/add_referral_doctor', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const { doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email } = req.body;
    const result = await executeQuery(
      'INSERT INTO public.tr_doctor_referrel(doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, doctor_created_by, doc_created_date, lab_id) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, $7) RETURNING doc_id',
      [doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, req.auth.sub, req.labId]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error adding referral doctor:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/get_referral_doctors', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_doctor_referrel WHERE is_deleted = false AND lab_id=$1 ORDER BY doc_id', [req.labId]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error getting referral doctors:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/get_sub_modalities/:modality', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT template_id, sub_modality FROM public.tr_templates WHERE modality=$1 AND lab_id=$2',
      [req.params.modality, req.labId]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error getting sub modalities:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/send_study_referral', auth.isAuthorized, resolveLab, requireFeature('refer_study_to_doctor'), async (req, res) => {
  try {
    // Requester identity comes from the verified token; body sr_requester_id is ignored
    const { sr_to_doctor, sr_requester_comments, sr_url } = req.body || {};

    if (typeof sr_url !== 'string' || !isAllowedReferralUrl(sr_url)) {
      return res.status(400).json({ error: 'Invalid referral URL' });
    }

    const doctorResult = await executeQuery(
      'SELECT doc_id, doc_name, doc_phone_number FROM public.tr_doctor_referrel WHERE doc_id = $1 AND lab_id = $2 AND is_deleted = false',
      [sr_to_doctor, req.labId]
    );
    if (doctorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    const short_key = generateUniqueKey();
    const result = await executeQuery(
      'INSERT INTO public.tr_study_referrals(sr_to_doctor, sr_status, sr_requester_sub, sr_lab_id, sr_requester_comments, short_key, referred_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING sr_id',
      [doctorResult.rows[0].doc_id, 'active', req.auth.sub, req.labId, sr_requester_comments, short_key, sr_url]
    );

    sendWhatsappreferral(doctorResult.rows[0], short_key)
      .catch((err) => console.error('Error in sendWhatsappreferral:', err.message));

    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error sending study referral:', err);
    res.status(500).json({ error: 'Database error' });
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





function sendWhatsappreferral(doctor, shortUrl) {
  const referralUrl = `${process.env.REFER_HOST}/teleapp/refer_to/${shortUrl}`;
  const messageBody = `Hello Dr. ${doctor.doc_name} 
Please check: ${referralUrl}`;

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

    req.write(JSON.stringify({
      token: process.env.WHATSAPP_TOKEN,
      to: doctor.doc_phone_number,
      body: messageBody,
      priority: 1,
      referenceId: `ref_${Date.now()}`,
      msgId: `msg_${Date.now()}`,
      mentions: ""
    }));
    req.end();
  });
}

/**
 * API to URL redirect for referral
*/
app.get('/refer_to/:url_str', async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT referred_url FROM public.tr_study_referrals WHERE short_key=$1 ORDER BY sr_id DESC',
      [req.params.url_str]
    );

    const target = result.rows.length ? result.rows[0].referred_url : null;
    if (!target || !isAllowedReferralUrl(target)) {
      return res.status(404).json({ error: 'Referral not found' });
    }
    res.redirect(target);

  } catch (err) {
    console.error('Error reading referral:', err);
    res.status(500).json({ error: 'Database error' });
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
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/read_templates', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND is_deleted = $2 ORDER BY template_id ASC',
      [req.labId, false]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error reading templates:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/create_template', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const { modality, template_content, sub_modality } = req.body;
    const result = await executeQuery(
      'INSERT INTO public.tr_templates(modality, template_content, lab_id, sub_modality, template_created_by, create_date) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE) RETURNING template_id',
      [modality, template_content, req.labId, sub_modality, req.auth.sub]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error creating template:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/update_template', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const { template_content, modality, sub_modality } = req.body;
    const result = await executeQuery(
      'UPDATE public.tr_templates SET template_content = $1, template_updated_by=$2, updated_date=CURRENT_DATE  WHERE modality = $3 AND sub_modality=$4 AND lab_id=$5',
      [template_content, req.auth.sub, modality, sub_modality, req.labId]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error updating template:', err);
    res.status(500).json({ error: 'Database error' });
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
//     res.status(500).json({ error: 'Database error' });
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
//     res.status(500).json({ error: 'Database error' });
//   }
// });

app.get('/read_study_template/:lab_id/:template_id', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND template_id=$2 AND is_deleted = $3 ORDER BY template_id ASC',
      [req.labId, req.params.template_id, false]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error reading study template:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/read_study_template_for_generate/:lab_id/:modality/:type', auth.isAuthorized, resolveLab, async (req, res) => {
  try {
    const query = req.params.type === 'm'
      ? 'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND template_id=$2 AND is_deleted = $3 ORDER BY template_id ASC'
      : 'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND modality=$2 AND is_deleted = $3 ORDER BY template_id ASC';

    const result = await executeQuery(query, [req.labId, req.params.modality, false]);
    res.json({ data: result.rows[0], status: 200 });
  } catch (err) {
    console.error('Error reading study template for generate:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * API to get lab subscriptions to lab admin
 * params
 *  :lab_id
 */


app.get('/get_lab_subscriptions/:lab_id', auth.isAuthorized, async (req, res) => {
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
      [req.auth.realm]
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
    res.status(500).json({ error: 'Database error' });
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
