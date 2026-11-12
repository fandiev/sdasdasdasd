'use strict';
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, saved) {
  if (!saved || !saved.includes(':')) return false;
  const [salt, original] = saved.split(':');
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(original)) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(original, 'hex'));
}

function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashPassword, verifyPassword, token };
