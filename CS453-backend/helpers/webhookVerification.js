const crypto = require("crypto");

/**
 * Verify webhook signature using HMAC
 * @param {string} signature - Signature from X-Webhook-Signature header
 * @param {string} payload - Raw request body as string
 * @param {string} secret - Webhook secret
 * @returns {boolean} - true if signature is valid
 */
function verifyWebhookSignature(signature, payload, secret) {
  if (!signature || !secret) {
    return false;
  }

  // Remove 'sha256=' prefix if present
  const signatureWithoutPrefix = signature.replace(/^sha256=/, "");
  
  // Calculate expected signature
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signatureWithoutPrefix, "hex"),
    Buffer.from(expectedSignature, "hex")
  );
}

/**
 * Express middleware to verify webhook signatures
 * @param {string} secret - Webhook secret (from env or config)
 * @returns {Function} - Express middleware function
 */
function webhookSignatureMiddleware(secret) {
  return (req, res, next) => {
    if (!secret) {
      console.warn(
        "[WEBHOOK] No webhook secret configured. Webhook verification disabled."
      );
      return next();
    }

    const signature = req.headers["x-webhook-signature"] || req.headers["x-n8n-signature"];
    
    if (!signature) {
      return res.status(401).json({
        error: "Missing webhook signature",
        message: "X-Webhook-Signature or X-N8N-Signature header required",
      });
    }

    // Get raw body (should be Buffer when using express.raw())
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = req.body.toString("utf8");
    } else if (typeof req.body === "string") {
      payload = req.body;
    } else if (req.body && typeof req.body === "object") {
      // Fallback: stringify if already parsed (shouldn't happen with raw middleware)
      payload = JSON.stringify(req.body);
    } else {
      payload = "";
    }

    const isValid = verifyWebhookSignature(signature, payload, secret);

    if (!isValid) {
      console.warn("[WEBHOOK] Invalid signature received");
      return res.status(403).json({
        error: "Invalid webhook signature",
        message: "Signature verification failed",
      });
    }

    console.log("[WEBHOOK] Signature verified successfully");
    next();
  };
}

module.exports = {
  verifyWebhookSignature,
  webhookSignatureMiddleware,
};

