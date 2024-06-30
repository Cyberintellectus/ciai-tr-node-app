const Keycloak = require('keycloak-backend').Keycloak

const keycloak = new Keycloak({
  "realm": process.env.REALM || "orthanc",
  "keycloak_base_url": process.env.KEYCLOAK_BASE_URL || "http://localhost/keycloak",
  "client_id": process.env.CLIENT_ID || "orthanc"
});

module.exports.isAuthorized = async (req, res, next) =>{
    try{
        const tokenAuth = await keycloak.jwt.verify(req.headers.authorization.replace('Bearer ',''));
    console.log("Is Token expired ", tokenAuth.isExpired());
    if(tokenAuth.isExpired()){
        res.status(403).render();
    }
    next();
    }
    catch(err){
        console.log("catch  error..", err);
        res.json({'Status':err});
    }
    
}

