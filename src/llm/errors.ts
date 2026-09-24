/** The model is not configured (or is disabled, as under NODE_ENV=test). */
export class LanguageModelConfigError extends Error {}

/** The provider call itself failed (network, auth, rate limit, server error). */
export class LanguageModelError extends Error {}
