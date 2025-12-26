const REGISTRY = 'https://registry-1.docker.io';
const AUTH_SERVICE = 'https://auth.docker.io';
const TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function parseScope(path) {
  const parts = path.split('/').filter(p => p);

  if (parts.length < 2) {
    return '';
  }

  if (parts.includes('_catalog')) {
    return 'registry:catalog:*';
  }

  const suffixIndex = parts.findIndex(p =>
    ['manifests', 'blobs', 'tags', 'referrers'].includes(p)
  );

  let repoName;
  if (suffixIndex !== -1) {
    repoName = parts.slice(1, suffixIndex).join('/');
  } else {
    repoName = parts.slice(1).join('/');
  }

  if (!repoName) {
    return '';
  }

  if (!repoName.includes('/')) {
    repoName = `library/${repoName}`;
  }

  return `repository:${repoName}:pull`;
}

async function getAuthToken(scope, authorization) {
  try {
    const tokenUrl = new URL(`${AUTH_SERVICE}/token`);
    tokenUrl.searchParams.set('service', 'registry.docker.io');
    if (scope) {
      tokenUrl.searchParams.set('scope', scope);
    }

    const tokenHeaders = new Headers();
    if (authorization) {
      tokenHeaders.set('Authorization', authorization);
    }

    const tokenResp = await fetchWithTimeout(tokenUrl.toString(), {
      method: 'GET',
      headers: tokenHeaders
    });

    if (!tokenResp.ok) {
      return null;
    }

    const tokenData = await tokenResp.json();
    return tokenData.token || tokenData.access_token || null;
  } catch {
    return null;
  }
}

async function handleAuth(request, url) {
  const scope = url.searchParams.get('scope');
  const authorization = request.headers.get('Authorization');

  if (!scope) {
    const token = await getAuthToken('', authorization);
    return new Response(JSON.stringify({ token: token || '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const token = await getAuthToken(scope, authorization);

  if (!token) {
    return new Response(JSON.stringify({
      errors: [{
        code: 'UNAUTHORIZED',
        message: 'authentication failed'
      }]
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleDockerRequest(path, fetchOptions) {
  const targetUrl = `${REGISTRY}${path}`;

  let response = await fetchWithTimeout(targetUrl, fetchOptions);

  if (response.status === 401) {
    const authHeader = fetchOptions.headers.get('Authorization');

    if (!authHeader) {
      const scope = parseScope(path);
      const token = await getAuthToken(scope, '');

      if (token) {
        const authHeaders = new Headers(fetchOptions.headers);
        authHeaders.set('Authorization', `Bearer ${token}`);

        response = await fetchWithTimeout(targetUrl, {
          ...fetchOptions,
          headers: authHeaders
        });

        if (response.status === 301 || response.status === 302 || response.status === 307) {
          const location = response.headers.get('Location');
          if (location) {
            const redirectHeaders = new Headers(authHeaders);
            redirectHeaders.delete('Authorization');

            response = await fetchWithTimeout(location, {
              method: 'GET',
              headers: redirectHeaders,
              redirect: 'follow'
            });
          }
        }
      }
    }
  }

  if (response.status === 301 || response.status === 302 || response.status === 307) {
    const location = response.headers.get('Location');
    if (location) {
      const redirectHeaders = new Headers(fetchOptions.headers);
      redirectHeaders.delete('Authorization');

      response = await fetchWithTimeout(location, {
        method: 'GET',
        headers: redirectHeaders,
        redirect: 'follow'
      });
    }
  }

  return response;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v2/' || path === '/v2') {
      return new Response('{}', {
        status: 200,
        headers: {
          'Docker-Distribution-Api-Version': 'registry/2.0',
          'Content-Type': 'application/json'
        }
      });
    }

    if (path === '/v2/auth') {
      return await handleAuth(request, url);
    }

    if (!path.startsWith('/v2/')) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (!['host', 'connection', 'upgrade', 'proxy-connection'].includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json');
    }

    const fetchOptions = {
      method: request.method,
      headers: headers,
      redirect: 'manual'
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      fetchOptions.body = request.body;
    }

    try {
      const response = await handleDockerRequest(path, fetchOptions);

      if (response.status === 401) {
        const responseHeaders = new Headers();
        responseHeaders.set('Content-Type', 'application/json');
        responseHeaders.set('Docker-Distribution-Api-Version', 'registry/2.0');
        responseHeaders.set('WWW-Authenticate', `Bearer realm="https://${url.hostname}/v2/auth",service="registry"`);

        return new Response(JSON.stringify({
          errors: [{
            code: 'UNAUTHORIZED',
            message: 'authentication required'
          }]
        }), {
          status: 401,
          headers: responseHeaders
        });
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      return new Response(JSON.stringify({
        errors: [{
          code: 'SERVICE_UNAVAILABLE',
          message: error.message || 'service unavailable'
        }]
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
