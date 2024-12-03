const Keycloak = require('keycloak-connect');
const session = require('express-session');
const jwt = require('jsonwebtoken');

const memoryStore = new session.MemoryStore();

// Create base Keycloak instance
const baseKeycloak = new Keycloak({
  store: memoryStore,
  secret: process.env.SESSION_SECRET || 'some-secret'
});

const isAuthorized = (req, res, next) => {
  // Check for authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: 'Authorization header is required'
    });
  }

  // Check for realm and client_id in headers
  const realm = req.headers.realm;
  const clientId = req.headers.clientid;

  if (!realm || !clientId) {
    return res.status(401).json({
      error: 'Realm and ClientId headers are required'
    });
  }

  // Create dynamic Keycloak config
  const keycloakConfig = {
    "realm": realm,
    "auth-server-url": process.env.KEYCLOAK_URL || "http://localhost/keycloak",
    "ssl-required": "external",
    "resource": clientId,
    "public-client": true,
    "confidential-port": 0,
    "verify-token-audience": true,
    "use-resource-role-mappings": true,
    "bearer-only": true
  };

  try {
    const token = authHeader.split(' ')[1];
    
    // First decode the token to check basic structure
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded) {
      return res.status(401).json({
        error: 'Invalid token format'
      });
    }

    // Check token expiration using decoded exp claim
    const now = Math.floor(Date.now() / 1000);
    if (decoded.payload.exp && decoded.payload.exp < now) {
      return res.status(401).json({
        error: 'Token has expired'
      });
    }

    // Verify token issuer matches realm
    const expectedIssuer = `${keycloakConfig['auth-server-url']}/realms/${realm}`;
    if (decoded.payload.iss !== expectedIssuer) {
      return res.status(401).json({
        error: 'Invalid token issuer',
        expected: expectedIssuer,
        received: decoded.payload.iss
      });
    }

    // Verify client ID
    if (decoded.payload.azp !== clientId && decoded.payload.client_id !== clientId) {
      return res.status(401).json({
        error: 'Invalid client ID'
      });
    }

    // Store decoded token info and proceed
    req.user = decoded.payload;
    next();

  } catch (err) {
    console.error('Token processing error:', err);
    return res.status(401).json({
      error: 'Invalid token',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Initialize Keycloak middleware
const initKeycloak = (realm, clientId) => {
  const keycloakConfig = {
    "realm": realm,
    "auth-server-url": process.env.KEYCLOAK_URL || "http://keycloak:8080",
    "ssl-required": "external",
    "resource": clientId,
    "public-client": true,
    "confidential-port": 0,
    "verify-token-audience": true,
    "use-resource-role-mappings": true,
    "bearer-only": true
  };

  return new Keycloak({
    store: memoryStore,
    secret: process.env.SESSION_SECRET || 'some-secret'
  }, keycloakConfig);
};

module.exports = {
  isAuthorized,
  initKeycloak,
  keycloak: baseKeycloak
};
