const REGISTRY = 'https://registry-1.docker.io';
const AUTH_SERVICE = 'https://auth.docker.io';
const TIMEOUT_MS = 120000; // 增加到 120 秒以支持大文件下载

// Token 缓存（内存）
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 240000; // 4 分钟（token 有效期 5 分钟）

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
  const cacheKey = `${scope}:${authorization || 'anonymous'}`;

  // 检查缓存
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    console.log('Using cached token for:', scope);
    return cached.token;
  }

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

    console.log('Fetching token:', tokenUrl.toString());

    let tokenResp = await fetchWithTimeout(tokenUrl.toString(), {
      method: 'GET',
      headers: tokenHeaders
    });

    console.log('Token response status:', tokenResp.status);

    // 处理 429 - 等待并重试
    if (tokenResp.status === 429) {
      console.log('Rate limited, waiting 10s...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      tokenResp = await fetchWithTimeout(tokenUrl.toString(), {
        method: 'GET',
        headers: tokenHeaders
      });

      console.log('Retry token response status:', tokenResp.status);
    }

    if (!tokenResp.ok) {
      const errorText = await tokenResp.text();
      console.log('Token error:', errorText);
      return null;
    }

    const tokenData = await tokenResp.json();
    const token = tokenData.token || tokenData.access_token || null;

    // 缓存 token
    if (token) {
      tokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + TOKEN_CACHE_TTL
      });
      console.log('Cached token for:', scope);
    }

    return token;
  } catch (error) {
    console.log('Token exception:', error.message);
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

  return new Response(JSON.stringify({
    token,
    access_token: token,
    expires_in: 300,
    issued_at: new Date().toISOString()
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache'
    }
  });
}

async function handleDockerRequest(path, fetchOptions) {
  const targetUrl = `${REGISTRY}${path}`;

  let response = await fetchWithTimeout(targetUrl, fetchOptions);

  // 处理重定向
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

      // 如果是 401，返回带 WWW-Authenticate 的响应，让客户端去获取 token
      if (response.status === 401) {
        const wwwAuth = response.headers.get('WWW-Authenticate');
        const responseHeaders = new Headers(response.headers);

        // 如果上游有 WWW-Authenticate，修改指向我们的 auth 端点
        if (wwwAuth) {
          responseHeaders.set('WWW-Authenticate', `Bearer realm="https://${url.hostname}/v2/auth",service="registry.docker.io"`);
        }

        return new Response(response.body, {
          status: 401,
          headers: responseHeaders
        });
      }

      // 直接返回其他响应
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
