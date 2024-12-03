const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const multer = require("multer");
const session = require("express-session");
const { Pool } = require('pg');

const auth = require('./middleware/keycloak');

dotenv.config();

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

const app = express();
const PORT = process.env.PORT || 3300;

app.use(express.static(__dirname + '/public'));

// Database configuration
const pool = new Pool({
  user: process.env.USER,
  password: process.env.PASSWORD,
  host: process.env.HOST,
  port: process.env.DB_PORT || '5432',
  database: process.env.DB,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Error handler for database connection
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Configure CORS
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Realm', 'ClientId']
}));

app.use(bodyParser.json());

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || "someSecret",
    resave: false,
    saveUninitialized: true
  })
);

// Helper function for database queries
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

app.get("/secure", auth.isAuthorized, (req, res) => {
  res.json({ message: "You have accessed a secure route!", user: req.user });
});

app.post("/update_referral_doctor", auth.isAuthorized, async (req, res) => {
  try {
    const { doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, doc_id } = req.body;
    const result = await executeQuery(
      'UPDATE public.tr_doctor_referrel SET doc_name=$1, doc_specialization=$2, doc_clinic=$3, doc_phone_number=$4, doc_email=$5 WHERE doc_id=$6 RETURNING doc_id',
      [doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email, doc_id]
    );
    res.json({ result, status: 200 });
  } catch (err) {
    console.error('Error updating referral doctor:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.post('/add_referral_doctor', auth.isAuthorized, async (req, res) => {
  try {
    const { doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email } = req.body;
    const result = await executeQuery(
      'INSERT INTO public.tr_doctor_referrel(doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email) VALUES ($1, $2, $3, $4, $5) RETURNING doc_id',
      [doc_name, doc_specialization, doc_clinic, doc_phone_number, doc_email]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error adding referral doctor:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.get("/get_referral_doctors", auth.isAuthorized, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_doctor_referrel WHERE is_deleted = false ORDER BY doc_id'
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error getting referral doctors:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.get('/get_sub_modalities/:modality', auth.isAuthorized, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT template_id, sub_modality FROM public.tr_templates WHERE modality=$1',
      [req.params.modality]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error getting sub modalities:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

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

app.get('/read_templates/:lab_id', auth.isAuthorized, async (req, res) => {
  try {
    const result = await executeQuery(
      'SELECT * FROM public.tr_templates WHERE lab_id=$1 AND is_deleted = $2 ORDER BY template_id ASC',
      [req.params.lab_id, false]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error reading templates:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.post('/create_template', auth.isAuthorized, async (req, res) => {
  try {
    const { modality, template_content, lab_id, sub_modality } = req.body;
    const result = await executeQuery(
      'INSERT INTO public.tr_templates(modality, template_content, lab_id, sub_modality) VALUES ($1, $2, $3, $4) RETURNING template_id',
      [modality, template_content, lab_id, sub_modality]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error creating template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

app.post('/update_template', auth.isAuthorized, async (req, res) => {
  try {
    const { template_content, modality, sub_modality } = req.body;
    const result = await executeQuery(
      'UPDATE public.tr_templates SET template_content = $1 WHERE modality = $2 AND sub_modality=$3',
      [template_content, modality, sub_modality]
    );
    res.json({ data: result.rows, status: 200 });
  } catch (err) {
    console.error('Error updating template:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});


// Error handling middleware
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
