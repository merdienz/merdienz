import { existsSync } from 'node:fs';
import { readSecretFile } from '../secret-file.js';
import { assertNotLiveStripeKey, assertStripeSecretKeyAllowed } from './keys.js';

export const DEFAULT_STRIPE_SECRET_FILE = '/etc/merdienz-cloud/stripe-secret';

export const DEFAULT_STRIPE_WEBHOOK_SECRET_FILE = '/etc/merdienz-cloud/stripe-webhook-secret';

// Latest Basil monthly release in the Stripe changelog (docs.stripe.com/changelog/basil).
// Invoice.subscription was removed in 2025-03-31.basil; pin the webhook endpoint to this version.
export const STRIPE_WEBHOOK_API_VERSION = '2025-08-27.basil';
// Shortest Checkout Session lifetime Stripe allows (30 minutes).
export const CHECKOUT_SESSION_TTL_SEC = 30 * 60;

export const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com';
export const STRIPE_FETCH_TIMEOUT_MS = 15_000;

function envOrDefault(envName, fallback) {
  const raw = process.env[envName];
  if (raw != null && String(raw).trim() !== '') return String(raw).trim();
  return fallback;
}

function isCloudOrProduction(config) {
  const mode = String(config.merdienzMode || '').toLowerCase();
  const nodeEnv = String(config.nodeEnv || '').toLowerCase();
  return mode === 'cloud' || nodeEnv === 'production';
}

function readOptionalSecret(path, label, required) {
  if (!path) {
    if (required) throw new Error(`${label} path is required`);
    return '';
  }
  if (!existsSync(path)) {
    if (required) throw new Error(`${label} not found`);
    return '';
  }
  return readSecretFile(path, label, { allowGroupReadable: true });
}

export function applyStripeConfig(config) {
  const prev = config.stripe || {};
  const secretFile = prev.secretKeyFile || envOrDefault('MERDIENZ_STRIPE_SECRET_KEY_FILE', DEFAULT_STRIPE_SECRET_FILE);
  const webhookFile = prev.webhookSecretFile
    || envOrDefault('MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE', DEFAULT_STRIPE_WEBHOOK_SECRET_FILE);
  const explicitSecret = Boolean(process.env.MERDIENZ_STRIPE_SECRET_KEY_FILE) || Boolean(prev.secretKeyFileExplicit);
  const explicitWebhook = Boolean(process.env.MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE) || Boolean(prev.webhookSecretFileExplicit);
  const prices = {
    starter_monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY || prev.prices?.starter_monthly || '',
    starter_yearly: process.env.STRIPE_PRICE_STARTER_YEARLY || prev.prices?.starter_yearly || '',
    pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || prev.prices?.pro_monthly || '',
    pro_yearly: process.env.STRIPE_PRICE_PRO_YEARLY || prev.prices?.pro_yearly || '',
  };
  let secretKey = prev.secretKey || '';
  let webhookSecret = prev.webhookSecret || '';
  const autoRead = isCloudOrProduction(config);
  if (!secretKey) {
    const mustRead = explicitSecret || (autoRead && existsSync(secretFile));
    if (mustRead || explicitSecret) {
      secretKey = readOptionalSecret(secretFile, 'MERDIENZ_STRIPE_SECRET_KEY_FILE', explicitSecret);
    }
  }
  if (!webhookSecret) {
    const required = explicitWebhook || Boolean(secretKey);
    const mustRead = required || (autoRead && existsSync(webhookFile));
    if (mustRead) {
      webhookSecret = readOptionalSecret(webhookFile, 'MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE', required);
    }
  }
  assertStripeSecretKeyAllowed(secretKey, 'MERDIENZ_STRIPE_SECRET_KEY_FILE');
  assertNotLiveStripeKey(webhookSecret, 'MERDIENZ_STRIPE_WEBHOOK_SECRET_FILE');
  const priceIds = Object.values(prices).filter(Boolean);
  if (secretKey && webhookSecret && priceIds.length !== 4) {
    throw new Error('Stripe price ids for starter and pro, monthly and yearly, are required when billing keys are set');
  }
  const apiBase = String(process.env.STRIPE_API_BASE || prev.apiBase || DEFAULT_STRIPE_API_BASE).replace(/\/$/, '');
  if (isCloudOrProduction(config) && apiBase !== DEFAULT_STRIPE_API_BASE) {
    throw new Error('STRIPE_API_BASE must be https://api.stripe.com in production and cloud');
  }
  const enabled = Boolean(secretKey && webhookSecret && priceIds.length === 4);
  config.stripe = {
    enabled,
    secretKey,
    webhookSecret,
    secretKeyFile: secretFile,
    webhookSecretFile: webhookFile,
    prices,
    apiBase,
    signatureToleranceSec: Number(prev.signatureToleranceSec || 300),
    fetchTimeoutMs: Number(prev.fetchTimeoutMs || STRIPE_FETCH_TIMEOUT_MS),
  };
  return config;
}
