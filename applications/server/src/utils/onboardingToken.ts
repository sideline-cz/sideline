// Onboarding's names for the shared URL-token primitives in `utils/urlToken.ts`.
// The crypto lives there so `/login` links and onboarding links cannot drift apart.
export { generateUrlToken as generateOnboardingToken, hashToken } from '~/utils/urlToken.js';
