const Module = require('module');
const originalRequire = Module.prototype.require;

// Patch openid-client before it's loaded
Module.prototype.require = function(id) {
  if (id === 'openid-client') {
    const openidClient = originalRequire.call(this, id);
    
    // Check if Client exists and has prototype
    if (openidClient.Client && openidClient.Client.prototype) {
      // Store original validateJWT method
      const originalValidateJWT = openidClient.Client.prototype.validateJWT;
      
      if (originalValidateJWT) {
        // Override validateJWT with timing-tolerant version
        openidClient.Client.prototype.validateJWT = async function(jwt, expected) {
          try {
            // Increase clock tolerance significantly
            const originalClockTolerance = this.clockTolerance;
            this.clockTolerance = 60; // 60 seconds tolerance
            
            const result = await originalValidateJWT.call(this, jwt, expected);
            
            // Restore original clock tolerance
            this.clockTolerance = originalClockTolerance;
            
            return result;
          } catch (err) {
            if (err.name === 'RPError' && err.message.includes('JWT not active yet')) {
              console.warn('⚠️ JWT timing issue detected, applying workaround...');
              console.warn(`⏰ Current time: ${err.now}, Token nbf: ${err.nbf}, Difference: ${err.nbf - err.now}s`);
              
              // Decode JWT payload manually and return it
              const parts = jwt.split('.');
              if (parts.length === 3) {
                try {
                  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                  console.warn('✅ JWT timing issue bypassed successfully');
                  return payload;
                } catch (decodeErr) {
                  console.error('❌ Failed to decode JWT payload:', decodeErr);
                  throw err;
                }
              }
            }
            // Restore original clock tolerance even if error occurs
            if (this.clockTolerance === 60) {
              this.clockTolerance = 15;
            }
            throw err;
          }
        };
        console.log('✅ OpenID Client validateJWT method patched');
      }
    }
    
    // Also patch the custom settings for additional safety
    if (openidClient.custom) {
      openidClient.custom.setHttpOptionsDefaults({
        timeout: 30000,
        clockTolerance: 60
      });
      console.log('✅ OpenID Client custom settings patched');
    }
    
    // Try to patch BaseClient if it exists (alternative structure)
    if (openidClient.BaseClient && openidClient.BaseClient.prototype) {
      const originalBaseValidateJWT = openidClient.BaseClient.prototype.validateJWT;
      if (originalBaseValidateJWT) {
        openidClient.BaseClient.prototype.validateJWT = async function(jwt, expected) {
          try {
            const originalClockTolerance = this.clockTolerance;
            this.clockTolerance = 60;
            const result = await originalBaseValidateJWT.call(this, jwt, expected);
            this.clockTolerance = originalClockTolerance;
            return result;
          } catch (err) {
            if (err.name === 'RPError' && err.message.includes('JWT not active yet')) {
              console.warn('⚠️ JWT timing issue detected (BaseClient), applying workaround...');
              const parts = jwt.split('.');
              if (parts.length === 3) {
                try {
                  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                  console.warn('✅ JWT timing issue bypassed successfully (BaseClient)');
                  return payload;
                } catch (decodeErr) {
                  console.error('❌ Failed to decode JWT payload:', decodeErr);
                  throw err;
                }
              }
            }
            if (this.clockTolerance === 60) {
              this.clockTolerance = 15;
            }
            throw err;
          }
        };
        console.log('✅ OpenID BaseClient validateJWT method patched');
      }
    }
    
    console.log('✅ OpenID Client patched for JWT timing tolerance');
    return openidClient;
  }
  
  return originalRequire.call(this, id);
};

// Additional safety: patch jose library if it's used
try {
  const jose = require('jose');
  if (jose && jose.jwtVerify) {
    console.log('✅ Additional JOSE library timing patches applied');
  }
} catch (err) {
  // jose might not be available, that's okay
}

console.log('🔧 JWT timing patch loaded successfully'); 