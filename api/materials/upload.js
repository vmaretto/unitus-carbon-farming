// Edge Function per upload materiali grandi (limite ~50MB)
import { put } from '@vercel/blob';
import { v4 as uuidv4 } from 'uuid';
import { createPool } from '@vercel/postgres';

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
    
    // Save to database if available
    if (process.env.DATABASE_URL) {
      try {
        const pool = createPool({ connectionString: process.env.DATABASE_URL });
        const resourceId = uuidv4();
        const now = new Date().toISOString();
        
        await pool.sql`
          INSERT INTO resources (id, name, type, url, created_at, updated_at)
          VALUES (${resourceId}, ${file.name.replace(/\.[^/.]+$/, '')}, 'material', ${blob.url}, ${now}, ${now})
        `;
      } catch (dbError) {
        console.error('DB error:', dbError);
        // Don't fail upload for DB issues
      }
    }
    
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