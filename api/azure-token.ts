/**
 * Vercel Edge Function que emite tokens temporales de Azure Speech Service.
 *
 * Flujo:
 * 1. El cliente (navegador) llama a /api/azure-token (sin parámetros)
 * 2. Esta función lee AZURE_SPEECH_KEY de las variables de entorno
 *    (configuradas en Vercel Dashboard > Project > Settings > Environment Variables)
 * 3. Hace POST al endpoint de Azure para canjear la key por un token JWT
 * 4. Devuelve { token, region } al cliente
 * 5. El cliente usa el token con el SDK de Azure (válido ~10 minutos)
 *
 * La AZURE_SPEECH_KEY NUNCA llega al navegador. Solo los tokens temporales.
 */

export const config = { runtime: 'edge' };

export default async function handler(_req: Request): Promise<Response> {
  const region = process.env['AZURE_REGION'] || 'eastus';
  const key = process.env['AZURE_SPEECH_KEY'];

  if (!key) {
    return jsonResponse(
      { error: 'AZURE_SPEECH_KEY no está configurada en las variables de entorno de Vercel.' },
      500
    );
  }

  try {
    const resp = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Length': '0'
        }
      }
    );

    if (!resp.ok) {
      return jsonResponse(
        { error: `Azure rechazó la solicitud (${resp.status} ${resp.statusText}).` },
        502
      );
    }

    const token = await resp.text();
    return jsonResponse({ token, region }, 200);
  } catch (e: any) {
    return jsonResponse(
      { error: e?.message || 'Error desconocido al pedir el token a Azure.' },
      500
    );
  }
}

function jsonResponse(body: any, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // Permitir que el frontend en el mismo dominio lo llame sin CORS issues.
      // Como front y endpoint están en el mismo dominio Vercel, no se necesita
      // CORS abierto, pero lo dejamos para flexibilidad.
      'Access-Control-Allow-Origin': '*'
    }
  });
}
