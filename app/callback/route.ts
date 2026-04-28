import { handleAuth } from '@workos-inc/authkit-nextjs';
import { NextRequest } from 'next/server';

const workosHandler = handleAuth();

export async function GET(request: NextRequest) {
  let req = request;
  
  // 1. Grab the real public domain that Railway's proxy passes down
  const forwardedHost = request.headers.get('x-forwarded-host');
  
  // 2. If Next.js is confused and thinks it's 0.0.0.0, fix it dynamically
  if (forwardedHost && request.nextUrl.hostname === '0.0.0.0') {
    const url = request.nextUrl.clone();
    url.hostname = forwardedHost;
    url.port = ''; // Strip out the internal :8080 port
    url.protocol = 'https:';
    
    // 3. Create a cloned request with the fixed URL to hand to WorkOS
    req = new NextRequest(url.toString(), {
      headers: request.headers,
      method: request.method,
    });
  }

  // 4. Pass the fixed request to WorkOS so it redirects to the correct domain
  return workosHandler(req);
}