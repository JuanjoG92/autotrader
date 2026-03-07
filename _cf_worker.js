export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Solo permitir requests a Binance API
    const target = 'https://api.binance.com' + url.pathname + url.search;
    
    // Copiar headers relevantes
    const headers = new Headers();
    for (const [key, value] of request.headers) {
      if (key.startsWith('x-mbx') || key === 'content-type') {
        headers.set(key, value);
      }
    }
    
    const resp = await fetch(target, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' ? await request.text() : undefined,
    });
    
    // Devolver respuesta con CORS
    const response = new Response(resp.body, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
    return response;
  },
};
