const REGISTRY = 'https://registry-1.docker.io';

function parseAuthenticate(authenticateStr) {
  const realmMatch = authenticateStr.match(/realm="([^"]+)"/);
  const serviceMatch = authenticateStr.match(/service="([^"]+)"/);

  if (!realmMatch || !serviceMatch) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }

  return {
    realm: realmMatch[1],
    service: serviceMatch[1]
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set('service', wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set('scope', scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set('Authorization', authorization);
  }
  return await fetch(url, { method: 'GET', headers });
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

async function handleDockerRequest(path, fetchOptions) {
  const targetUrl = `${REGISTRY}${path}`;

  let response = await fetch(targetUrl, {
    ...fetchOptions,
    redirect: 'manual'
  });

  if (response.status === 401) {
    const authHeader = fetchOptions.headers.get('Authorization');

    if (!authHeader) {
      const authenticateStr = response.headers.get('WWW-Authenticate');
      if (authenticateStr) {
        const wwwAuthenticate = parseAuthenticate(authenticateStr);
        const scope = parseScope(path);

        const tokenResponse = await fetchToken(wwwAuthenticate, scope, '');

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          if (tokenData.token || tokenData.access_token) {
            const token = tokenData.token || tokenData.access_token;
            const authHeaders = new Headers(fetchOptions.headers);
            authHeaders.set('Authorization', `Bearer ${token}`);

            response = await fetch(targetUrl, {
              ...fetchOptions,
              headers: authHeaders,
              redirect: 'manual'
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

      response = await fetch(location, {
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
      headers: headers
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

      return response;
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
