import { Redirect } from 'expo-router';

/**
 * Sign-in redirects land here only if iOS hands the URL to the app instead
 * of to the sign-in sheet that's waiting for it. The sheet redeems the code
 * itself, so there's nothing to do but move on.
 */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
