import * as crypto from 'crypto';

/**
 * Encrypts a plaintext token using AES-256-GCM.
 * Returns a string in format 'iv:authTag:ciphertext' where each segment is hex-encoded.
 */
export function encryptToken(plaintext: string, masterKey: string): string {
  // Convert hex-encoded master key to buffer
  const keyBuffer = Buffer.from(masterKey, 'hex');

  // Generate a random IV (16 bytes for AES)
  const iv = crypto.randomBytes(16);

  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);

  // Encrypt the plaintext
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  // Get the authentication tag
  const authTag = cipher.getAuthTag();

  // Return in format: iv:authTag:ciphertext (all hex-encoded)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext}`;
}

/**
 * Decrypts a token encrypted with encryptToken.
 * Expects ciphertext in format 'iv:authTag:ciphertext' where each segment is hex-encoded.
 * Throws an error if decryption fails (including GCM integrity check failure).
 */
export function decryptToken(ciphertext: string, masterKey: string): string {
  // Convert hex-encoded master key to buffer
  const keyBuffer = Buffer.from(masterKey, 'hex');

  // Split the ciphertext into segments
  const segments = ciphertext.split(':');

  if (segments.length !== 3) {
    throw new Error('Invalid ciphertext format: expected 3 segments separated by colons');
  }

  const [ivHex, authTagHex, encryptedHex] = segments;

  // Validate hex format
  if (!/^[0-9a-f]*$/.test(ivHex) || !/^[0-9a-f]*$/.test(authTagHex) || !/^[0-9a-f]*$/.test(encryptedHex)) {
    throw new Error('Invalid ciphertext format: segments must be valid hex');
  }

  // Convert from hex to buffers
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  // Create decipher
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);

  // Set the authentication tag
  decipher.setAuthTag(authTag);

  // Decrypt
  try {
    let decrypted = decipher.update(encrypted.toString('binary'), 'binary', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
