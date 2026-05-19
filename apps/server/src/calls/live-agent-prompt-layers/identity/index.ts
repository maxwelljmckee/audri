// Identity layer — exports submodule builders. compose.ts decides which
// segments fire when (the opener fires before behavioral content; the
// principles fire mid-prompt; persona fires near the end).

export { buildWho } from './who.js';
export { buildPrinciples } from './principles.js';
export { buildPersona } from './persona.js';
