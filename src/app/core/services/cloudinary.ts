// =====================================================================
// SUBIDA DE ARCHIVOS A CLOUDINARY (gratis, sin Firebase Storage/Blaze)
// Cuenta: duherjgyg · preset unsigned: fotos_mega
// =====================================================================

export const CLOUDINARY = {
  cloudName: 'duherjgyg',
  uploadPreset: 'fotos_mega'
};

/**
 * Sube un archivo (PDF o imagen) a Cloudinary mediante "unsigned upload"
 * y devuelve la URL pública (secure_url). No requiere autenticación ni backend.
 */
export async function subirACloudinary(file: File, carpeta = 'megatalento'): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY.uploadPreset);
  formData.append('folder', carpeta);

  // /auto/ detecta automáticamente si es imagen o documento (PDF = raw/image)
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY.cloudName}/auto/upload`;

  const resp = await fetch(endpoint, { method: 'POST', body: formData });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error('Falló la subida a Cloudinary: ' + detalle);
  }

  const data = await resp.json();
  return data.secure_url as string;
}
