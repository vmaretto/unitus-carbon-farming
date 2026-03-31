// Edge Function per upload materiali grandi (limite ~50MB)
import { put } from '@vercel/blob';

export const config = {
  runtime: 'edge',
  maxDuration: 30
};

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  
  // Check auth header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const token = authHeader.slice(7);
  if (!token || token !== 'admin-token') {
    return new Response('Invalid token', { status: 401 });
  }
  
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file) {
      return new Response(JSON.stringify({ error: 'Nessun file caricato' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    console.log('Upload materiale Edge:', {
      name: file.name,
      size: file.size,
      type: file.type
    });
    
    if (file.size > 50 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'File troppo grande (max 50MB per Edge Function)' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Sanitizza nome
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Upload to Vercel Blob
    const fileBuffer = await file.arrayBuffer();
    const blob = await put(safeName, fileBuffer, {
      access: 'public'
    });
    
    // Note: Database insert skipped in Edge Function for simplicity
    // The file will be accessible via the blob URL
    
    return new Response(JSON.stringify({ 
      url: blob.url, 
      filename: safeName 
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(JSON.stringify({ error: 'Upload failed: ' + error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}