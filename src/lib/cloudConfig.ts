// Firebase web configuration is public. Authorization is enforced by Firestore
// rules and Firebase ID tokens, never by hiding the web API key.
export const CLOUD_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyB405HjEMNaeSJGIccDEh3vWkXH57yzjQk',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'lomifynext'
};
export const GOOGLE_DESKTOP_CLIENT_ID = import.meta.env.VITE_GOOGLE_DESKTOP_CLIENT_ID || '315836420792-ngm3ia52585lsbgucc6kb08ggr9q6fek.apps.googleusercontent.com';
