const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Public URL Keycloak puts in the token `iss` claim (e.g. https://ciaiteleradiology.com/keycloak)
const PUBLIC_KEYCLOAK_URL = (process.env.KEYCLOAK_URL || 'http://localhost/keycloak').replace(/\/+$/, '');
// Docker-network URL used to fetch each realm's signing keys
const INTERNAL_KEYCLOAK_URL = (process.env.KEYCLOAK_BASE_URL || 'http://keycloak:8080').replace(/\/+$/, '');

const REALM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];
const JWKS_TTL_MS = 10 * 60 * 1000;
// Minimum gap between forced refetches (unknown kid), so forged kids can't hammer Keycloak
const JWKS_MIN_REFETCH_MS = 30 * 1000;

const jwksCache = new Map(); // realm -> { keys: Map<kid, KeyObject>, fetchedAt }

const fetchRealmKeys = async (realm) => {
  const response = await fetch(`${INTERNAL_KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/certs`);
  if (!response.ok) {
    throw new Error(`JWKS fetch for realm "${realm}" failed with status ${response.status}`);
  }
  const { keys = [] } = await response.json();
  const byKid = new Map();
  for (const jwk of keys) {
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      byKid.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch (err) {
      console.error(`Skipping unusable JWK ${jwk.kid} for realm ${realm}:`, err.message);
    }
  }
  const entry = { keys: byKid, fetchedAt: Date.now() };
  jwksCache.set(realm, entry);
  return entry;
};

const getSigningKey = async (realm, kid) => {
  let entry = jwksCache.get(realm);
  const age = entry ? Date.now() - entry.fetchedAt : Infinity;
  if (age > JWKS_TTL_MS || (!entry.keys.has(kid) && age > JWKS_MIN_REFETCH_MS)) {
    entry = await fetchRealmKeys(realm);
  }
  return entry.keys.get(kid);
};

const unauthorized = (res, error) => res.status(401).json({ error });

/**
 * Verifies the Keycloak bearer token (signature, issuer, expiry, client) and
 * exposes the verified identity as req.auth. Handlers must use req.auth and
 * never client-supplied identity headers/body fields (Usersub, Labid, *_id).
 */
const isAuthorized = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return unauthorized(res, 'Bearer token is required');
  }

  const realm = req.headers.realm;
  const clientId = req.headers.clientid;
  if (!realm || !clientId) {
    return unauthorized(res, 'Realm and ClientId headers are required');
  }
  if (!REALM_PATTERN.test(realm)) {
    return unauthorized(res, 'Invalid realm');
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    return unauthorized(res, 'Invalid token format');
  }

  let payload;
  try {
    const key = await getSigningKey(realm, decoded.header.kid);
    if (!key) {
      return unauthorized(res, 'Unknown token signing key');
    }
    payload = jwt.verify(token, key, {
      algorithms: ALLOWED_ALGORITHMS,
      issuer: `${PUBLIC_KEYCLOAK_URL}/realms/${realm}`,
    });
  } catch (err) {
    console.warn(`Rejected token for realm ${realm}: ${err.message}`);
    return unauthorized(res, 'Invalid or expired token');
  }

  // Only access tokens; ID/refresh tokens must not be accepted as bearer credentials
  if (payload.typ && payload.typ !== 'Bearer') {
    return unauthorized(res, 'Invalid token type');
  }
  if (payload.azp !== clientId && payload.client_id !== clientId) {
    return unauthorized(res, 'Invalid client ID');
  }

  req.user = payload;
  req.auth = {
    realm,
    sub: payload.sub,
    roles: (payload.realm_access && payload.realm_access.roles) || [],
  };
  next();
};

module.exports = {
  isAuthorized,
};
