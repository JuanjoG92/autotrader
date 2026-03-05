// src/services/ai-token.js
// Carga el token de OpenAI desde GitHub (igual que CentralChat)
// El GITHUB_CONFIG_TOKEN se carga desde .env (no va en el repo)

const GITHUB_TOKEN      = process.env.GITHUB_CONFIG_TOKEN;
const GITHUB_CONFIG_URL = 'https://raw.githubusercontent.com/JuanjoG92/gestionpos-precios/main/precios.json';
const CACHE_TTL         = 6 * 60 * 60 * 1000; // 6 horas

let _cachedToken = null;
let _cacheTime   = 0;

async function getOpenAIToken() {
  const now = Date.now();
  if (_cachedToken && (now - _cacheTime) < CACHE_TTL) return _cachedToken;

  try {
    const res = await fetch(GITHUB_CONFIG_URL, {
      headers: { 'Authorization': `token ${GITHUB_TOKEN}` },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const data = await res.json();
    const token = data.openaiToken || data.openai_token || data.aiToken;
    if (token) {
      _cachedToken = token;
      _cacheTime   = now;
      console.log('[AI-Token] Token cargado desde GitHub');
    }
    return token || _cachedToken;
  } catch (e) {
    console.error('[AI-Token] Error cargando token:', e.message);
    return _cachedToken;
  }
}

module.exports = { getOpenAIToken };
